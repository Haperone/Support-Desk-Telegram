import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_COPY, statusLocale, statusText } from '../tgcloud/lib/copy.js';
import { formatStatus } from '../tgcloud/lib/status.js';

const now = new Date('2026-10-12T18:00:00Z');
const snapshot = () => ({ schemaVersion: 1, overall: 'degraded', support: 'partial', monitorDatabase: 'unavailable',
  checks: ['usage', 'd1_analytics', 'storage', 'delivery', 'alerts', 'maintenance', 'runtime'].map((id, index) =>
    ({ id, status: ['available', 'degraded', 'stale'][index % 3], measuredAt: now.toISOString() })),
  services: [{ name: 'Customer service', status: 'stale', measuredAt: null }],
  incidents: { total: null, items: [] }, alerts: { route: 'disabled', lastSuccessAt: null, lastFailureAt: now.toISOString() },
  runtimeEnabled: false });

test('all status copy has four languages, identical placeholders and no text from another language', () => {
  const keys = Object.keys(STATUS_COPY.en).sort();
  const slots = text => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort();
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    assert.deepEqual(Object.keys(STATUS_COPY[locale]).sort(), keys);
    for (const key of keys) {
      const value = STATUS_COPY[locale][key];
      assert.ok(value.trim());
      assert.deepEqual(slots(value), slots(STATUS_COPY.en[key]), `${locale}.${key}`);
      if (locale !== 'ru') assert.doesNotMatch(value, /[А-Яа-яЁё]/u);
      if (locale !== 'zh') assert.doesNotMatch(value, /\p{Script=Han}/u);
    }
  }
  assert.equal(statusLocale('unsupported'), 'en');
  assert.equal(statusText('es', 'historical', { time: '$& {time}', age: '2' }), 'Último resultado recibido: $& {time} (2).');
  assert.throws(() => statusText('en', 'missing'), /Missing status translation/);
});

test('healthy, incomplete, cached and failed status screens render every locale with localized times', () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    for (const error of [null, 'not_configured', 'unreachable', 'unauthorized', 'invalid_response', 'local_state_unavailable']) {
      for (const saved of [null, snapshot()]) {
        const view = { error, snapshot: saved, fetchedAt: new Date(now.getTime() - 95 * 60_000).toISOString() };
        const text = formatStatus(view, now, locale);
        assert.ok(text.startsWith(statusText(locale, 'title')));
        assert.doesNotMatch(text, /undefined|\{(?:time|age|count|status|zone)\}/);
        if (locale !== 'ru') assert.doesNotMatch(text, /[А-Яа-яЁё]/u, text);
        if (locale !== 'zh') assert.doesNotMatch(text, /\p{Script=Han}/u, text);
        if (saved && error && error !== 'not_configured') assert.ok(text.includes(statusText(locale, 'historicalWarning')));
      }
    }
    const healthy = { ...snapshot(), overall: 'healthy', support: 'available', monitorDatabase: 'available' };
    const text = formatStatus({ snapshot: healthy, fetchedAt: now.toISOString() }, now, locale);
    assert.ok(text.includes(statusText(locale, 'healthy')));
    assert.ok(text.includes(statusText(locale, 'minutesAgo', { minutes: 0 })));
  }
});

test('status keeps service names and stored incident text intact, including words that match UI labels', () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const data = snapshot();
    data.services[0].name = 'Пользователи';
    data.incidents.items = [{ message: 'Storage\noperator $& {value}' }];
    const text = formatStatus({ snapshot: data, fetchedAt: now.toISOString() }, now, locale);
    assert.ok(text.includes('Пользователи:'));
    assert.ok(text.includes('• Storage operator $& {value}'));
    assert.ok(text.includes(statusText(locale, 'incidentLanguage')));
  }
});
