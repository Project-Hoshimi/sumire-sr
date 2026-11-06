// Fresh-boot smoke test: with no game data, a freshly migrated database must
// accept sandbox Auth:Create. It spawns the real server (so the main-module
// check runs too), waits for the port, sends one encrypted RPC and checks the
// decoded response. Works from both the private tree and the public export.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from '../src/gateway/crypto.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';

const PORT = Number(process.env.PORT || 18099);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 30_000;

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

function die(message: string): never {
  console.error(`smoke-fresh-boot: ${message}`);
  process.exit(2);
}

if (!process.env.WIRE_SEC_KEY) die('WIRE_SEC_KEY is required');
if (!process.env.DATABASE_URL) die('DATABASE_URL is required');
if (process.env.SUMIRE_PROFILE !== 'sandbox') {
  die('refusing to run outside the sandbox profile (set SUMIRE_PROFILE=sandbox)');
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
function redact(text: string): string {
  return text.replace(JWT_RE, '<redacted-jwt>');
}

let output = '';
function append(chunk: Buffer): void {
  output += chunk.toString('utf8');
}

function fail(message: string): never {
  console.error(`smoke-fresh-boot: ${message}`);
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

type RpcResult = { status: number; headers: http.IncomingHttpHeaders; trailers: http.IncomingHttpHeaders; body: Buffer };

function authCreate(uid: string): Promise<RpcResult> {
  const service = 'Auth';
  const name = 'Create';
  const shapeName = endpoints[service][name].request;
  const shape = msgRegistry.get(shapeName);
  if (!shape) throw new Error(`no message shape for ${shapeName}`);

  const w = new Writer();
  encodeMessage(shape, { FirebaseUID: uid }, w);
  const envelope = encrypt(Buffer.from(w.toBytes()), Buffer.from('ab'));
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(envelope.length, 1);
  const body = Buffer.concat([header, envelope]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: `/api.${service}/${name}`,
        method: 'POST',
        headers: { 'content-type': 'application/grpc', 'content-length': body.length },
      },
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
    req.end(body);
  });
}

let child: ChildProcess | null = null;
// fail() exits without running finally, so the server is reaped here as well.
process.on('exit', () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
});

try {
  console.log(`smoke-fresh-boot: starting server on ${HOST}:${PORT}`);
  child = spawn('node', ['src/server.ts'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  await waitForPort(child);

  const uid = randomUUID();
  const result = await authCreate(uid);

  if (result.status !== 200) {
    fail(`Auth:Create returned HTTP ${result.status} (${result.headers['grpc-message'] ?? ''})`);
  }
  const grpcStatus = result.headers['grpc-status'] ?? result.trailers['grpc-status'];
  if (grpcStatus !== '0') {
    const message = result.headers['grpc-message'] ?? result.trailers['grpc-message'] ?? '';
    fail(`Auth:Create grpc-status ${grpcStatus ?? '<missing>'} ${message}`);
  }
  if (result.body.length < 5) fail(`Auth:Create response body too short (${result.body.length} bytes)`);

  const shapeName = endpoints.Auth.Create.response;
  const responseShape = msgRegistry.get(shapeName);
  if (!responseShape) fail(`no message shape for ${shapeName}`);
  let decoded: Record<string, unknown>;
  try {
    const plain = decrypt(result.body.subarray(5));
    decoded = decodeMessage(responseShape!, new Reader(Uint8Array.from(plain)));
  } catch (err) {
    fail(`could not decrypt/decode Auth:Create response: ${(err as Error).message}`);
  }
  const token = decoded.FirebaseCustomToken;
  if (typeof token !== 'string' || token.length === 0) {
    fail('Auth:Create response has no FirebaseCustomToken');
  }

  console.log('smoke ok: migrations + boot + Auth:Create');
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
