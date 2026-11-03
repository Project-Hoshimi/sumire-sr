import { encrypt, decrypt } from './gateway/crypto.ts';
import { loadCorpus } from './services/replay/corpus.ts';

const BASE = 'https://127.0.0.1:8443';
const enc = new TextEncoder();

async function main() {
  const corpus = loadCorpus();
  const picks = ['System:Check', 'User:Get', 'Home:Enter', 'Auth:Login', 'Master:Get', 'Quest:Top'];
  let passed = 0;
  let failed = 0;
  for (const name of picks) {
    const entry = corpus.get(name);
    if (!entry || !entry.request) { console.log(`${name}: no req entry`); continue; }
    const [svc, m] = name.split(':');
    const url = `${BASE}/api.${svc}/${m}`;
    const frame = encrypt(entry.request, Buffer.from('cb'));
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': 't' },
      body: frame,
    });
    if (resp.status !== 200) { console.log(`${name}: HTTP ${resp.status}`); failed++; continue; }
    const body = Buffer.from(await resp.arrayBuffer());
    const plain = decrypt(body);
    const ok = plain.equals(entry.response);
    const ct = resp.headers.get('content-type');
    const st = resp.headers.get('x-server-time');
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ct=${ct} x-server-time=${st !== null} ${plain.length}B`);
    ok ? passed++ : failed++;
  }
  console.log(`h2 tls boot test: ${passed} passed, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });