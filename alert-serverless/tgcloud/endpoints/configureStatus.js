import { api, db, EndpointError } from 'sdk';
import { authorized, configureStatus } from '../lib/status.js';
import { ALERT_BOT_ID, DISPLAY_TIMEZONE } from '../lib/settings.js';
import { statusLocale, statusText } from '../lib/copy.js';

export default async function (input, ctx) {
  try {
    if (!authorized(ctx?.initData?.user?.id)) throw new Error('forbidden');
    const me = await api.getMe();
    if (me.id !== ALERT_BOT_ID) throw new Error('wrong_bot');
    if (input?.probe === true) return { botId: me.id, username: me.username,
      timers: typeof setTimeout === 'function', abortController: typeof AbortController === 'function',
      url: typeof URL === 'function', localizedTime: new Date().toLocaleString(statusLocale(), { timeZone: DISPLAY_TIMEZONE }) };
    return await configureStatus(input, ctx?.initData?.user?.id, db);
  }
  catch { throw new EndpointError(statusText(undefined, 'configureError')); }
}
