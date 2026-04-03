import { describe, it, expect } from 'vitest';
import { createDedupCache } from '../core/dedup-cache.js';

describe('DedupCache', () => {
  it('returns false for new message, true for duplicate', () => {
    const cache = createDedupCache();
    expect(cache.isDuplicate('msg-1')).toBe(false);
    expect(cache.isDuplicate('msg-1')).toBe(true);
  });

  it('tracks different messages independently', () => {
    const cache = createDedupCache();
    expect(cache.isDuplicate('msg-1')).toBe(false);
    expect(cache.isDuplicate('msg-2')).toBe(false);
    expect(cache.isDuplicate('msg-1')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('evicts expired entries when above maxSize', () => {
    const cache = createDedupCache({ ttlMs: 1, maxSize: 2 });
    cache.isDuplicate('msg-1');
    cache.isDuplicate('msg-2');

    // Wait for TTL expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    // Adding a third entry should trigger eviction of expired ones
    cache.isDuplicate('msg-3');
    // msg-1 and msg-2 should be evicted since they're expired
    expect(cache.isDuplicate('msg-1')).toBe(false);
  });

  it('clear resets the cache', () => {
    const cache = createDedupCache();
    cache.isDuplicate('msg-1');
    cache.isDuplicate('msg-2');
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.isDuplicate('msg-1')).toBe(false);
  });
});
