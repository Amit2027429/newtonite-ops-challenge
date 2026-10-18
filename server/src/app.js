import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { authRequired, jwtSecret } from './auth.js';
import { pool } from './db.js';
import { enqueueActivity } from './events.js';

export const app = express();
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : null;
app.use(cors({
  origin: allowedOrigins?.length ? allowedOrigins : process.env.NODE_ENV === 'production' ? false : true,
}));
app.use(express.json({ limit: '1mb' }));

const ITEM_TYPES = ['incident', 'customer issue', 'payment', 'compliance', 'task'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const STATUSES = ['Open', 'In Progress', 'Awaiting Approval', 'Resolved', 'Closed'];
const WRITERS = ['Member', 'Lead', 'Admin'];
const TRANSITIONS = {
  Open: ['In Progress'],
  'In Progress': ['Open', 'Awaiting Approval'],
  'Awaiting Approval': ['In Progress', 'Resolved'],
  Resolved: ['Closed'],
  Closed: [],
};
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function fail(status, message, extra) {
  throw new HttpError(status, message, extra);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, maximum = 2147483647) {
  return (typeof value === 'number' || typeof value === 'string')
    && /^\d+$/.test(String(value))
    && Number(value) > 0
    && Number.isSafeInteger(Number(value))
    && Number(value) <= maximum;
}

function validDate(value) {
  if (value == null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function verifyPassword(password, encoded) {
  const [scheme, saltText, hashText] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function getRole(userId, teamId, db = pool, lock = false) {
  const result = await db.query(
    `SELECT role FROM memberships WHERE user_id=$1 AND team_id=$2${lock ? ' FOR SHARE' : ''}`,
    [userId, teamId],
  );
  return result.rows[0]?.role || null;
}

async function getItem(userId, itemId, db = pool) {
  if (!positiveInteger(itemId, Number.MAX_SAFE_INTEGER)) return null;
  const result = await db.query(
    `SELECT wi.*, team.name AS team_name, assignee.name AS assignee_name,
            creator.name AS creator_name
     FROM work_items wi
     JOIN teams team ON team.id=wi.team_id
     LEFT JOIN users assignee ON assignee.id=wi.assignee_id
     JOIN users creator ON creator.id=wi.created_by
     WHERE wi.id=$1
       AND EXISTS (
         SELECT 1 FROM memberships membership
         WHERE membership.user_id=$2 AND membership.team_id=wi.team_id
       )`,
    [itemId, userId],
  );
  return result.rows[0] || null;
}

async function addActivity(db, itemId, actorId, eventType, details) {
  await enqueueActivity(db, itemId, actorId, eventType, details);
}

function validateItemInput(body) {
  if (!isObject(body)) fail(400, 'Request body must be an object');
  const allowed = ['title', 'description', 'type', 'priority', 'teamId', 'assigneeId', 'dueDate'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'Unknown item field');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) fail(400, 'Title must be between 1 and 200 characters');
  const description = body.description ?? '';
  if (typeof description !== 'string' || description.length > 10000) fail(400, 'Invalid description');
  const type = body.type ?? 'task';
  const priority = body.priority ?? 'Medium';
  if (!ITEM_TYPES.includes(type)) fail(400, 'Invalid work item type');
  if (!PRIORITIES.includes(priority)) fail(400, 'Invalid priority');
  if (!positiveInteger(body.teamId)) fail(400, 'teamId must be a positive integer');
  if (body.assigneeId != null && !positiveInteger(body.assigneeId)) fail(400, 'assigneeId must be a positive integer');
  if (!validDate(body.dueDate)) fail(400, 'dueDate must be a valid YYYY-MM-DD date');
  return {
    title,
    description,
    type,
    priority,
    teamId: Number(body.teamId),
    assigneeId: body.assigneeId == null ? null : Number(body.assigneeId),
    dueDate: body.dueDate ?? null,
  };
}

function validateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) {
    fail(400, 'A valid positive item version is required');
  }
}

function validatePaging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1) fail(400, 'page must be a positive integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'limit must be between 1 and 100');
  return { page, limit };
}

app.get('/api/health', asyncHandler(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, database: 'ready' });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || email.length > 254
      || typeof password !== 'string' || !password || password.length > 256) {
    fail(400, 'A valid email and password are required');
  }
  const result = await pool.query(
    'SELECT id, name, email, password_hash FROM users WHERE lower(email)=lower($1)',
    [email.trim()],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    fail(401, 'Invalid email or password');
  }
  const token = jwt.sign({ sub: String(user.id) }, jwtSecret(), { expiresIn: '8h' });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
}));

app.use('/api', authRequired);

app.get('/api/me', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT user_account.id, user_account.name, user_account.email,
            team.id AS team_id, team.name AS team_name, membership.role
     FROM users user_account
     JOIN memberships membership ON membership.user_id=user_account.id
     JOIN teams team ON team.id=membership.team_id
     WHERE user_account.id=$1 ORDER BY team.name`,
    [req.user.id],
  );
  if (!result.rowCount) fail(404, 'User not found');
  const first = result.rows[0];
  res.json({
    id: first.id,
    name: first.name,
    email: first.email,
    teams: result.rows.map((row) => ({ id: row.team_id, name: row.team_name, role: row.role })),
  });
}));

app.get('/api/dashboard', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE wi.assignee_id=$1 AND wi.status NOT IN ('Resolved', 'Closed'))::int
         AS assigned_to_me,
       COUNT(*) FILTER (
         WHERE wi.assignee_id IS NULL AND wi.priority='Urgent'
           AND wi.status NOT IN ('Resolved', 'Closed')
       )::int AS unassigned_urgent,
       COUNT(*) FILTER (
         WHERE wi.status='Awaiting Approval'
           AND EXISTS (
             SELECT 1 FROM memberships lead_membership
             WHERE lead_membership.user_id=$1 AND lead_membership.team_id=wi.team_id
               AND lead_membership.role='Lead'
           )
       )::int AS awaiting_my_approval
     FROM work_items wi
     WHERE EXISTS (
       SELECT 1 FROM memberships membership
       WHERE membership.user_id=$1 AND membership.team_id=wi.team_id
     )`,
    [req.user.id],
  );
  res.json(result.rows[0]);
}));

app.get('/api/teams/:teamId/members', asyncHandler(async (req, res) => {
  if (!positiveInteger(req.params.teamId)) fail(404, 'Team not found');
  const role = await getRole(req.user.id, Number(req.params.teamId));
  if (!role) fail(404, 'Team not found');
  const result = await pool.query(
    `SELECT user_account.id, user_account.name, membership.role
     FROM memberships membership
     JOIN users user_account ON user_account.id=membership.user_id
     WHERE membership.team_id=$1 ORDER BY user_account.name`,
    [req.params.teamId],
  );
  res.json({ members: result.rows });
}));

app.get('/api/items', asyncHandler(async (req, res) => {
  const { page, limit } = validatePaging(req.query);
  const { status, priority, teamId, assigneeId, type, q, view } = req.query;
  if (status !== undefined && !STATUSES.includes(status)) fail(400, 'Invalid status filter');
  if (priority !== undefined && !PRIORITIES.includes(priority)) fail(400, 'Invalid priority filter');
  if (type !== undefined && !ITEM_TYPES.includes(type)) fail(400, 'Invalid type filter');
  if (teamId !== undefined && !positiveInteger(teamId)) fail(400, 'teamId must be a positive integer');
  if (assigneeId !== undefined && assigneeId !== 'unassigned' && !positiveInteger(assigneeId)) {
    fail(400, 'assigneeId must be a positive integer or unassigned');
  }
  if (q !== undefined && (typeof q !== 'string' || q.length > 200)) fail(400, 'Search text is too long');
  if (view !== undefined && !['all', 'mine', 'unassigned_urgent', 'approval'].includes(view)) {
    fail(400, 'Invalid dashboard view');
  }

  const values = [req.user.id];
  const clauses = [
    'EXISTS (SELECT 1 FROM memberships membership WHERE membership.user_id=$1 AND membership.team_id=wi.team_id)',
  ];
  const add = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (status !== undefined) add('wi.status=?', status);
  if (priority !== undefined) add('wi.priority=?', priority);
  if (teamId !== undefined) add('wi.team_id=?', Number(teamId));
  if (assigneeId === 'unassigned') clauses.push('wi.assignee_id IS NULL');
  else if (assigneeId !== undefined) add('wi.assignee_id=?', Number(assigneeId));
  if (type !== undefined) add('wi.type=?', type);
  if (q?.trim()) {
    values.push(`%${q.trim()}%`);
    clauses.push(`(wi.title ILIKE $${values.length} OR wi.description ILIKE $${values.length})`);
  }
  if (view === 'mine') clauses.push('wi.assignee_id=$1');
  if (view === 'unassigned_urgent') {
    clauses.push("wi.assignee_id IS NULL AND wi.priority='Urgent' AND wi.status NOT IN ('Resolved', 'Closed')");
  }
  if (view === 'approval') {
    clauses.push(`wi.status='Awaiting Approval' AND EXISTS (
      SELECT 1 FROM memberships lead_membership
      WHERE lead_membership.user_id=$1 AND lead_membership.team_id=wi.team_id
        AND lead_membership.role='Lead'
    )`);
  }

  const where = clauses.join(' AND ');
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM work_items wi WHERE ${where}`,
    values,
  );
  const rows = await pool.query(
    `SELECT wi.*, team.name AS team_name, assignee.name AS assignee_name,
            creator.name AS creator_name
     FROM work_items wi
     JOIN teams team ON team.id=wi.team_id
     LEFT JOIN users assignee ON assignee.id=wi.assignee_id
     JOIN users creator ON creator.id=wi.created_by
     WHERE ${where}
     ORDER BY wi.updated_at DESC, wi.id DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, (page - 1) * limit],
  );
  res.json({ items: rows.rows, total: count.rows[0].total, page, limit });
}));

app.post('/api/items', asyncHandler(async (req, res) => {
  const input = validateItemInput(req.body);
  const key = req.get('Idempotency-Key');
  if (key !== undefined && (!key.trim() || key.length > 200)) fail(400, 'Invalid Idempotency-Key');
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await getRole(req.user.id, input.teamId, client, true);
    if (!role) fail(403, 'You are not a member of this team');
    if (!WRITERS.includes(role)) fail(403, 'Your team role cannot create work items');
    if (input.assigneeId !== null) {
      const assignee = await getRole(input.assigneeId, input.teamId, client, true);
      if (!assignee) fail(400, 'Assignee must belong to the selected team');
    }

    if (key) {
      await client.query(
        `DELETE FROM idempotency_records
         WHERE key=$1 AND user_id=$2 AND scope='create-item' AND expires_at<=NOW()`,
        [key, req.user.id],
      );
      const reserved = await client.query(
        `INSERT INTO idempotency_records(key, user_id, scope, request_hash)
         VALUES($1, $2, 'create-item', $3)
         ON CONFLICT(key, user_id, scope) DO NOTHING RETURNING key`,
        [key, req.user.id, requestHash],
      );
      if (!reserved.rowCount) {
        const existing = await client.query(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_records
           WHERE key=$1 AND user_id=$2 AND scope='create-item'`,
          [key, req.user.id],
        );
        if (!existing.rowCount) fail(409, 'Idempotency key is being processed; retry shortly');
        if (existing.rows[0].request_hash !== requestHash) {
          fail(409, 'Idempotency-Key was already used with a different request');
        }
        if (!existing.rows[0].response_body || !existing.rows[0].response_status) {
          fail(409, 'Idempotency key is being processed; retry shortly');
        }
        await client.query('COMMIT');
        res.set('Idempotency-Replayed', 'true')
          .status(existing.rows[0].response_status)
          .json(existing.rows[0].response_body);
        return;
      }
    }

    const inserted = await client.query(
      `INSERT INTO work_items(title, description, type, priority, team_id, assignee_id, created_by, due_date)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.title,
        input.description,
        input.type,
        input.priority,
        input.teamId,
        input.assigneeId,
        req.user.id,
        input.dueDate,
      ],
    );
    const itemId = inserted.rows[0].id;
    await addActivity(client, itemId, req.user.id, 'created', { title: input.title });
    const item = await getItem(req.user.id, itemId, client);
    if (!item) fail(500, 'Created item could not be loaded');
    if (key) {
      await client.query(
        `UPDATE idempotency_records
         SET response_status=201, response_body=$1, expires_at=NOW() + INTERVAL '7 days'
         WHERE key=$2 AND user_id=$3 AND scope='create-item'`,
        [JSON.stringify(item), key, req.user.id],
      );
    }
    await client.query('COMMIT');
    res.status(201).json(item);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/items/:id', asyncHandler(async (req, res) => {
  const item = await getItem(req.user.id, req.params.id);
  if (!item) fail(404, 'Item not found');
  res.json(item);
}));

app.patch('/api/items/:id', asyncHandler(async (req, res) => {
  const current = await getItem(req.user.id, req.params.id);
  if (!current) fail(404, 'Item not found');
  if (!isObject(req.body)) fail(400, 'Request body must be an object');
  const { version } = req.body;
  validateVersion(version);
  const allowed = ['version', 'title', 'description', 'type', 'priority', 'dueDate', 'assigneeId'];
  if (Object.keys(req.body).some((key) => !allowed.includes(key))) fail(400, 'Unknown item field');
  const changes = {};
  if ('title' in req.body) {
    if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.trim().length > 200) {
      fail(400, 'Title must be between 1 and 200 characters');
    }
    changes.title = req.body.title.trim();
  }
  if ('description' in req.body) {
    if (typeof req.body.description !== 'string' || req.body.description.length > 10000) fail(400, 'Invalid description');
    changes.description = req.body.description;
  }
  if ('type' in req.body) {
    if (!ITEM_TYPES.includes(req.body.type)) fail(400, 'Invalid work item type');
    changes.type = req.body.type;
  }
  if ('priority' in req.body) {
    if (!PRIORITIES.includes(req.body.priority)) fail(400, 'Invalid priority');
    changes.priority = req.body.priority;
  }
  if ('dueDate' in req.body) {
    if (!validDate(req.body.dueDate)) fail(400, 'dueDate must be a valid YYYY-MM-DD date');
    changes.due_date = req.body.dueDate;
  }
  if ('assigneeId' in req.body) {
    if (req.body.assigneeId !== null && !positiveInteger(req.body.assigneeId)) fail(400, 'Invalid assigneeId');
    changes.assignee_id = req.body.assigneeId === null ? null : Number(req.body.assigneeId);
  }
  if (!Object.keys(changes).length) fail(400, 'At least one item field must be changed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await getRole(req.user.id, current.team_id, client, true);
    if (!role) fail(404, 'Item not found');
    if (!WRITERS.includes(role)) fail(403, 'Your team role cannot update work items');
    if ('assignee_id' in changes) {
      if (role === 'Member') fail(403, 'Only team Leads and Admins may change an assignee');
      if (changes.assignee_id !== null) {
        const assigneeRole = await getRole(changes.assignee_id, current.team_id, client, true);
        if (!assigneeRole) fail(400, 'Assignee must belong to this team');
      }
    }
    const fields = Object.keys(changes);
    const values = fields.map((field) => changes[field]);
    const assignments = fields.map((field, index) => `${field}=$${index + 1}`);
    values.push(current.id, version);
    const updated = await client.query(
      `UPDATE work_items
       SET ${assignments.join(', ')}, version=version+1, updated_at=NOW()
       WHERE id=$${values.length - 1} AND version=$${values.length}
       RETURNING id`,
      values,
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      const latest = await getItem(req.user.id, current.id);
      fail(409, 'This item changed since you loaded it. Reload the latest version.', { current: latest });
    }
    const details = {};
    for (const [field, value] of Object.entries(changes)) {
      const before = field === 'assignee_id' ? current.assignee_id : current[field];
      if (before !== value) details[field] = { from: before, to: value };
    }
    await addActivity(client, current.id, req.user.id, 'updated', { changes: details });
    await client.query('COMMIT');
    res.json(await getItem(req.user.id, current.id));
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/items/:id/claim', asyncHandler(async (req, res) => {
  const current = await getItem(req.user.id, req.params.id);
  if (!current) fail(404, 'Item not found');
  if (req.body && Object.keys(req.body).length) fail(400, 'Claim does not accept a request body');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await getRole(req.user.id, current.team_id, client, true);
    if (!role) fail(404, 'Item not found');
    if (!WRITERS.includes(role)) fail(403, 'Your team role cannot claim work items');
    const result = await client.query(
      `UPDATE work_items
       SET assignee_id=$1, version=version+1, updated_at=NOW()
       WHERE id=$2 AND assignee_id IS NULL AND status NOT IN ('Resolved', 'Closed')
       RETURNING id`,
      [req.user.id, current.id],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      fail(409, 'This item has already been claimed or is closed');
    }
    await addActivity(client, current.id, req.user.id, 'claimed', { assigneeId: req.user.id });
    await client.query('COMMIT');
    res.json(await getItem(req.user.id, current.id));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/items/:id/transition', asyncHandler(async (req, res) => {
  const current = await getItem(req.user.id, req.params.id);
  if (!current) fail(404, 'Item not found');
  if (!isObject(req.body)) fail(400, 'Request body must be an object');
  const { toStatus, version } = req.body;
  validateVersion(version);
  if (Object.keys(req.body).some((key) => !['toStatus', 'version'].includes(key))) {
    fail(400, 'Unknown transition field');
  }
  if (typeof toStatus !== 'string' || !TRANSITIONS[current.status]?.includes(toStatus)) {
    fail(400, `Transition from ${current.status} to ${String(toStatus)} is not allowed`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await getRole(req.user.id, current.team_id, client, true);
    if (!role) fail(404, 'Item not found');
    if (!WRITERS.includes(role)) fail(403, 'Your team role cannot change workflow status');
    if (current.status === 'Awaiting Approval' && toStatus === 'Resolved' && role !== 'Lead') {
      fail(403, 'Only a Lead of this team may approve this item');
    }
    const updated = await client.query(
      `UPDATE work_items SET status=$1, version=version+1, updated_at=NOW()
       WHERE id=$2 AND version=$3 AND status=$4 RETURNING id`,
      [toStatus, current.id, version, current.status],
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      const latest = await getItem(req.user.id, current.id);
      fail(409, 'This item changed since you loaded it. Reload the latest version.', { current: latest });
    }
    await addActivity(client, current.id, req.user.id, 'status_changed', {
      from: current.status,
      to: toStatus,
    });
    await client.query('COMMIT');
    res.json(await getItem(req.user.id, current.id));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/items/:id/activity', asyncHandler(async (req, res) => {
  const item = await getItem(req.user.id, req.params.id);
  if (!item) fail(404, 'Item not found');
  const { page, limit } = validatePaging(req.query);
  const result = await pool.query(
    `SELECT event.id, event.item_id, event.actor_id, actor.name AS actor_name,
            event.event_type, event.details, event.created_at
     FROM activity_events event
     LEFT JOIN users actor ON actor.id=event.actor_id
     WHERE event.item_id=$1 ORDER BY event.created_at DESC, event.id DESC
     LIMIT $2 OFFSET $3`,
    [item.id, limit, (page - 1) * limit],
  );
  res.json({ events: result.rows, page, limit });
}));

app.get('/api/items/:id/comments', asyncHandler(async (req, res) => {
  const item = await getItem(req.user.id, req.params.id);
  if (!item) fail(404, 'Item not found');
  const { page, limit } = validatePaging(req.query);
  const result = await pool.query(
    `SELECT comment.id, comment.item_id, comment.author_id, author.name AS author_name,
            comment.body, comment.created_at
     FROM item_comments comment JOIN users author ON author.id=comment.author_id
     WHERE comment.item_id=$1 ORDER BY comment.created_at DESC, comment.id DESC
     LIMIT $2 OFFSET $3`,
    [item.id, limit, (page - 1) * limit],
  );
  res.json({ comments: result.rows, page, limit });
}));

app.post('/api/items/:id/comments', asyncHandler(async (req, res) => {
  const item = await getItem(req.user.id, req.params.id);
  if (!item) fail(404, 'Item not found');
  if (!isObject(req.body) || Object.keys(req.body).some((key) => key !== 'body')) {
    fail(400, 'A comment body is required');
  }
  if (typeof req.body.body !== 'string' || !req.body.body.trim() || req.body.body.trim().length > 5000) {
    fail(400, 'Comment must be between 1 and 5000 characters');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await getRole(req.user.id, item.team_id, client, true);
    if (!role) fail(404, 'Item not found');
    if (!WRITERS.includes(role)) fail(403, 'Your team role cannot comment on work items');
    const inserted = await client.query(
      `INSERT INTO item_comments(item_id, author_id, body)
       VALUES($1, $2, $3)
       RETURNING id, item_id, author_id, body, created_at`,
      [item.id, req.user.id, req.body.body.trim()],
    );
    const comment = { ...inserted.rows[0], author_name: (await client.query(
      'SELECT name FROM users WHERE id=$1',
      [req.user.id],
    )).rows[0].name };
    await client.query('UPDATE work_items SET updated_at=NOW() WHERE id=$1', [item.id]);
    await addActivity(client, item.id, req.user.id, 'commented', { commentId: comment.id });
    await client.query('COMMIT');
    res.status(201).json(comment);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((error, _req, res, _next) => {
  const status = error instanceof HttpError
    ? error.status
    : Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
  if (status >= 500) console.error('Request failed:', error.message);
  res.status(status).json({
    error: status >= 500
      ? 'Internal server error'
      : error.type === 'entity.parse.failed'
        ? 'Invalid JSON request body'
        : error.type === 'entity.too.large'
          ? 'Request body is too large'
          : error.message,
    ...error.extra,
  });
});
