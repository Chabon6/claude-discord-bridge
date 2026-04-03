import { describe, it, expect } from 'vitest';
import { acquireThreadLock, isThreadLocked, activeLocksCount } from '../core/thread-lock.js';

describe('ThreadLock', () => {
  it('acquires and releases a lock', async () => {
    const release = await acquireThreadLock('test-thread-1');
    expect(isThreadLocked('test-thread-1')).toBe(true);
    release();
    expect(isThreadLocked('test-thread-1')).toBe(false);
  });

  it('queues second request for same thread', async () => {
    const order = [];
    const release1 = await acquireThreadLock('test-thread-2');
    order.push('acquired-1');

    const p2 = acquireThreadLock('test-thread-2').then((release2) => {
      order.push('acquired-2');
      release2();
    });

    // release1 should unblock p2
    order.push('releasing-1');
    release1();
    await p2;

    expect(order).toEqual(['acquired-1', 'releasing-1', 'acquired-2']);
  });

  it('different threads run in parallel', async () => {
    const release1 = await acquireThreadLock('parallel-a');
    const release2 = await acquireThreadLock('parallel-b');
    expect(activeLocksCount()).toBeGreaterThanOrEqual(2);
    release1();
    release2();
  });
});
