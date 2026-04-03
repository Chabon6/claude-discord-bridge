import { describe, it, expect } from 'vitest';
import { toDiscordMarkdown, splitMessage } from '../core/format.js';

describe('toDiscordMarkdown', () => {
  it('returns empty string for falsy input', () => {
    expect(toDiscordMarkdown('')).toBe('');
    expect(toDiscordMarkdown(null)).toBe('');
    expect(toDiscordMarkdown(undefined)).toBe('');
  });

  it('passes through normal markdown unchanged', () => {
    const input = '**bold** and *italic* and `code`';
    expect(toDiscordMarkdown(input)).toBe(input);
  });

  it('closes unclosed code blocks', () => {
    const input = '```js\nconsole.log("hello")';
    const result = toDiscordMarkdown(input);
    expect(result).toContain('```');
    const count = (result.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });
});

describe('splitMessage', () => {
  it('does not split short messages', () => {
    const chunks = splitMessage('hello world');
    expect(chunks).toEqual(['hello world']);
  });

  it('splits long messages at newlines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(30)}`);
    const text = lines.join('\n');
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('preserves all content after splitting', () => {
    const text = 'a'.repeat(3000);
    const chunks = splitMessage(text, 1000);
    const joined = chunks.join('');
    expect(joined.length).toBe(text.length);
  });
});
