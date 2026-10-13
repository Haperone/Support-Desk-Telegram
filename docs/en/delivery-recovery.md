# Recover queued delivery

[Documentation](../README.md) · [Русский](../ru/delivery-recovery.md)

Open delivery recovery from the manager's private chat, either for a service or from
the control/recovery section. It retries messages already saved by the application.
It does not bypass moderation or force Telegram to resend updates not yet received.

## Read the result

The report shows progress and remaining messages, blocked steps, Telegram errors,
and retry deadlines. **Refresh result** only reads state. A finished attempt does
not mean the whole queue was delivered: one run is limited to 12 stages, so a large
queue may need several runs. A `+` means more items exist than the displayed sample.

Only one manual run can be active. It shares per-user and per-operation locks with
Cron and webhook delivery. After a Worker interruption, the saved report remains;
after two minutes the run is marked interrupted and no longer blocks a new one.
An interrupted run may already have delivered some messages.

The same recovery mechanisms handle deleted topics, conversation reopening, albums,
and releasing messages after verification or restriction expiry. A full database reset
blocks new runs and stops a running one when its data generation changes.

## When not to retry blindly

- Restore a bot's group access first if Telegram rejected delivery for permissions.
- Wait until a confirmed Telegram rate limit expires; retries honor `retry_after`.
- Inspect **uncertain** delivery manually. Telegram may have accepted a message even
  when its response was lost; an automatic resend could duplicate it.
- Some unfinished operator sends need the original update to recover the sender and
  reply parameters. The report exposes these records without inventing a replacement.
- Messages discarded by moderation or a rate limit may need the customer to resend
  them after the restriction is removed. They are not all retained in the queue.

Reply `/status` to a particular operator message in its topic to inspect its delivery.
The refresh button rereads actual database state. If the bot displaying the panel is
itself rate-limited, the saved report can be viewed after Telegram access recovers.

Recovery does not reset CAPTCHA, restrictions, deduplication, uncertain outcomes, or
conversation history. A clear queue and a passed CAPTCHA are different conditions.

## CAPTCHA confirmation

After a successful check, the web page shows success and the Telegram verification
message is updated with its button removed. Failed editing is retried in the background,
including after the delivery queue finishes. Opening the link again does not duplicate
confirmation, and a busy queue does not invalidate an accepted verification.

For buttons created by older versions that did not save the message ID, the original
message cannot be edited automatically. Reopening a still-valid old link can send a
single confirmation; the old button may be removed manually. Deployment does not send
confirmation messages to every previously verified user.

## Upgrade and checks

Migrations `0026_manual_delivery_runs.sql` and `0027_verification_notice_status.sql`
introduced the recovery history/lock and saved verification-message status. The run
history is bounded to the latest 20 manual runs. For current code, follow the complete
[database upgrade guide](database-upgrade.md), apply all pending migrations, then deploy
the changed Worker using your own configuration. Historical upgrades from `0025`
needed those two migrations and one main Worker deploy, without new secrets or webhooks.

Recovery and verification-status stages use internal Worker entrypoints with their
own query budgets; they do not create another public HTTP endpoint. Test with your own
customer/operator accounts and inspect both the topic and private chat.
