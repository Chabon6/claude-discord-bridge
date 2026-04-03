import { describe, it, expect } from 'vitest';
import { createThreadRegistry } from '../core/thread-registry.js';

describe('ThreadRegistry', () => {
  it('registers and retrieves a thread', () => {
    const reg = createThreadRegistry();
    reg.register('thread-1', 'ad-hoc', { initiator: 'user-1' });
    const entry = reg.get('thread-1');
    expect(entry).not.toBeNull();
    expect(entry.type).toBe('ad-hoc');
    expect(entry.metadata.initiator).toBe('user-1');
    expect(entry.sessionId).toBeNull();
  });

  it('sets and retrieves session ID', () => {
    const reg = createThreadRegistry();
    reg.register('thread-2', 'ad-hoc');
    reg.setSessionId('thread-2', 'session-abc');
    expect(reg.get('thread-2').sessionId).toBe('session-abc');
  });

  it('has() returns correct boolean', () => {
    const reg = createThreadRegistry();
    expect(reg.has('nope')).toBe(false);
    reg.register('exists', 'ad-hoc');
    expect(reg.has('exists')).toBe(true);
  });

  it('remove() deletes a thread', () => {
    const reg = createThreadRegistry();
    reg.register('del-me', 'ad-hoc');
    reg.remove('del-me');
    expect(reg.has('del-me')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('pruneStale removes inactive threads', () => {
    const reg = createThreadRegistry({ ttlMs: 1 });
    reg.register('stale', 'ad-hoc');

    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const pruned = reg.pruneStale();
    expect(pruned).toBe(1);
    expect(reg.has('stale')).toBe(false);
  });

  it('touch updates lastActivity', () => {
    const reg = createThreadRegistry({ ttlMs: 50 });
    reg.register('active', 'ad-hoc');
    const before = reg.get('active').lastActivity;

    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    reg.touch('active');
    expect(reg.get('active').lastActivity).toBeGreaterThan(before);
  });

  it('list returns all threads', () => {
    const reg = createThreadRegistry();
    reg.register('a', 'ad-hoc');
    reg.register('b', 'ad-hoc');
    const all = reg.list();
    expect(Object.keys(all)).toEqual(['a', 'b']);
  });
});
