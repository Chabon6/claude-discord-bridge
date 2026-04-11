/**
 * auto-intel addon — 自動情報蒐集與知識攝入
 *
 * 每小時自動執行：
 *   1. 透過 ECC rate limit 快取（或 ccusage 回退）檢查 Claude Code 額度
 *   2. 額度充裕時，呼叫 claude -p 搜尋高品質資訊
 *   3. 將合格內容攝入 knowledge-wiki
 *   4. 發送摘要到 Discord 指定頻道
 *   5. 支援 emoji 回應（✅ 有興趣 / ❌ 沒興趣）與訊息回覆互動
 *
 * 必要環境變數：
 *   AUTO_INTEL_CHANNEL_ID — 發送摘要的 Discord 頻道 ID
 *
 * 可選環境變數：
 *   AUTO_INTEL_INTERVAL_MS   — 執行間隔（預設 3600000 = 1 小時）
 *   AUTO_INTEL_MAX_5H_PCT    — 5 小時 rate limit 百分比上限（預設 80）
 *   AUTO_INTEL_MAX_7D_PCT    — 7 天 rate limit 百分比上限（預設 80）
 *   AUTO_INTEL_MAX_DAILY_COST — 回退用：當日花費閾值 USD（預設 20.00）
 *   AUTO_INTEL_MAX_7DAY_COST  — 回退用：7 天花費閾值 USD（預設 150.00）
 *   AUTO_INTEL_STARTUP_DELAY_MS — 啟動後首次執行延遲（預設 60000 = 1 分鐘）
 *   WIKI_DIR                  — 知識庫路徑（預設 ~/knowledge-wiki）
 *   CLAUDE_CLI_PATH           — Claude CLI 路徑（預設 claude）
 *   CLAUDE_CWD                — Claude 工作目錄（預設 $HOME）
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { checkQuota } from './quota-checker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 主題輪轉表 — 每小時依序切換不同研究方向。
 */
const TOPICS = [
  {
    id: 'career',
    label: '職涯發展',
    keywords: 'career development for accountant turning into tech, CPA technology career path, accounting automation career pivot 2026',
  },
  {
    id: 'ai-skills',
    label: 'AI 與技術技能',
    keywords: 'AI coding assistant productivity, Claude Code tips, Python automation best practices 2026, LLM application development',
  },
  {
    id: 'investment-tw',
    label: '台股投資',
    keywords: 'Taiwan stock market analysis 2026, TWSE investment strategy, Taiwan semiconductor industry outlook',
  },
  {
    id: 'investment-us',
    label: '美股投資',
    keywords: 'US stock market analysis 2026, S&P 500 outlook, tech stock valuation, AI stocks investment thesis',
  },
  {
    id: 'fintech',
    label: '金融科技',
    keywords: 'fintech innovation 2026, accounting technology automation, digital transformation in finance, RPA financial services',
  },
  {
    id: 'social',
    label: '社交與人脈',
    keywords: 'LinkedIn personal branding strategy, professional networking tips tech industry, building online presence for professionals',
  },
  {
    id: 'productivity',
    label: '生產力與工具',
    keywords: 'developer productivity tools 2026, AI-assisted coding workflows, knowledge management systems, Obsidian power user tips',
  },
];

const DISCORD_MAX_LEN = 1900;

/** 簡易訊息分割（在換行處切割）。 */
function splitText(text, maxLen = DISCORD_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/** 取得今天日期字串 YYYY-MM-DD。 */
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/** 取得台灣時間的小時數。 */
function taipeiHour() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }),
  ).getHours();
}

export function requiredEnv() {
  return ['AUTO_INTEL_CHANNEL_ID'];
}

export function register(hooks, env) {
  const channelId = env.AUTO_INTEL_CHANNEL_ID;
  const intervalMs = parseInt(env.AUTO_INTEL_INTERVAL_MS || '3600000', 10);
  const max5hPct = parseInt(env.AUTO_INTEL_MAX_5H_PCT || '80', 10);
  const max7dPct = parseInt(env.AUTO_INTEL_MAX_7D_PCT || '80', 10);
  const maxDailyCost = parseFloat(env.AUTO_INTEL_MAX_DAILY_COST || '20.00');
  const max7dayCost = parseFloat(env.AUTO_INTEL_MAX_7DAY_COST || '150.00');
  const startupDelay = parseInt(env.AUTO_INTEL_STARTUP_DELAY_MS || '60000', 10);
  const wikiDir = resolve(env.WIKI_DIR || join(homedir(), 'knowledge-wiki'));
  const cliPath = env.CLAUDE_CLI_PATH || 'claude';
  const cwd = env.CLAUDE_CWD || homedir();

  let client = null;
  let timer = null;
  let isRunning = false;
  let skipUntil = 0; // 冷卻期：若無結果則延後執行

  // 追蹤已發送的 auto-intel 訊息，用於 emoji 回應處理
  const trackedMessages = new Map();

  // 載入 prompt 模板
  const promptTemplate = readFileSync(
    join(__dirname, 'prompts', 'research.md'),
    'utf-8',
  );

  // =========================================================================
  // Hooks
  // =========================================================================

  hooks.on('startup', (_client, _config) => {
    client = _client;

    client.once('ready', () => {
      log(`addon loaded — interval ${intervalMs / 60_000}min, channel ${channelId}`);

      // 啟動排程
      timer = setInterval(() => runCycle(), intervalMs);

      // 首次延遲執行（讓系統穩定）
      setTimeout(() => runCycle(), startupDelay);
    });

    // 監聽 emoji 回應
    client.on('messageReactionAdd', async (reaction, user) => {
      if (user.bot) return;

      // 處理 partial reaction（Discord 可能不完整載入）
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }

      // 處理 partial message
      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }

      const tracked = trackedMessages.get(reaction.message.id);
      if (!tracked) return;

      const emoji = reaction.emoji.name;

      if (emoji === '\u2705') {
        tracked.interested = true;
        log(`user interested in topic=${tracked.topic} msg=${reaction.message.id}`);
      } else if (emoji === '\u274C') {
        tracked.interested = false;
        log(`user not interested in topic=${tracked.topic} msg=${reaction.message.id}`);
      }
    });
  });

  hooks.on('shutdown', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  // =========================================================================
  // Core cycle
  // =========================================================================

  async function runCycle() {
    if (isRunning) {
      log('previous cycle still running, skipping');
      return;
    }

    // 冷卻期檢查
    if (Date.now() < skipUntil) {
      log('in cooldown period, skipping');
      return;
    }

    // 避免深夜執行（台灣時間 00:00-07:00）
    const hour = taipeiHour();
    if (hour < 7) {
      log(`night hours (${hour}:00 TW), skipping`);
      return;
    }

    isRunning = true;

    try {
      // 1. 額度檢查（優先 rate limit 快取，回退 ccusage）
      const quota = await checkQuota({ max5hPct, max7dPct, maxDailyCost, max7dayCost });
      if (!quota.ok) {
        log(`quota exceeded [${quota.source}]: ${quota.reason}`);
        return;
      }
      if (quota.source === 'rate-limit-cache') {
        log(`quota OK [rate-limit] — 5h:${quota.fiveHourPct ?? '?'}% 7d:${quota.sevenDayPct ?? '?'}% (cache ${quota.cacheAgeMin}min old)`);
      } else if (quota.source === 'ccusage') {
        log(`quota OK [ccusage] — daily $${quota.dailyCost?.toFixed(2) || '?'}, 7day $${quota.weekCost?.toFixed(2) || '?'}`);
      } else {
        log(`quota OK [${quota.source}]: ${quota.reason}`);
      }

      // 2. 選擇主題（依台灣時間小時輪轉）
      const topicIndex = hour % TOPICS.length;
      const topic = TOPICS[topicIndex];
      log(`researching topic: ${topic.label} (${topic.id})`);

      // 3. 建構 prompt
      const prompt = promptTemplate
        .replaceAll('{{TOPIC_LABEL}}', topic.label)
        .replaceAll('{{TOPIC_KEYWORDS}}', topic.keywords)
        .replaceAll('{{TOPIC_ID}}', topic.id)
        .replaceAll('{{TODAY}}', todayStr())
        .replaceAll('{{WIKI_DIR}}', wikiDir);

      // 4. 執行 claude -p
      const result = await runClaudeCli(cliPath, cwd, prompt);

      if (!result || result.trim().length === 0) {
        log('no result from claude, entering 2h cooldown');
        skipUntil = Date.now() + 2 * 60 * 60 * 1000;
        return;
      }

      // 5. 發送到 Discord
      await postToDiscord(result, topic);
      log(`posted summary for topic: ${topic.label}`);
    } catch (err) {
      log(`cycle error: ${err.message}`);
    } finally {
      isRunning = false;
      pruneTrackedMessages();
    }
  }

  // =========================================================================
  // Claude CLI execution
  // =========================================================================

  const CLAUDE_TIMEOUT_MS = 1_500_000; // 25 分鐘上限（研究 + wiki 攝入需時較長）

  function runClaudeCli(cli, workDir, prompt) {
    return new Promise((resolve) => {
      const child = spawn(cli, [
        '-p', prompt,
        '--output-format', 'json',
        '--allowedTools', '*',
      ], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none' },
      });

      // spawn 不支援 timeout，手動實作 kill timer
      const killTimer = setTimeout(() => {
        log(`claude process exceeded ${CLAUDE_TIMEOUT_MS / 60_000}min, killing`);
        try {
          child.kill('SIGTERM');
        } catch { /* best effort */ }
      }, CLAUDE_TIMEOUT_MS);

      const chunks = [];
      const errChunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => errChunks.push(d));

      child.on('close', (code) => {
        clearTimeout(killTimer);
        const stdout = Buffer.concat(chunks).toString('utf-8').trim();

        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
          log(`claude exit code ${code}: ${stderr.slice(0, 300)}`);
          resolve(null);
          return;
        }

        try {
          const json = JSON.parse(stdout);
          resolve(json.result || stdout);
        } catch {
          resolve(stdout);
        }
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        log(`claude spawn error: ${err.message}`);
        resolve(null);
      });
    });
  }

  // =========================================================================
  // Discord posting
  // =========================================================================

  async function postToDiscord(result, topic) {
    if (!client) return;

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      log(`failed to fetch channel ${channelId}: ${err.message}`);
      return;
    }
    if (!channel) return;

    const chunks = splitText(result, DISCORD_MAX_LEN);
    let lastMessage = null;

    for (let i = 0; i < chunks.length; i++) {
      let message;
      try {
        message = await channel.send(chunks[i]);
      } catch (err) {
        log(`failed to send chunk ${i + 1}/${chunks.length}: ${err.message}`);
        break;
      }
      lastMessage = message;
    }

    // 只追蹤最後一則訊息（帶 emoji 的）
    if (lastMessage) {
      try {
        await lastMessage.react('\u2705');
        await lastMessage.react('\u274C');
      } catch {
        // emoji 失敗不影響主流程
      }

      trackedMessages.set(lastMessage.id, {
        topic: topic.id,
        topicLabel: topic.label,
        timestamp: Date.now(),
        interested: null,
      });
    }
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  /** 清除超過 7 天的追蹤記錄。 */
  function pruneTrackedMessages() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [id, data] of trackedMessages) {
      if (data.timestamp < cutoff) {
        trackedMessages.delete(id);
      }
    }
  }

  function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [auto-intel] ${msg}`);
  }
}
