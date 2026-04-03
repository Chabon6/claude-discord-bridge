import { describe, it, expect } from 'vitest';
import { createI18n } from '../core/i18n.js';

describe('i18n', () => {
  it('loads English messages by default', () => {
    const i18n = createI18n('en');
    expect(i18n.locale).toBe('en');
    expect(i18n.t('shutdown')).toContain('shutting down');
  });

  it('resolves nested keys', () => {
    const i18n = createI18n('en');
    expect(i18n.t('session.created', { sessionId: 'abc' })).toContain('abc');
  });

  it('substitutes variables', () => {
    const i18n = createI18n('en');
    const result = i18n.t('error', { message: 'test-error' });
    expect(result).toContain('test-error');
  });

  it('returns key for missing translations', () => {
    const i18n = createI18n('en');
    expect(i18n.t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('falls back to English for unknown locale', () => {
    const i18n = createI18n('xx-XX');
    expect(i18n.t('shutdown')).toContain('shutting down');
  });

  it('loads zh-TW messages', () => {
    const i18n = createI18n('zh-TW');
    expect(i18n.locale).toBe('zh-TW');
    expect(i18n.t('shutdown')).toContain('關閉');
  });
});
