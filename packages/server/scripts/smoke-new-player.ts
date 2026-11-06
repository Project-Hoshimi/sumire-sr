// New-player smoke test: with the published data repo mounted at
// SUMIRE_DATA_DIR, sandbox Auth:Create, the real Firebase-token login flow,
// User:Get, Home:Login and Home:Enter must all succeed against a freshly
// migrated database. Works from both the private tree and the public export.
import '../src/env.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from '../src/gateway/crypto.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';

const PORT = Number(process.env.PORT || 18100);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 30_000;

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

function die(message: string): never {
  console.error(`smoke-new-player: ${message}`);
  process.exit(2);
}

if (!process.env.WIRE_SEC_KEY) die('WIRE_SEC_KEY is required');
if (!process.env.DATABASE_URL) die('DATABASE_URL is required');
if (process.env.SUMIRE_PROFILE !== 'sandbox') {
  die('refusing to run outside the sandbox profile (set SUMIRE_PROFILE=sandbox)');
}
if (!process.env.SUMIRE_DATA_DIR) die('SUMIRE_DATA_DIR is required');

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
function redact(text: string): string {
  return text.replace(JWT_RE, '<redacted-jwt>');
}

let output = '';
function append(chunk: Buffer): void {
  output += chunk.toString('utf8');
}

function fail(message: string): never {
  console.error(`smoke-new-player: ${message}`);
  const lines = output.split('\n');
  console.error('--- last 40 lines of server output ---');
  console.error(redact(lines.slice(-40).join('\n')));
  process.exit(1);
}

function waitForPort(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      if (err) reject(err);
      else resolve();
    };
    const onExit = (code: number | null) => {
      finish(new Error(`server exited before listening (code ${code})`));
    };
    child.once('exit', onExit);

    const attempt = () => {
      if (settled) return;
      if (Date.now() > deadline) {
        finish(new Error(`server did not listen on ${HOST}:${PORT} within ${TIMEOUT_MS / 1000}s`));
        return;
      }
      const socket = net.createConnection({ host: HOST, port: PORT });
      socket.setTimeout(1000);
      let done = false;
      socket.once('connect', () => {
        done = true;
        socket.destroy();
        finish();
      });
      const retry = () => {
        if (done) return;
        done = true;
        socket.destroy();
        setTimeout(attempt, 200);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

type RpcResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  trailers: http.IncomingHttpHeaders;
  body: Buffer;
};

function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            // Leave json empty; the status check reports the failure.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function rpc(name: string, body: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const [service, method] = name.split(':') as [string, string];
  const shapeName = endpoints[service]?.[method]?.request;
  if (!shapeName) throw new Error(`no endpoint for ${name}`);
  const shape = msgRegistry.get(shapeName);
  if (!shape && shapeName !== 'Empty') throw new Error(`no message shape for ${shapeName}`);

  const w = new Writer();
  if (shape) encodeMessage(shape, body, w);
  const envelope = encrypt(Buffer.from(w.toBytes()), Buffer.from('ab'));
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(envelope.length, 1);
  const framed = Buffer.concat([header, envelope]);

  const headers: Record<string, string | number> = {
    'content-type': 'application/grpc',
    'content-length': framed.length,
  };
  if (token) headers['x-auth-token'] = token;

  const result = await new Promise<RpcResult>((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: `/api.${service}/${method}`, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            trailers: res.trailers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(framed);
  });

  if (result.status !== 200) {
    throw new Error(`${name} returned HTTP ${result.status} (${result.headers['grpc-message'] ?? ''})`);
  }
  const grpcStatus = result.headers['grpc-status'] ?? result.trailers['grpc-status'];
  if (grpcStatus !== '0') {
    const message = result.headers['grpc-message'] ?? result.trailers['grpc-message'] ?? '';
    throw new Error(`${name} grpc-status ${grpcStatus ?? '<missing>'} ${message}`);
  }
  if (result.body.length < 5) throw new Error(`${name} response body too short (${result.body.length} bytes)`);

  const responseName = endpoints[service]![method]!.response;
  const responseShape = msgRegistry.get(responseName);
  if (!responseShape) throw new Error(`no message shape for ${responseName}`);
  const plain = decrypt(result.body.subarray(5));
  return decodeMessage(responseShape, new Reader(Uint8Array.from(plain))) as Record<string, unknown>;
}

let child: ChildProcess | null = null;
process.on('exit', () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
});

try {
  console.log(`smoke-new-player: starting server on ${HOST}:${PORT}`);
  child = spawn('node', ['src/server.ts'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  await waitForPort(child);

  const uid = randomUUID();
  const create = await rpc('Auth:Create', { FirebaseUID: uid });
  const customToken = create.FirebaseCustomToken;
  if (typeof customToken !== 'string' || customToken.length === 0) {
    fail('Auth:Create response has no FirebaseCustomToken');
  }
  console.log('smoke-new-player: Auth:Create ok');

  const signIn = await postJson('/v1/accounts:signInWithCustomToken', {
    token: customToken,
    returnSecureToken: true,
  });
  const idToken = signIn.json.idToken;
  if (signIn.status !== 200 || typeof idToken !== 'string' || idToken.length === 0) {
    fail(`signInWithCustomToken failed (HTTP ${signIn.status})`);
  }
  console.log('smoke-new-player: signInWithCustomToken ok');

  const login = await rpc('Auth:Login', { FirebaseIDToken: idToken });
  const gameToken = login.GameAuthToken;
  if (typeof gameToken !== 'string' || gameToken.length === 0) {
    fail('Auth:Login response has no GameAuthToken');
  }
  console.log('smoke-new-player: Auth:Login ok');

  const user = await rpc('User:Get', {}, gameToken);
  if (!user.User) fail('User:Get response has no User');
  console.log('smoke-new-player: User:Get ok');

  const homeLogin = await rpc('Home:Login', {}, gameToken);
  if (!homeLogin.CommonResponse?.UpdatedData?.User) fail('Home:Login response has no User');
  console.log('smoke-new-player: Home:Login ok');

  const home = await rpc('Home:Enter', { SkipUpdate: false }, gameToken);
  if (!home.LessonProgress) fail('Home:Enter response has no LessonProgress');
  console.log('smoke-new-player: Home:Enter ok');

  console.log('smoke ok: data + migrations + new player flow');
} catch (err) {
  fail((err as Error).message);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
