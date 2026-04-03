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
    const messages = await channel.messages.fetch({ limit: 50 });
    const arr = [...messages.values()];

    const botParticipated = arr.some((m) => m.author?.id === botUserId);
    if (!botParticipated) return false;

    let recoveredSessionId = null;
    for (const m of arr) {
      if (m.author?.id === botUserId && m.content?.includes('sid:')) {
        const match = m.content.match(SESSION_MARKER_REGEX);
        if (match) recoveredSessionId = match[1];
      }
    }

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
   */
  async function twoPhaseExecute(prompt, threadId, replyChannel) {
    const permissionMode = getPermissionMode(threadId);
    const { sessionId: initSessionId } = await claude.runClaude(
      buildInitPrompt(templates, prompt),
      { threadId, timeoutMs: config.claude.initTimeoutMs, permissionMode },
    );

    if (initSessionId) {
      threads.setSessionId(threadId, initSessionId);
      await postSessionMarker(replyChannel, initSessionId, i18n);
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
   * Prompt the user for permission approval via Discord message.
   * Waits 60 seconds for a yes/no reply.
   *
   * @param {object} channel - Discord channel to send the prompt
   * @param {string} userId  - Discord user ID to listen for
   * @returns {Promise<boolean>} true if user approved
   */
  async function promptPermissionRetry(channel, userId) {
    await channel.send(i18n.t('permission.prompt', { userId }));

    try {
      const collected = await channel.awaitMessages({
        filter: (m) =>
          m.author.id === userId &&
          /^(yes|no|y|n)$/i.test(m.content.trim()),
        max: 1,
        time: 60_000,
        errors: ['time'],
      });

      const reply = collected.first()?.content?.trim()?.toLowerCase();
      if (reply === 'yes' || reply === 'y') {
        await channel.send(i18n.t('permission.approved'));
        return true;
      }
      await channel.send(i18n.t('permission.rejected'));
      return false;
    } catch {
      await channel.send(i18n.t('permission.timeout'));
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
          ({ result, streamCb, permissionDenied } = await twoPhaseExecute(prompt, threadId, replyChannel));
        } else {
          const prompt = buildAdHocPrompt(
            templates, transformedPrompt || cleanText || '', message.author.id,
          ) + extraContext;
          ({ result, streamCb, permissionDenied } = await twoPhaseExecute(prompt, threadId, replyChannel));
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

  async function executeResume({ sessionId: targetSessionId, prompt, channel, userId }) {
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
        permissionMode: getPermissionMode(threadId),
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

  // =========================================================================
  // Graceful shutdown
  // =========================================================================

  async function stop(signal) {
    clearInterval(hourlyCleanup);
    clearInterval(tempFileCleanup);

    if (config.discord.channelId) {
      try {
        const channel = await client.channels.fetch(config.discord.channelId);
        if (channel) {
          await channel.send(i18n.t('shutdown', { signal: signal || 'manual' }));
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
