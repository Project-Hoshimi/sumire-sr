/*
 * ssl_unpinning.js — Universal Android SSL unpinning for Idoly Pride
 * Covers: OkHttp3 / HttpURLConnection / Conscrypt (Java layer)
 *         Cronet/BoringSSL native TLS (Unity UnityWebRequest backend)
 *
 * Usage:
 *   frida -U -f game.qualiarts.idolypride -l ssl_unpinning.js
 */

'use strict';

const START_TS = Date.now();
function ts() {
  return `${((Date.now() - START_TS) / 1000).toFixed(1)}s`;
}
function log(msg) {
  console.log(`[unpin ${ts()}] ${msg}`);
}

/* =========================================================================
 * 1) JAVA LAYER — OkHttp / HttpURLConnection / Conscrypt
 * ========================================================================= */
Java.perform(function () {
  log('Injecting Java-layer hooks');

  const X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
  const BlindTrust = Java.registerClass({
    name: 'com.idoly.unpin.BlindTrust',
    implements: [X509TrustManager],
    methods: {
      checkClientTrusted: function () {},
      checkServerTrusted: function () {},
      getAcceptedIssuers: function () { return []; }
    }
  });
  const blindManagers = [BlindTrust.$new()];

  const SSLContext = Java.use('javax.net.ssl.SSLContext');
  SSLContext.init.overloads.forEach(function (init) {
    init.implementation = function (km, tm, sr) {
      log('SSLContext.init() blinded trust managers');
      init.call(this, km, blindManagers, sr);
    };
  });

  try {
    const HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection');
    HttpsURLConnection.setDefaultHostnameVerifier.implementation = function (hv) {
      log('HttpsURLConnection.setDefaultHostnameVerifier() neutralized');
    };
  } catch (e) { /* missing overload */ }

  function trustAllVerifyChain(TMI) {
    TMI.verifyChain.implementation = function (unverifiedChain, authType, host, clientAuth, socket, additionalChain) {
      log(`verifyChain() -> ACCEPT (host=${host})`);
      return unverifiedChain;
    };
    TMI.checkServerTrusted.overloads.forEach(function (o) {
      o.implementation = function (chain) {
        log('checkServerTrusted() -> ACCEPT');
        /* TrustManagerImpl exposes BOTH the standard void overload
         * (chain, authType) and the extended List-returning overload
         * (chain, authType, host) used by Chromium's
         * AndroidNetworkLibrary.verifyServerCertificates. Returning
         * undefined for the List overload -> NPE in Chromium's
         * .size(). Match the declared return type. */
        const rt = o.returnType && o.returnType.className || '';
        if (rt.indexOf('List') !== -1) {
          const ArrayList = Java.use('java.util.ArrayList');
          const list = ArrayList.$new();
          if (chain) for (let i = 0; i < chain.length; i++) list.add(chain[i]);
          return list;
        }
        return;
      };
    });
    TMI.checkTrustedRecursive.overloads.forEach(function (o) {
      o.implementation = function () {
        log('checkTrustedRecursive() -> ACCEPT');
        return null;
      };
    });
  }

  const tmiClasses = ['com.android.org.conscrypt.TrustManagerImpl', 'org.conscrypt.TrustManagerImpl'];
  for (const cls of tmiClasses) {
    try {
      const TMI = Java.use(cls);
      trustAllVerifyChain(TMI);
      log(`Hooked ${cls}`);
    } catch (e) {
      log(`${cls} not loaded: ${e.message}`);
    }
  }

  try {
    const CertificatePinner = Java.use('okhttp3.CertificatePinner');
    CertificatePinner.check.overloads.forEach(function (o) {
      o.implementation = function (hostname, peerCerts) {
        log(`okhttp3 CertificatePinner.check(${hostname}) -> ALLOW`);
        return;
      };
    });
    log('Hooked okhttp3.CertificatePinner');
  } catch (e) {
    log(`CertificatePinner not loaded: ${e.message}`);
  }

  try {
    const CertificatePinnerBuilder = Java.use('okhttp3.CertificatePinner$Builder');
    CertificatePinnerBuilder.add.overloads.forEach(function (o) {
      o.implementation = function () {
        log('okhttp3 CertificatePinner.Builder.add() -> dropped');
        return this;
      };
    });
    log('Hooked okhttp3.CertificatePinner.Builder');
  } catch (e) { /* n/a */ }

  try {
    const OkHttpClientBuilder = Java.use('okhttp3.OkHttpClient$Builder');
    OkHttpClientBuilder.certificatePinner.implementation = function (cp) {
      log('okhttp3 Builder.certificatePinner() -> stripped');
      return this;
    };
    log('Hooked okhttp3.OkHttpClient$Builder.certificatePinner');
  } catch (e) {
    log(`OkHttpClient$Builder not loaded: ${e.message}`);
  }

  log('Java-layer hooks installed');
});

/* =========================================================================
 * 2) NATIVE LAYER — Cronet / BoringSSL TLS
 *    UnityWebRequest on Android 16 uses Cronet (libmainlinecronet.*.so).
 *    Force SSL_VERIFY_NONE at SSL_CTX creation time so TLS is MITM-able.
 * ========================================================================= */

const SSL_VERIFY_NONE = 0x00;

function hookSymbol(mod, sym) {
  try {
    const addr = mod.findExportByName(sym);
    if (!addr) return 0;
    Interceptor.attach(addr, {
      onEnter(args) {
        log(`${mod.name}::${sym}() mode=${args[1].toInt32()} -> SSL_VERIFY_NONE`);
        args[1] = ptr(SSL_VERIFY_NONE);
        if (args[2]) args[2] = ptr(0);
      }
    });
    log(`${mod.name} hooking ${sym} @ ${addr}`);
    return 1;
  } catch (e) {
    log(`hookSymbol ${mod.name}::${sym} failed: ${e.message}`);
    return 0;
  }
}

const nativeTargets = [
  'libmainlinecronet',   // Cronet mainline (modern Unity WebRequest backend)
  'libcronet',
  'libunity.so',
  'libil2cpp.so',
  'libssl.so',
  'libboringssl.so'
];

const nativeSyms = ['SSL_CTX_set_custom_verify', 'SSL_CTX_set_verify'];

function runNativePass() {
  for (const name of nativeTargets) {
    const mod = Process.enumerateModules().find(m => m.name.startsWith(name));
    if (!mod) continue;
    for (const sym of nativeSyms) hookSymbol(mod, sym);
  }
}

// First pass shortly after spawn (libs are usually loaded during splash);
// then keep re-scanning in case networking/tls libs load lazily.
runNativePass();
setInterval(runNativePass, 3000);/*
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
// `off610` is 6.1.0, mapped from 6.0.3 by masked arm64 signature matching. Not yet tested on a device.
const GAME_VERSION = '6.1.0';
const TRACE = {
  signature: true,
  requests: true,
  encrypt: true,
  decrypt: true,
  md5: true,
  iv: true,
  http: true,
  headers: true,
  aeslow: false,
  compress: false
};
const FULLRAW = true;   // dump full plaintext (no 512B cap) to /data/local/tmp/raw/<n>.<dir>.bin
const DUMP_MAX = 512;   // max bytes hexdumped per payload field (summary lines)

const RAW_DIR = '/data/data/game.qualiarts.idolypride/cache/raw/';
let rawSeq = 0;
let rawCur = 'startup';
let rawDirReady = false;

/* Create RAW_DIR from inside the app process so it gets the app's uid and
 * SELinux category (a dir made via `su` is root-owned and unwritable). */
function ensureRawDir() {
  if (rawDirReady) return;
  rawDirReady = true;
  try {
    const mkdir = new NativeFunction(Module.getGlobalExportByName('mkdir'), 'int', ['pointer', 'int']);
    const parent = RAW_DIR.replace(/raw\/$/, '');
    mkdir(Memory.allocUtf8String(parent), 0o2771);
    mkdir(Memory.allocUtf8String(RAW_DIR), 0o2771);
  } catch (e) { log(`[raw] mkdir fail: ${e.message}`); }
}

/* Write the FULL byte[] to a per-RPC file (no truncation) — feeds A1/A2/A3
 * byte-exact verification and A2 master-data decode. A key is derived from the
 * current HDR service/method (rawCur) which combined_hooks updates on EXEC. */
function rawBytes(desc, ptr) {
  try {
    if (!FULLRAW || ptr.isNull()) return;
    const rawLen = Number(ptr.add(0x18).readU64());
    if (rawLen <= 0 || rawLen > 0x2000000) return;
    const n = Math.min(rawLen, 64 * 1024 * 1024);
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = ptr.add(0x20 + i).readU8();
    ensureRawDir();
    const name = `${String(rawSeq++).padStart(5, '0')}.${desc}.${rawCur.replace(/[^A-Za-z0-9_:]/g, '_')}.bin`;
    try { File.writeAllBytes(RAW_DIR + name, buf); }
    catch (e) { log(`[raw] write ${name} fail: ${e.message}`); }
  } catch (e) { log(`[raw] read fail: ${e.message}`); }
}

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
 * Dictionary<string,string> reader (IL2CPP 64-bit)
 *   Il2CppArray: vtable(0x0) klass(0x8) bounds(0x10) max_length(0x18) data(0x20)
 *   Dictionary fields (in decl order after 16-byte object header):
 *     _buckets@0x10 _entries@0x18 _count@0x20 _freeList@0x24 _freeCount@0x28
 *     _version@0x2C _comparer@0x30 _keys@0x38 _values@0x40 _syncRoot@0x48
 *   Entry<K,V> (0x18): hashCode@0x0 next@0x4 key@0x8 value@0x10
 * ------------------------------------------------------------------------- */
function readDictStringString(dict, capLocal = 8) {
  try {
    if (dict.isNull()) return '(null-dict)';
    const count = dict.add(0x20).readS32();
    const entriesPtr = dict.add(0x18).readPointer();
    if (entriesPtr.isNull() || count <= 0) return '(empty-dict)';
    const elemCount = Number(entriesPtr.add(0x18).readU64());
    const data = entriesPtr.add(0x20);
    const n = Math.min(count, elemCount, capLocal);
    let out = [];
    let shown = 0;
    for (let i = 0; i < n; i++) {
      const entry = data.add(i * 0x18);
      const key = readString(entry.add(0x8));
      if (!key || key === '(null)' || key.indexOf('(null)') === 0 || key === '(badlen') continue;
      const val = readString(entry.add(0x10));
      out.push(`${key}=${val}`);
      shown++;
      if (shown >= capLocal) break;
    }
    const extra = count > shown ? ` (+${count - shown} more)` : '';
    return `${out.join(' | ')}${extra}`;
  } catch (e) {
    return `(dict? ${e.message})`;
  }
}

/* ---------------------------------------------------------------------------
 * Hook table
 * ------------------------------------------------------------------------- */
const HOOKS = [
  { off: 0x6dc9aec, off603: 0x6dca47c, off610: 0x6dde36c, name: 'ApiBase.CreateRequestSignature', tag: 'signature' },
  { off: 0x5ab69ac, off603: 0x5ab733c, off610: 0x5ac9eb8, name: 'ApiBase.ExecuteAsync', tag: 'requests' },
  { off: 0x5ab658c, off603: 0x5ab6f1c, off610: 0x5ac9a98, name: 'ApiBase.ExecuteApiAsync', tag: 'requests' },
  { off: 0x5ab5b48, off603: 0x5ab64d8, off610: 0x5ac9054, name: 'ApiBase.CreateHeader', tag: 'requests' },
  { off: 0x6dc9a6c, off603: 0x6dca3fc, off610: 0x6dde2ec, name: 'ApiBase.CreateRequestId', tag: 'requests' },
  { off: 0x6dc9dc4, off603: 0x6dca754, off610: 0x6dde644, name: 'ApiBase.GetUnixTimestamp', tag: 'requests' },
  { off: 0x8799358, off603: 0x8799ce8, off610: 0x87b0644, name: 'MarshallerFactory.Encrypt', tag: 'encrypt' },
  { off: 0x8799404, off603: 0x8799d94, off610: 0x87b06f0, name: 'MarshallerFactory.Decrypt', tag: 'decrypt' },
  { off: 0x87994d0, off603: 0x8799e60, off610: 0x87b07bc, name: 'MarshallerFactory.CreateAesIV', tag: 'iv' },
  { off: 0x8799704, off603: 0x879a094, off610: 0x87b09f0, name: 'MarshallerFactory.CompressBuffer', tag: 'compress' },
  { off: 0x8799a3c, off603: 0x879a3cc, off610: 0x87b0d28, name: 'MarshallerFactory.DecompressBuffer', tag: 'compress' },
  { off: 0x8799da0, off603: 0x879a730, off610: 0x87b108c, name: 'MarshallerFactory.MD5Hash', tag: 'md5' },
  { off: 0x8799370, off603: 0x8799d00, off610: 0x87b065c, name: 'Crypto.Aes.Encrypt', tag: 'aeslow' },
  { off: 0x8799424, off603: 0x8799db4, off610: 0x87b0710, name: 'Crypto.Aes.Decrypt', tag: 'aeslow' },
  { off: 0x50409c0, off603: 0x5041350, off610: 0x504e410, name: 'Solis.AES.Encrypt', tag: 'aeslow' },
  { off: 0x5040b00, off603: 0x5041490, off610: 0x504e550, name: 'Solis.AES.Decrypt', tag: 'aeslow' },
  { off: 0x8798d58, off603: 0x87996e8, off610: 0x87b0044, name: 'CustomHttpMessageHandler.SendAsync', tag: 'http' },
  { off: 0x46EA260, off603: 0x46eabf0, off610: 0x46f4c24, name: 'Api.CreateCustomHeader', tag: 'headers' },
  { off: 0x5ab6aa8, off603: 0x5ab7438, off610: 0x5ac9fb4, name: 'ApiBase.ExecuteAsync<fsg>', tag: 'requests' },
  { off: 0x5ab6684, off603: 0x5ab7014, off610: 0x5ac9b90, name: 'ApiBase.ExecuteApiAsync<fsg>', tag: 'requests' },
  { off: 0x5ab6008, off603: 0x5ab6998, off610: 0x5ac9514, name: 'ApiBase.CreateHeader<fsg>', tag: 'requests' },
  { off: 0x845db34, off603: 0x845e4c4, off610: 0x8474e20, name: 'Grpc.Metadata.Add', tag: 'headers' },
  { off: 0x845dd6c, off603: 0x845e6fc, off610: 0x8475058, name: 'Grpc.Metadata.Add2', tag: 'headers' }
];
if (GAME_VERSION === '6.0.3') for (const h of HOOKS) h.off = h.off603;
if (GAME_VERSION === '6.1.0') for (const h of HOOKS) h.off = h.off610;

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
          case 'ApiBase.ExecuteApiAsync<fsg>': {
            log(`  API-fsg ${readString(args[1])}`);
            break;
          }
          case 'ApiBase.CreateHeader<fsg>': {
            log(`  HDR-fsg service=${readString(args[2])} method=${readString(args[3])}`);
            break;
          }
          case 'ApiBase.ExecuteAsync<fsg>': {
            log(`  EXEC-fsg service=${readString(args[3])} method=${readString(args[4])} api=${readString(args[5])}`);
            break;
          }
          case 'Grpc.Metadata.Add':
          case 'Grpc.Metadata.Add2': {
            if (TRACE.headers) log(`  META + ${readString(args[1])} = ${readString(args[2])}`);
            break;
          }
          case 'ApiBase.ExecuteAsync': {
            rawCur = `${readString(args[3])}:${readString(args[4])}`;
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
            rawBytes('req-plain', args[1]);   // full request protobuf (no truncation)
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
            fmtBytes(`  IV  in  header  :`, args[2], 160);
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
          case 'Api.CreateCustomHeader': {
            break; // return value dumped onLeave
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
            rawBytes('resp-plain', ret);      // full decrypted response protobuf
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
          case 'Api.CreateCustomHeader': {
            if (TRACE.headers) log(`  HDRS out         : ${readDictStringString(ret, 12)}`);
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
  if (FULLRAW) { /* RAW_DIR pre-created via adb (app cache is SELinux-writable) */ }
  _installed = installPass();
  if (_installed) log('All il2cpp hooks installed.');
}, 500);

})();
