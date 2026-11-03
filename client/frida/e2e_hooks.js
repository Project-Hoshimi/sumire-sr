'use strict';
/* e2e_hooks.js — A4 M1-boot E2E instrument window.
 * 1) Reuses the unpin block from combined_hooks.js (Java + native SSL verify).
 * 2) Adds a libc getaddrinfo hook so api.octo-cloud.com resolves to 127.0.0.1
 *    (adb reverse tcp:443 -> host:8443 carries the traffic; game connects :443).
 * Loaded alone:  frida -U -f game.qualiarts.idolypride -l frida/e2e_hooks.js
 */

const START_TS = Date.now();
function ts() { return `${((Date.now() - START_TS) / 1000).toFixed(1)}s`; }
function log(msg) { console.log(`[e2e ${ts()}] ${msg}`); }

/* ================ 1) SSL UNPIN (Java) ================ */
Java.perform(function () {
  log('Java-layer unpin');

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
      log('SSLContext.init() blinded');
      init.call(this, km, blindManagers, sr);
    };
  });
  try {
    Java.use('javax.net.ssl.HttpsURLConnection').setDefaultHostnameVerifier.implementation = function () {
      log('HttpsURLConnection.setDefaultHostnameVerifier() neutralized');
    };
  } catch (e) {}

  function trustAllVerifyChain(TMI) {
    TMI.verifyChain.implementation = function (chain) {
      log('verifyChain() -> ACCEPT');
      return chain;
    };
    TMI.checkServerTrusted.overloads.forEach(function (o) {
      o.implementation = function (chain) {
        log('checkServerTrusted() -> ACCEPT');
        const rt = (o.returnType && o.returnType.className) || '';
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
      o.implementation = function () { log('checkTrustedRecursive() -> ACCEPT'); return null; };
    });
  }
  for (const cls of ['com.android.org.conscrypt.TrustManagerImpl', 'org.conscrypt.TrustManagerImpl']) {
    try { trustAllVerifyChain(Java.use(cls)); log(`Hooked ${cls}`); } catch (e) { log(`${cls} not loaded: ${e.message}`); }
  }
  try {
    const CertificatePinner = Java.use('okhttp3.CertificatePinner');
    CertificatePinner.check.overloads.forEach(function (o) {
      o.implementation = function (host) { log(`CertificatePinner.check(${host}) -> ALLOW`); return; };
    });
    Java.use('okhttp3.CertificatePinner$Builder').add.overloads.forEach(function (o) {
      o.implementation = function () { return this; };
    });
    Java.use('okhttp3.OkHttpClient$Builder').certificatePinner.implementation = function () { return this; };
    log('Hooked okhttp3 pinner');
  } catch (e) { log(`okhttp3 n/a: ${e.message}`); }
  log('Java unpin done');
});

/* ================ 2) NATIVE SSL UNPIN — DIAGNOSE-THEN-BLIND ================ */
let __BLIND = false;      // flip live: touch /tmp/a4e2e_blind on device
const BLIND_FLAGS = ['/tmp/a4e2e_blind', '/data/data/game.qualiarts.idolypride/files/a4e2e_blind'];
const SSL_VERIFY_NONE = 0x00;
const NATIVE_NAMES = ['libmainlinecronet', 'libcronet', 'libunity.so', 'libil2cpp.so', 'libssl.so', 'libboringssl.so'];
const hookedKeys = {};

function mkPtr(v) { return new NativePointer(v); }
function num(v) { try { if (v.isNull()) return -1; return v.readU32(); } catch (e) { return v; } }

let _lastInv = '';
function dumpInventory() {
  const lines = Process.enumerateModules()
    .filter(m => NATIVE_NAMES.some(n => m.name.startsWith(n)) || /ssl|crypt|cronet|boringssl/i.test(m.name))
    .map(m => `  ${m.name} @ ${m.path} base=${m.base} size=${m.size}`)
    .sort();
  const joined = `MODULE INVENTORY (${lines.length}):\n${lines.join('\n')}`;
  if (joined !== _lastInv) { _lastInv = joined; log(joined); }
}

function hookAll(sym) {
  for (const mod of Process.enumerateModules()) {
    if (!NATIVE_NAMES.some(n => mod.name.startsWith(n)) && !/ssl|crypt|cronet/i.test(mod.name)) continue;
    const key = `${mod.path}::${sym}`;
    if (hookedKeys[key]) continue;
    let addr;
    try { addr = mod.findExportByName(sym); } catch (e) { addr = 0; }
    if (!addr) continue;
    hookedKeys[key] = 1;
    try {
      Interceptor.attach(addr, {
        onEnter(args) {
          if (sym.indexOf('set_verify') !== -1) {
            log(`${mod.name}::${sym} mode=${num(args[1])}`);
            if (__BLIND) {
              args[1] = mkPtr(SSL_VERIFY_NONE);
              if (args.length > 2 && args[2] && !args[2].isNull()) args[2] = mkPtr(0);
              log(`${mod.name}::${sym} -> BLINDED (VERIFY_NONE)`);
            }
          }
          if (sym === 'X509_verify_cert' || sym === 'SSL_connect' || sym === 'SSL_do_handshake') {
            log(`${mod.name}::${sym} CALLED`);
          }
        },
        onLeave(ret) {
          if (sym === 'X509_verify_cert') { log(`${mod.name}::X509_verify_cert() rc=${num(ret)}`); if (__BLIND) { log(`-> BLINDED (rc=1)`); return 1; } }
          if (sym === 'SSL_get_verify_result') { log(`${mod.name}::SSL_get_verify_result() rc=${num(ret)}`); if (__BLIND) { log(`-> BLINDED (X509_V_OK)`); return 0; } }
          if (sym === 'SSL_connect' || sym === 'SSL_do_handshake') { log(`${mod.name}::${sym}() rc=${num(ret)}`); }
        }
      });
      log(`hooked ${mod.path}::${sym} @ ${addr}`);
    } catch (e) { log(`hook ${sym} err: ${e.message}`); }
  }
}

function nativePass() {
  for (const s of ['SSL_CTX_set_custom_verify', 'SSL_CTX_set_verify', 'SSL_set_verify',
                   'SSL_set_custom_verify', 'SSL_get_verify_result', 'SSL_connect',
                   'SSL_do_handshake', 'X509_verify_cert']) hookAll(s);
}
dumpInventory();
nativePass();
let _access = null;
setInterval(() => {
  nativePass();
  dumpInventory();
  if (!_access) {
    const libc = Process.enumerateModules().find(m => m.name === 'libc.so');
    if (libc) {
      const a = libc.findExportByName('access');
      if (a) _access = new NativeFunction(a, 'int', ['pointer', 'int']);
    }
  }
  if (_access) {
    try {
      // /tmp exists on the Pixel (Magisk); the emulator has no /tmp, so it uses the app's files dir
      const hit = BLIND_FLAGS.some(p => { const s = Memory.allocUtf8String(p); return _access(s, 0) === 0; });
      if (hit && !__BLIND) { __BLIND = true; log('>>> BLIND TRIGGERED by blind flag file'); blindYaha(); }
      if (!hit && __BLIND) { __BLIND = false; log('>>> BLIND OFF (blind flag removed)'); }
    } catch (e) { log(`blind poll err: ${e.message}`); }
  }
}, 3000);

/* ================ 2b) YAHA (rustls + webpki) verifier diagnostics + blind ================
 * API stack = libCysharp...YetAnotherHttpHandler.Native.so (Rust: rustls + webpki + ring).
 * ELF load bias == module.base (file_off = vaddr-0x4000) — verified. We hook the
 * verifier entry points by vaddr to learn which one rustls actually calls, then
 * blind by overwriting the verifier with the game's own accept-all stub
 * (NoCertificateVerification::verify_server_cert):
 *     mov w9, #0x14 ; strb w9, [x8] ; ret       (writes Ok discriminant to sret x8)
 */
const YAHA_FUNCS = [
  { name: 'CustomCertVerifier.verify_server_cert',       off: 0x197fc8, verifier: true },
  { name: 'WebPkiServerVerifier.verify_server_cert',     off: 0x201f04, verifier: true },
  { name: 'WebPkiServerVerifier.verify_tls12_signature', off: 0x2023e0, verifier: true },
  { name: 'WebPkiServerVerifier.verify_tls13_signature', off: 0x2023fc, verifier: true },
  { name: 'NoCertVerifier.verify_server_cert',           off: 0x19f4ec, verifier: false },
  { name: 'supported_verify_schemes(custom)',            off: 0x19807c, verifier: false },
  { name: 'yaha.add_root_certificates',                  off: 0x18ae14, verifier: false },
  { name: 'yaha.set_server_cert_verification_handler',   off: 0x18b388, verifier: false },
  { name: 'yaha.init_context',                           off: 0x18abac, verifier: false },
  { name: 'rustls.process_new_packets',                  off: 0x133b98, verifier: false },
  { name: 'rustls.send_fatal_alert',                     off: 0x1b7868, verifier: false }
];
let _yaha = null;
let _yahaHooked = false;
let _yahaBlinded = false;
const _yahaLoggers = {};

function yahaModule() {
  if (!_yaha) _yaha = Process.enumerateModules().find(m => /YetAnotherHttpHandler/i.test(m.name));
  return _yaha;
}

function hookYaha() {
  if (_yahaHooked) return;
  const mod = yahaModule();
  if (!mod) return;
  for (const f of YAHA_FUNCS) {
    const target = mod.base.add(f.off);
    try {
      _yahaLoggers[f.off] = Interceptor.attach(target, {
        onEnter(args) {
          try {
            this.sret = this.context.x8; // sret pointer for verify_server_cert / signature fns
            if (f.name === 'rustls.send_fatal_alert') log(`YAHA ${f.name} desc=${args[1].toInt32()}`);
            else log(`YAHA ${f.name} CALLED`);
          } catch (e) { log(`YAHA ${f.name} (arg err)`); }
        },
        onLeave(ret) {
          try {
            if (f.verifier && __BLIND && this.sret && !this.sret.isNull()) {
              this.sret.writeU8(0x14); // rustls Ok discriminant
              log(`YAHA ${f.name} -> FORCED OK (0x14)`);
            }
          } catch (e) { log(`YAHA ${f.name} onLeave err: ${e.message}`); }
        }
      });
    } catch (e) { log(`YAHA hook ${f.name} err: ${e.message}`); }
  }
  _yahaHooked = true;
  log('YAHA verifier hooks installed');
}

const ACCEPT_STUB = [0x52800289, 0x39000109, 0xd65f03c0]; // mov w9,#0x14; strb w9,[x8]; ret

function patchAccept(target) {
  try {
    Memory.protect(target, 0x10, 'rwx');
    target.writeU32(ACCEPT_STUB[0]);
    target.add(4).writeU32(ACCEPT_STUB[1]);
    target.add(8).writeU32(ACCEPT_STUB[2]);
    log(`PATCHED accept-stub @ ${target}`);
  } catch (e) { log(`patch err @ ${target}: ${e.message}`); }
}

function blindYaha() {
  // Blind is enforced in each verifier hook's onLeave (forces rustls Ok 0x14).
  // No memory patching -> avoids racing module load vs the verify call.
  if (_yahaBlinded) return;
  const mod = yahaModule();
  if (!mod) { log('blindYaha: YAHA module not loaded yet (onLeave force will apply once hooked)'); return; }
  _yahaBlinded = true;
  log('>>> YAHA verifiers BLINDED (onLeave force OK)');
}

hookYaha();
setInterval(hookYaha, 3000);

/* ================ 3) DNS REDIRECT (api.octo-cloud.com -> 127.0.0.1) ================ */
const REDIRECT = {
  'api.octo-cloud.com': '127.0.0.1',
  'api.game-idolypride.jp': '127.0.0.1',
};

function hookGetaddrinfo() {
  const libc = Process.enumerateModules().find(m => m.name === 'libc.so');
  if (!libc) return;
  try {
    const ga = libc.findExportByName('getaddrinfo');
    if (!ga) return;
    // struct addrinfo (LP64): ai_family @+4, ai_addr @+24, ai_next @+40
    function rewriteEntry(ai) {
      const family = ai.add(4).readU32();
      const sa = ai.add(24).readPointer();
      if (sa.isNull()) return;
      if (family === 2) {          // AF_INET
        sa.add(4).writeU32(0x0100007f); // 127.0.0.1
      } else if (family === 10) {  // AF_INET6
        for (let i = 0; i < 15; i++) sa.add(8 + i).writeU8(0);
        sa.add(23).writeU8(1);     // ::1
      }
    }
    Interceptor.attach(ga, {
      onEnter(args) {
        try {
          const node = args[0].isNull() ? '' : args[0].readCString();
          this.node = node;
          this.redirect = node && REDIRECT[node] ? REDIRECT[node] : null;
          this.ppRes = this.redirect ? args[3] : null; // out param: struct addrinfo **
          try { const m = Process.findModuleByAddress(this.returnAddress); this.caller = m ? m.name : String(this.returnAddress); } catch (e) { this.caller = '?'; }
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
            log(`getaddrinfo(${this.node}) -> 127.0.0.1 (${n} entries) caller=${this.caller}`);
          } catch (e) { log(`dns rewrite err: ${e.message}`); }
        }
      }
    });
    log('hooked libc getaddrinfo');
  } catch (e) { log(`getaddrinfo hook err: ${e.message}`); }
}
hookGetaddrinfo();

/* ================ 4) CONNECT logger (libc connect) ================ */
function hookConnect() {
  const libc = Process.enumerateModules().find(m => m.name === 'libc.so');
  if (!libc) return;
  try {
    const cz = libc.findExportByName('connect');
    if (!cz) return;
    const ntohs = (b) => ((b & 0xff) << 8) | ((b >> 8) & 0xff);
    Interceptor.attach(cz, {
      onEnter(args) {
        try {
          const sa = args[1];
          if (sa.isNull()) return;
          const fam = sa.readU16();
          let dst = '?', port = -1;
          if (fam === 2) { // AF_INET
            port = ntohs(sa.add(2).readU16());
            const a = sa.add(4).readU8(), b = sa.add(5).readU8(), c = sa.add(6).readU8(), d = sa.add(7).readU8();
            dst = `${a}.${b}.${c}.${d}`;
          } else if (fam === 10) { // AF_INET6
            port = ntohs(sa.add(2).readU16());
            const by = [];
            for (let i = 0; i < 16; i++) by.push(sa.add(8 + i).readU8().toString(16).padStart(2, '0'));
            dst = by.join('');
          } else { return; }
          let caller = '?';
          try { const m = Process.findModuleByAddress(this.returnAddress); caller = m ? m.name : String(this.returnAddress); } catch (e) {}
          // The Rust YAHA (rustls/hyper) stack ignores our getaddrinfo rewrite
          // and connects straight to the DNS-resolved official IP. Rewrite its
          // AF_INET :443 socket to loopback so adb-reverse (device:443 ->
          // host:8443) delivers the API traffic to our server.
          // Redirect API traffic to loopback (adb reverse device:443 -> host:8443).
          // - YAHA (rustls) ignores the getaddrinfo rewrite entirely.
          // - libunity/UnityWebRequest reads the *real* DNS answer despite our
          //   getaddrinfo rewrite (observed: getaddrinfo -> 127.0.0.1, then
          //   connect(35.221.155.103)), and it fetches the master partitions from
          //   api.game-idolypride.jp/master/... (our rewritten Master:Get URLs),
          //   so it must be redirected too. Match the game hosts by IP.
          // Also api.octo-cloud.com (130.211.5.37) - the Octo asset-catalog
          // service; our server proxies /v2/* upstream (proxyHandler).
          const GAME_IPS = { '35.221.155.103': 1, '34.120.154.49': 1, '34.102.172.238': 1, '130.211.5.37': 1 };
          const isYaha = caller.indexOf('YetAnotherHttpHandler.Native') >= 0;
          if (fam === 2 && port === 443 && dst !== '127.0.0.1' &&
              (isYaha || GAME_IPS[dst])) {
            sa.add(4).writeU32(0x0100007f);
            log(`connect REDIRECT ${dst}:${port} -> 127.0.0.1:${port} caller=${caller}`);
          }
          if (port === 443 || port === 8443 || dst.startsWith('127.') || dst === '00000000000000000000000000000001') {
            log(`connect(${dst}:${port}) caller=${caller}`);
          }
        } catch (e) {}
      }
    });
    log('hooked libc connect');
  } catch (e) { log(`connect hook err: ${e.message}`); }
}
hookConnect();

/* ================ 5) UNITY CertificateHandler BYPASS ================
 * The api.octo-cloud.com TLS connection that sends fatal alert 49 is made by
 * Unity's UnityWebRequest stack: bundled libcurl/8.10.1-DEV + mbedTLS
 * ("unitytls", External/unitytls/.../Mbedtls.inl.h) statically linked in
 * libunity.so. mbedTLS does not consult libssl/conscrypt, so the native SSL
 * hooks above never fire for it. Unity routes its verification result through
 * the managed CertificateHandler:
 *   UnityEngine.Networking.CertificateHandler.ValidateCertificate      RVA 0x91DED94 (slot 4)
 *   UnityEngine.Networking.CertificateHandler.ValidateCertificateNative RVA 0x91DED9C ([RequiredByNativeCode])
 * Force both to return true. Also log Api.GetSSLRootCertificates (RVA 0x46E9F8C)
 * which supplies the gRPC/YAHA (rustls) root bundle.
 */
function readManagedString(ptr) {
  try {
    if (!ptr || ptr.isNull()) return '(null)';
    const len = ptr.add(0x10).readU32();
    if (len === 0 || len > 0x100000) return `(badlen ${len})`;
    let out = '';
    const n = Math.min(len, 200);
    for (let i = 0; i < n; i++) {
      const cp = ptr.add(0x14 + i * 2).readU16();
      out += (cp >= 0x20 && cp < 0x7f) ? String.fromCharCode(cp) : (cp === 10 ? '\\n' : '.');
    }
    return `${out}${len > n ? '…' : ''} (len=${len})`;
  } catch (e) { return `(str? ${e.message})`; }
}

const CERT_HOOKS = [
  { off: 0x91DED94, name: 'CertificateHandler.ValidateCertificate', force: true },
  { off: 0x91DED9C, name: 'CertificateHandler.ValidateCertificateNative', force: true },
  { off: 0x46E9F8C, name: 'Api.GetSSLRootCertificates', force: false },
];
let _certHooked = false;
function hookCertHandlers() {
  if (_certHooked) return;
  const mod = Process.enumerateModules().find(m => m.name === 'libil2cpp.so');
  if (!mod) return;
  for (const h of CERT_HOOKS) {
    if (h.done) continue;
    const target = mod.base.add(h.off);
    try {
      Interceptor.attach(target, {
        onEnter(args) {
          log(`CERT ${h.name} called`);
          if (h.force) {
            try {
              const len = args[1].add(0x18).readU64();
              log(`CERT ${h.name} certData bytes=${len}`);
            } catch (e) {}
          }
        },
        onLeave(ret) {
          if (h.force) {
            log(`CERT ${h.name} rc=${ret} -> FORCE true`);
            try { ret.replace(mkPtr(1)); } catch (e) { log(`CERT force err: ${e.message}`); }
          } else {
            log(`CERT ${h.name} -> ${readManagedString(ret)}`);
          }
        }
      });
      h.done = true;
      log(`hooked ${h.name} @ ${target} (vaddr 0x${h.off.toString(16)})`);
    } catch (e) { log(`CERT hook ${h.name} err: ${e.message}`); }
  }
  _certHooked = CERT_HOOKS.every(h => h.done);
}
hookCertHandlers();
setInterval(hookCertHandlers, 1000);

/* ================ 6) libunity.so native mbedTLS TLS bypass ================
 * The managed CertificateHandler hooks never fired, so the api.octo-cloud.com
 * UnityWebRequest/mbedTLS handshake aborts natively inside libunity.so with
 * fatal alert 49 (access_denied) during mbedtls_ssl_parse_certificate.
 *
 * Confirmed vaddrs (aarch64, stripped libunity.so):
 *   0x9b5bd4  mbedtls_ssl_parse_certificate ENTRY
 *   0x9b64e0  candidate mbedtls_x509_crt_verify called from parse_certificate
 *   0x969af8  Unity mbedtls_ssl_get_verify_result wrapper
 *   0xf36d48  real verify-result getter (returns code in w0)
 *   0x15046d8 global (runtime ptr) used by parse_certificate; [g+0x30]=f_vrfy cb
 *
 * Forcing is toggled by device files so experiments need no re-edit:
 *   /tmp/a4u_f_parse    -> force 0x9b64e0 ret 0
 *   /tmp/a4u_f_verify   -> force 0xf36d48 ret 0
 *   /tmp/a4u_f_wrapper  -> force 0x969af8 ret 0
 */
// Each /tmp flag is also honoured in the app's files dir (the emulator has no /tmp).
function devFlag(p) {
  const paths = [p];
  if (p.startsWith('/tmp/')) paths.push('/data/data/game.qualiarts.idolypride/files/' + p.slice(5));
  return paths.some(q => { try { const f = new File(q, 'r'); f.close(); return true; } catch (e) { return false; } });
}
const UNITY_HOOKS = [
  { off: 0x9b5bd4, name: 'mbedtls_ssl_parse_certificate', force: false },
  { off: 0x9b64e0, name: 'mbedtls_x509_crt_verify?', flag: '/tmp/a4u_f_parse' },
  { off: 0x966c5c, name: 'mbedtls_ssl_conf_verify f_vrfy cb', flag: '/tmp/a4u_f_cb' },
  { off: 0x969da4, name: 'unitytls x509verify (global+0xd8)', flag: '/tmp/a4u_f_cb' },
  { off: 0x969af8, name: 'ssl_get_verify_result(wrapper)', flag: '/tmp/a4u_f_wrapper' },
  { off: 0xf36d48, name: 'ssl_get_verify_result(real)', flag: '/tmp/a4u_f_verify' },
];
let _unityHooked = false;
function hookUnityTls() {
  if (_unityHooked) return;
  const mod = Process.enumerateModules().find(m => m.name === 'libunity.so');
  if (!mod) return;
  log(`libunity.so base=${mod.base} size=${mod.size}`);
  const glob = mod.base.add(0x15046d8);
  for (const h of UNITY_HOOKS) {
    if (h.done) continue;
    const target = mod.base.add(h.off);
    try {
      Interceptor.attach(target, {
        onEnter(args) {
          let callOff = '?';
          try {
            const ra = this.returnAddress;
            callOff = ra.sub(mod.base).toString(16);
          } catch (e) {}
          log(`UNITY ${h.name} called x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]} caller=libunity+0x${callOff}`);
          if (h.off === 0x9b5bd4) {
            try {
              const g = glob.readPointer();
              log(`UNITY parse_cert global[0x15046d8]=${g}`);
              if (!g.isNull()) {
                log(`UNITY parse_cert g+0x10=${g.add(0x10).readPointer()} g+0xd8=${g.add(0xd8).readPointer()} g+0x58=${g.add(0x58).readPointer()} g+0x108=${g.add(0x108).readPointer()}`);
              }
            } catch (e) { log(`UNITY parse_cert glob err: ${e.message}`); }
          }
          if (h.off === 0x969da4) { try { this.rstruct = args[1]; } catch (e) {} }
          if (h.off === 0x966c5c) {
            try {
              const fl = args[3].readU32();
              log(`UNITY f_vrfy cb depth=${args[2].toInt32()} flags=0x${fl.toString(16)}`);
              if (devFlag(h.flag)) { args[3].writeU32(0); log(`UNITY f_vrfy flags CLEARED -> 0`); }
            } catch (e) { log(`UNITY f_vrfy err: ${e.message}`); }
          }
        },
        onLeave(ret) {
          if (h.flag) {
            const on = devFlag(h.flag);
            log(`UNITY ${h.name} rc=${ret}${on ? ' -> FORCE 0' : ''}`);
            if (on) {
              try { ret.replace(mkPtr(0)); } catch (e) { log(`UNITY force err: ${e.message}`); }
              if (h.off === 0x969da4 && this.rstruct && !this.rstruct.isNull()) {
                try { this.rstruct.add(4).writeU32(0); this.rstruct.add(8).writeU32(0); log(`UNITY x509verify state CLEARED`); } catch (e) {}
              }
            }
          } else {
            log(`UNITY ${h.name} rc=${ret}`);
          }
        }
      });
      h.done = true;
      log(`hooked ${h.name} @ ${target} (vaddr 0x${h.off.toString(16)})`);
    } catch (e) { log(`UNITY hook ${h.name} err: ${e.message}`); }
  }
  _unityHooked = UNITY_HOOKS.every(h => h.done);
}
hookUnityTls();
setInterval(hookUnityTls, 1000);

/* ================ 7) YAHA/rustls trust — append our CA to Api.GetSSLRootCertificates ================
   ApiBase.CreateHttpMessageHandler(sslRootCertificates,...) feeds YAHA (rustls/webpki) custom roots.
   Api.GetSSLRootCertificates (libil2cpp Slot 31, RVA 0x46E9F8C) returns the Mozilla PEM bundle.
   We append our server CA so rustls trusts https://api.octo-cloud.com (our Fastify :8443). */
const OUR_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUOAyUvuVwRi3y/rYhb+NxXMweiakwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSSWRvbHkgUHJpZGUgRGV2IENBMB4XDTI2MTAwNzA3MTkw
OVoXDTM2MTAwNDA3MTkwOVowHTEbMBkGA1UEAwwSSWRvbHkgUHJpZGUgRGV2IENB
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5j0Fj/AeRxTGQflgzQr
v8DbJTgxJLySKAUn1rmzvK0EzOO9Z8Dr1JD4dA2t8/eYdEwv7adMBGL77pIAB0h8
XH3xcpuL8USyY04oTL6pCm7Hv32YyDFX/r2Y2hJCxmlCuWgPgw3LCItXYTNcLTdg
fUw4kuPPUARizHbjMgP0t3d/0fHwtEB48fPvfRWJHJe4cXs4zvANesT36lKgLo40
9P2BbGWQmSzTaTp6StmSj5lw5kWhugMmSe0CM5/yQIGvVA+DTlQ3bQ3T1hdLzQBL
MEt7u76ZQ5TTNG2SIUSB788CsIxc7VrAzCE+uS1TBolyIOoNh9eJiKlUsrIqbEUh
PQIDAQABo2MwYTAdBgNVHQ4EFgQUzhYWJWVMkvs6ly6iETbEmtMFjLwwHwYDVR0j
BBgwFoAUzhYWJWVMkvs6ly6iETbEmtMFjLwwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBABKuLsOyCrzQGP3VwhfqYrt2
Tgmz5fCZrinXoJOnyFqn7rndUAMRwfUKgd+0NVE8S/gDq3nJYAfPf7OMzFtya3Xh
DaOno8ppPgXueUKY4KWUIKLyfinlceCG3htfpMeDfKv5X/yQVwEjPbxEjEQ4bVpl
S5sfuPFvaAG87RG88uTEp+EXwAzq52z2drRu5FbnfBR99J4GYvGUO7AM2hPPAsJ9
Cww6NE7MBypiPtclQlalqkVHQ9ChYdq/B5ThyAZOKaX9Sa6J4FY67Ig4Z3ZH4Y3W
6cSaUGwbz11KoAKyWYEVBGlQwCWO5rAiAKUWNkNjzbj7IK1V5gRcbX+DORk/LhE=
-----END CERTIFICATE-----`;
const IL2CPP_STR_NEW_RVA = 0x41947d8;
const GET_SSL_ROOTS_RVA = 0x46E9F8C;
const OUR_CA_TAG = OUR_CA_PEM.trim().slice(-48);
let _sslRootsHooked = false;
function hookSslRoots() {
  if (_sslRootsHooked) return;
  let mod;
  try { mod = Process.getModuleByName('libil2cpp.so'); } catch (e) { return; }
  try {
    const strNew = new NativeFunction(mod.base.add(IL2CPP_STR_NEW_RVA), 'pointer', ['pointer']);
    const readStr = (s) => s.add(0x14).readUtf16String(s.add(0x10).readS32());
    Interceptor.attach(mod.base.add(GET_SSL_ROOTS_RVA), {
      onEnter() { log('SSLROOTS Api.GetSSLRootCertificates called'); },
      onLeave(ret) {
        try {
          const s = ret;
          if (s.isNull()) { log('SSLROOTS ret null'); return; }
          const orig = readStr(s);
          if (orig.indexOf('BEGIN CERTIFICATE') < 0) { log(`SSLROOTS non-pem len=${orig.length}`); return; }
          if (orig.indexOf(OUR_CA_TAG) >= 0) { log('SSLROOTS our CA already present, skip'); return; }
          const combined = OUR_CA_PEM + '\n' + orig + '\n';
          const ns = strNew(Memory.allocUtf8String(combined));
          ret.replace(ns);
          log(`SSLROOTS prepended our CA: origLen=${orig.length} newLen=${combined.length}`);
        } catch (e) { log(`SSLROOTS err: ${e.message}`); }
      }
    });
    _sslRootsHooked = true;
    log(`hooked Api.GetSSLRootCertificates @ ${mod.base.add(GET_SSL_ROOTS_RVA)} (vaddr 0x${GET_SSL_ROOTS_RVA.toString(16)})`);
  } catch (e) { log(`SSLROOTS hook err: ${e.message}`); }
}
hookSslRoots();
setInterval(hookSslRoots, 1000);

/* ================ 8) gRPC channel host discovery ================
   ApiBase<T>.CreateChannel(string channelHost) RVA 0x6DC8490 (slot 28);
   Api.GetHost() RVA 0x46E9EB0 (slot 25). Log the managed strings so we learn the
   exact host YAHA/rustls uses (api.octo-cloud.com vs an IP literal). */
const HOST_HOOKS = [
  { off: 0x6DC8490, name: 'ApiBase.CreateChannel', arg: 1, onLeave: false },
  { off: 0x46E9EB0, name: 'Api.GetHost',           arg: 0, onLeave: true  },
];
let _hostHooked = false;
function hookHosts() {
  if (_hostHooked) return;
  let mod;
  try { mod = Process.getModuleByName('libil2cpp.so'); } catch (e) { return; }
  for (const h of HOST_HOOKS) {
    try {
      Interceptor.attach(mod.base.add(h.off), {
        onEnter(args) { this.args = args; if (!h.onLeave) { try { log(`HOST ${h.name}(...) arg=${readManagedString(args[h.arg])}`); } catch (e) { log(`HOST ${h.name} err ${e.message}`); } } },
        onLeave(ret) { if (h.onLeave) { try { log(`HOST ${h.name}() -> ${readManagedString(ret)}`); } catch (e) { log(`HOST ${h.name} err ${e.message}`); } } },
      });
      log(`hooked ${h.name} @ ${mod.base.add(h.off)} (vaddr 0x${h.off.toString(16)})`);
    } catch (e) { log(`HOST hook ${h.name} err: ${e.message}`); }
  }
  _hostHooked = true;
}
hookHosts();
setInterval(hookHosts, 1000);

/* ================ 9) inspect sslRootCertificates passed to YAHA ================ */
const CREATE_HTTP_HANDLER_RVA = 0x6DC8698; // ApiBase<T>.CreateHttpMessageHandler(string sslRootCertificates, int,int,bool)
let _chhHooked = false;
function hookCreateHttpHandler() {
  if (_chhHooked) return;
  let mod;
  try { mod = Process.getModuleByName('libil2cpp.so'); } catch (e) { return; }
  try {
    Interceptor.attach(mod.base.add(CREATE_HTTP_HANDLER_RVA), {
      onEnter(args) {
        try {
          const s = args[1];
          if (!s || s.isNull()) { log('CHH sslRootCertificates=null'); return; }
          const len = s.add(0x10).readU32();
          const full = s.add(0x14).readUtf16String(len);
          const hasTag = full.indexOf(OUR_CA_TAG) >= 0;
          log(`CHH sslRootCertificates len=${len} hasOurCA=${hasTag} tail=${JSON.stringify(full.slice(-40))}`);
        } catch (e) { log(`CHH err ${e.message}`); }
      },
    });
    log('hooked ApiBase.CreateHttpMessageHandler');
  } catch (e) { log(`CHH hook err: ${e.message}`); }
  _chhHooked = true;
}
const CERT_DIAG = devFlag('/tmp/a4e2e_diag');
if (CERT_DIAG) {
  hookCreateHttpHandler();
  setInterval(hookCreateHttpHandler, 1000);
} else {
  log('section 9 (CHH sslRoots diag) disabled (touch /tmp/a4e2e_diag to enable)');
}

/* ================ 10) native YAHA root-cert consumption ================ */
const YAHA_NATIVE = 'libCysharp.Net.Http.YetAnotherHttpHandler.Native.so';
const SET_ROOTCERTS_RVA = 0x5A2E86C; // YetAnotherHttpHandler.set_RootCertificates(string)
let _yahaMgdHooked = false, _yahaNatHooked = false;

function hexdumpCString(p, max) {
  try {
    let out = '';
    for (let i = 0; i < max; i++) { const b = p.add(i).readU8(); if (b === 0) break; out += String.fromCharCode(b); }
    return out;
  } catch (e) { return `<err:${e.message}>`; }
}

function hookYahaNative() {
  if (_yahaNatHooked) return;
  let m; try { m = Process.getModuleByName(YAHA_NATIVE); } catch (e) { return; }
  let exps; try { exps = m.enumerateExports(); } catch (e) { log(`YAHA enum err: ${e.message}`); return; }
  let n = 0;
  for (const e of exps) {
    if (e.type !== 'function' || e.name.indexOf('yaha_') !== 0) continue;
    try {
      const nm = e.name;
      Interceptor.attach(e.address, {
        onEnter(args) {
          this.args = args;
          if (nm === 'yaha_client_config_add_root_certificates') {
            let info = '';
            try {
              const v = args[1];
              const dp = v.readPointer();
              const len = v.add(8).readU64();
              info = `dataPtr=${dp} len=${len}`;
              if (len > 200 && len < 2000000) {
                const n = Number(len);
                const u8 = new Uint8Array(dp.readByteArray(n));
                let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                const beg = (s.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
                const end = (s.match(/-----END CERTIFICATE-----/g) || []).length;
                info += ` begins=${beg} ends=${end} hasOurCA=${s.indexOf(OUR_CA_TAG) >= 0} head=${JSON.stringify(s.slice(0, 28))} tail=${JSON.stringify(s.slice(-28))}`;
              }
            } catch (err) { info = `err:${err.message}`; }
            log(`YAHA ${nm}(x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]}) ${info}`);
          } else {
            log(`YAHA ${nm}(x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]})`);
          }
        },
        onLeave(ret) { if (nm === 'yaha_client_config_add_root_certificates' || nm === 'yaha_build_client') log(`YAHA ${nm} -> ${ret}`); },
      });
      n++;
    } catch (err) { log(`YAHA attach ${e.name} err: ${err.message}`); }
  }
  _yahaNatHooked = true;
  log(`hooked ${n} native yaha_* exports`);
}

function hookYahaManaged() {
  if (_yahaMgdHooked) return;
  let mod; try { mod = Process.getModuleByName('libil2cpp.so'); } catch (e) { return; }
  try {
    Interceptor.attach(mod.base.add(SET_ROOTCERTS_RVA), {
      onEnter(args) {
        hookYahaNative(); // ensure native hooks are live before config is built
        try {
          const s = args[1];
          const len = s.add(0x10).readU32();
          const full = s.add(0x14).readUtf16String(len);
          log(`YAHA set_RootCertificates len=${len} hasOurCA=${full.indexOf(OUR_CA_TAG) >= 0}`);
        } catch (e) { log(`YAHA set_RootCertificates err ${e.message}`); }
      },
    });
    _yahaMgdHooked = true;
    log('hooked YetAnotherHttpHandler.set_RootCertificates');
  } catch (e) { log(`YAHA managed hook err: ${e.message}`); }
}


function hookDlopen() {
  let libc; try { libc = Process.getModuleByName('libc.so'); } catch (e) { log(`dlopen hook: no libc ${e.message}`); return; }
  for (const nm of ['android_dlopen_ext', 'dlopen']) {
    let a; try { a = libc.getExportByName(nm); } catch (e) { continue; }
    try {
      Interceptor.attach(a, {
        onEnter(args) { try { this.path = args[0].isNull() ? null : args[0].readCString(); } catch (e) { this.path = null; } },
        onLeave(ret) {
          if (this.path && this.path.indexOf('YetAnotherHttpHandler') >= 0) {
            log(`dlopen(${this.path}) -> installing native yaha hooks synchronously`);
            hookYahaNative();
          }
        },
      });
      log(`hooked ${nm} for YAHA load detection`);
    } catch (e) { log(`attach ${nm} err: ${e.message}`); }
  }
}
if (CERT_DIAG) {
  hookDlopen();
  hookYahaManaged(); hookYahaNative();
  setInterval(() => { hookYahaManaged(); hookYahaNative(); }, 200);
} else {
  log('section 10 (native yaha_* diag) disabled (touch /tmp/a4e2e_diag to enable)');
}

/**
 * LOVE REPLAY BYPASS
 * The client's LoveEpisodeListScreenPresenter marks episodes below the latest
 * unlocked one as Cleared and refuses to replay them. Patch the IL2CPP
 * read-status helper so every episode is reported New (0) -> selectable.
 * RVA from Il2CppDumper script.json:
 *   Solis.OutGame.LoveEpisodeListScreenPresenter/<>c__DisplayClass9_0::
 *     <SetItemModels>g__GetLoveStoryReadStatus|3   (returns LoveStoryReadStatus)
 */
const LOVE_READ_STATUS_RVA = 0x581DD08;
let _loveReplayHooked = false;
function hookLoveReplay() {
  if (_loveReplayHooked) return;
  let mod; try { mod = Process.getModuleByName('libil2cpp.so'); } catch (e) { return; }
  try {
    Interceptor.attach(mod.base.add(LOVE_READ_STATUS_RVA), {
      onLeave(ret) {
        try { ret.replace(0); } catch (e) {}
      },
    });
    _loveReplayHooked = true;
    log('hooked love read-status -> always New (chapter replay enabled)');
  } catch (e) { log(`love replay hook err: ${e.message}`); }
}
hookLoveReplay();
setInterval(hookLoveReplay, 1000);

log('e2e_hooks loaded');