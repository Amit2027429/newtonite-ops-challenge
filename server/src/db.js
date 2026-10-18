import pg from 'pg';
import { randomBytes, scryptSync } from 'node:crypto';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

function demoPasswordHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('Viewer', 'Member', 'Lead', 'Admin')),
      PRIMARY KEY (user_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS membership_team_user_idx ON memberships(team_id, user_id);
    CREATE TABLE IF NOT EXISTS work_items (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'task'
        CHECK (type IN ('incident', 'customer issue', 'payment', 'compliance', 'task')),
      priority TEXT NOT NULL DEFAULT 'Medium'
        CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
      status TEXT NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'In Progress', 'Awaiting Approval', 'Resolved', 'Closed')),
      team_id INT NOT NULL REFERENCES teams(id),
      assignee_id INT REFERENCES users(id),
      created_by INT NOT NULL REFERENCES users(id),
      due_date DATE,
      version INT NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wi_team_status_updated_idx
      ON work_items(team_id, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS wi_team_priority_updated_idx
      ON work_items(team_id, priority, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS wi_assignee_updated_idx
      ON work_items(assignee_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS wi_team_unassigned_idx
      ON work_items(team_id, priority, updated_at DESC) WHERE assignee_id IS NULL;
    CREATE TABLE IF NOT EXISTS activity_events (
      id BIGSERIAL PRIMARY KEY,
      item_id BIGINT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS activity_item_created_idx
      ON activity_events(item_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS item_comments (
      id BIGSERIAL PRIMARY KEY,
      item_id BIGINT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      author_id INT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS comment_item_created_idx
      ON item_comments(item_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT NOT NULL,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INT,
      response_body JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      PRIMARY KEY (key, user_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_records(expires_at);
    CREATE TABLE IF NOT EXISTS outbox_jobs (
      id BIGSERIAL PRIMARY KEY,
      job_type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'dead')),
      attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_by TEXT,
      locked_until TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS outbox_pending_idx
      ON outbox_jobs(status, available_at, id);
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      outbox_job_id BIGINT NOT NULL UNIQUE REFERENCES outbox_jobs(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await seedDemoData();
}

async function seedDemoData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const teams = {};
    for (const name of ['Operations', 'Payments']) {
      const result = await client.query(
        'INSERT INTO teams(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [name],
      );
      teams[name] = result.rows[0].id;
    }

    const demoUsers = [
      ['Admin User', 'admin@demo.local', ['Operations', 'Payments'], 'Admin'],
      ['Operations Lead', 'lead@demo.local', ['Operations'], 'Lead'],
      ['Operations Member', 'member@demo.local', ['Operations'], 'Member'],
      ['Operations Viewer', 'viewer@demo.local', ['Operations'], 'Viewer'],
      ['Operations Member Two', 'ops2@demo.local', ['Operations'], 'Member'],
      ['Payments Lead', 'payments-lead@demo.local', ['Payments'], 'Lead'],
      ['Payments Member', 'payments-member@demo.local', ['Payments'], 'Member'],
      ['Payments Viewer', 'payments-viewer@demo.local', ['Payments'], 'Viewer'],
      ['Payments Member Two', 'payments2@demo.local', ['Payments'], 'Member'],
      ['Cross-team Lead', 'dual@demo.local', ['Operations', 'Payments'], 'Member'],
    ];

    const userIds = new Map();
    for (const [name, email, memberships, role] of demoUsers) {
      const user = await client.query(
        `INSERT INTO users(name, email, password_hash)
         VALUES($1, $2, $3)
         ON CONFLICT(email) DO UPDATE SET
           name=EXCLUDED.name,
           password_hash=CASE WHEN users.password_hash='demo-only'
             THEN EXCLUDED.password_hash ELSE users.password_hash END
         RETURNING id`,
        [name, email, demoPasswordHash('password123')],
      );
      userIds.set(email, user.rows[0].id);
      for (const teamName of memberships) {
        const membershipRole = email === 'dual@demo.local' && teamName === 'Payments' ? 'Lead' : role;
        await client.query(
          `INSERT INTO memberships(user_id, team_id, role) VALUES($1, $2, $3)
           ON CONFLICT(user_id, team_id) DO UPDATE SET role=EXCLUDED.role`,
          [user.rows[0].id, teams[teamName], membershipRole],
        );
      }
    }

    const count = await client.query('SELECT COUNT(*)::int AS total FROM work_items');
    if (count.rows[0].total === 0) {
      const leadId = userIds.get('lead@demo.local');
      const memberId = userIds.get('member@demo.local');
      const paymentsLeadId = userIds.get('payments-lead@demo.local');
      const paymentsMemberId = userIds.get('payments-member@demo.local');
      for (let i = 1; i <= 60; i += 1) {
        const isPayments = i % 6 === 0;
        const status = ['Open', 'In Progress', 'Awaiting Approval', 'Resolved', 'Closed'][i % 5];
        const priority = i % 11 === 0 ? 'Urgent' : i % 3 === 0 ? 'High' : 'Medium';
        const inserted = await client.query(
          `INSERT INTO work_items(title, description, type, priority, status, team_id, assignee_id, created_by)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            `Sample work item ${i}`,
            `Operations demo item ${i}`,
            i % 4 === 0 ? 'incident' : 'task',
            priority,
            status,
            isPayments ? teams['Payments'] : teams['Operations'],
            i % 3 === 0 ? (isPayments ? paymentsMemberId : memberId) : null,
            isPayments ? paymentsLeadId : leadId,
          ],
        );
        const activity = await client.query(
          `INSERT INTO activity_events(item_id, actor_id, event_type, details)
           VALUES($1, $2, 'created', $3) RETURNING id`,
          [inserted.rows[0].id, isPayments ? paymentsLeadId : leadId, JSON.stringify({ title: `Sample work item ${i}` })],
        );
        await client.query(
          `INSERT INTO outbox_jobs(job_type, dedupe_key, payload)
           VALUES('activity_notification', $1, $2) ON CONFLICT(dedupe_key) DO NOTHING`,
          [`activity:${activity.rows[0].id}`, JSON.stringify({ activityId: activity.rows[0].id, itemId: inserted.rows[0].id })],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
