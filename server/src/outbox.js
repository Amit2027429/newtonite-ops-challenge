import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export async function deliverActivityNotification(job) {
  await pool.query(
    `INSERT INTO notifications(outbox_job_id, payload)
     VALUES($1, $2) ON CONFLICT(outbox_job_id) DO NOTHING`,
    [job.id, JSON.stringify(job.payload)],
  );
}

export async function processOutboxBatch({
  workerId = randomUUID(),
  batchSize = 10,
  handler = deliverActivityNotification,
  baseDelayMs = 1000,
  maxDelayMs = 300000,
  leaseMs = 60000,
} = {}) {
  const client = await pool.connect();
  let jobs;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE outbox_jobs SET status='dead', locked_by=NULL, locked_until=NULL,
         last_error=COALESCE(last_error, 'Worker lease expired after the maximum number of attempts')
       WHERE status='processing' AND locked_until<NOW() AND attempts>=max_attempts`,
    );
    const claimed = await client.query(
      `WITH candidates AS (
         SELECT id FROM outbox_jobs
         WHERE attempts < max_attempts
           AND ((status='pending' AND available_at <= NOW())
             OR (status='processing' AND locked_until < NOW()))
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE outbox_jobs AS job
       SET status='processing', attempts=job.attempts+1,
           locked_by=$2, locked_until=NOW() + ($3 * INTERVAL '1 millisecond')
       FROM candidates
       WHERE job.id=candidates.id
       RETURNING job.id, job.job_type, job.payload, job.attempts, job.max_attempts`,
      [batchSize, workerId, leaseMs],
    );
    jobs = claimed.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const results = [];
  for (const job of jobs) {
    try {
      await handler(job);
      await pool.query(
        `UPDATE outbox_jobs
         SET status='completed', completed_at=NOW(), locked_by=NULL, locked_until=NULL, last_error=NULL
         WHERE id=$1 AND status='processing' AND locked_by=$2`,
        [job.id, workerId],
      );
      results.push({ id: job.id, status: 'completed' });
    } catch (error) {
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, job.attempts - 1)));
      const state = job.attempts >= job.max_attempts ? 'dead' : 'pending';
      await pool.query(
        `UPDATE outbox_jobs
         SET status=$3, available_at=NOW() + ($4 * INTERVAL '1 millisecond'),
             locked_by=NULL, locked_until=NULL, last_error=$5
         WHERE id=$1 AND status='processing' AND locked_by=$2`,
        [job.id, workerId, state, delay, String(error?.message || 'Handler failed').slice(0, 1000)],
      );
      results.push({ id: job.id, status: state, error: String(error?.message || 'Handler failed') });
    }
  }
  return results;
}
