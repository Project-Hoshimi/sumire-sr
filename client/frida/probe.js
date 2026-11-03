const mods = Process.enumerateModules();
const wanted = /unity|il2cpp|cronet/i;
const symbols = ['SSL_CTX_set_verify', 'SSL_CTX_set_custom_verify', 'SSL_set_verify', 'SSL_set_custom_verify', 'X509_verify_cert', 'SSL_CTX_set_default_verify_paths'];
for (const m of mods) {
  if (!wanted.test(m.name)) continue;
  console.log(`== ${m.name} base=${m.base} size=${m.size}`);
  let exported = 0;
  for (const s of symbols) {
    try {
      const a = m.findExportByName(s);
      if (a) { console.log(`   EXPORT ${s} = ${a}`); exported++; }
    } catch (e) { console.log(`   err ${s}: ${e}`); }
  }
  // count total exports
  const all = m.enumerateExports();
  console.log(`   total exports: ${all.length}`);
  const matching = all.filter(e => /ssl|x509|verify|cert|custom/i.test(e.name));
  if (matching.length) {
    for (const e of matching.slice(0, 30)) console.log(`   sym ${e.name} = ${e.address}`);
  }
}

(End of file - total 21 lines)
