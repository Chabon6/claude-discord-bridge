/**
 * Markdown formatter for Discord.
 *
 * Discord supports standard markdown natively, so the main job is
 * to ensure content fits within Discord's 2000-char message limit
 * and strip any unsupported elements.
 */

const DISCORD_MAX_LEN = 2000;
const SAFE_MAX_LEN = 1950; // Leave margin for prefix/suffix

/**
 * Format a Claude response for Discord.
 * Discord supports: **bold**, *italic*, `code`, ```code blocks```,
 * > blockquotes, # headers (limited), ||spoilers||, lists, links.
 *
 * @param {string} text
 * @returns {string}
 */
export function toDiscordMarkdown(text) {
  if (!text) return '';

  let result = text;

  // Ensure code blocks are properly closed
  const codeBlockCount = (result.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    result += '\n```';
  }

  return result;
}

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 * Splits at newlines when possible, otherwise at the character limit.
 *
 * @param {string} text
 * @param {number} [maxLen=1950]
 * @returns {string[]}
 */
export function splitMessage(text, maxLen = SAFE_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) {
      // No good newline — split at space
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt < maxLen / 2) {
      // No good split point — hard split
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
