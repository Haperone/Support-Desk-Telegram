# Delete an operator reply

[Documentation](../README.md) · [Русский](../ru/message-deletion.md)

In the support topic, reply to **your own sent message** with
`/delete@your_service_bot`. Plain `/delete` also works in that service's topic.
The command is not forwarded to the customer. For an album, only the selected item
is deleted. The service bot needs **Delete Messages** permission in the support group.

The bot deletes the confirmed customer copy first, then the original in the topic.
If customer-side deletion is not confirmed, the original remains. After a partial
result, inspect the topic and retry the command if the original is still visible.
Deleting through Telegram's ordinary message menu does **not** synchronize deletion
to the customer. Topic panels and case screens display a reminder of this distinction.

## Limits and uncertain results

Telegram generally allows deletion of messages less than 48 hours old. A dice
message in a private chat can only be deleted after 24 hours, while still subject to
the overall 48-hour limit. See [deleteMessage](https://core.telegram.org/bots/api#deletemessage).

A 429, server failure, timeout, or invalid JSON does not confirm deletion. Success
requires an accepted API response or the specific 400 “message to delete not found”
response for the already known message ID. A missing mapping cannot be guessed.

The action rechecks operator access and holds the existing operator lock. Losing the
lock after the first deletion stops the second. Old mappings from a different group
or topic do not qualify. Mappings remain available for a safe retry; this command
does not enqueue a background deletion that could bypass a later permission check.

The audit records confirmed results without duplicating an entry on webhook replay.
A partial result and a later success are separate observations. Confirmed absence of
an already deleted message does not create a Telegram-failure statistic.

This feature requires no new service, polling, Cron, or migration. It shares the
existing D1 invocation budget. Tests cover permissions, API failures, unknown outcomes,
albums, replay, topic changes, lock loss, and low remaining query budgets.
