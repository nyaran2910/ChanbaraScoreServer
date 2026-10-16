import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { startDiscovery } from '../src/discovery.mjs';
import { createScoreServer } from '../src/server.mjs';

async function setup(t) {
  const api = createScoreServer();
  api.listen(0, '0.0.0.0');
  await once(api, 'listening');
  t.after(() => new Promise(resolve => api.close(resolve)));
  const httpPort = api.address().port;
  const responder = await startDiscovery({ httpPort, serverId: api.scoreServerId, port: 0 });
  t.after(() => new Promise(resolve => responder.close(resolve)));
  const client = dgram.createSocket('udp4');
  client.bind(0, '0.0.0.0');
  await once(client, 'listening');
  client.setBroadcast(true);
  t.after(() => new Promise(resolve => client.close(resolve)));
  const replies = [];
  client.on('message', (packet, remote) => replies.push({ body: JSON.parse(packet.toString()), remote }));
  const send = (body, address = '127.0.0.1') => new Promise((resolve, reject) => {
    client.send(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), responder.address().port, address,
      error => error ? reject(error) : resolve());
  });
  return { api, responder, send, replies, httpPort };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, 'timed out waiting for UDP discovery');
}

test('UDP offer echoes the nonce and locates the actual HTTP API', async t => {
  const fixture = await setup(t);
  const nonce = randomUUID().replaceAll('-', '');
  await fixture.send({ type: 'kosen.score.discover', version: 1, nonce });
  await waitFor(() => fixture.replies.length === 1);
  const { body, remote } = fixture.replies[0];
  assert.deepEqual(body, { type: 'kosen.score.offer', version: 1, nonce, serverId: fixture.api.scoreServerId, port: fixture.httpPort });
  const health = await (await fetch(`http://${remote.address}:${body.port}/health`)).json();
  assert.equal(health.serverId, body.serverId);
});

test('LAN broadcast receives an offer without knowing the server IP', async t => {
  const fixture = await setup(t);
  await fixture.send({ type: 'kosen.score.discover', version: 1, nonce: randomUUID().replaceAll('-', '') }, '255.255.255.255');
  await waitFor(() => fixture.replies.length > 0);
  assert.equal(fixture.replies[0].body.serverId, fixture.api.scoreServerId);
});

test('unrelated, malformed, old-version and oversized packets receive no offer', async t => {
  const fixture = await setup(t);
  for (const packet of ['{', 'null', 'x'.repeat(300), {},
    { type: 'kosen.score.discover', version: 2, nonce: 'a'.repeat(32) },
    { type: 'kosen.score.discover', version: 1, nonce: 'invalid' }]) await fixture.send(packet);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.replies.length, 0);
});

test('a second responder cannot silently take over the same discovery port', async t => {
  const fixture = await setup(t);
  await assert.rejects(startDiscovery({ httpPort: 3080, serverId: randomUUID(), port: fixture.responder.address().port }),
    { code: 'EADDRINUSE' });
});
