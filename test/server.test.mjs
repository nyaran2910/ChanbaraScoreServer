import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createScoreServer } from '../src/server.mjs';

async function start(t, databasePath) {
  const server = createScoreServer({ databasePath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = () => new Promise(resolve => server.close(resolve));
  t.after(() => server.listening ? close() : undefined);
  const url = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options) {
    const response = await fetch(url + route, options);
    return { status: response.status, body: await response.json() };
  }
  const submit = (defeated, overrides = {}) => request('/api/scores', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: randomUUID(), name: 'テスト', difficulty: 'normal', defeated, ...overrides })
  });
  return { request, submit, close, serverId: server.scoreServerId };
}

test('top ten are sorted by defeats, ties retain registration order, and difficulties are separate', async t => {
  const api = await start(t);
  for (let i = 0; i < 12; i++) assert.equal((await api.submit(i)).status, 201);
  assert.equal((await api.submit(2, { name: '同点' })).status, 409);
  assert.equal((await api.submit(100, { difficulty: 'easy' })).status, 201);
  const { body } = await api.request('/api/scores?difficulty=normal');
  assert.deepEqual(body.entries.map(entry => entry.defeated), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual(body.entries.map(entry => entry.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal((await api.request('/api/scores?difficulty=easy')).body.entries.length, 1);
  const tie = await api.submit(11, { name: '後の記録' });
  assert.equal(tie.body.rank, 2);
  assert.equal(tie.body.entries[1].name, '後の記録');
});

test('empty slots accept zero and a hundred defeats can be registered', async t => {
  const api = await start(t);
  assert.equal((await api.request('/api/scores/qualification?difficulty=normal&defeated=0')).body.qualified, true);
  assert.equal((await api.submit(0)).status, 201);
  assert.equal((await api.submit(100)).body.rank, 1);
});

test('qualification is checked again at commit, including concurrent contenders for tenth', async t => {
  const api = await start(t);
  for (let i = 0; i < 9; i++) await api.submit(100);
  assert.equal((await api.request('/api/scores/qualification?difficulty=normal&defeated=50')).body.rank, 10);
  const results = await Promise.all([api.submit(50, { name: '先着' }), api.submit(50, { name: '後着' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(results.find(result => result.status === 409).body.code, 'NOT_QUALIFIED');
  assert.equal((await api.request('/api/scores?difficulty=normal')).body.entries.length, 10);
});

test('retrying a committed run is idempotent even after it falls out of the leaderboard', async t => {
  const api = await start(t);
  const runId = randomUUID();
  await api.submit(1, { runId });
  for (let i = 0; i < 10; i++) await api.submit(100);
  const retry = await api.submit(1, { runId });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.rank, 11);
  assert.equal(retry.body.entry.runId, runId);
  assert.equal((await api.submit(1, { runId, name: '変更' })).body.code, 'RUN_CONFLICT');
});

test('records survive a server restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chanbara-scores-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'scores.sqlite');
  const api = await start(t, database);
  await api.submit(88, { name: '記録保持' });
  await api.close();
  const restarted = await start(t, database);
  assert.equal((await restarted.request('/api/scores?difficulty=normal')).body.entries[0].name, '記録保持');
  assert.equal(restarted.serverId, api.serverId);
});

test('invalid scores, names, identifiers, JSON and oversized requests are rejected', async t => {
  const api = await start(t);
  for (const score of [-1, 101, 1.5, '10', null]) assert.equal((await api.submit(score)).status, 400);
  for (const name of ['', '   ', 'あ'.repeat(13), '行\n替え', '不可\u200b視', '不可\ud800']) assert.equal((await api.submit(4, { name })).status, 400);
  assert.equal((await api.submit(4, { runId: 'bad' })).status, 400);
  assert.equal((await api.submit(4, { difficulty: 'hard' })).status, 400);
  for (const body of ['{', 'null', '[]']) {
    assert.equal((await api.request('/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
  }
  assert.equal((await api.request('/api/scores', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await api.request('/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(5000) })).status, 413);
  for (const raw of ['', '-1', '101', '1.5', 'Infinity', 'NaN']) {
    assert.equal((await api.request('/api/scores/qualification?difficulty=normal&defeated=' + raw)).status, 400);
  }
  assert.equal((await api.request('/api/scores?difficulty=bad')).status, 400);
  assert.equal((await api.request('/missing')).status, 404);
  assert.equal((await api.request('/health')).body.ok, true);
  assert.equal((await api.request('/health')).body.serverId, api.serverId);
});

test('a record qualified against another database cannot be saved here', async t => {
  const api = await start(t);
  assert.equal((await api.submit(88, { serverId: randomUUID() })).body.code, 'SERVER_CHANGED');
  const wrongHeader = await api.request('/api/scores?difficulty=normal', { headers: { 'X-Kosen-Score-Server': randomUUID() } });
  assert.equal(wrongHeader.status, 409);
  assert.equal(wrongHeader.body.code, 'SERVER_CHANGED');
  assert.equal((await api.request('/api/scores?difficulty=normal')).body.entries.length, 0);
  assert.equal((await api.submit(88, { serverId: api.serverId })).status, 201);
});

test('names are normalized and SQL-looking input stays data', async t => {
  const api = await start(t);
  const result = await api.submit(32, { name: '　Ａｂｃ　' });
  assert.equal(result.body.entry.name, 'Abc');
  assert.equal((await api.submit(33, { name: "'; DROP --" })).status, 201);
  assert.equal((await api.request('/api/scores?difficulty=normal')).body.entries.length, 2);
});
