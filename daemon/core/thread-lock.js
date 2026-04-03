/**
 * Per-Thread Queue Lock
 *
 * Ensures that messages within the SAME thread are processed sequentially,
 * while messages across DIFFERENT threads run in parallel.
 *
 * Includes a configurable max queue depth to prevent unbounded memory growth.
 */

const MAX_QUEUE_DEPTH = 3;

const locks = new Map();   // threadId -> { queue: Promise, depth: number }

/**
 * Acquire a per-thread lock. Returns a release function.
 * Throws if the queue for this thread exceeds MAX_QUEUE_DEPTH.
 *
 * @param {string} threadId
 * @returns {Promise<() => void>}
 */
export function acquireThreadLock(threadId) {
  const entry = locks.get(threadId);

  if (entry && entry.depth >= MAX_QUEUE_DEPTH) {
    throw new Error('Thread queue is full. Please wait for the current task to finish.');
  }

  let resolve;
  const newTail = new Promise((r) => { resolve = r; });

  const release = () => {
    resolve();
    const current = locks.get(threadId);
    if (current) {
      current.depth--;
      if (current.queue === newTail && current.depth <= 0) {
        locks.delete(threadId);
      }
    }
  };

  if (!entry) {
    locks.set(threadId, { queue: newTail, depth: 1 });
    return Promise.resolve(release);
  }

  const previousQueue = entry.queue;
  entry.queue = newTail;
  entry.depth++;

  return previousQueue.then(() => release);
}

export function isThreadLocked(threadId) {
  return locks.has(threadId);
}

export function activeLocksCount() {
  return locks.size;
}

export function getQueueDepth(threadId) {
  return locks.get(threadId)?.depth ?? 0;
}

/**
 * Clear all locks. For test teardown only.
 */
export function clearAllLocks() {
  locks.clear();
}
