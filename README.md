# claude-discord-bridge

Production-grade Discord bot that bridges messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Each Discord thread gets an independent Claude session with real-time streaming, file handling, and session persistence.

## Features

- **Per-thread sessions** -- every Discord thread spawns an isolated Claude process
- **Two-phase execution** -- init session (buffered JSON) then resume (streaming NDJSON)
- **Real-time streaming** -- 5-second debounced narration posted to Discord as Claude works
- **Session persistence** -- resume previous sessions with `/claude-resume`
- **File handling** -- upload attachments for Claude to read; Claude output files auto-upload to Discord
- **Permission modes** -- switch between `full-auto`, `auto`, `acceptEdits`, `plan`, `dontAsk` per thread
- **DM support** -- direct message conversations with optional allowlist
- **Addon system** -- hook-based plugin architecture for custom extensions
- **i18n** -- English and Traditional Chinese (zh-TW) out of the box
- **PM2 ready** -- designed for background daemon operation

## How It Differs from the Official Discord Plugin

Anthropic ships an [official Discord plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) (v0.0.4) that runs as an MCP server inside an existing Claude Code session. The two projects serve different use cases:

| Aspect | Official Plugin (v0.0.4) | This Bridge (v1.0.0) |
|--------|--------------------------|----------------------|
| Architecture | Single MCP session via stdio | Per-thread independent processes |
| Start new session from Discord | Not possible | Automatic |
| Session resume | Not possible (process death = lost) | `/claude-resume` with session ID |
| Concurrent users | Serial (all messages into one session) | Parallel (per-thread lock + queue) |
| Streaming output | None (tool returns full response) | Real-time (5s debounce) |
| Remote permission approval | Yes (Discord buttons + text) | No (`-p` mode limitation) -- use `/claude-mode` instead |
| Attachment handling | Lazy download (Claude calls tool) | Auto-download injected into prompt |
| Access control | Pairing code + allowlist + per-channel | Channel filter + DM allowlist |
| Prompt injection defense | Skill layer + instructions layer | XML escaping + mention gating + hook filters |
| Message chunking | Newline/length modes | 2000-char Discord limit splitting |
| Rate limiting | None (relies on discord.js built-in 429) | Per-thread lock + queue (max 10) |
| Daemon operation | No (requires open terminal) | PM2 background daemon |
| Runtime | Bun (Windows experimental) | Node.js 18+ (all platforms stable) |
| Windows support | Runs but token files unprotected | Native support, no Unix permission dependency |

**TL;DR** -- The official plugin is a "personal remote control" for one person's local Claude session. This bridge is a "multi-user AI service" for team Discord servers.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A [Discord bot](https://discord.com/developers/applications) with these intents enabled:
  - `MESSAGE CONTENT`
  - `SERVER MEMBERS` (optional, for DM allowlist)

## Quick Start

```bash
# Clone
git clone https://github.com/anthropics/claude-discord-bridge.git
cd claude-discord-bridge

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your Discord bot token and application ID

# Validate configuration
node daemon/bin/claude-discord-bridge.js --check

# Register slash commands
npm run register

# Start
npm start
```

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_APPLICATION_ID` | Discord application (client) ID |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_GUILD_ID` | _(all guilds)_ | Restrict to a specific guild |
| `DISCORD_CHANNEL_ID` | _(all channels)_ | Monitor a specific channel only |
| `CLAUDE_CLI_PATH` | `claude` | Path to the Claude CLI binary |
| `CLAUDE_CWD` | `$HOME` | Working directory for Claude execution |
| `LOCALE` | `en` | Message language: `en` or `zh-TW` |
| `REQUIRE_MENTION` | `true` | Require @mention in channel messages |
| `PERMISSION_MODE` | `full-auto` | Default permission mode (see below) |
| `DM_ENABLED` | `true` | Allow DM conversations |
| `DM_ALLOWLIST` | _(empty = all)_ | Comma-separated Discord user IDs |
| `INIT_TIMEOUT_SEC` | `300` | Two-phase init timeout |
| `EXEC_TIMEOUT_SEC` | `3600` | Execution timeout |
| `THREAD_TTL_MS` | `43200000` | Thread session TTL (12h) |
| `LOG_RETENTION_DAYS` | `7` | NDJSON log file retention |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/claude-resume` | Resume a previous Claude session by ID |
| `/claude-stop` | Force-stop a running Claude task |
| `/claude-status` | Show currently running tasks |
| `/claude-mode` | View or switch permission mode for the current thread |

### Permission Modes

Use `/claude-mode` to switch per-thread:

| Mode | Behavior |
|------|----------|
| `full-auto` | All tools pre-approved (`--allowedTools '*'`). No confirmation prompts. |
| `auto` | Background classifier reviews each action. Requires Team/Enterprise/API plan. |
| `acceptEdits` | Auto-accept file edits only. Other tools require pre-approval. |
| `plan` | Read-only analysis. No file modifications allowed. |
| `dontAsk` | Only pre-approved tools from settings. Denied tools terminate the task. |

## Architecture

```
Discord User
    |
    v
[Discord Gateway]
    |
    v
[claude-discord-bridge daemon]
    |-- messageCreate handler
    |     |-- mention gating / channel filter / dedup
    |     |-- per-thread lock + queue (max 10)
    |     |-- download attachments
    |     |-- hook: onMessage filter
    |     |-- hook: onBeforeClaude transform
    |     |-- two-phase Claude execution
    |     |     |-- Phase 1: init session (buffered JSON, 5min timeout)
    |     |     |-- Phase 2: resume + execute (streaming NDJSON, 1hr timeout)
    |     |-- hook: onAfterClaude transform
    |     |-- post response + upload output files
    |
    |-- interactionCreate handler
    |     |-- /claude-resume, /claude-stop, /claude-status, /claude-mode
    |
    |-- periodic cleanup (hourly)
    |     |-- prune stale threads
    |     |-- prune old log files
    |     |-- prune temp files
    |
    v
[claude -p --output-format stream-json]
    |-- spawned per thread
    |-- isolated process with timeout
    |-- session ID tracking for resume
```

### Module Structure

```
daemon/
  bin/
    claude-discord-bridge.js  -- CLI entry point
  core/
    index.js          -- main bridge factory (wires everything)
    claude-runner.js   -- spawns claude CLI processes
    config.js          -- environment-based configuration
    file-handler.js    -- attachment download + output upload
    thread-registry.js -- per-thread session state
    thread-lock.js     -- concurrency control (lock + queue)
    dedup-cache.js     -- message deduplication
    hooks.js           -- addon hook system
    i18n.js            -- internationalization
    format.js          -- markdown formatting + message splitting
    reactions.js       -- emoji reaction management
    logger.js          -- NDJSON structured logging
  templates/
    messages/          -- i18n message templates (en, zh-TW)
    prompts/           -- Claude prompt templates
  addons/              -- drop-in addon modules (auto-discovered)
  tests/               -- unit tests (vitest)
scripts/
  register-commands.js -- register Discord slash commands
  health-check.sh      -- PM2 health check script
```

## Running with PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start as daemon
pm2 start daemon/bin/claude-discord-bridge.js --name claude-bridge

# View logs
pm2 logs claude-bridge

# Restart after config changes
pm2 restart claude-bridge

# Auto-start on boot
pm2 startup
pm2 save
```

## Addon System

Drop a module into `daemon/addons/<name>/index.js` with a `register(hooks, env)` export:

```javascript
// daemon/addons/my-addon/index.js
export function register(hooks, env) {
  hooks.on('onMessage', async (message) => {
    // Return false to block, true to allow
    return true;
  });

  hooks.on('onBeforeClaude', async (prompt, context) => {
    // Transform the prompt before sending to Claude
    return prompt;
  });

  hooks.on('onAfterClaude', async (response, context) => {
    // Transform Claude's response before posting to Discord
    return response;
  });
}

// Optional: declare required env vars (addon skipped if missing)
export function requiredEnv() {
  return ['MY_ADDON_API_KEY'];
}
```

### Available Hooks

| Hook | Phase | Description |
|------|-------|-------------|
| `onMessage` | Filter | Return `false` to block a message |
| `onBeforeClaude` | Transform | Modify prompt before sending to Claude |
| `onAfterClaude` | Transform | Modify response before posting to Discord |
| `startup` | Event | Called when the bot starts |
| `shutdown` | Event | Called when the bot stops |

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

## Security Considerations

- **No secrets in code** -- all credentials via environment variables
- **Session ID validation** -- regex-validated before passing to CLI
- **XML escaping** -- user content escaped before embedding in prompt templates
- **Mention gating** -- configurable @mention requirement prevents accidental triggers
- **DM allowlist** -- restrict direct messages to specific users
- **Per-thread isolation** -- each session runs in a separate process
- **Error message sanitization** -- internal errors never leak to Discord users
- **Hook-based filtering** -- addons can implement custom access control

## License

[MIT](LICENSE)
