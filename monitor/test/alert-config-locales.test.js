import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_CONFIG_MESSAGES, localizedAlertConfigError, readAlertRoute } from '../alert-config.js';

const locales=['en','ru','es','zh'];
const errorKeys=['keyUnavailable','tokenCorrupt','recipients','outcomeUnknown','rateLimited','botAccess','missingKey','stale',
  'tokenAdmin','usernameBot','startBot','noBot','group','mode','same','disabled'];
const fill=(template,values={})=>template.replace(/\{(\d+)\}/g,(_match,index)=>values[index]??'');

test('alert route configuration errors have complete four-language copy',async()=>{
  for(const [key,copies] of Object.entries(ALERT_CONFIG_MESSAGES)) {
    assert.deepEqual(Object.keys(copies).sort(),locales.slice().sort(),`${key} locale coverage`);
    for(const locale of ['es','zh']) {
      assert.notEqual(copies[locale],copies.en,`${locale} English fallback for ${key}`);
      assert.equal(/[А-Яа-яЁё]/.test(copies[locale]),false,`${locale} Russian text for ${key}`);
    }
  }
  const messages={en:'The alert settings key is missing. Delivery is stopped.',ru:'Ключ настроек алертов отсутствует. Доставка остановлена.',es:'Falta la clave de configuración de alertas. Se ha detenido la entrega.',zh:'缺少警报设置密钥。消息投递已停止。'};
  for(const locale of locales) await assert.rejects(
    readAlertRoute({ALERT_CONFIG_REQUIRED:'true',MONITOR_LOCALE:locale}),new RegExp(messages[locale].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('known alert configuration errors translate across source and target locales',()=>{
  for(const key of errorKeys.filter(key=>key!=='startBot')) {
    for(const source of locales) for(const target of locales) {
      const values={0:'alerts_bot'};
      if(key==='rateLimited') values[0]='37';
      const original=fill(ALERT_CONFIG_MESSAGES[key][source],values);
      assert.equal(localizedAlertConfigError(original,target),fill(ALERT_CONFIG_MESSAGES[key][target],values),`${key}: ${source} → ${target}`);
    }
  }
  for(const wrapperSource of locales) for(const reasonSource of locales) for(const target of locales) {
    const reason=ALERT_CONFIG_MESSAGES.rateLimited[reasonSource].replace('{0}','37');
    const original=fill(ALERT_CONFIG_MESSAGES.startBot[wrapperSource],{0:'alerts_bot',1:reason});
    const expected=fill(ALERT_CONFIG_MESSAGES.startBot[target],{0:'alerts_bot',1:ALERT_CONFIG_MESSAGES.rateLimited[target].replace('{0}','37')});
    assert.equal(localizedAlertConfigError(original,target),expected,`startBot: ${wrapperSource} + ${reasonSource} → ${target}`);
  }
});

test('alert error localization rejects unknown or non-error messages',()=>{
  for(const locale of locales) {
    assert.equal(localizedAlertConfigError('An arbitrary message containing private details',locale),null);
    assert.equal(localizedAlertConfigError(ALERT_CONFIG_MESSAGES.connectProbe[locale],locale),null);
    assert.equal(localizedAlertConfigError(`${ALERT_CONFIG_MESSAGES.botAccess[locale]} extra`,locale),null);
    assert.equal(localizedAlertConfigError(fill(ALERT_CONFIG_MESSAGES.rateLimited[locale],{0:'private details'}),locale),null);
    assert.equal(localizedAlertConfigError(fill(ALERT_CONFIG_MESSAGES.startBot[locale],{0:'invalid username',1:ALERT_CONFIG_MESSAGES.botAccess[locale]}),locale),null);
  }
});
