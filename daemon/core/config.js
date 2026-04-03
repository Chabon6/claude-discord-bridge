/**
 * Centralized configuration with validation.
 *
 * Build a frozen config object from environment variables.
 * All values have sensible defaults except DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.
 */

/**
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Readonly<object>}
 */
export function buildConfig(env = process.env) {
  return Object.freeze({
    discord: Object.freeze({
      botToken: env.DISCORD_BOT_TOKEN,
      applicationId: env.DISCORD_APPLICATION_ID,
      guildId: env.DISCORD_GUILD_ID || null,
      channelId: env.DISCORD_CHANNEL_ID || null,
    }),
    dm: Object.freeze({
      enabled: env.DM_ENABLED !== 'false',
      allowlist: (env.DM_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean),
    }),
    claude: Object.freeze({
      cliPath: env.CLAUDE_CLI_PATH || 'claude',
      cwd: env.CLAUDE_CWD || env.USERPROFILE || env.HOME,
      initTimeoutMs: parseInt(env.INIT_TIMEOUT_SEC || '300', 10) * 1000,
      execTimeoutMs: parseInt(env.EXEC_TIMEOUT_SEC || '3600', 10) * 1000,
      defaultPermissionMode: env.PERMISSION_MODE || 'full-auto',
    }),
    locale: env.LOCALE || 'en',
    requireMention: env.REQUIRE_MENTION !== 'false',
    emojis: Object.freeze({
      ack: env.ACK_EMOJI || '\uD83D\uDC40',           // eyes
      typing: env.TYPING_EMOJI || '\u231B',             // hourglass
      done: env.DONE_EMOJI || '\u2705',                 // white_check_mark
      error: env.ERROR_EMOJI || '\u274C',               // x
    }),
    dedup: Object.freeze({
      ttlMs: parseInt(env.DEDUP_TTL_MS || '60000', 10),
      maxSize: parseInt(env.DEDUP_MAX_SIZE || '500', 10),
    }),
    thread: Object.freeze({
      ttlMs: parseInt(env.THREAD_TTL_MS || String(12 * 60 * 60 * 1000), 10),
    }),
    log: Object.freeze({
      dir: env.LOG_DIR || 'logs',
      retentionDays: parseInt(env.LOG_RETENTION_DAYS || '7', 10),
    }),
  });
}

/**
 * Validate that all required config values are present.
 *
 * @param {Readonly<object>} config
 */
export function validateConfig(config) {
  const missing = [];
  if (!config.discord.botToken) missing.push('DISCORD_BOT_TOKEN');
  if (!config.discord.applicationId) missing.push('DISCORD_APPLICATION_ID');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in your Discord Bot credentials.'
    );
  }
}
