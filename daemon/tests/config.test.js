import { describe, it, expect } from 'vitest';
import { buildConfig, validateConfig } from '../core/config.js';

describe('buildConfig', () => {
  it('builds config from env with defaults', () => {
    const config = buildConfig({
      DISCORD_BOT_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: 'test-app-id',
    });

    expect(config.discord.botToken).toBe('test-token');
    expect(config.discord.applicationId).toBe('test-app-id');
    expect(config.discord.guildId).toBeNull();
    expect(config.discord.channelId).toBeNull();
    expect(config.locale).toBe('en');
    expect(config.requireMention).toBe(true);
    expect(config.dm.enabled).toBe(true);
    expect(config.claude.cliPath).toBe('claude');
    expect(config.dedup.ttlMs).toBe(60000);
  });

  it('respects custom env values', () => {
    const config = buildConfig({
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_GUILD_ID: 'guild-123',
      LOCALE: 'zh-TW',
      REQUIRE_MENTION: 'false',
      DM_ENABLED: 'false',
      INIT_TIMEOUT_SEC: '60',
    });

    expect(config.discord.guildId).toBe('guild-123');
    expect(config.locale).toBe('zh-TW');
    expect(config.requireMention).toBe(false);
    expect(config.dm.enabled).toBe(false);
    expect(config.claude.initTimeoutMs).toBe(60000);
  });

  it('config is frozen', () => {
    const config = buildConfig({
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_APPLICATION_ID: 'app',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.discord)).toBe(true);
  });
});

describe('validateConfig', () => {
  it('throws when required fields are missing', () => {
    const config = buildConfig({});
    expect(() => validateConfig(config)).toThrow('DISCORD_BOT_TOKEN');
  });

  it('does not throw when required fields are present', () => {
    const config = buildConfig({
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_APPLICATION_ID: 'app',
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});
