-- Remember the actual CAPTCHA message so success can replace it without a new
-- message or a stale Verify button. Legacy notices have no recoverable message ID.
ALTER TABLE verification_challenges ADD COLUMN notice_message_id INTEGER;
ALTER TABLE verification_challenges ADD COLUMN notice_resolved_at TEXT;
ALTER TABLE verification_challenges ADD COLUMN notice_resolution_token TEXT;
ALTER TABLE verification_challenges ADD COLUMN notice_resolution_started_at TEXT;
ALTER TABLE verification_challenges ADD COLUMN notice_retry_at TEXT;
CREATE INDEX verification_notice_pending ON verification_challenges(bot_id, COALESCE(notice_retry_at, verified_at))
  WHERE status = 'passed' AND notice_message_id IS NOT NULL AND notice_resolved_at IS NULL
    AND notice_resolution_started_at IS NULL;
