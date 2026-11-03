import Fastify from 'fastify';
import { request as httpsRequest } from 'node:https';

const app = Fastify({ logger: true });

app.get('/probe', (_req, reply) => {
  console.log('PROBE entered');
  const opts = {
    host: '130.211.5.37',
    port: 443,
    servername: 'api.octo-cloud.com',
    method: 'GET',
    path: '/',
    headers: { host: 'api.octo-cloud.com', 'content-length': '0' },
    rejectUnauthorized: false,
  };
  const up = httpsRequest(opts, (r) => {
    console.log('PROBE GOT status', r.statusCode);
    reply.send('ok ' + r.statusCode);
  });
  up.on('error', (e) => { console.log('PROBE ERR', e.code, e.message); });
  up.on('socket', (s) => console.log('PROBE SOCK', s && s.remoteAddress, s && s.remotePort));
  up.on('connect', () => console.log('PROBE CONNECTED'));
  up.end();
});

app.listen({ port: 18080, host: '127.0.0.1' }).then((addr) => console.log('probe up', addr));