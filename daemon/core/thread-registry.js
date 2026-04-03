/**
 * Thread Registry -- maps threadId to session context.
 *
 * Each thread/channel maintains a Claude session ID so subsequent replies
 * can resume the same session (full tool results + reasoning preserved).
 *
 * Structure:
 *   threadId -> { type, sessionId, metadata, createdAt, lastActivity }
 *
 * Factory function: all configuration via parameters, no global state.
 */

/**
 * @param {object} options
 * @param {number} [options.ttlMs=43200000] - Inactivity timeout in ms (default: 12h)
 * @returns {object} Thread registry interface
 */
export function createThreadRegistry({ ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const registry = new Map();

  function register(threadId, type, metadata = {}) {
    registry.set(threadId, {
      type,
      sessionId: null,
      metadata: { ...metadata },
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
    });
  }

  function get(threadId) {
    return registry.get(threadId) ?? null;
  }

  function has(threadId) {
    return registry.has(threadId);
  }

  function setSessionId(threadId, sessionId) {
    const entry = registry.get(threadId);
    if (entry) {
      entry.sessionId = sessionId;
      entry.lastActivity = Date.now();
    }
  }

  function touch(threadId) {
    const entry = registry.get(threadId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  function remove(threadId) {
    registry.delete(threadId);
  }

  function list() {
    return Object.fromEntries(registry);
  }

  function pruneStale() {
    const now = Date.now();
    let pruned = 0;
    for (const [id, entry] of registry) {
      if (now - entry.lastActivity > ttlMs) {
        registry.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  return {
    register,
    get,
    has,
    setSessionId,
    touch,
    remove,
    list,
    pruneStale,
    get size() { return registry.size; },
  };
}
