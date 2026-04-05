/**
 * Discover available Claude Code commands (user commands + plugin commands).
 *
 * Scans:
 *   1. ~/.claude/commands/*.md         -- user-installed / global commands
 *   2. ~/.claude/plugins/cache/...     -- plugin-provided commands
 *
 * Each command is returned as { name, description, source }.
 * Results are cached and refreshed periodically or on demand.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_DIR = join(homedir(), '.claude');
const COMMANDS_DIR = join(CLAUDE_DIR, 'commands');
const PLUGINS_CACHE_DIR = join(CLAUDE_DIR, 'plugins', 'cache');

/**
 * Parse YAML frontmatter from a .md file and extract `description`.
 * Returns empty string if no frontmatter or no description found.
 */
function extractDescription(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return '';
    const frontmatter = match[1];
    const descLine = frontmatter
      .split('\n')
      .find((line) => line.startsWith('description:'));
    if (!descLine) return '';
    return descLine.replace(/^description:\s*/, '').trim();
  } catch {
    return '';
  }
}

/** Only allow safe command names: lowercase, digits, hyphens, underscores. */
const VALID_COMMAND_NAME = /^[a-z0-9_-]+$/;

/**
 * Scan a directory for .md command files.
 * @returns {{ name: string, description: string }[]}
 */
function scanCommandDir(dir) {
  try {
    const entries = readdirSync(dir);
    return entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: basename(f, '.md'),
        description: extractDescription(join(dir, f)),
      }))
      .filter((cmd) => VALID_COMMAND_NAME.test(cmd.name));
  } catch {
    return [];
  }
}

/**
 * Scan all plugin cache directories for commands/ subdirectories.
 * @returns {{ name: string, description: string, source: string }[]}
 */
function scanPluginCommands() {
  const results = [];
  try {
    // Structure: cache/<marketplace>/<plugin-name>/<version>/commands/*.md
    const marketplaces = readdirSync(PLUGINS_CACHE_DIR);
    for (const marketplace of marketplaces) {
      const mpDir = join(PLUGINS_CACHE_DIR, marketplace);
      if (!isDir(mpDir)) continue;

      const plugins = readdirSync(mpDir);
      for (const pluginName of plugins) {
        const pluginDir = join(mpDir, pluginName);
        if (!isDir(pluginDir)) continue;

        // Version directories or direct commands/
        const subEntries = readdirSync(pluginDir);
        for (const sub of subEntries) {
          const commandsDir = join(pluginDir, sub, 'commands');
          if (isDir(commandsDir)) {
            const cmds = scanCommandDir(commandsDir);
            for (const cmd of cmds) {
              results.push({ ...cmd, source: pluginName });
            }
          }
        }

        // Also check direct commands/ under plugin dir
        const directCmds = join(pluginDir, 'commands');
        if (isDir(directCmds)) {
          const cmds = scanCommandDir(directCmds);
          for (const cmd of cmds) {
            results.push({ ...cmd, source: pluginName });
          }
        }
      }
    }
  } catch {
    // Plugins dir might not exist
  }
  return results;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create a command discovery instance with caching and auto-refresh.
 *
 * @param {object} [options]
 * @param {number} [options.refreshIntervalMs=3600000] - Auto-refresh interval (default 1h)
 * @param {object} [options.logger]
 * @returns {{ getAll, getCategories, search, refresh, destroy }}
 */
export { VALID_COMMAND_NAME };

export function createCommandDiscovery(options = {}) {
  const { refreshIntervalMs = 60 * 60 * 1000, logger } = options;

  /** @type {{ name: string, description: string, source: string }[]} */
  let cache = [];
  let lastRefresh = 0;

  function refresh() {
    const userCommands = scanCommandDir(COMMANDS_DIR).map((cmd) => ({
      ...cmd,
      source: 'user',
    }));

    const pluginCommands = scanPluginCommands();

    // Deduplicate: user commands take precedence over plugin commands with same name
    const seen = new Set();
    const merged = [];

    for (const cmd of userCommands) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        merged.push(cmd);
      }
    }
    for (const cmd of pluginCommands) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        merged.push(cmd);
      }
    }

    merged.sort((a, b) => a.name.localeCompare(b.name));
    cache = merged;
    lastRefresh = Date.now();

    if (logger) {
      logger.log('info', 'commands:refreshed', { count: cache.length });
    }
  }

  /**
   * Get all discovered commands.
   * @returns {{ name: string, description: string, source: string }[]}
   */
  function getAll() {
    if (cache.length === 0) refresh();
    return cache;
  }

  /**
   * Categorize commands by prefix pattern.
   * @returns {Map<string, { name: string, description: string, source: string }[]>}
   */
  function getCategories() {
    const commands = getAll();
    const categories = new Map();

    for (const cmd of commands) {
      const category = categorize(cmd.name);
      if (!categories.has(category)) {
        categories.set(category, []);
      }
      categories.get(category).push(cmd);
    }

    return categories;
  }

  /**
   * Search commands by keyword (name or description).
   * @param {string} query
   * @returns {{ name: string, description: string, source: string }[]}
   */
  function search(query) {
    const q = query.toLowerCase();
    return getAll().filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q),
    );
  }

  // Auto-refresh timer
  const timer = setInterval(refresh, refreshIntervalMs);

  function destroy() {
    clearInterval(timer);
  }

  // Initial scan
  refresh();

  return { getAll, getCategories, search, refresh, destroy };
}

/**
 * Categorize a command name by its prefix or known patterns.
 */
function categorize(name) {
  const prefixMap = [
    [/^(cpp|go|kotlin|flutter|rust|python|java|csharp)-/, 'Language'],
    [/^(prp|commit|clean|checkpoint|save-session|resume-session)-?/, 'Git'],
    [/^(plan|write-plan|execute-plan|brainstorm|multi-)/, 'Planning'],
    [/^(tdd|test|e2e|verify|eval|quality)/, 'Testing'],
    [/^(docs|update-docs|update-codemaps)$/, 'Docs'],
    [/^(code-review|refactor|prune|polish)/, 'Review'],
    [/^(build-fix|loop|orchestrate|devfleet|gan-)/, 'Automation'],
    [/^(skill|rules|configure|instinct|learned)/, 'Config'],
  ];

  for (const [pattern, category] of prefixMap) {
    if (pattern.test(name)) return category;
  }
  return 'General';
}
