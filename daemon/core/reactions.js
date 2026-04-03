/**
 * Discord emoji reaction helpers.
 *
 * Provides a clean interface for adding/removing Discord reactions.
 * Uses Unicode emoji directly (Discord supports Unicode emoji natively).
 */

/**
 * Create reaction helpers with configurable emoji.
 *
 * @param {{ ack: string, typing: string, done: string, error: string }} emojis - Unicode emoji characters
 */
export function createReactions(emojis) {
  /**
   * Safely add a reaction. Silently ignores errors.
   *
   * @param {import('discord.js').Message} message
   * @param {string} emoji - Unicode emoji character
   */
  async function addReaction(message, emoji) {
    try { await message.react(emoji); }
    catch { /* ignore — reaction may already exist or no permission */ }
  }

  /**
   * Safely remove the bot's own reaction. Silently ignores errors.
   *
   * @param {import('discord.js').Message} message
   * @param {string} emoji - Unicode emoji character
   */
  async function removeReaction(message, emoji) {
    try {
      const reaction = message.reactions.cache.get(emoji);
      if (reaction) {
        await reaction.users.remove(message.client.user.id);
      }
    } catch { /* ignore */ }
  }

  return {
    addAck: (msg) => addReaction(msg, emojis.ack),
    addTyping: (msg) => addReaction(msg, emojis.typing),
    removeTyping: (msg) => removeReaction(msg, emojis.typing),
    addDone: (msg) => addReaction(msg, emojis.done),
    addError: (msg) => addReaction(msg, emojis.error),
  };
}
