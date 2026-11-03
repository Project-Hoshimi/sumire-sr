/* Photo-capture DNS redirect: api.octo-cloud.com & api.game-idolypride.jp -> 127.0.0.1.
 * Used ONLY for the Phase-0 official photo capture window, loaded alongside
 * combined_hooks.js. The game connects to 127.0.0.1:443 -> adb reverse ->
 * host SNI proxy (tools/sni_proxy.py) -> real official server. This exists
 * because the device's guest Wi-Fi refuses TCP 443 to the official GCP IPs.
 * No SSL bypass here: the host proxy is a TRANSPARENT TCP relay, so the game
 * talks real TLS to official (combined_hooks supplies the FULLRAW plaintext
 * dump on-device). Pattern copied from e2e_hooks.js section 3. */
const REDIRECT = {
  'api.octo-cloud.com': '127.0.0.1',
  'api.game-idolypride.jp': '127.0.0.1',
};
const REDIRECT_IPS = ['35.221.155.103', '130.211.5.37'];

function hookGetaddrinfo() {
  const libc = Process.enumerateModules().find(m => m.name === 'libc.so');
  if (!libc) return;
  try {
    const ga = libc.findExportByName('getaddrinfo');
    if (!ga) return;
    function rewriteEntry(ai) {
      const family = ai.add(4).readU32();
      const sa = ai.add(24).readPointer();
      if (sa.isNull()) return;
      if (family === 2) {
        sa.add(4).writeU32(0x0100007f);
      } else if (family === 10) {
        for (let i = 0; i < 15; i++) sa.add(8 + i).writeU8(0);
        sa.add(23).writeU8(1);
      }
    }
    Interceptor.attach(ga, {
      onEnter(args) {
        try {
          const node = args[0].isNull() ? '' : args[0].readCString();
          this.node = node;
          this.redirect = node && REDIRECT[node] ? REDIRECT[node] : null;
          this.ppRes = this.redirect ? args[3] : null;
        } catch (e) { this.redirect = null; this.ppRes = null; }
      },
      onLeave(ret) {
        if (this.redirect && ret.toInt32() === 0 && this.ppRes && !this.ppRes.isNull()) {
          try {
            let ai = this.ppRes.readPointer();
            let n = 0;
            while (!ai.isNull() && n < 16) {
              rewriteEntry(ai);
              ai = ai.add(40).readPointer();
              n++;
            }
            log(`photo-dns: getaddrinfo(${this.node}) -> 127.0.0.1 (${n} entries)`);
          } catch (e) { log(`photo-dns rewrite err: ${e.message}`); }
        }
      }
    });
    log('photo-dns: hooked libc getaddrinfo');
  } catch (e) { log(`photo-dns hook err: ${e.message}`); }
}

function hookConnect() {
  const libc = Process.enumerateModules().find(m => m.name === 'libc.so');
  if (!libc) return;
  try {
    const co = libc.findExportByName('connect');
    if (!co) return;
    Interceptor.attach(co, {
      onEnter(args) {
        try {
          const fd = args[0].toInt32();
          const sa = args[1];
          const fam = sa.add(0).readU16();
          const port = sa.add(2).readU16();
          const p = ((port & 0xff) << 8) | (port >> 8);
          if (fam === 2) {
            const ip = `${sa.add(4).readU8()}.${sa.add(5).readU8()}.${sa.add(6).readU8()}.${sa.add(7).readU8()}`;
            if (REDIRECT_IPS.indexOf(ip) !== -1 && p === 443) {
              sa.add(4).writeU32(0x0100007f);
              log(`photo-conn: REDIRECT fd=${fd} ${ip}:443 -> 127.0.0.1:443`);
            } else {
              log(`photo-conn: fd=${fd} AF_INET ${ip}:${p}`);
            }
          } else if (fam === 10) {
            const b = sa.add(8);
            const hex = [];
            for (let i = 0; i < 16; i++) hex.push(('0' + b.add(i).readU8().toString(16)).slice(-2));
            log(`photo-conn: fd=${fd} AF_INET6 ${hex.join('')}:${p}`);
          } else {
            log(`photo-conn: fd=${fd} fam=${fam} port=${p}`);
          }
        } catch (e) { log(`photo-conn err: ${e.message}`); }
      }
    });
    log('photo-dns: hooked libc connect');
  } catch (e) { log(`photo-connect hook err: ${e.message}`); }
}
hookGetaddrinfo();
hookConnect();
