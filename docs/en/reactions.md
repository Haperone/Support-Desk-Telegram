# Check and enable message reactions

[Documentation](../README.md) · [Русский](../ru/reactions.md)

Check each service bot separately as the main administrator. The test creates no
customer case and triggers no welcome message or CAPTCHA. Both directions are enabled
automatically only when both pass.

## Run the check

1. Open the service card in the manager's private chat and choose the reaction check.
2. Follow its link to the service bot and press Start using your administrator account.
   The bot prepares one test message privately and another in General.
3. Open the General test message. Add **👍**, wait for the next instruction, replace it
   with **👀**, wait again, then remove your reaction. Watch the private copy update.
4. Repeat that sequence on the **private test message** to check the reverse direction.
5. Return to the manager, refresh the result, and confirm both directions passed.
   Then try a reaction on an ordinary conversation message.

React to the two dedicated test messages, not the settings panel. Rapidly performing
all three actions without waiting does not replace the sequential check.

## If the check stalls

Refresh the result. A missing step means the relevant Telegram event has not arrived
or the mirrored change was not confirmed. Inspect any reported error, remove your
reaction, and repeat the requested action. Check group administrator permissions and
that 👍 and 👀 are allowed in the group's reaction settings.

The bot subscribes to `message_reaction`; Telegram's event requirements do not guarantee
that every private-chat direction is available. An absent event is not a passed test.
You can enable **only the direction that passed** manually in service settings.
The test link expires after 20 minutes; unconfirmed directions remain unconfirmed.

If preparation was interrupted, close the check and start a new one. Old buttons and
reactions cannot confirm a newer test. Reopening a valid link reuses its test messages.
A recheck does not disable a previously enabled direction; turn it off yourself while
investigating if it stopped working. Disabling requires no test.

## Supported behavior

The code supports the 73 standard Telegram emoji reactions in its catalog, including
🔥, 🥰, 🎉, 💯, and 🤝. Equivalent emoji variants such as ❤️ and ❤ are normalized.
Setting, replacing, and removing a reaction are mirrored. The bot sets one reaction
per destination message; when several are received, the last supported standard one
is selected. The destination chat must allow that reaction.

Custom emoji, paid reactions, and emoji outside the catalog are not mirrored. Replacing
a supported reaction with an unsupported one clears its previous mirror. The bot's own
reactions are not mirrored back. Testing one bot does not certify other service bots.

## Upgrade an older installation

Migration `0030` added reaction checks. Back up D1, apply pending migrations, then deploy
the main Worker with your installation's configuration. Do not edit already-applied
migrations. If bot registration was never installed, also provision `BOT_REGISTRY_KEY`
as described in [First launch](first-launch.md). Expanding the standard reaction catalog
alone needs no new migration or recheck of already confirmed directions.

See [Telegram update types](https://core.telegram.org/bots/api#update) and
[setMessageReaction](https://core.telegram.org/bots/api#setmessagereaction).
