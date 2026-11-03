/*
 * il2cpp_hooks.js — Offset-based native hooks into libil2cpp.so for Idoly Pride
 *
 * Targets (from Il2CppDumper script.json, addresses are ELF vaddrs; base at PT_LOAD vaddr 0):
 *   Qua.Network.ApiBase$$CreateRequestSignature            0x6dc9aec  (byte[] req, String ts, byte[] key) -> String sig
 *   Qua.Network.ApiBase$$ExecuteAsync<object,object>       0x5ab69ac  (apiRequest, serviceName, methodName, apiName)
 *   Qua.Network.ApiBase$$ExecuteApiAsync<object,object>    0x5ab658c  (apiName, request, header)
 *   Qua.Network.ApiBase$$CreateHeader<object,object>       0x5ab5b48  (apiRequest, serviceName, methodName)
 *   Qua.Network.ApiBase$$CreateRequestId                   0x6dc9a6c  () -> String
 *   Qua.Network.ApiBase$$GetUnixTimestamp                  0x6dc9dc4  () -> String
 *   Qua.Network.DefaultMarshallerFactory$$Encrypt          0x8799358  (byte[], byte[] key, byte[] iv) -> byte[]
 *   Qua.Network.DefaultMarshallerFactory$$Decrypt          0x8799404  (byte[], int off, int len, byte[] key, byte[] iv) -> byte[]
 *   Qua.Network.DefaultMarshallerFactory$$CreateAesIV      0x87994d0  (byte[] secKey, Header) -> byte[]
 *   Qua.Network.DefaultMarshallerFactory$$CompressBuffer   0x8799704  (byte[]) -> byte[]
 *   Qua.Network.DefaultMarshallerFactory$$DecompressBuffer 0x8799a3c  (byte[]) -> byte[]
 *   Qua.Network.DefaultMarshallerFactory$$MD5Hash          0x8799da0  (byte[]) -> byte[]
 *   Qua.Network.Crypto.Aes$$Encrypt                        0x8799370  (byte[], byte[], byte[]) -> byte[]
 *   Qua.Network.Crypto.Aes$$Decrypt                        0x8799424  (byte[], int, int, byte[], byte[]) -> byte[]
 *   Solis.Common.Crypto.AES$$Encrypt(x3)                   0x50409c0  (plain, key, iv) -> byte[]
 *   Solis.Common.Crypto.AES$$Decrypt(x3)                   0x5040b00  (cipher, key, iv) -> byte[]
 *   Qua.Network.CustomHttpMessageHandler$$SendAsync        0x8798d58  (request, ct) -> HttpResponseMessage
 *
 * Usage: combined with ssl_unpinning.js and loaded via:
 *   frida -U -f game.qualiarts.idolypride -l combined_hooks.js
 */

'use strict';

(function () {

const START_TS = Date.now();
function ts() {
  return `${((Date.now() - START_TS) / 1000).toFixed(1)}s`;
}
function log(msg) {
  console.log(`[il2cpp ${ts()}] ${msg}`);
}

const MOD_NAME = 'libil2cpp.so';
// libil2cpp RVAs move between builds: HOOKS `off` is 6.0.2 (phase3d/dump),
// `off603` is 6.0.3 (phase3d_603/dump_net). Set this to the installed versionName.
const GAME_VERSION = '6.0.3';
const TRACE = {
  signature: true,
  requests: true,
  encrypt: true,
  decrypt: true,
  md5: true,
  iv: true,
  http: false,
  aeslow: false,
  compress: false
};
const DUMP_MAX = 512;   // max bytes hexdumped per payload field

/* ---------------------------------------------------------------------------
 * IL2CPP object readers (64-bit)
 *   System.String : +0x08 hash(u32), +0x0C length(u32), +0x10 wchar data (UTF-16LE)
 *   System.Byte[] : +0x08 size(u64), element data @ +0x10
 * ------------------------------------------------------------------------- */
function readString(ptr) {
  try {
    if (ptr.isNull()) return '(null)';
    const len = ptr.add(0x10).readU32();
    if (len === 0 || len > 0x100000) return `(badlen ${len})`;
    let out = '';
    for (let i = 0; i < len; i++) {
      const lo = ptr.add(0x14 + i*2).readU8();
      const hi = ptr.add(0x14 + i*2 + 1).readU8();
      const cp = lo | (hi << 8);
      if (cp >= 0x20 && cp <= 0x7e) out += String.fromCharCode(cp);
      else if (cp > 0x7f) out += String.fromCharCode(cp);
      else out += '\\x' + cp.toString(16).padStart(2, '0');
    }
    return out;
  } catch (e) {
    return `(str? ${e.message})`;
  }
}

function readBytes(ptr, capLocal = DUMP_MAX) {
  try {
    if (ptr.isNull()) return '(null)';
    const rawLen = ptr.add(0x18).readU64();
    const len = Number(rawLen);
    if (len === 0) return '(empty)';
    if (len > 0x2000000) return `(badlen ${len})`;
    const n = Math.min(len, capLocal);
    let hex = '';
    for (let i = 0; i < n; i++) {
      hex += ptr.add(0x20 + i).readU8().toString(16).padStart(2, '0');
      if (i < n - 1) hex += ' ';
    }
    return { len, hex, full: len <= capLocal };
  } catch (e) {
    return `(arr? ${e.message})`;
  }
}

function fmtBytes(desc, ptr, capLocal) {
  const r = readBytes(ptr, capLocal);
  if (typeof r === 'string') { log(`${desc} ${r}`); return; }
  const { len, hex } = r;
  log(`${desc} bytes=${len} ${len > (capLocal || DUMP_MAX) ? '(truncated) ' : ''}${hex}`);
}

function fmtStr(desc, ptr) {
  log(`${desc} = ${readString(ptr)}`);
}

/* ---------------------------------------------------------------------------
 * Hook table
 * ------------------------------------------------------------------------- */
const HOOKS = [
  { off: 0x6dc9aec, off603: 0x6dca47c, name: 'ApiBase.CreateRequestSignature', tag: 'signature' },
  { off: 0x5ab69ac, off603: 0x5ab733c, name: 'ApiBase.ExecuteAsync', tag: 'requests' },
  { off: 0x5ab658c, off603: 0x5ab6f1c, name: 'ApiBase.ExecuteApiAsync', tag: 'requests' },
  { off: 0x5ab5b48, off603: 0x5ab64d8, name: 'ApiBase.CreateHeader', tag: 'requests' },
  { off: 0x6dc9a6c, off603: 0x6dca3fc, name: 'ApiBase.CreateRequestId', tag: 'requests' },
  { off: 0x6dc9dc4, off603: 0x6dca754, name: 'ApiBase.GetUnixTimestamp', tag: 'requests' },
  { off: 0x8799358, off603: 0x8799ce8, name: 'MarshallerFactory.Encrypt', tag: 'encrypt' },
  { off: 0x8799404, off603: 0x8799d94, name: 'MarshallerFactory.Decrypt', tag: 'decrypt' },
  { off: 0x87994d0, off603: 0x8799e60, name: 'MarshallerFactory.CreateAesIV', tag: 'iv' },
  { off: 0x8799704, off603: 0x879a094, name: 'MarshallerFactory.CompressBuffer', tag: 'compress' },
  { off: 0x8799a3c, off603: 0x879a3cc, name: 'MarshallerFactory.DecompressBuffer', tag: 'compress' },
  { off: 0x8799da0, off603: 0x879a730, name: 'MarshallerFactory.MD5Hash', tag: 'md5' },
  { off: 0x8799370, off603: 0x8799d00, name: 'Crypto.Aes.Encrypt', tag: 'aeslow' },
  { off: 0x8799424, off603: 0x8799db4, name: 'Crypto.Aes.Decrypt', tag: 'aeslow' },
  { off: 0x50409c0, off603: 0x5041350, name: 'Solis.AES.Encrypt', tag: 'aeslow' },
  { off: 0x5040b00, off603: 0x5041490, name: 'Solis.AES.Decrypt', tag: 'aeslow' },
  { off: 0x8798d58, off603: 0x87996e8, name: 'CustomHttpMessageHandler.SendAsync', tag: 'http' }
];
if (GAME_VERSION === '6.0.3') for (const h of HOOKS) h.off = h.off603;

function installPass() {
  const mod = Process.enumerateModules().find(m => m.name === MOD_NAME);
  if (!mod) return false;
  const base = mod.base; // NativePointer
  for (const h of HOOKS) {
    if (h.attached) continue;
    if (!TRACE[h.tag]) { h.attached = true; continue; }
    const target = base.add(h.off);
    // sanity check: read 4 bytes at target
    let peek = '(n/a)';
    try {
      const b = new Uint8Array(target.readByteArray(4));
      peek = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
    } catch (e) { /* ignore */ }
    try {
      Interceptor.attach(target, makeHandler(h));
      h.attached = true;
      log(`hooked ${h.name} @ ${target} (vaddr 0x${h.off.toString(16)}) peek=${peek}`);
    } catch (e) {
      log(`FAIL hook ${h.name} @ ${target}: ${e.message}`);
    }
  }
  return HOOKS.every(h => h.attached);
}

/* ---------------------------------------------------------------------------
 * Handlers
 *   ARM64 ABI: x0..x7 args, x0 return.
 * ------------------------------------------------------------------------- */
function makeHandler(h) {
  return {
    onEnter(args) {
      try {
        switch (h.name) {
          case 'ApiBase.CreateRequestSignature': {
            fmtBytes(`  SIG in  request  :`, args[1]);
            fmtStr(`  SIG in  timestamp :`, args[2]);
            fmtBytes(`  SIG in  key      :`, args[3], 64);
            break;
          }
          case 'ApiBase.ExecuteApiAsync': {
            log(`  API ${readString(args[1])}`);
            break;
          }
          case 'ApiBase.ExecuteAsync': {
            log(`  EXEC service=${readString(args[3])} method=${readString(args[4])} api=${readString(args[5])}`);
            break;
          }
          case 'ApiBase.CreateHeader': {
            log(`  HDR service=${readString(args[2])} method=${readString(args[3])}`);
            break;
          }
          case 'ApiBase.CreateRequestId': {
            break; // return value logged onLeave
          }
          case 'ApiBase.GetUnixTimestamp': {
            break;
          }
          case 'MarshallerFactory.Encrypt': {
            if (TRACE.encrypt) {
              fmtBytes(`  ENC in  plain   :`, args[1]);
              fmtBytes(`  ENC in  key     :`, args[2], 64);
              fmtBytes(`  ENC in  iv      :`, args[3], 64);
            }
            break;
          }
          case 'MarshallerFactory.Decrypt': {
            if (TRACE.decrypt) {
              const off = args[2].toInt32();
              const len = args[3].toInt32();
              const r = readBytes(args[1], Math.min(len + 8, DUMP_MAX));
              if (typeof r === 'string') { log(`  DEC in cipher ${r}`); }
              else { log(`  DEC in  cipher  : offset=${off} len=${len} bytes=${r.len} full=${r.full} ${r.hex}`); }
              fmtBytes(`  DEC in  key     :`, args[4], 64);
              fmtBytes(`  DEC in  iv      :`, args[5], 64);
            }
            break;
          }
          case 'MarshallerFactory.CreateAesIV': {
            fmtBytes(`  IV  in  secKey  :`, args[1], 64);
            break;
          }
          case 'MarshallerFactory.CompressBuffer': {
            fmtBytes(`  CMZ in  data    :`, args[1], 128);
            break;
          }
          case 'MarshallerFactory.DecompressBuffer': {
            fmtBytes(`  DCZ in  cdata   :`, args[1], 128);
            break;
          }
          case 'MarshallerFactory.MD5Hash': {
            fmtBytes(`  MD5 in  data    :`, args[1], 128);
            break;
          }
          case 'Crypto.Aes.Encrypt': {
            if (TRACE.aeslow) fmtBytes(`  AES-E in plain  :`, args[1]);
            break;
          }
          case 'Crypto.Aes.Decrypt': {
            if (TRACE.aeslow) fmtBytes(`  AES-D in cipher :`, args[1]);
            break;
          }
          case 'Solis.AES.Encrypt': {
            if (TRACE.aeslow) fmtBytes(`  SOL-E in plain  :`, args[1]);
            break;
          }
          case 'Solis.AES.Decrypt': {
            if (TRACE.aeslow) fmtBytes(`  SOL-D in cipher :`, args[1]);
            break;
          }
          case 'CustomHttpMessageHandler.SendAsync': {
            if (TRACE.http) log(`  HTTP send request ptr=${args[1]}`);
            break;
          }
        }
      } catch (e) {
        log(`${h.name} onEnter error: ${e.message}`);
      }
    },
    onLeave(ret) {
      try {
        switch (h.name) {
          case 'ApiBase.CreateRequestSignature': {
            fmtStr(`  SIG out signature:`, ret);
            break;
          }
          case 'ApiBase.CreateRequestId': {
            fmtStr(`  REQID out         :`, ret);
            break;
          }
          case 'ApiBase.GetUnixTimestamp': {
            fmtStr(`  TS out            :`, ret);
            break;
          }
          case 'MarshallerFactory.Encrypt': {
            fmtBytes(`  ENC out cipher    :`, ret);
            break;
          }
          case 'MarshallerFactory.Decrypt': {
            fmtBytes(`  DEC out plain     :`, ret);
            break;
          }
          case 'MarshallerFactory.CreateAesIV': {
            fmtBytes(`  IV  out iv       :`, ret, 64);
            break;
          }
          case 'MarshallerFactory.MD5Hash': {
            fmtBytes(`  MD5 out digest   :`, ret, 16);
            break;
          }
          case 'Crypto.Aes.Encrypt': {
            if (TRACE.aeslow) fmtBytes(`  AES-E out        :`, ret, 64);
            break;
          }
          case 'Crypto.Aes.Decrypt': {
            if (TRACE.aeslow) fmtBytes(`  AES-D out        :`, ret, 64);
            break;
          }
          case 'Solis.AES.Encrypt':
          case 'Solis.AES.Decrypt': {
            if (TRACE.aeslow) fmtBytes(`  SOL out          :`, ret, 64);
            break;
          }
        }
      } catch (e) {
        log(`${h.name} onLeave error: ${e.message}`);
      }
    }
  };
}

/* Poll until libil2cpp.so is mapped (app may load it lazily) */
var _installed = false;
setInterval(() => {
  if (_installed) return;
  _installed = installPass();
  if (_installed) log('All il2cpp hooks installed.');
}, 500);

})();
