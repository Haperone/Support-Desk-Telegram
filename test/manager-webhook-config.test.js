import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebhookConfig } from '../scripts/telegram-webhook.mjs';

test('manager webhook config is independent of client BOT_REGISTRY entries', () => {
  const config = readWebhookConfig(`PUBLIC_BASE_URL = "https://support.example.workers.dev"
MANAGER_BOT_USERNAME = "manager_bot"`, 'manager');
  assert.deepEqual(config, { username: 'manager_bot', secretBinding: 'MANAGER_WEBHOOK_SECRET',
    url: 'https://support.example.workers.dev/tg/manager', manager: true });
  assert.throws(() => readWebhookConfig('PUBLIC_BASE_URL = "https://support.example.workers.dev"', 'manager'),
    /MANAGER_BOT_USERNAME/);
});
