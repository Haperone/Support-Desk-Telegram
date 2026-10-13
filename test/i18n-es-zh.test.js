import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAccessEvent } from '../user-access-alerts.js';
import { formatUsageAlert } from '../monitor/worker.js';
import { storageChinese, storageEnglish, storageSpanish, storageText } from '../storage-copy.js';

test('access alerts render Spanish and Chinese copy without Russian labels', () => {
  const event={kind:'auto_restricted',service:'Soporte',user_id:42,first_name:'Ana',username:'ana',created_at:'2026-09-01T10:00:00Z',deadline:'2026-09-01T11:00:00Z',detail:'4',risk_score:4,queued:2,muted_until:'2026-09-01T11:00:00Z',support_group_id:-1001234567890,thread_id:55};
  for (const [locale, expected] of [['es','Usuario'],['zh','用户']]) {
    const text=formatAccessEvent(event,'Europe/Madrid',new Date('2026-09-01T10:30:00Z'),locale);
    assert.match(text,new RegExp(expected));
    assert.match(text,/https:\/\/t\.me\/c\/1234567890\/55/);
    assert.doesNotMatch(text,/[А-Яа-яЁё]/);
  }
  assert.match(formatAccessEvent(event,'Europe/Madrid',new Date(),'ru'),/Пользователь/);
  assert.match(formatAccessEvent(event,'Europe/Madrid',new Date(),'en'),/User:/);
  assert.match(formatAccessEvent(event),/User:/);
});

test('monitor usage alerts localize Spanish and Chinese labels and metric names', () => {
  const now=new Date('2026-09-01T10:00:00Z');
  const usage={worker_requests:850,workerBreakdown:[],d1Breakdown:[],kvBreakdown:[],period:{plan:'free',start:'2026-09-01',end:'2026-09-02'}};
  const period={plan:'free',start:'2026-09-01',end:'2026-09-02',key:'2026-09-01'};
  for (const [locale, expected] of [['es','Solicitudes de Workers'],['zh','Workers 请求数']]) {
    const text=formatUsageAlert('worker_requests',850,1000,'85',null,usage,now,'Europe/Madrid',period,locale);
    assert.match(text,new RegExp(expected));
    assert.match(text,locale==='es'?/Restante/:/剩余/);
    assert.doesNotMatch(text,/[А-Яа-яЁё]/);
  }
  assert.match(formatUsageAlert('worker_requests',850,1000,'85',null,usage,now,'UTC',period,'en'),/Workers requests/);
  assert.match(formatUsageAlert('worker_requests',850,1000,'85',null,usage,now,'UTC',period,'ru'),/Запросы Workers/);
});

test('storage copy has complete Spanish and Chinese catalogs without English or Russian fallbacks', () => {
  assert.equal(storageText()('Хранилище обращений'),'Conversation storage');
  assert.equal(storageText('es')('Хранилище обращений'),'Almacenamiento de conversaciones');
  assert.equal(storageText('zh')('Хранилище обращений'),'会话存储');
  for (const [locale, dictionary] of [['es',storageSpanish],['zh',storageChinese]]) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(storageEnglish).sort(), `${locale} catalog keys differ`);
    assert.deepEqual(Object.keys(storageEnglish).filter(key=>!dictionary[key]),[],`${locale} translation catalog is incomplete`);
    for (const key of Object.keys(storageEnglish)) {
      assert.doesNotMatch(storageText(locale)(key),/[А-Яа-яЁё]/,`${locale} leaked Russian from ${key}`);
      assert.notEqual(dictionary[key],storageEnglish[key],`${locale} fell back to English for ${key}`);
      const slots=value=>[...value.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
      assert.deepEqual(slots(dictionary[key]),slots(key),`${locale} placeholders differ for ${key}`);
    }
  }
  assert.throws(() => storageText('es')('missing storage key'), /Missing storage translation: es\.missing storage key/);
});
