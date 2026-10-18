import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { initDb, pool } from '../src/db.js';
import { processOutboxBatch } from '../src/outbox.js';

const suffix = randomUUID();
const tokens = {};
const users = {};
let operationsTeam;

async function login(email) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'password123' });
  assert.equal(response.status, 200, response.body.error);
  return response.body.token;
}

function api(token) {
  const send = (method, path) => request(app)[method](path)
    .set('Authorization', `Bearer ${token}`);
  return {
    get: (path) => send('get', path),
    post: (path) => send('post', path),
    patch: (path) => send('patch', path),
  };
}

async function createItem(token, input = {}) {
  return api(token)
    .post('/api/items')
    .send({
      title: `Test item ${suffix} ${randomUUID()}`,
      teamId: operationsTeam,
      ...input,
    });
}

before(async () => {
  await initDb();
  await processOutboxBatch({ batchSize: 500 });
  for (const [key, email] of [
    ['admin', 'admin@demo.local'],
    ['lead', 'lead@demo.local'],
    ['member', 'member@demo.local'],
    ['member2', 'ops2@demo.local'],
    ['viewer', 'viewer@demo.local'],
    ['outsider', 'payments-member@demo.local'],
  ]) {
    tokens[key] = await login(email);
  }
  const result = await pool.query(
    `SELECT email, id AS user_id FROM users
     WHERE email IN ('member@demo.local', 'ops2@demo.local', 'payments-member@demo.local')`,
  );
  operationsTeam = Number((await pool.query("SELECT id FROM teams WHERE name='Operations'")).rows[0].id);
  for (const row of result.rows) users[row.email] = Number(row.user_id);
});

after(async () => {
  await pool.end();
});

test('health and authentication failures use explicit responses', async () => {
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal((await request(app).get('/api/me')).status, 401);
  assert.equal(
    (await request(app).post('/api/auth/login').send({ email: 'member@demo.local', password: 'wrong' })).status,
    401,
  );
  assert.equal((await api(tokens.member).post('/api/items').send({ title: '' })).status, 400);
});

test('two concurrent users cannot claim the same unassigned item', async () => {
  const created = await createItem(tokens.member);
  assert.equal(created.status, 201, created.body.error);
  const itemId = created.body.id;
  const claims = await Promise.all([
    api(tokens.member).post(`/api/items/${itemId}/claim`),
    api(tokens.member2).post(`/api/items/${itemId}/claim`),
  ]);
  assert.deepEqual(claims.map((response) => response.status).sort(), [200, 409]);
  const winners = claims.filter((response) => response.status === 200);
  assert.ok(
    [users['member@demo.local'], users['ops2@demo.local']].includes(Number(winners[0].body.assignee_id)),
  );
});

test('stale item versions are rejected without overwriting the committed update', async () => {
  const created = await createItem(tokens.member);
  const item = created.body;
  const update = await api(tokens.member)
    .patch(`/api/items/${item.id}`)
    .send({ version: item.version, title: `Updated ${suffix}` });
  assert.equal(update.status, 200, update.body.error);
  const stale = await api(tokens.member)
    .patch(`/api/items/${item.id}`)
    .send({ version: item.version, title: 'must not replace' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.title, `Updated ${suffix}`);
  const persisted = await pool.query('SELECT title, version FROM work_items WHERE id=$1', [item.id]);
  assert.equal(persisted.rows[0].title, `Updated ${suffix}`);
  assert.equal(persisted.rows[0].version, item.version + 1);
});

test('idempotent create retries return the original item and reject payload mismatch', async () => {
  const key = `create-${suffix}`;
  const input = { title: `Idempotent ${suffix}`, teamId: operationsTeam, priority: 'High' };
  const [first, retry] = await Promise.all([
    api(tokens.member).post('/api/items').set('Idempotency-Key', key).send(input),
    api(tokens.member).post('/api/items').set('Idempotency-Key', key).send(input),
  ]);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(
    [first, retry].filter((response) => response.headers['idempotency-replayed'] === 'true').length,
    1,
  );
  const replay = await api(tokens.member).post('/api/items').set('Idempotency-Key', key).send(input);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotency-replayed'], 'true');
  assert.equal(replay.body.id, first.body.id);
  const count = await pool.query('SELECT COUNT(*)::int AS total FROM work_items WHERE id=$1', [first.body.id]);
  assert.equal(count.rows[0].total, 1);

  const conflict = await api(tokens.member)
    .post('/api/items')
    .set('Idempotency-Key', key)
    .send({ ...input, title: 'Different payload' });
  assert.equal(conflict.status, 409);
});

test('workflow rejects invalid jumps and only a team Lead can approve', async () => {
  const item = (await createItem(tokens.member)).body;
  const invalid = await api(tokens.member)
    .post(`/api/items/${item.id}/transition`)
    .send({ version: item.version, toStatus: 'Closed' });
  assert.equal(invalid.status, 400);

  let transition = await api(tokens.member)
    .post(`/api/items/${item.id}/transition`)
    .send({ version: item.version, toStatus: 'In Progress' });
  assert.equal(transition.status, 200, transition.body.error);
  transition = await api(tokens.member)
    .post(`/api/items/${item.id}/transition`)
    .send({ version: transition.body.version, toStatus: 'Awaiting Approval' });
  assert.equal(transition.status, 200, transition.body.error);
  const denied = await api(tokens.member)
    .post(`/api/items/${item.id}/transition`)
    .send({ version: transition.body.version, toStatus: 'Resolved' });
  assert.equal(denied.status, 403);
  const approved = await api(tokens.lead)
    .post(`/api/items/${item.id}/transition`)
    .send({ version: transition.body.version, toStatus: 'Resolved' });
  assert.equal(approved.status, 200, approved.body.error);
});

test('team-scoped item reads, updates, and history do not leak across teams', async () => {
  const item = (await createItem(tokens.member)).body;
  assert.equal((await api(tokens.outsider).get(`/api/items/${item.id}`)).status, 404);
  assert.equal(
    (await api(tokens.outsider).patch(`/api/items/${item.id}`).send({ version: item.version, title: 'intrusion' })).status,
    404,
  );
  assert.equal((await api(tokens.outsider).get(`/api/items/${item.id}/activity`)).status, 404);
  assert.equal((await api(tokens.viewer).post(`/api/items/${item.id}/claim`)).status, 403);
});

test('item changes, comments, activity, and outbox records commit together', async () => {
  const item = (await createItem(tokens.member)).body;
  const update = await api(tokens.member)
    .patch(`/api/items/${item.id}`)
    .send({ version: item.version, priority: 'Urgent' });
  assert.equal(update.status, 200, update.body.error);
  const comment = await api(tokens.member)
    .post(`/api/items/${item.id}/comments`)
    .send({ body: 'Investigating this issue.' });
  assert.equal(comment.status, 201, comment.body.error);
  assert.equal((await api(tokens.member).get(`/api/items/${item.id}/comments`)).body.comments.length, 1);
  const activity = await api(tokens.member).get(`/api/items/${item.id}/activity`);
  assert.deepEqual(
    activity.body.events.slice(0, 3).map((event) => event.event_type),
    ['commented', 'updated', 'created'],
  );
  const durable = await pool.query(
    `SELECT COUNT(*)::int AS activity_count,
            (SELECT COUNT(*)::int FROM outbox_jobs WHERE payload->>'itemId'=$1) AS outbox_count
     FROM activity_events WHERE item_id=$1::bigint`,
    [String(item.id)],
  );
  assert.equal(durable.rows[0].activity_count, 3);
  assert.equal(durable.rows[0].outbox_count, 3);
});

test('outbox retries transient failures and marks the maximum-attempt job dead', async () => {
  await processOutboxBatch({ batchSize: 500 });
  const dedupeKey = `retry-test-${suffix}`;
  const job = await pool.query(
    `INSERT INTO outbox_jobs(job_type, dedupe_key, payload, max_attempts)
     VALUES('test', $1, '{"test":true}', 2) RETURNING id`,
    [dedupeKey],
  );
  const handler = async () => {
    throw new Error('deliberate transient failure');
  };
  const first = await processOutboxBatch({ batchSize: 1, handler, baseDelayMs: 0 });
  assert.equal(first[0].status, 'pending');
  const second = await processOutboxBatch({ batchSize: 1, handler, baseDelayMs: 0 });
  assert.equal(second[0].status, 'dead');
  const final = await pool.query('SELECT status, attempts FROM outbox_jobs WHERE id=$1', [job.rows[0].id]);
  assert.equal(final.rows[0].status, 'dead');
  assert.equal(final.rows[0].attempts, 2);
});

test('outbox notification handler is idempotent when a completed job is replayed', async () => {
  await processOutboxBatch({ batchSize: 500 });
  const created = await createItem(tokens.member);
  const job = await pool.query(
    `SELECT id FROM outbox_jobs WHERE payload->>'itemId'=$1 AND payload->>'eventType'='created'
     ORDER BY id DESC LIMIT 1`,
    [String(created.body.id)],
  );
  await processOutboxBatch({ batchSize: 1 });
  await pool.query(
    `UPDATE outbox_jobs SET status='pending', attempts=0, completed_at=NULL,
       available_at=NOW(), locked_by=NULL, locked_until=NULL WHERE id=$1`,
    [job.rows[0].id],
  );
  await processOutboxBatch({ batchSize: 1 });
  const notifications = await pool.query(
    'SELECT COUNT(*)::int AS total FROM notifications WHERE outbox_job_id=$1',
    [job.rows[0].id],
  );
  assert.equal(notifications.rows[0].total, 1);
});

test('server-side filters and pagination return only matching team items', async () => {
  const marker = `page-${suffix}`;
  const first = await createItem(tokens.member, { title: `${marker}-one`, priority: 'High' });
  const second = await createItem(tokens.member, { title: `${marker}-two`, priority: 'High' });
  await createItem(tokens.member, { title: `${marker}-urgent`, priority: 'Urgent' });
  const pageOne = await api(tokens.member)
    .get('/api/items')
    .query({ q: marker, priority: 'High', teamId: operationsTeam, page: 1, limit: 1 });
  const pageTwo = await api(tokens.member)
    .get('/api/items')
    .query({ q: marker, priority: 'High', teamId: operationsTeam, page: 2, limit: 1 });
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.total, 2);
  assert.equal(pageOne.body.items.length, 1);
  assert.equal(pageTwo.body.items.length, 1);
  assert.notEqual(pageOne.body.items[0].id, pageTwo.body.items[0].id);
  assert.ok([first.body.id, second.body.id].includes(pageOne.body.items[0].id));
});
