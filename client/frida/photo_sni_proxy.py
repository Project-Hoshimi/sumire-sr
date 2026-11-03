#!/usr/bin/env python3
"""Transparent SNI TCP relay for the official photo-capture USB tunnel.

The Pixel 6's "tao guest" Wi-Fi refuses TCP 443 to the official GCP game
servers, so the game's TLS connects are redirected (frida photo_redirect.js ->
adb reverse tcp:443 -> this proxy) to the host, which CAN reach the official
servers. This proxy reads only the TLS ClientHello SNI to pick the upstream,
then relays the connection byte-exact (including the buffered ClientHello).
No MITM, no cert changes, no SSL unpinning: the game still talks real TLS to
the real servers, so FULLRAW (combined_hooks.js) sees exact plaintext.

Usage: python3 photo_sni_proxy.py [listen_host] [listen_port]
       (defaults: 127.0.0.1:8444)  --  Ctrl-C to stop.
"""
import socket
import sys
import threading
import time

LISTEN_HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
LISTEN_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8444

# Known official endpoints (host -> upstream IP:port).
ROUTES = {
    "api.game-idolypride.jp": ("35.221.155.103", 443),
    "api.octo-cloud.com": ("130.211.5.37", 443),
}

READ_CHUNK = 65536
CLIENT_HELLO_TIMEOUT = 10.0


def log(msg):
    print("[sni-proxy] %s %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def parse_sni(buf):
    """Return SNI hostname from a (possibly partial) TLS ClientHello.

    Returns the hostname when fully parsed, None when the buffer is not yet a
    complete-enough ClientHello, or b"" on a malformed record.
    """
    off = 0
    while True:
        if len(buf) < off + 5:
            return None
        rtype = buf[off]
        rlen = int.from_bytes(buf[off + 3:off + 5], "big")
        rec_end = off + 5 + rlen
        if len(buf) < rec_end:
            return None
        if rtype != 22:  # not a handshake record
            off = rec_end
            continue
        hb = buf[off + 5:rec_end]
        if len(hb) < 4:
            return None
        hlen = int.from_bytes(hb[1:4], "big")
        if len(hb) < 4 + hlen:
            return None
        if hb[0] != 1:  # not ClientHello
            return b""
        p = 4
        # legacy_version(2) + random(32)
        p += 2 + 32
        # session_id: len(1) + data
        if p + 1 > len(hb):
            return None
        sid = hb[p]
        p += 1 + sid
        # cipher_suites: len(2) + data
        if p + 2 > len(hb):
            return None
        cs = int.from_bytes(hb[p:p + 2], "big")
        p += 2 + cs
        # compression_methods: len(1) + data
        if p + 1 > len(hb):
            return None
        cm = hb[p]
        p += 1 + cm
        # extensions: len(2) then each ext: type(2) len(2) data
        if p + 2 > len(hb):
            return None
        ext_total = int.from_bytes(hb[p:p + 2], "big")
        p += 2
        ext_end = p + ext_total
        if ext_end > len(hb):
            return None
        while p + 4 <= ext_end:
            etype = int.from_bytes(hb[p:p + 2], "big")
            elen = int.from_bytes(hb[p + 2:p + 4], "big")
            edata = hb[p + 4:p + 4 + elen]
            if etype == 0:  # server_name
                if len(edata) < 3:
                    return b""
                q = 2  # server_name_list length(2)
                while q < len(edata):
                    ntype = edata[q]
                    nlen = int.from_bytes(edata[q + 1:q + 3], "big")
                    name = edata[q + 3:q + 3 + nlen]
                    if ntype == 0 and name:
                        return name
                    q += 3 + nlen
            p += 4 + elen
        return b""
        # fall through only if no SNI found in a complete ClientHello


def pick_upstream(sni):
    if sni in ROUTES:
        return ROUTES[sni]
    try:
        ip = socket.gethostbyname(sni)
        return (ip, 443)
    except Exception as exc:
        log("resolve %r failed: %s" % (sni, exc))
        return ("35.221.155.103", 443)  # last-resort default


def pump(src, dst, name):
    try:
        while True:
            data = src.recv(READ_CHUNK)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client, addr):
    try:
        client.settimeout(CLIENT_HELLO_TIMEOUT)
        buf = b""
        while True:
            try:
                chunk = client.recv(READ_CHUNK)
            except socket.timeout:
                log("ClientHello timeout from %s" % (addr,))
                return
            if not chunk:
                log("client %s closed before ClientHello" % (addr,))
                return
            buf += chunk
            sni = parse_sni(buf)
            if sni is None:
                continue
            if sni == b"":
                log("malformed TLS from %s" % (addr,))
                return
            break
        host, port = pick_upstream(sni.decode("latin1"))
        log("conn %s SNI=%s -> %s:%d" % (addr, sni.decode("latin1"), host, port))
        upstream = socket.create_connection((host, port), timeout=CLIENT_HELLO_TIMEOUT)
        client.settimeout(None)
        upstream.settimeout(None)
        # hand the already-read ClientHello bytes straight through
        if buf:
            upstream.sendall(buf)
        t1 = threading.Thread(target=pump, args=(client, upstream, "c->u"), daemon=True)
        t2 = threading.Thread(target=pump, args=(upstream, client, "u->c"), daemon=True)
        t1.start(); t2.start()
        t1.join(); t2.join()
        client.close(); upstream.close()
        log("conn %s done" % (addr,))
    except Exception as exc:
        log("conn %s error: %s" % (addr, exc))
    finally:
        try:
            client.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(16)
    log("listening on %s:%d" % (LISTEN_HOST, LISTEN_PORT))
    while True:
        c, a = srv.accept()
        threading.Thread(target=handle, args=(c, a), daemon=True).start()


if __name__ == "__main__":
    main()
