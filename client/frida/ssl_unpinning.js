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
      o.implementation = function () {
        log('checkServerTrusted() -> ACCEPT');
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
setInterval(runNativePass, 3000);

(End of file - total 170 lines)
