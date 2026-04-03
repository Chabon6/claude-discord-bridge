#!/usr/bin/env node

/**
 * claude-discord-bridge -- CLI entry point
 *
 * Usage:
 *   npx claude-discord-bridge          # Start the bridge
 *   npx claude-discord-bridge --help   # Show help
 *   npx claude-discord-bridge --check  # Validate config without starting
 */

import 'dotenv/config';
import { createBridge } from '../core/index.js';
import { buildConfig, validateConfig } from '../core/config.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-discord-bridge -- Discord <-> Claude Code bridge

Usage:
  claude-discord-bridge              Start the bridge
  claude-discord-bridge --check      Validate .env config without starting
  claude-discord-bridge --help       Show this help message

Required environment variables:
  DISCORD_BOT_TOKEN        Discord bot token
  DISCORD_APPLICATION_ID   Discord application (client) ID

See .env.example for all configuration options.
  `);
  process.exit(0);
}

if (args.includes('--check')) {
  try {
    const config = buildConfig();
    validateConfig(config);
    console.log('Configuration is valid.');
    console.log(`  Bot token: ${config.discord.botToken ? 'set' : 'MISSING'}`);
    console.log(`  Application ID: ${config.discord.applicationId ? 'set' : 'MISSING'}`);
    console.log(`  Guild: ${config.discord.guildId || 'all guilds'}`);
    console.log(`  Channel: ${config.discord.channelId || 'all channels'}`);
    console.log(`  Locale: ${config.locale}`);
    console.log(`  Mention required: ${config.requireMention}`);
    console.log(`  DM enabled: ${config.dm.enabled}`);
    console.log(`  Claude CLI: ${config.claude.cliPath}`);
    console.log(`  Claude CWD: ${config.claude.cwd}`);
    process.exit(0);
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
}

// Start the bridge
try {
  const bridge = await createBridge();

  console.log(`
  claude-discord-bridge is running!

  Bot: ${bridge.client.user.tag} (${bridge.botUserId})
  Guild: ${bridge.config.discord.guildId || 'all guilds'}
  Channel: ${bridge.config.discord.channelId || 'all channels'}
  Locale: ${bridge.config.locale}
  Mention required: ${bridge.config.requireMention}
  DM enabled: ${bridge.config.dm.enabled}

  Press Ctrl+C to stop.
  `);
} catch (err) {
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
}
