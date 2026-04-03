import { describe, it, expect, vi } from 'vitest';
import { createReactions } from '../core/reactions.js';

describe('Reactions', () => {
  const emojis = {
    ack: '\uD83D\uDC40',
    typing: '\u231B',
    done: '\u2705',
    error: '\u274C',
  };

  function mockMessage() {
    const reactions = new Map();
    return {
      react: vi.fn(),
      reactions: {
        cache: {
          get: (emoji) => reactions.get(emoji),
        },
      },
      client: { user: { id: 'bot-123' } },
    };
  }

  it('addAck calls message.react with ack emoji', async () => {
    const rx = createReactions(emojis);
    const msg = mockMessage();
    await rx.addAck(msg);
    expect(msg.react).toHaveBeenCalledWith(emojis.ack);
  });

  it('addTyping calls message.react with typing emoji', async () => {
    const rx = createReactions(emojis);
    const msg = mockMessage();
    await rx.addTyping(msg);
    expect(msg.react).toHaveBeenCalledWith(emojis.typing);
  });

  it('addDone calls message.react with done emoji', async () => {
    const rx = createReactions(emojis);
    const msg = mockMessage();
    await rx.addDone(msg);
    expect(msg.react).toHaveBeenCalledWith(emojis.done);
  });

  it('swallows errors silently', async () => {
    const rx = createReactions(emojis);
    const msg = mockMessage();
    msg.react.mockRejectedValue(new Error('no permission'));
    // Should not throw
    await rx.addAck(msg);
  });
});
