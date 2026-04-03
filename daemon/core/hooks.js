/**
 * EventEmitter-based addon hook system.
 *
 * Hook points:
 *   onMessage(msg)                  - before routing; return false to skip
 *   onBeforeClaude(prompt, context) - modify prompt before sending to Claude
 *   onAfterClaude(result, context)  - post-process Claude result
 *   onReaction(emoji, msg)          - custom reaction handlers
 *   onStartup(client, config)       - addon initialization
 *   onShutdown()                    - cleanup
 */

import { EventEmitter } from 'node:events';

class HookRegistry extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    /** @type {Map<string, { name: string, hooks: string[] }>} */
    this._addons = new Map();
  }

  async registerAddon(name, setupFn) {
    if (this._addons.has(name)) {
      throw new Error(`Addon "${name}" is already registered`);
    }

    const hookedEvents = [];
    const originalOn = this.on.bind(this);

    const trackedOn = (event, fn) => {
      hookedEvents.push(event);
      return originalOn(event, fn);
    };

    const proxy = new Proxy(this, {
      get(target, prop) {
        if (prop === 'on' || prop === 'addListener') return trackedOn;
        return Reflect.get(target, prop);
      },
    });

    await setupFn(proxy);
    this._addons.set(name, { name, hooks: hookedEvents });
  }

  async emitFilter(event, ...args) {
    const listeners = this.listeners(event);
    for (const listener of listeners) {
      const result = await listener(...args);
      if (result === false) {
        return false;
      }
    }
    return true;
  }

  async emitTransform(event, value, ...args) {
    const listeners = this.listeners(event);
    let current = value;
    for (const listener of listeners) {
      const result = await listener(current, ...args);
      if (result !== undefined) {
        current = result;
      }
    }
    return current;
  }

  listAddons() {
    return [...this._addons.values()];
  }
}

export const hooks = new HookRegistry();
export { HookRegistry };
