const BURST_MS = 10_000;
const LEASE_MS = 60_000;

export async function claimManagerHome(db, actorId, updateId, at = new Date()) {
  const token = crypto.randomUUID(), timestamp = at.toISOString();
  const row = await db.prepare(`INSERT INTO manager_home_screens
    (operator_id,update_id,requested_at,claim_token,lease_expires_at)
    VALUES(?,?,?,?,?) ON CONFLICT(operator_id) DO UPDATE SET
      message_id=CASE WHEN manager_home_screens.requested_at>=? THEN manager_home_screens.message_id ELSE NULL END,
      update_id=excluded.update_id,requested_at=excluded.requested_at,completed=0,
      claim_token=excluded.claim_token,lease_expires_at=excluded.lease_expires_at
    WHERE (manager_home_screens.claim_token IS NULL OR manager_home_screens.lease_expires_at<=excluded.requested_at)
      AND (excluded.update_id>manager_home_screens.update_id
        OR excluded.update_id=manager_home_screens.update_id AND manager_home_screens.completed=0)
    RETURNING message_id`)
    .bind(actorId, updateId, timestamp, token, new Date(at.getTime() + LEASE_MS).toISOString(),
      new Date(at.getTime() - BURST_MS).toISOString()).first();
  // A concurrent home command is already covered by the active renderer. A
  // replayed completed command or an older update must not overwrite newer UI.
  return row ? { token, messageId: row.message_id } : null;
}

export async function completeManagerHome(db, actorId, token, messageId) {
  await db.prepare(`UPDATE manager_home_screens SET message_id=?,completed=1,claim_token=NULL,lease_expires_at=NULL
    WHERE operator_id=? AND claim_token=?`).bind(messageId || null, actorId, token).run();
}

export async function releaseManagerHome(db, actorId, token) {
  await db.prepare('UPDATE manager_home_screens SET claim_token=NULL,lease_expires_at=NULL WHERE operator_id=? AND claim_token=?')
    .bind(actorId, token).run();
}
