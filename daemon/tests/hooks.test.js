import { describe, it, expect } from 'vitest';
import { HookRegistry } from '../core/hooks.js';

describe('HookRegistry', () => {
  it('registers an addon and tracks hooks', async () => {
    const hooks = new HookRegistry();
    await hooks.registerAddon('test-addon', (h) => {
      h.on('onMessage', () => {});
      h.on('onBeforeClaude', () => {});
    });

    const addons = hooks.listAddons();
    expect(addons).toHaveLength(1);
    expect(addons[0].name).toBe('test-addon');
    expect(addons[0].hooks).toContain('onMessage');
    expect(addons[0].hooks).toContain('onBeforeClaude');
  });

  it('prevents duplicate addon registration', async () => {
    const hooks = new HookRegistry();
    await hooks.registerAddon('dup', () => {});
    await expect(hooks.registerAddon('dup', () => {}))
      .rejects.toThrow('already registered');
  });

  it('emitFilter returns true when all listeners allow', async () => {
    const hooks = new HookRegistry();
    hooks.on('onMessage', () => true);
    hooks.on('onMessage', () => true);
    expect(await hooks.emitFilter('onMessage')).toBe(true);
  });

  it('emitFilter returns false when any listener vetoes', async () => {
    const hooks = new HookRegistry();
    hooks.on('onMessage', () => true);
    hooks.on('onMessage', () => false);
    expect(await hooks.emitFilter('onMessage')).toBe(false);
  });

  it('emitTransform chains transformations', async () => {
    const hooks = new HookRegistry();
    hooks.on('onBeforeClaude', (text) => text + ' [addon-1]');
    hooks.on('onBeforeClaude', (text) => text + ' [addon-2]');
    const result = await hooks.emitTransform('onBeforeClaude', 'original');
    expect(result).toBe('original [addon-1] [addon-2]');
  });

  it('emitTransform preserves value when listener returns undefined', async () => {
    const hooks = new HookRegistry();
    hooks.on('onBeforeClaude', () => {}); // returns undefined
    const result = await hooks.emitTransform('onBeforeClaude', 'keep-me');
    expect(result).toBe('keep-me');
  });
});
