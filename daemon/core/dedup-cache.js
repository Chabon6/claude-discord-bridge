/**
 * Dedup Cache -- prevents double-processing of the same message.
 *
 * Discord can deliver the same event multiple times.
 * TTL-based with max size eviction.
 */

/**
 * @param {object} options
 * @param {number} [options.ttlMs=60000]
 * @param {number} [options.maxSize=500]
 */
export function createDedupCache({ ttlMs = 60_000, maxSize = 500 } = {}) {
  const cache = new Map();

  function isDuplicate(messageId) {
    const now = Date.now();

    if (cache.size > maxSize) {
      for (const [key, timestamp] of cache) {
        if (now - timestamp > ttlMs) {
          cache.delete(key);
        }
      }
    }

    if (cache.has(messageId)) {
      return true;
    }

    cache.set(messageId, now);
    return false;
  }

  return {
    isDuplicate,
    clear() { cache.clear(); },
    get size() { return cache.size; },
  };
}
