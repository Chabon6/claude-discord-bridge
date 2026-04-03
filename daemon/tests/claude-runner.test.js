import { describe, it, expect } from 'vitest';
import { normalizePermissionMode, VALID_PERMISSION_MODES } from '../core/claude-runner.js';

describe('VALID_PERMISSION_MODES', () => {
  it('contains expected modes', () => {
    expect(VALID_PERMISSION_MODES.has('full-auto')).toBe(true);
    expect(VALID_PERMISSION_MODES.has('auto')).toBe(true);
    expect(VALID_PERMISSION_MODES.has('acceptEdits')).toBe(true);
    expect(VALID_PERMISSION_MODES.has('plan')).toBe(true);
    expect(VALID_PERMISSION_MODES.has('dontAsk')).toBe(true);
  });

  it('has exactly 5 modes', () => {
    expect(VALID_PERMISSION_MODES.size).toBe(5);
  });
});

describe('normalizePermissionMode', () => {
  it('returns valid modes unchanged', () => {
    for (const mode of VALID_PERMISSION_MODES) {
      expect(normalizePermissionMode(mode)).toBe(mode);
    }
  });

  it('falls back to full-auto for invalid input', () => {
    expect(normalizePermissionMode('invalid')).toBe('full-auto');
    expect(normalizePermissionMode('')).toBe('full-auto');
    expect(normalizePermissionMode(undefined)).toBe('full-auto');
    expect(normalizePermissionMode(null)).toBe('full-auto');
  });

  it('is case-sensitive', () => {
    expect(normalizePermissionMode('Auto')).toBe('full-auto');
    expect(normalizePermissionMode('PLAN')).toBe('full-auto');
    expect(normalizePermissionMode('Full-Auto')).toBe('full-auto');
  });
});
