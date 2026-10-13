import test from "node:test";
import assert from "node:assert/strict";
import { MONITOR_COPY, monitorLocale, monitorText } from "../incident-copy.js";
import { translateManager } from '../../manager-language.js';

test("monitor incident copy has complete four-locale catalogs and matching placeholders", () => {
  const keys = Object.keys(MONITOR_COPY.en).sort();
  for (const locale of ["en", "ru", "es", "zh"]) {
    assert.deepEqual(Object.keys(MONITOR_COPY[locale]).sort(), keys, `${locale} keys`);
    for (const key of keys) {
      const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(placeholders(MONITOR_COPY[locale][key]), placeholders(MONITOR_COPY.en[key]), `${locale}.${key} placeholders`);
    }
  }
});

test("monitor incident copy defaults to English and respects each configured locale", () => {
  assert.equal(monitorLocale(undefined), "en");
  assert.equal(monitorLocale({ MONITOR_LOCALE: "es" }), "es");
  assert.equal(monitorLocale({ MONITOR_LOCALE: "zh" }), "zh");
  assert.match(monitorText(undefined, "prefix_recovered"), /^✅ Recovered$/);
  assert.match(monitorText({ MONITOR_LOCALE: "ru" }, "prefix_recovered"), /Восстановлено/);
  assert.match(monitorText({ MONITOR_LOCALE: "es" }, "prefix_recovered"), /Recuperado/);
  assert.match(monitorText({ MONITOR_LOCALE: "zh" }, "prefix_recovered"), /已恢复/);
});

test('storage instructions use the actual manager menu label in every locale', () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const label = translateManager(locale, '🗄️ Хранилище').replace(/^🗄️\s*/u, '');
    assert.ok(monitorText(locale, 'storage_admin').includes(label), `${locale}: ${label}`);
  }
});

test("monitor incident copy exposes missing supported-locale keys instead of falling back", () => {
  assert.throws(() => monitorText({ MONITOR_LOCALE: "es" }, "missing_key"), /Missing monitor translation: es\.missing_key/);
});
