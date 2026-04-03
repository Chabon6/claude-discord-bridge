#!/usr/bin/env node

/**
 * Register Discord slash commands globally or for a specific guild.
 *
 * Usage:
 *   node scripts/register-commands.js                    # Global registration
 *   node scripts/register-commands.js --guild 123456     # Guild-specific
 *   node scripts/register-commands.js --delete           # Delete all commands
 */

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!TOKEN || !APP_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const guildIdx = args.indexOf('--guild');
const guildId = guildIdx !== -1 ? args[guildIdx + 1] : process.env.DISCORD_GUILD_ID;
const isDelete = args.includes('--delete');

const commands = [
  new SlashCommandBuilder()
    .setName('claude-resume')
    .setDescription('Resume a previous Claude session')
    .addStringOption(opt =>
      opt.setName('session-id')
        .setDescription('The session ID to resume')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('prompt')
        .setDescription('Optional prompt to send')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-stop')
    .setDescription('Force-stop a running Claude task')
    .addStringOption(opt =>
      opt.setName('session-id')
        .setDescription('Session ID prefix to stop (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-status')
    .setDescription('Show currently running Claude tasks'),

  new SlashCommandBuilder()
    .setName('claude-mode')
    .setDescription('View or switch the Claude permission mode for this thread')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Permission mode to set')
        .setRequired(false)
        .addChoices(
          { name: 'full-auto (all tools, no prompts)', value: 'full-auto' },
          { name: 'auto (classifier reviews actions)', value: 'auto' },
          { name: 'acceptEdits (auto-accept edits)', value: 'acceptEdits' },
          { name: 'plan (read-only, no edits)', value: 'plan' },
          { name: 'dontAsk (only pre-approved tools)', value: 'dontAsk' },
        )),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  const route = guildId
    ? Routes.applicationGuildCommands(APP_ID, guildId)
    : Routes.applicationCommands(APP_ID);

  if (isDelete) {
    await rest.put(route, { body: [] });
    console.log(`Deleted all slash commands (${guildId ? `guild: ${guildId}` : 'global'})`);
  } else {
    const data = await rest.put(route, { body: commands });
    console.log(`Registered ${data.length} slash commands (${guildId ? `guild: ${guildId}` : 'global'})`);
  }
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
