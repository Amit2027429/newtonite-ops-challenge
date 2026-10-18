export async function enqueueActivity(db, itemId, actorId, eventType, details) {
  const activity = await db.query(
    `INSERT INTO activity_events(item_id, actor_id, event_type, details)
     VALUES($1, $2, $3, $4) RETURNING id`,
    [itemId, actorId, eventType, JSON.stringify(details)],
  );
  await db.query(
    `INSERT INTO outbox_jobs(job_type, dedupe_key, payload)
     VALUES('activity_notification', $1, $2)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      `activity:${activity.rows[0].id}`,
      JSON.stringify({ activityId: activity.rows[0].id, itemId, eventType, actorId }),
    ],
  );
}
