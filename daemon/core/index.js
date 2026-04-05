/**
 * Core entry point -- wires all modules together and starts the Discord-Claude bridge.
 *
 * Architecture:
 *   createBridge(options) -- factory that wires everything, starts the bot, returns control object
 *
 * Features:
 *   - Two-phase execution (init session -> resume execution)
 *   - Message routing with mention gating, dedup, channel filter
 *   - Streaming progress with debounced narration
 *   - File handling (download attachments, upload output files)
 *   - Discord thread support (auto-create threads for conversations)
 *   - Slash commands (/claude-resume, /claude-stop, /claude-status)
 *   - DM support with allowlist policy
 *   - Session recovery from message history
 *   - Addon auto-discovery from addons/ directory
 *   - Graceful startup/shutdown with periodic cleanup
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
} from 'discord.js';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, validateConfig } from './config.js';
import { createClaudeRunner, VALID_PERMISSION_MODES, normalizePermissionMode } from './claude-runner.js';
import { createFileHandler } from './file-handler.js';
import { createThreadRegistry } from './thread-registry.js';
import { createDedupCache } from './dedup-cache.js';
import { createReactions } from './reactions.js';
import { createLogger } from './logger.js';
import { createI18n } from './i18n.js';
import { hooks, HookRegistry } from './hooks.js';
import { toDiscordMarkdown, splitMessage } from './format.js';
import { acquireThreadLock, isThreadLocked, activeLocksCount } from './thread-lock.js';
import { createCommandDiscovery, VALID_COMMAND_NAME } from './command-discovery.js';

export { toDiscordMarkdown, splitMessage } from './format.js';
export { acquireThreadLock, isThreadLocked, activeLocksCount } from './thread-lock.js';
export { hooks, HookRegistry };

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Prompt template loader
// ---------------------------------------------------------------------------

function loadPromptTemplates() {
  const dir = join(__dirname, '..', 'templates', 'prompts');
  const load = (name) => {
    try { return readFileSync(join(dir, name), 'utf-8'); }
    catch { return ''; }
  };
  return Object.freeze({
    init: load('init.md'),
    adHoc: load('ad-hoc.md'),
    thread: load('thread.md'),
    formatRules: load('format-rules.md'),
  });
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Escape user-controlled strings that will be embedded inside XML-tagged
 * prompt sections. Prevents prompt injection by breaking out of XML contexts.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Session marker
// ---------------------------------------------------------------------------

const SESSION_MARKER_REGEX = /sid:([a-f0-9-]+)/;

// ---------------------------------------------------------------------------
// Config merge helper
// ---------------------------------------------------------------------------

function mergeConfig(base, overrides) {
  const result = {};
  for (const key of Object.keys(base)) {
    if (
      overrides[key] !== undefined &&
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = Object.freeze({ ...base[key], ...overrides[key] });
    } else {
      result[key] = overrides[key] !== undefined ? overrides[key] : base[key];
    }
  }
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// Addon auto-discovery
// ---------------------------------------------------------------------------

async function discoverAddons(hooksRegistry, logger, env = process.env) {
  const addonsDir = join(__dirname, '..', 'addons');
  let entries;
  try {
    entries = readdirSync(addonsDir);
  } catch {
    logger.log('debug', 'addon:discovery', { message: 'No addons directory found' });
    return;
  }

  for (const name of entries) {
    const addonPath = join(addonsDir, name, 'index.js');
    try {
      const stat = statSync(addonPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    try {
      const addonUrl = addonPath.match(/^[a-zA-Z]:/)
        ? new URL(`file:///${addonPath.replace(/\\/g, '/')}`).href
        : addonPath;
      const addonModule = await import(addonUrl);

      if (typeof addonModule.register !== 'function') continue;

      // Check for addon-specific ENV requirements
      if (typeof addonModule.requiredEnv === 'function') {
        const missing = addonModule.requiredEnv().filter((key) => !env[key]);
        if (missing.length > 0) {
          logger.log('debug', 'addon:skip', { addon: name, missing });
          continue;
        }
      }

      await hooksRegistry.registerAddon(name, (h) => addonModule.register(h, env));
      logger.log('info', 'addon:loaded', { addon: name });
    } catch (err) {
      logger.log('error', 'addon:error', { addon: name, error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming progress callback factory
// ---------------------------------------------------------------------------

/**
 * Create a debounced stream callback that posts text narration to Discord.
 */
function makeStreamCallback(channel, logger) {
  const DEBOUNCE_MS = 5_000;
  const MAX_WAIT_MS = 15_000;
  const MAX_TEXT_LEN = 1800;
  const MIN_POST_GAP_MS = 10_000;

  let textBuffer = '';
  let debounceTimer = null;
  let windowStart = 0;
  let lastPostTime = 0;
  const postedSnippets = [];

  async function flush() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (!textBuffer.trim()) return;

    const now = Date.now();
    if (now - lastPostTime < MIN_POST_GAP_MS && lastPostTime > 0) {
      textBuffer = '';
      windowStart = 0;
      return;
    }

    const snippet = textBuffer.length > MAX_TEXT_LEN
      ? textBuffer.slice(0, MAX_TEXT_LEN) + '...'
      : textBuffer;
    textBuffer = '';
    windowStart = 0;
    lastPostTime = now;

    try {
      await channel.send(`> ${snippet.split('\n').join('\n> ')}`);
      postedSnippets.push(snippet);
    } catch (err) {
      logger.log('warn', 'stream:postFailed', { error: err.message });
    }
  }

  const callback = async (event) => {
    if (event.type === 'text') {
      const now = Date.now();
      textBuffer += event.text;
      if (!windowStart) windowStart = now;
      if (now - windowStart >= MAX_WAIT_MS) {
        await flush();
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => flush(), DEBOUNCE_MS);
    }
  };

  callback.cancel = () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    textBuffer = '';
  };

  callback.wasAlreadyPosted = (finalText) => {
    if (postedSnippets.length === 0) return false;
    const normalised = (finalText || '').replace(/\s+/g, ' ').trim();
    if (!normalised) return false;
    for (const snippet of postedSnippets) {
      const normSnippet = snippet.replace(/\s+/g, ' ').trim();
      if (normSnippet.length >= normalised.length * 0.8 && normSnippet.includes(normalised.slice(0, 200))) {
        return true;
      }
      if (normalised.length <= 1000 && normSnippet.length >= normalised.length * 0.7) {
        return true;
      }
    }
    return false;
  };

  return callback;
}

function makeProgressCallback(channel, i18n) {
  return async ({ elapsedMin }) => {
    try {
      await channel.send(i18n.t('progress', { elapsedMin }));
    } catch { /* best effort */ }
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildInitPrompt(templates, fullPrompt) {
  return renderTemplate(templates.init, { fullPrompt });
}

function buildAdHocPrompt(templates, text, userId) {
  return renderTemplate(templates.adHoc, {
    userId,
    text,
    formatRules: templates.formatRules,
  });
}

function buildThreadPrompt(templates, threadType, latestText, userId, history) {
  const historyBlock = history
    .map((m) => `[${m.isBot ? 'bot' : escapeXml(m.author)}] ${escapeXml(m.text)}`)
    .join('\n');
  return renderTemplate(templates.thread, {
    threadType,
    historyBlock,
    userId,
    latestText,
    formatRules: templates.formatRules,
  });
}

// ---------------------------------------------------------------------------
// Thread naming
// ---------------------------------------------------------------------------

/**
 * Extract a short topic title from the user's first message.
 * Returns a concise, "subject-like" title (max ~50 chars).
 */
function generateTopicTitle(text) {
  if (!text) return 'Claude';
  // Strip mentions, URLs, and excessive whitespace
  const cleaned = text
    .replace(/<[@#][!&]?\d+>\s*/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Claude';

  // Take the first sentence or first 50 chars
  const firstSentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  return firstSentence.length > 50
    ? firstSentence.slice(0, 47) + '...'
    : firstSentence;
}

/**
 * Rename a thread to the standard format: `<sid_short> <topic_title>`.
 * Silently ignores errors (e.g. missing permissions).
 */
async function renameThread(channel, sessionId, userText, logger) {
  if (!channel?.isThread?.()) return;
  try {
    const sidShort = sessionId.slice(0, 8);
    const topic = generateTopicTitle(userText);
    const newName = `${sidShort} ${topic}`.slice(0, 100); // Discord max 100 chars
    await channel.setName(newName);
    logger.log('info', 'thread:renamed', { threadId: channel.id, name: newName });
  } catch (err) {
    logger.log('warn', 'thread:renameFailed', { threadId: channel.id, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function isBotMentioned(message, botUserId) {
  return message.mentions.has(botUserId);
}

function stripMention(text, botUserId) {
  if (!botUserId || !text) return text || '';
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, 'g'), '').trim();
}

async function getThreadHistory(channel, limit = 20) {
  try {
    const messages = await channel.messages.fetch({ limit });
    return [...messages.values()].reverse().map((m) => ({
      author: m.author?.username ?? 'unknown',
      text: m.content ?? '',
      id: m.id,
      isBot: m.author?.bot ?? false,
    }));
  } catch {
    return [];
  }
}

async function postSessionMarker(channel, sessionId, i18n) {
  try {
    await channel.send(i18n.t('session.created', { sessionId }));
  } catch { /* best effort */ }
}

async function postClaudeResponse(channel, userId, response) {
  const formatted = toDiscordMarkdown(response);
  const prefix = userId ? `<@${userId}> ` : '';

  const chunks = splitMessage(`${prefix}${formatted}`);

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ---------------------------------------------------------------------------
// Session recovery
// ---------------------------------------------------------------------------

async function recoverThread(channel, botUserId, threads, logger) {
  const threadId = channel.id;
  try {
    // Paginated scan: fetch up to 300 messages (3 pages) to find sid: marker
    let botParticipated = false;
    let recoveredSessionId = null;
    let lastMessageId = undefined;
    const maxPages = 3;

    for (let page = 0; page < maxPages; page++) {
      const fetchOpts = { limit: 100 };
      if (lastMessageId) fetchOpts.before = lastMessageId;

      const messages = await channel.messages.fetch(fetchOpts);
      if (messages.size === 0) break;

      for (const m of messages.values()) {
        if (m.author?.id === botUserId) {
          botParticipated = true;
          if (m.content?.includes('sid:')) {
            const match = m.content.match(SESSION_MARKER_REGEX);
            if (match) recoveredSessionId = match[1];
          }
        }
      }

      // Stop paginating if we already found sid
      if (recoveredSessionId) break;

      lastMessageId = messages.last()?.id;
      if (messages.size < 100) break; // No more messages
    }

    if (!botParticipated) return false;

    threads.register(threadId, 'ad-hoc', { recovered: true });
    if (recoveredSessionId) {
      threads.setSessionId(threadId, recoveredSessionId);
      logger.log('info', 'session:recovered', {
        threadId,
        sessionId: recoveredSessionId.slice(0, 8),
      });
    } else {
      logger.log('info', 'session:recoveredNoSid', { threadId });
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

function buildSlashCommands() {
  return [
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
          .setDescription('Session ID prefix to stop (optional — stops longest if omitted)')
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

    new SlashCommandBuilder()
      .setName('claude-approve')
      .setDescription('Retry denied operations with full-auto permissions (resumes last session)'),

    new SlashCommandBuilder()
      .setName('claude-compact')
      .setDescription('Compact the current thread\'s Claude session context (runs /compact)'),

    new SlashCommandBuilder()
      .setName('claude-commands')
      .setDescription('Browse and execute Claude Code commands')
      .addStringOption(opt =>
        opt.setName('category')
          .setDescription('Filter by category')
          .setRequired(false)
          .addChoices(
            { name: 'All', value: 'all' },
            { name: 'General', value: 'General' },
            { name: 'Language', value: 'Language' },
            { name: 'Git', value: 'Git' },
            { name: 'Planning', value: 'Planning' },
            { name: 'Testing', value: 'Testing' },
            { name: 'Docs', value: 'Docs' },
            { name: 'Review', value: 'Review' },
            { name: 'Automation', value: 'Automation' },
            { name: 'Config', value: 'Config' },
          ))
      .addStringOption(opt =>
        opt.setName('search')
          .setDescription('Search commands by keyword')
          .setRequired(false)),
  ];
}

// ---------------------------------------------------------------------------
// createBridge -- main factory
// ---------------------------------------------------------------------------

/**
 * Create and start the Discord-Claude bridge.
 *
 * @param {object} [options={}]
 */
export async function createBridge(options = {}) {
  // -- Config ---
  const baseConfig = buildConfig();
  const config = Object.keys(options).length > 0
    ? mergeConfig(baseConfig, options)
    : baseConfig;
  validateConfig(config);

  // -- Module instantiation ---
  const logger = createLogger({ logDir: config.log.dir, retentionDays: config.log.retentionDays });
  const i18n = createI18n(config.locale);
  const threads = createThreadRegistry(config.thread);
  const dedup = createDedupCache(config.dedup);
  const reactions = createReactions(config.emojis);
  const claude = createClaudeRunner({ cliPath: config.claude.cliPath, cwd: config.claude.cwd, logger });
  const files = createFileHandler();
  const templates = loadPromptTemplates();
  const commandDiscovery = createCommandDiscovery({ logger });

  // -- Discord client ---
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
    ],
  });

  // -- Register slash commands ---
  const rest = new REST({ version: '10' }).setToken(config.discord.botToken);
  const commands = buildSlashCommands().map(cmd => cmd.toJSON());

  try {
    if (config.discord.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.discord.applicationId, config.discord.guildId),
        { body: commands },
      );
    } else {
      await rest.put(
        Routes.applicationCommands(config.discord.applicationId),
        { body: commands },
      );
    }
    logger.log('info', 'slash:registered', { count: commands.length });
  } catch (err) {
    logger.log('error', 'slash:registerFailed', { error: err.message });
  }

  // -- Addon auto-discovery ---
  await discoverAddons(hooks, logger);

  // -- Per-thread permission mode override ---
  const threadPermissionModes = new Map();

  function getPermissionMode(threadId) {
    return threadPermissionModes.get(threadId) || config.claude.defaultPermissionMode;
  }

  // =========================================================================
  // Internal message handlers
  // =========================================================================

  /**
   * Resolve the "reply channel" — either an existing thread or auto-create one.
   * For DMs, use the DM channel directly.
   */
  async function resolveReplyChannel(message) {
    // If message is already in a thread, reply there
    if (message.channel.isThread()) {
      return message.channel;
    }

    // For DMs, reply directly in the DM channel
    if (message.channel.type === ChannelType.DM) {
      return message.channel;
    }

    // For guild channel messages, auto-create a thread
    try {
      const threadName = (message.content || 'Claude').slice(0, 90) || 'Claude';
      const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 1440, // 24h auto-archive
      });
      return thread;
    } catch (err) {
      // Fallback: reply in the same channel — may leak conversation if bot lacks thread perms
      logger.log('warn', 'thread:createFailed', { channelId: message.channel.id, error: err.message });
      return message.channel;
    }
  }

  /**
   * Two-phase Claude execution: init session then resume for actual work.
   * @param {string} prompt - The full prompt to send.
   * @param {string} threadId - The thread ID.
   * @param {object} replyChannel - The Discord channel/thread to reply in.
   * @param {string} [userText] - Original user text for thread naming.
   */
  async function twoPhaseExecute(prompt, threadId, replyChannel, userText) {
    const permissionMode = getPermissionMode(threadId);
    const { sessionId: initSessionId } = await claude.runClaude(
      buildInitPrompt(templates, prompt),
      { threadId, timeoutMs: config.claude.initTimeoutMs, permissionMode },
    );

    if (initSessionId) {
      threads.setSessionId(threadId, initSessionId);
      await postSessionMarker(replyChannel, initSessionId, i18n);
      await renameThread(replyChannel, initSessionId, userText, logger);
      logger.log('info', 'session:init', { threadId, sessionId: initSessionId });
    }

    const streamCb = makeStreamCallback(replyChannel, logger);
    const { text: result, sessionId, permissionDenied } = await claude.runClaude(
      i18n.t('session.executeTrigger') || 'Please execute the task described above.',
      {
        threadId,
        resumeSessionId: initSessionId,
        onProgress: makeProgressCallback(replyChannel, i18n),
        onStreamEvent: streamCb,
        timeoutMs: config.claude.execTimeoutMs,
        permissionMode,
      },
    );

    if (sessionId) threads.setSessionId(threadId, sessionId);
    return { result, sessionId, streamCb, permissionDenied };
  }

  /**
   * Handle output files: collect from output dir, upload to Discord, cleanup.
   */
  async function handleOutputFiles(outputDir, replyChannel) {
    const outputFiles = files.collectOutputFiles(outputDir);
    if (outputFiles.length > 0) {
      await files.uploadFilesToDiscord(replyChannel, outputFiles);
      logger.log('info', 'files:uploaded', { threadId: replyChannel.id, count: outputFiles.length });
    }
    files.cleanupOutputDir(outputDir);
  }

  /**
   * Post the final response.
   */
  async function postFinalResponse(streamCb, result, replyChannel, userId, originMessage) {
    if (!streamCb.wasAlreadyPosted(result)) {
      await postClaudeResponse(replyChannel, userId, result);
    } else {
      logger.log('info', 'stream:tagOnly', { threadId: replyChannel.id });
    }

    // Always reply to the original message to trigger Discord notification
    if (originMessage) {
      try {
        await originMessage.reply(i18n.t('done', { userId: userId || '' }));
      } catch {
        // Fallback: mention in channel if reply fails (e.g. original message deleted)
        await replyChannel.send(i18n.t('done', { userId: userId || '' }));
      }
    }
  }

  /**
   * Prompt the user for permission approval via Discord buttons.
   * Waits 5 minutes for a button click. Only the original user can interact.
   *
   * @param {object} channel - Discord channel to send the prompt
   * @param {string} userId  - Discord user ID allowed to click
   * @returns {Promise<boolean>} true if user approved
   */
  async function promptPermissionRetry(channel, userId) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('permission_approve')
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('permission_reject')
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    );

    const promptMsg = await channel.send({
      content: i18n.t('permission.prompt', { userId }),
      components: [row],
    });

    try {
      const interaction = await promptMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === userId,
        time: 300_000, // 5 minutes
      });

      // Disable buttons after click
      row.components.forEach((btn) => btn.setDisabled(true));

      if (interaction.customId === 'permission_approve') {
        await interaction.update({
          content: i18n.t('permission.approved'),
          components: [row],
        });
        return true;
      }

      await interaction.update({
        content: i18n.t('permission.rejected'),
        components: [row],
      });
      return false;
    } catch {
      // Timeout — disable buttons and notify
      row.components.forEach((btn) => btn.setDisabled(true));
      await promptMsg.edit({
        content: i18n.t('permission.timeout'),
        components: [row],
      }).catch(() => {});
      return false;
    }
  }

  // -- DM policy check ---
  function isDmAllowed(userId) {
    if (!config.dm.enabled) return false;
    if (config.dm.allowlist.length === 0) return true;
    return config.dm.allowlist.includes(userId);
  }

  // -- handleMessage (unified for channel + thread + DM) ---

  async function handleMessage(message) {
    // Ignore bots and system messages
    if (message.author.bot) return;
    if (message.system) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isInThread = message.channel.isThread?.() ?? false;
    const hasText = message.content && message.content.trim();
    const hasFiles = message.attachments.size > 0;

    if (!hasText && !hasFiles) return;

    // DM policy
    if (isDM) {
      if (!isDmAllowed(message.author.id)) {
        if (!config.dm.enabled) {
          await message.reply(i18n.t('dm.notAllowed'));
        } else {
          await message.reply(i18n.t('dm.notInAllowlist'));
        }
        return;
      }
    }

    // Channel filter
    if (!isDM && !isInThread && config.discord.channelId && message.channel.id !== config.discord.channelId) return;
    if (!isDM && isInThread && config.discord.channelId && message.channel.parentId !== config.discord.channelId) return;

    // Mention gating (only for guild channel messages, not threads or DMs)
    if (!isDM && !isInThread && config.requireMention && !isBotMentioned(message, client.user.id)) return;

    // Dedup
    if (dedup.isDuplicate(message.id)) return;

    // Hook: onMessage filter
    const allowed = await hooks.emitFilter('onMessage', message);
    if (!allowed) return;

    const cleanText = stripMention(message.content || '', client.user.id);

    // Determine thread context
    let threadId;
    let replyChannel;

    if (isInThread) {
      threadId = message.channel.id;
      replyChannel = message.channel;
    } else if (isDM) {
      threadId = `dm_${message.author.id}`;
      replyChannel = message.channel;
    } else {
      // Guild channel message — will auto-create a thread
      replyChannel = await resolveReplyChannel(message);
      threadId = replyChannel.id;
    }

    const isExistingThread = threads.has(threadId);

    // Thread reply to an existing session
    if ((isInThread || isDM) && isExistingThread) {
      threads.touch(threadId);
    } else if ((isInThread || isDM) && !isExistingThread) {
      // Try session recovery
      const recovered = await recoverThread(replyChannel, client.user.id, threads, logger);
      if (!recovered) {
        if (isInThread && !isBotMentioned(message, client.user.id)) return;
        threads.register(threadId, 'ad-hoc', { initiator: message.author.id });
      }
    } else {
      // New conversation
      threads.register(threadId, 'ad-hoc', { initiator: message.author.id, originalText: cleanText });
    }

    await reactions.addAck(message);

    // Per-thread lock: queue if busy, reject if queue full
    if (isThreadLocked(threadId)) {
      logger.log('info', 'queue:busy', { threadId });
      await replyChannel.send(i18n.t('queue'));
    }

    let release;
    try {
      release = await acquireThreadLock(threadId);
    } catch {
      await replyChannel.send('Queue is full. Please wait for the current task to finish.');
      return;
    }
    const outputDir = files.createOutputDir(threadId);
    let streamCb = null;

    try {
      // Download attached files
      const downloadedFiles = await files.downloadAttachments(message.attachments);
      const fileContext = files.buildFileContext(downloadedFiles);
      const outputDirContext = files.buildOutputDirContext(outputDir);

      // Hook: onBeforeClaude transform
      const transformedPrompt = await hooks.emitTransform('onBeforeClaude', cleanText || '', {
        channelId: message.channel.id, threadId, userId: message.author.id,
      });

      const currentThread = threads.get(threadId);
      const hasSession = Boolean(currentThread?.sessionId);
      const extraContext = fileContext + outputDirContext;
      const userMessage = (transformedPrompt || cleanText || '') + extraContext;
      let result;
      let permissionDenied = false;

      if (hasSession) {
        // Existing session — resume directly
        streamCb = makeStreamCallback(replyChannel, logger);
        await reactions.addTyping(message);
        ({ text: result, permissionDenied } = await claude.runClaude(userMessage, {
          threadId,
          resumeSessionId: currentThread.sessionId,
          onProgress: makeProgressCallback(replyChannel, i18n),
          onStreamEvent: streamCb,
          timeoutMs: config.claude.execTimeoutMs,
          permissionMode: getPermissionMode(threadId),
        }));
      } else {
        // New session — two-phase init
        await reactions.addTyping(message);
        if (isInThread || isDM) {
          const history = await getThreadHistory(replyChannel);
          const prompt = buildThreadPrompt(
            templates, currentThread?.type ?? 'ad-hoc',
            transformedPrompt || cleanText || '', message.author.id, history,
          ) + extraContext;
          ({ result, streamCb, permissionDenied } = await twoPhaseExecute(prompt, threadId, replyChannel, cleanText));
        } else {
          const prompt = buildAdHocPrompt(
            templates, transformedPrompt || cleanText || '', message.author.id,
          ) + extraContext;
          ({ result, streamCb, permissionDenied } = await twoPhaseExecute(prompt, threadId, replyChannel, cleanText));
        }
      }

      // Hook: onAfterClaude transform
      const finalResult = await hooks.emitTransform('onAfterClaude', result, {
        channelId: message.channel.id, threadId, userId: message.author.id,
        sessionId: threads.get(threadId)?.sessionId,
      });

      await reactions.removeTyping(message);
      await postFinalResponse(streamCb, finalResult, replyChannel, message.author.id, message);
      await handleOutputFiles(outputDir, replyChannel);

      // Permission denial detected — offer retry with full-auto
      if (permissionDenied) {
        logger.log('info', 'permission:denied', { threadId, userId: message.author.id });
        const approved = await promptPermissionRetry(replyChannel, message.author.id);

        if (approved) {
          const retrySessionId = threads.get(threadId)?.sessionId;
          const retryStreamCb = makeStreamCallback(replyChannel, logger);
          const retryPrompt = i18n.t('permission.retryPrompt')
            || 'Please retry the operations that were denied due to permissions.';

          const { text: retryResult } = await claude.runClaude(retryPrompt, {
            threadId,
            resumeSessionId: retrySessionId,
            onProgress: makeProgressCallback(replyChannel, i18n),
            onStreamEvent: retryStreamCb,
            timeoutMs: config.claude.execTimeoutMs,
            permissionMode: 'full-auto',
          });

          const retryFinal = await hooks.emitTransform('onAfterClaude', retryResult, {
            channelId: message.channel.id, threadId, userId: message.author.id,
            sessionId: threads.get(threadId)?.sessionId,
          });

          await postFinalResponse(retryStreamCb, retryFinal, replyChannel, message.author.id, message);
          await handleOutputFiles(outputDir, replyChannel);
        }
      }

      await reactions.addDone(message);
    } catch (err) {
      await reactions.removeTyping(message);
      await reactions.addError(message);
      logger.log('error', 'message:handler', { threadId, error: err.message, stack: err.stack });
      logger.logClaude('error', threadId, threads.get(threadId)?.sessionId ?? null, {
        source: 'handleMessage', error: err.message,
      });
      // Never leak internal error details to Discord users
      await replyChannel.send(i18n.t('error', { message: 'Internal error. Check server logs.' }));
      files.cleanupOutputDir(outputDir);
    } finally {
      streamCb?.cancel?.();
      release();
    }
  }

  // -- executeResume (shared by slash command) ---

  async function executeResume({ sessionId: targetSessionId, prompt, channel, userId, permissionMode }) {
    const threadId = channel.id;

    if (!threads.has(threadId)) {
      threads.register(threadId, 'ad-hoc', { initiator: userId, resumedFrom: targetSessionId });
    }
    threads.setSessionId(threadId, targetSessionId);

    logger.log('info', 'session:resume', { threadId, sessionId: targetSessionId.slice(0, 8) });
    await postSessionMarker(channel, targetSessionId, i18n);

    const release = await acquireThreadLock(threadId);
    try {
      const streamCb = makeStreamCallback(channel, logger);
      const { text: result, sessionId } = await claude.runClaude(prompt, {
        threadId,
        resumeSessionId: targetSessionId,
        onProgress: makeProgressCallback(channel, i18n),
        onStreamEvent: streamCb,
        timeoutMs: config.claude.execTimeoutMs,
        permissionMode: permissionMode || getPermissionMode(threadId),
      });

      if (sessionId) threads.setSessionId(threadId, sessionId);

      await postFinalResponse(streamCb, result, channel, userId, null);
    } catch (err) {
      logger.log('error', 'resume:error', { threadId, error: err.message, stack: err.stack });
      await channel.send(i18n.t('error', { message: 'Internal error. Check server logs.' }));
    } finally {
      release();
    }
  }

  // =========================================================================
  // Discord event registration
  // =========================================================================

  client.on('messageCreate', handleMessage);

  // -- Slash command handling ---

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'claude-resume') {
      const sid = interaction.options.getString('session-id');
      const prompt = interaction.options.getString('prompt')
        || i18n.t('session.defaultResumePrompt') || 'Please continue the previous task.';

      if (!sid || !/^[a-f0-9-]{8,36}$/.test(sid)) {
        await interaction.reply({ content: i18n.t('commands.resumeFormat'), ephemeral: true });
        return;
      }

      await interaction.reply(
        i18n.t('session.resuming', { userId: interaction.user.id, sessionId: sid.slice(0, 8) + '...' })
      );

      await executeResume({
        sessionId: sid,
        prompt,
        channel: interaction.channel,
        userId: interaction.user.id,
      });
    }

    if (commandName === 'claude-stop') {
      const input = interaction.options.getString('session-id') || '';
      const active = claude.listActiveProcesses();

      if (active.length === 0) {
        await interaction.reply({ content: i18n.t('commands.statusEmpty'), ephemeral: true });
        return;
      }

      if (input) {
        const match = active.find((p) => {
          const thread = threads.get(p.threadId);
          return thread?.sessionId?.startsWith(input);
        });

        if (match) {
          const sid = threads.get(match.threadId)?.sessionId ?? '';
          claude.killClaude(match.threadId);
          await interaction.reply(
            `${i18n.t('commands.stopSuccess')} (session \`${sid.slice(0, 8)}...\`, ${match.elapsedMin} min)`
          );
        } else {
          await interaction.reply({ content: i18n.t('commands.stopNotFound'), ephemeral: true });
        }
      } else {
        const longest = [...active].sort((a, b) => b.elapsedMin - a.elapsedMin)[0];
        const sid = threads.get(longest.threadId)?.sessionId ?? '';
        claude.killClaude(longest.threadId);
        await interaction.reply(
          `${i18n.t('commands.stopSuccess')} (session \`${sid.slice(0, 8)}...\`, ${longest.elapsedMin} min)`
        );
      }
      logger.log('info', 'slash:stop', { user: interaction.user.id, input: input || '(none)' });
    }

    if (commandName === 'claude-status') {
      const active = claude.listActiveProcesses();
      const locksCount = activeLocksCount();

      if (active.length === 0) {
        await interaction.reply({ content: i18n.t('commands.statusEmpty'), ephemeral: true });
        return;
      }

      const lines = active.map((p, idx) => {
        const sid = threads.get(p.threadId)?.sessionId ?? 'unknown';
        return `**${idx + 1}.** Session \`${sid.slice(0, 8)}...\` -- ${p.elapsedMin} min\n     ${p.prompt}...`;
      });
      await interaction.reply(
        `**${i18n.t('commands.statusHeader', { count: active.length, locks: locksCount })}**\n\n${lines.join('\n\n')}`
      );
    }

    if (commandName === 'claude-mode') {
      const threadId = interaction.channel?.isThread?.()
        ? interaction.channel.id
        : interaction.channel?.type === ChannelType.DM
          ? `dm_${interaction.user.id}`
          : interaction.channel?.id;

      const newMode = interaction.options.getString('mode');

      if (!newMode) {
        // Show current mode
        const current = getPermissionMode(threadId);
        const defaultMode = config.claude.defaultPermissionMode;
        const isOverride = threadPermissionModes.has(threadId);
        await interaction.reply({
          content: i18n.t('commands.modeShow', {
            current,
            defaultMode,
            scope: isOverride ? 'thread override' : 'default',
          }),
          ephemeral: true,
        });
        return;
      }

      threadPermissionModes.set(threadId, newMode);
      logger.log('info', 'mode:changed', {
        threadId,
        user: interaction.user.id,
        mode: newMode,
      });
      await interaction.reply(
        i18n.t('commands.modeChanged', { mode: newMode, userId: interaction.user.id })
      );
    }

    if (commandName === 'claude-approve') {
      const threadId = interaction.channel?.isThread?.()
        ? interaction.channel.id
        : interaction.channel?.type === ChannelType.DM
          ? `dm_${interaction.user.id}`
          : interaction.channel?.id;

      // Attempt session recovery if thread not in memory
      if (!threads.has(threadId) && interaction.channel?.isThread?.()) {
        await recoverThread(interaction.channel, client.user.id, threads, logger);
      }

      const currentThread = threads.get(threadId);
      const sessionId = currentThread?.sessionId;

      if (!sessionId) {
        await interaction.reply({
          content: i18n.t('commands.approveNoSession'),
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(i18n.t('permission.approved'));
      logger.log('info', 'permission:manualApprove', {
        threadId,
        user: interaction.user.id,
        sessionId: sessionId.slice(0, 8),
      });

      const retryPrompt = i18n.t('permission.retryPrompt')
        || 'Please retry the operations that were denied due to permissions.';

      await executeResume({
        sessionId,
        prompt: retryPrompt,
        channel: interaction.channel,
        userId: interaction.user.id,
        permissionMode: 'full-auto',
      });
    }

    if (commandName === 'claude-compact') {
      const threadId = interaction.channel?.isThread?.()
        ? interaction.channel.id
        : interaction.channel?.type === ChannelType.DM
          ? `dm_${interaction.user.id}`
          : interaction.channel?.id;

      // Attempt session recovery if thread not in memory
      if (!threads.has(threadId) && interaction.channel?.isThread?.()) {
        await recoverThread(interaction.channel, client.user.id, threads, logger);
      }

      const currentThread = threads.get(threadId);
      const sessionId = currentThread?.sessionId;

      if (!sessionId) {
        await interaction.reply({
          content: i18n.t('commands.compactNoSession')
            || 'No active session found for this thread. Send a message first to start a session.',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(
        i18n.t('commands.compactStarted', { userId: interaction.user.id, sessionId: sessionId.slice(0, 8) + '...' })
          || `<@${interaction.user.id}> Compacting session \`${sessionId.slice(0, 8)}...\` context...`
      );
      logger.log('info', 'slash:compact', {
        threadId,
        user: interaction.user.id,
        sessionId: sessionId.slice(0, 8),
      });

      await executeResume({
        sessionId,
        prompt: '/compact',
        channel: interaction.channel,
        userId: interaction.user.id,
      });
    }

    if (commandName === 'claude-commands') {
      const category = interaction.options.getString('category') || 'all';
      const searchQuery = interaction.options.getString('search') || '';

      let commands;
      if (searchQuery) {
        commands = commandDiscovery.search(searchQuery);
      } else if (category === 'all') {
        commands = commandDiscovery.getAll();
      } else {
        const categories = commandDiscovery.getCategories();
        commands = categories.get(category) || [];
      }

      if (commands.length === 0) {
        await interaction.reply({
          content: searchQuery
            ? `No commands found matching "${searchQuery}".`
            : `No commands found in category "${category}".`,
          ephemeral: true,
        });
        return;
      }

      // Discord select menu limit: 25 options. Paginate if needed.
      const PAGE_SIZE = 25;
      const totalPages = Math.ceil(commands.length / PAGE_SIZE);
      const page = commands.slice(0, PAGE_SIZE);

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('claude_command_select')
        .setPlaceholder(`Select a command (${commands.length} available)`)
        .addOptions(
          page.map((cmd) => ({
            label: `/${cmd.name}`.slice(0, 100),
            description: (cmd.description || cmd.source || 'No description').slice(0, 100),
            value: cmd.name.slice(0, 100),
          })),
        );

      const row = new ActionRowBuilder().addComponents(selectMenu);
      const header = searchQuery
        ? `**Commands matching "${searchQuery}"** (${commands.length})`
        : category === 'all'
          ? `**All Commands** (${commands.length})`
          : `**${category} Commands** (${commands.length})`;

      const footer = totalPages > 1
        ? `\nShowing 1-${PAGE_SIZE} of ${commands.length}. Use \`/claude-commands search:<keyword>\` to narrow results.`
        : '';

      await interaction.reply({
        content: `${header}${footer}`,
        components: [row],
        ephemeral: true,
      });

      logger.log('info', 'slash:commands', {
        user: interaction.user.id,
        category,
        search: searchQuery || '(none)',
        results: commands.length,
      });
    }
  });

  // -- Select menu interaction handler (claude-commands) ---

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== 'claude_command_select') return;

    try {
      const selectedCommand = interaction.values[0];
      if (!selectedCommand) return;

      // Validate command name against strict allowlist
      if (!VALID_COMMAND_NAME.test(selectedCommand)) {
        await interaction.update({ content: 'Invalid command name.', components: [] });
        return;
      }
      const knownNames = commandDiscovery.getAll().map((c) => c.name);
      if (!knownNames.includes(selectedCommand)) {
        await interaction.update({ content: 'Command no longer available. Try `/claude-commands` again.', components: [] });
        return;
      }

      if (!interaction.channel) {
        await interaction.update({ content: 'Cannot execute in this context.', components: [] });
        return;
      }

      const threadId = interaction.channel.isThread?.()
        ? interaction.channel.id
        : interaction.channel.type === ChannelType.DM
          ? `dm_${interaction.user.id}`
          : interaction.channel.id;

      // Attempt session recovery
      if (!threads.has(threadId) && interaction.channel.isThread?.()) {
        await recoverThread(interaction.channel, client.user.id, threads, logger);
      }

      const currentThread = threads.get(threadId);
      const sessionId = currentThread?.sessionId;

      if (!sessionId) {
        await interaction.update({
          content: i18n.t('commands.commandsNewSession', { command: selectedCommand })
            || `Executing \`/${selectedCommand}\` in a new session...`,
          components: [],
        });

        // Start a new two-phase session with the command as prompt
        const newThreadId = threadId;
        threads.register(newThreadId, 'ad-hoc', { initiator: interaction.user.id });
        const prompt = buildAdHocPrompt(
          templates, `/${selectedCommand}`, interaction.user.id,
        );
        const release = await acquireThreadLock(newThreadId);
        try {
          const { result, streamCb } = await twoPhaseExecute(
            prompt, newThreadId, interaction.channel, `/${selectedCommand}`,
          );
          const finalResult = await hooks.emitTransform('onAfterClaude', result, {
            channelId: interaction.channel.id, threadId: newThreadId, userId: interaction.user.id,
            sessionId: threads.get(newThreadId)?.sessionId,
          });
          await postFinalResponse(streamCb, finalResult, interaction.channel, interaction.user.id, null);
        } finally {
          release();
        }
        return;
      }

      await interaction.update({
        content: i18n.t('commands.commandsExecute', { command: selectedCommand, sessionId: sessionId.slice(0, 8) + '...' })
          || `Executing \`/${selectedCommand}\` on session \`${sessionId.slice(0, 8)}...\``,
        components: [],
      });

      logger.log('info', 'commands:execute', {
        user: interaction.user.id,
        command: selectedCommand,
        threadId,
        sessionId: sessionId.slice(0, 8),
      });

      await executeResume({
        sessionId,
        prompt: `/${selectedCommand}`,
        channel: interaction.channel,
        userId: interaction.user.id,
      });
    } catch (err) {
      logger.log('error', 'commands:selectError', { error: err.message, stack: err.stack });
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: i18n.t('error', { message: 'Internal error.' }), ephemeral: true });
        } else {
          await interaction.update({ content: i18n.t('error', { message: 'Internal error.' }), components: [] });
        }
      } catch { /* best effort */ }
    }
  });

  // =========================================================================
  // Periodic cleanup timers
  // =========================================================================

  const hourlyCleanup = setInterval(() => {
    threads.pruneStale();
    logger.pruneOldLogs();
  }, 60 * 60 * 1000);

  const tempFileCleanup = setInterval(() => {
    files.pruneStaleFiles();
  }, 30 * 60 * 1000);

  // =========================================================================
  // Startup
  // =========================================================================

  await hooks.emit('startup', client, config);
  await client.login(config.discord.botToken);

  logger.log('info', 'app:start', {
    botUserId: client.user.id,
    botTag: client.user.tag,
    channelId: config.discord.channelId || 'all',
    guildId: config.discord.guildId || 'all',
    requireMention: config.requireMention,
    dmEnabled: config.dm.enabled,
    locale: config.locale,
    addons: hooks.listAddons().map((a) => a.name),
  });

  // Startup notification
  if (config.discord.channelId) {
    try {
      const channel = await client.channels.fetch(config.discord.channelId);
      if (channel) {
        const timestamp = new Date().toISOString();
        const addonNames = hooks.listAddons().map((a) => a.name).join(', ') || 'none';
        await channel.send([
          `**${i18n.t('startup.success')}**`,
          i18n.t('startup.time', { timestamp }),
          i18n.t('startup.bot', { botUserId: client.user.id }),
          i18n.t('startup.channel', { channelId: config.discord.channelId }),
          i18n.t('startup.mentionGating', { status: config.requireMention ? 'ON' : 'OFF' }),
          i18n.t('startup.dmPolicy', { status: config.dm.enabled ? 'enabled' : 'disabled' }),
          i18n.t('startup.permissionMode', { mode: config.claude.defaultPermissionMode }),
          `Addons: ${addonNames}`,
        ].join('\n'));
      }
    } catch (err) {
      logger.log('error', 'startup:notify', { error: err.message });
    }
  }

  // Send startup notification to dedicated notify channel (if configured)
  if (config.discord.notifyChannelId && config.discord.notifyChannelId !== config.discord.channelId) {
    try {
      const notifyChannel = await client.channels.fetch(config.discord.notifyChannelId);
      if (notifyChannel) {
        const timestamp = new Date().toISOString();
        const addonNames = hooks.listAddons().map((a) => a.name).join(', ') || 'none';
        await notifyChannel.send([
          `**${i18n.t('startup.success')}**`,
          i18n.t('startup.time', { timestamp }),
          i18n.t('startup.bot', { botUserId: client.user.id }),
          i18n.t('startup.channel', { channelId: config.discord.channelId || 'all' }),
          i18n.t('startup.mentionGating', { status: config.requireMention ? 'ON' : 'OFF' }),
          i18n.t('startup.dmPolicy', { status: config.dm.enabled ? 'enabled' : 'disabled' }),
          i18n.t('startup.permissionMode', { mode: config.claude.defaultPermissionMode }),
          `Addons: ${addonNames}`,
        ].join('\n'));
      }
    } catch (err) {
      logger.log('error', 'startup:notifyChannel', { error: err.message });
    }
  }

  // =========================================================================
  // Graceful shutdown
  // =========================================================================

  async function stop(signal) {
    clearInterval(hourlyCleanup);
    clearInterval(tempFileCleanup);
    commandDiscovery.destroy();

    if (config.discord.channelId) {
      try {
        const channel = await client.channels.fetch(config.discord.channelId);
        if (channel) {
          await channel.send(i18n.t('shutdown', { signal: signal || 'manual' }));
        }
      } catch { /* best effort */ }
    }

    if (config.discord.notifyChannelId && config.discord.notifyChannelId !== config.discord.channelId) {
      try {
        const notifyChannel = await client.channels.fetch(config.discord.notifyChannelId);
        if (notifyChannel) {
          await notifyChannel.send(i18n.t('shutdown', { signal: signal || 'manual' }));
        }
      } catch { /* best effort */ }
    }

    await hooks.emit('shutdown');
    client.destroy();
    logger.log('info', 'app:stop', { signal: signal || 'manual' });
  }

  process.once('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0)));

  return {
    client,
    config,
    hooks,
    claude,
    threads,
    dedup,
    reactions,
    files,
    logger,
    i18n,
    botUserId: client.user.id,
    stop,
  };
}
