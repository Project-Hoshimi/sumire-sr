import Fastify from 'fastify';
import { buildServer } from './server.ts';
import { encrypt, decrypt } from './gateway/crypto.ts';
import { mintToken } from './auth/jwt.ts';

const app = buildServer();
await app.listen({ port: 18099, host: '127.0.0.1' });

const token = mintToken({ sub: 'account-test-1', seedId: 'dev-seed' });

// SystemCheckRequest: field1 FirebaseIDToken = "test-token"
const reqPlain = Buffer.from([0x0a, 0x0a, ...Buffer.from('test-token')]);
const reqFrame = encrypt(reqPlain, Buffer.from('0000000000000001'));

const res = await fetch('http://127.0.0.1:18099/api.System/Check', {
  method: 'POST',
  headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': token },
  body: reqFrame,
});
const respPlain = decrypt(Buffer.from(await res.arrayBuffer()));
console.log('status:', res.status);
console.log('x-server-time:', res.headers.get('x-server-time'));
console.log('resp plaintext hex:', respPlain.toString('hex'));

// bad token -> still 200 (System:Check is open/guest); used later for gated endpoints
const resBad = await fetch('http://127.0.0.1:18099/api.System/Check', {
  method: 'POST',
  headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': 'not.a.jwt' },
  body: reqFrame,
});
console.log('bad-token status:', resBad.status);

await app.close();