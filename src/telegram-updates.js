// Every webhook writer must retain updates used by bot registration.
export const BOT_UPDATES = Object.freeze(['message', 'callback_query', 'message_reaction', 'managed_bot']);
export function reactionUpdates(includeReactions) {
  return BOT_UPDATES.filter(type => includeReactions || type !== 'message_reaction');
}
