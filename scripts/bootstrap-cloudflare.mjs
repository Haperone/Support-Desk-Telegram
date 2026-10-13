import { ACCOUNT } from './bootstrap-state.mjs';

// Credentials stay in memory. Failure simply falls back to entering the public subdomain.
export async function discoverWorkersOrigin(accountId, worker, credentials, fetchImpl = fetch) {
  if (!ACCOUNT.test(accountId || '')) return null;
  const headers = credentials?.token ? { authorization: `Bearer ${credentials.token}` } : null;
  if (!headers) return null;
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      headers, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) return null;
    const data = await response.json();
    const name = data?.result?.subdomain;
    if (data.success !== true || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name || '')) return null;
    return `https://${worker}.${name}.workers.dev`;
  } catch { return null; }
}
