# Documentation

[Project overview](../README.md) · [О проекте на русском](../README_RU.md)

Choose a guide in your language. Run all shell commands from the **repository root**,
unless a guide explicitly says otherwise.

| Topic / Тема | English | Русский |
| --- | --- | --- |
| First launch / Первый запуск | [Setup wizard and manual setup](en/first-launch.md) | [Мастер и ручная настройка](ru/first-launch.md) |
| Manager / Управляющий бот | [Groups, services, operators, alerts](en/manager-bot.md) | [Группы, сервисы, операторы, алерты](ru/manager-bot.md) |
| Reports / Отчёты | [Statistics and schedules](en/reports.md) | [Статистика и расписания](ru/reports.md) |
| Reactions / Реакции | [Check both directions](en/reactions.md) | [Проверка направлений](ru/reactions.md) |
| Delivery / Доставка | [Recover queued messages](en/delivery-recovery.md) | [Восстановление очереди](ru/delivery-recovery.md) |
| Delete replies / Удаление ответов | [Delete a mirrored reply](en/message-deletion.md) | [Удаление ответа у клиента](ru/message-deletion.md) |
| Storage / Хранилище | [Retention and cleanup](en/retention.md) | [Хранение и очистка](ru/retention.md) |
| Monitoring / Мониторинг | [Usage, health, and plan](en/monitoring.md) | [Ресурсы, здоровье и тариф](ru/monitoring.md) |
| Alert bot status / Статус алерт-бота | [Telegram Serverless](en/alert-status.md) | [Telegram Serverless](ru/alert-status.md) |
| Moderation alerts / События доступа | [User access events](en/access-alerts.md) | [События доступа](ru/access-alerts.md) |
| Database upgrade / Обновление БД | [Migrations and backups](en/database-upgrade.md) | [Миграции и резервные копии](ru/database-upgrade.md) |
| Earlier setup / Прежняя установка | [Archived setup](en/legacy-setup.md) | [Архивная инструкция](ru/legacy-setup.md) |

## Repository layout

| Folder | Contents |
| --- | --- |
| `src/` | Main support Worker and shared application modules |
| `monitor/` | Monitoring Worker, its migrations, and tests |
| `alert-serverless/` | Optional Telegram Serverless status component |
| `scripts/` | Setup wizard, maintenance, and local validation tools |
| `test/` | Main application and setup tests |
| `migrations/` | Main D1 schema migrations |
| `database/` | Historical migration compatibility data |
| `docs/en/`, `docs/ru/` | English and Russian guides |

Entry configurations remain at `wrangler.toml` and `monitor/wrangler.toml`.
Launch the wizard with `npm run setup`; run local tests with `npm test`.
