# Cloudflare Usage Monitor

Независимый `/status` того же алерт-бота на Telegram Serverless и защищённый endpoint здоровья:
[подключение и ограничения](../alert-serverless/README.md). Секрет чтения статуса `STATUS_READ_TOKEN`
отдельный от Telegram bot token; обычная отправка алертов остаётся на Cloudflare.

Новые проверки размеров D1, сбоев доставки, входящего webhook и optional CPU: [полная инструкция](../OPERATIONS_RETENTION.md), [English](../OPERATIONS_RETENTION_EN.md). Точка входа Wrangler теперь `service-entry.js`; `entry.js` остаётся тестируемым обработчиком Cron.

Отдельный Cloudflare Worker для контроля Workers, D1 и Workers KV: суточных квот Free или включённых месячных объёмов Paid. Он запускается Cron Trigger каждые 15 минут, читает account-wide аналитику через официальный GraphQL Analytics API, хранит snapshots/dedup/health state в D1 и отправляет предупреждения в Telegram.

Monitor не использует Workers KV: состояние хранится в D1 binding `MONITOR_DB`. `SUPPORT_PLAN` → `CloudflarePlan` читает настройку плана, `SUPPORT_HEALTH` → `SupportHealth` возвращает агрегаты очередей и проверку webhook. Прямого доступа к SUPPORT_DB и текстам переписки у монитора нет. `StorageHealth` отдаёт сохранённые измерения размеров в панель основного бота.

Язык Telegram-уведомлений задаёт несекретная переменная `MONITOR_LOCALE`: `en` (по умолчанию), `ru`, `es` или `zh` (упрощённый китайский). Настройка применяется к предупреждениям об использовании, сбоях монитора, событиях доступа и тексту прогноза размера хранилища.

## Что реализовано

- Workers requests, D1 rows read/written и KV read/write/delete/list за текущий UTC-день на Free или расчётный месяц на Paid;
- пороги 70/85/95%, каждый уровень максимум один раз на метрику и период; переключение Free/Paid не смешивает snapshots, прогноз и dedup;
- прогноз по snapshot примерно час назад: минимум 30% использования, положительный burn rate, ETA не больше `PREDICTIVE_WARNING_HOURS`;
- top Workers scripts и KV namespaces, когда эти dimensions доступны в live GraphQL schema;
- snapshots и breakdown в D1, автоматическое удаление истории старше 7 дней;
- health alert после трех последовательных ошибок Cloudflare API и одно recovery-сообщение после восстановления;
- проверка HTTP status, Telegram `ok` и `description`; неотправленный alert не попадает в dedup;
- расчет локального времени reset через IANA timezone с автоматическим CET/CEST.

Daily summary и `/usage` относятся к P2 и пока не включены. Переменная `DAILY_SUMMARY=false` зарезервирована для совместимости с ТЗ.

## Подготовка

Из корня репозитория:

```powershell
npx wrangler d1 create support-monitor
```

Запишите полученный `database_id` в `monitor/wrangler.toml`, затем примените migration:

```powershell
npx wrangler d1 migrations apply support-monitor --remote --config monitor/wrangler.toml
```

Новая база `MONITOR_DB` получает `0005_initial_schema.sql` и `0006_alert_delivery_config.sql`. Существующей базе нужен [однократный переход](../DATABASE_SETUP.md), без повторного создания таблиц. При первой установке используйте [актуальный порядок](../DEPLOY_FIRST_TIME_RU.md): основной Worker временно без трёх связей с монитором, затем монитор, затем основной Worker со связями.

Замените только обычные variables в `monitor/wrangler.toml`:

- `CF_ACCOUNT_ID` — Cloudflare Account ID;
- `ALERT_CHAT_ID` — Telegram chat/supergroup ID только для старого маршрута алертов через файл;
- `ALERT_THREAD_ID` — ID forum topic только для того же старого маршрута; в новой установке адрес выбирается в **Админушка → Алерты**;
- при необходимости добавьте `KV_NAMESPACE_NAMES` как JSON-объект `namespace-id -> понятное имя`;
- скорректируйте limits, thresholds и `DISPLAY_TIMEZONE`.

В `[[services]]` проверьте `service`: это имя основного Worker (по умолчанию `telegram-private-chatbot`). Сначала разверните основной Worker с `entry.js` и named entrypoint `CloudflarePlan`, затем монитор.

## Единый план Free/Paid

Главный администратор выбирает план в личке Админушки: **План и хранилище → План Cloudflare**. Монитор перечитывает его перед каждым запуском. `RECOVERY_D1_PLAN` основного Worker действует, пока Админушка не сохранила явный выбор; «Использовать конфиг» возвращает это поведение. Обновление переменной требует deploy, переключение в Админушке — нет. При самостоятельном запуске монитора без `SUPPORT_PLAN` задайте `RECOVERY_D1_PLAN` и `WORKERS_BILLING_DAY` в его собственных `[vars]`.

На Paid нужен день продления подписки (1–31) из Cloudflare Billing. Он сохраняется в Админушке либо задаётся в `WORKERS_BILLING_DAY` основного Worker. Период начинается в этот день UTC; для коротких месяцев день ограничивается последним числом. Например, 6 сентября с днём продления 17 монитор запрашивает данные с 17 августа. Без дня продления месячные данные не объявляются достоверными.

| Метрика | Free, за сутки | Paid, включено за расчётный месяц |
| --- | ---: | ---: |
| Workers requests | 100 000 | 10 000 000 |
| D1 rows read | 5 000 000 | 25 000 000 000 |
| D1 rows written | 100 000 | 50 000 000 |
| KV reads | 100 000 | 10 000 000 |
| KV writes / deletes / lists, каждая | 1 000 | 1 000 000 |

Эти значения соответствуют [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) и [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/). На Paid превышение включённого объёма оплачивается дополнительно; уведомление не означает остановку запросов. Это монитор перечисленных метрик, а не расчёт полного счёта: CPU и хранение здесь не учитываются.

`LIMIT_*` относятся только к Free. Для собственных порогов Paid используйте `PAID_LIMIT_WORKER_REQUESTS`, `PAID_LIMIT_D1_ROWS_READ`, `PAID_LIMIT_D1_ROWS_WRITTEN`, `PAID_LIMIT_KV_READS/WRITES/DELETES/LISTS`. Старые дневные значения не переносятся на Paid. Ограничение D1 50/1000 запросов на запуск основного Worker независимо от этих квот.

Если план недоступен или день продления не настроен, запуск возвращает ошибку `monitor_plan_unavailable`. Критические предупреждения по суточным ориентирам Free сохраняются даже при отказе обеих D1, но явно помечаются как неподтверждённый план и не попадают в обычную историю периода. После трёх подряд ошибок с доступной базой состояния приходит health alert. Это не молчаливое переключение подтверждённого Paid на Free.

Пример дополнительных vars:

```toml
ALERT_THREAD_ID = "123"
KV_NAMESPACE_NAMES = '{"0123456789abcdef":"Folder Links"}'
```

Не записывайте токены в TOML, JS, README или Git. Создайте Cloudflare API Token для аналитики; для измерения размера баз ему также нужен D1 Read (или отдельный `CF_D1_READ_TOKEN` с этим правом). Добавьте секрет аналитики:

```powershell
npx wrangler secret put CF_ANALYTICS_TOKEN --config monitor/wrangler.toml
```

`ALERT_BOT_TOKEN` нужен лишь старой установке с маршрутом из TOML. В новой установке токен алерт-бота вводится через **Админушка → Алерты**.

После миграции `0006` создайте `ALERT_CONFIG_KEY` командой `powershell.exe -NoProfile -File scripts/initialize-alert-config-key.ps1` из корня проекта. Он защищает токен алерт-бота, введённый через управляющий бот; локальная резервная копия шифруется Windows DPAPI. Не заменяйте ключ после подключения бота. `ALERT_BOT_TOKEN` и адрес из TOML действуют как прежний маршрут до первого изменения через интерфейс. После отключения через интерфейс прежний маршрут не восстанавливается автоматически.

Global API Key, Workers Edit, KV Write и Account Edit не нужны.

## Проверка и deploy

Unit tests не требуют внешних сервисов:

```powershell
node --test monitor/test/monitor.test.js
```

После настройки сначала проверьте сборщик на тестовом/небоевом Worker и посмотрите structured logs. Затем deploy выполняется отдельно от support Worker:

```powershell
npx wrangler deploy --config monitor/wrangler.toml
npx wrangler tail telegram-support-usage-monitor
```

Cron в `wrangler.toml`: `*/15 * * * *`.

## Обязательная live-проверка GraphQL

Cloudflare описывает GraphQL schema как динамическую: набор datasets/fields, beta/deprecation и доступность зависят от аккаунта и тарифа. Поэтому репозиторный тест не может доказать доступность fields для конкретного токена.

Monitor сначала запрашивает:

- `workersInvocationsAdaptive`: `sum.requests` + `dimensions.scriptName`;
- account-wide `kvOperationsAdaptiveGroups`: `sum.requests` + `dimensions.actionType`;
- отдельный такой же запрос с `filter.namespaceId` для каждого ID из `KV_NAMESPACE_NAMES`.

`namespaceId` по официальной схеме является filter, а не output dimension, поэтому список отслеживаемых namespaces задаётся явно. Ошибка отдельного namespace-запроса пишет `kv_namespace_breakdown_failed`, помечает breakdown как `partial`, но не скрывает account-wide totals и alerts. Ошибка основного account-wide запроса учитывается health monitor. Для Workers недоступный `scriptName` переключается в total-only schema fallback.

После первого запуска обязательно:

1. Убедитесь в логе `monitor_check_complete`, что пять counters ненулевые/правдоподобные и `breakdown_status` ожидаемый.
2. Сравните значения с Cloudflare Dashboard за тот же UTC-день (Free) или период от дня продления (Paid), учитывая задержку analytics. Поля `plan`, `period_start`, `period_end` в логе показывают выбранный период.
3. Если Workers включил fallback или KV breakdown стал `partial`, выполните introspection в Cloudflare GraphQL Explorer и проверьте токен/namespace IDs.
4. Временно понизьте limits в тестовом окружении и подтвердите threshold, dedup, Telegram topic и повтор после Telegram error.

Cloudflare отдельно предупреждает, что GraphQL analytics — агрегированная аналитика, а не точный billing meter; разумная задержка/погрешность ожидаема.

Официальные источники:

- [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [Cloudflare GraphQL introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/)
- [Workers metrics query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Workers KV metrics and queries](https://developers.cloudflare.com/kv/observability/metrics-analytics/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Эксплуатационные ограничения

- До 100 строк breakdown сохраняются одним SQL statement; отметки достигнутых порогов также записываются одним запросом. Локальные тесты проверяют предел 50 D1 statements на полный запуск, включая семь одновременных уведомлений, перехват истёкших leases и восстановление API/телеметрии.
- Проверка раз в 15 минут не способна предупредить о мгновенном скачке от безопасного уровня до 100% раньше исчерпания account-wide Workers quota.
- KV analytics фильтруется по `Date`, поэтому запрос текущего UTC-дня возвращает накопленный дневной счетчик; Workers query ограничен точным интервалом от 00:00 UTC до текущего времени.
- KV breakdown строится только для IDs, явно перечисленных в `KV_NAMESPACE_NAMES`; account-wide totals всегда считаются отдельно.
- Secrets и authorization headers никогда не логируются. GraphQL errors ограничиваются текстом ответа без request headers.
