-- A menu send must have one owner. An expired claim is uncertain because the
-- Telegram send may have succeeded before its response was lost.
ALTER TABLE support_groups ADD COLUMN menu_claim_token TEXT;
ALTER TABLE support_groups ADD COLUMN menu_claim_expires_at TEXT;
