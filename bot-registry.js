import { parseBotRegistry } from './worker.js';
import { DEFAULT_LANGUAGE } from './language.js';
import { resolveInvocationDatabase } from './recovery-budget.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hydrated = Symbol('hydrated bot registry');
export const MAX_REGISTERED_BOTS = 50;
export { BOT_UPDATES } from './telegram-updates.js';

export function registrationEnabled(env) { return env.BOT_ONBOARDING_ENABLED === 'true'; }
export function validRegistryKey(env) { return /^[a-f0-9]{64}$/i.test(env.BOT_REGISTRY_KEY || ''); }
function bytes64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function base64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
async function key(env) {
  if (!validRegistryKey(env)) throw new Error('Bot registry encryption key is unavailable');
  const bytes = Uint8Array.from(env.BOT_REGISTRY_KEY.match(/../g), value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealCredentials(env, identity, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('bot-registry:v1:' + identity) },
    await key(env), encoder.encode(JSON.stringify(value)));
  return 'v1.' + base64(iv) + '.' + base64(data);
}
export async function openCredentials(env, identity, value) {
  const [version, iv, data, extra] = String(value).split('.');
  if (version !== 'v1' || !iv || !data || extra) throw new Error('Invalid encrypted bot credentials');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes64(iv), additionalData: encoder.encode('bot-registry:v1:' + identity) },
    await key(env), bytes64(data));
  return JSON.parse(decoder.decode(plain));
}
export function registeredConfig(me, displayName, topicPrefix) {
  return { id: 'bot-' + me.id, displayName, topicPrefix, username: me.username, locale: DEFAULT_LANGUAGE, enabled: true,
    tokenBinding: 'REGISTERED_' + me.id + '_TOKEN', webhookSecretBinding: 'REGISTERED_' + me.id + '_WEBHOOK' };
}
export function webhookUrl(env, botId) {
  const origin = new URL(env.PUBLIC_BASE_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
  }
  return new URL('/tg/' + botId, origin).href;
}

// No cross-request cache: adding a bot and changing its token must be visible to
// webhook, Cron and private RPC invocations immediately. Count this lookup in D1's budget.
export async function withBotRegistry(env, mode = 'webhook') {
  if (!registrationEnabled(env) || env[hydrated]) return env;
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, mode);
  const rows = await db.prepare('SELECT bot_id, config_json, credentials, status FROM registered_bots ORDER BY sequence LIMIT ?')
    .bind(MAX_REGISTERED_BOTS).all();
  let configs = JSON.parse(env.BOT_REGISTRY || '[]');
  if (configs.length) {
    const adopted = await db.prepare('SELECT bot_id FROM adopted_static_bots').all();
    const adoptedIds = new Set((adopted.results || []).map(row => row.bot_id));
    configs = configs.filter(item => !adoptedIds.has(item.id));
  }
  const result = { ...env, SUPPORT_DB: db, DYNAMIC_BOT_STATES: {}, [hydrated]: true };
  for (const row of rows.results || []) {
    const config = JSON.parse(row.config_json);
    if (configs.some(item => item.id === row.bot_id)) throw new Error('Static and registered bot IDs conflict');
    result.DYNAMIC_BOT_STATES[row.bot_id] = row.status;
    try {
      const credentials = await openCredentials(env, row.bot_id, row.credentials);
      result[config.tokenBinding] = credentials.token;
      result[config.webhookSecretBinding] = credentials.webhookSecret;
    } catch {
      // A damaged credential must not interrupt the other support bots.
      result.DYNAMIC_BOT_STATES[row.bot_id] = 'credentials_unavailable';
    }
    configs.push({ ...config, enabled: result.DYNAMIC_BOT_STATES[row.bot_id] === 'active' });
  }
  result.BOT_REGISTRY = JSON.stringify(configs);
  parseBotRegistry(result.BOT_REGISTRY);
  return result;
}
