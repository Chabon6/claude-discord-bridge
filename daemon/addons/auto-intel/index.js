/**
 * auto-intel addon — 自動情報蒐集與知識攝入
 *
 * 每日固定整點執行（台灣時間 0/6/12/18 時）：
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
 *   AUTO_INTEL_INTERVAL_MS   — 已棄用（改為固定整點排程，此參數無效）
 *   AUTO_INTEL_MAX_5H_PCT    — 5 小時 rate limit 百分比上限（預設 80）
 *   AUTO_INTEL_MAX_7D_PCT    — 7 天 rate limit 百分比上限（預設 80）
 *   AUTO_INTEL_MAX_DAILY_COST — 回退用：當日花費閾值 USD（預設 20.00）
 *   AUTO_INTEL_MAX_7DAY_COST  — 回退用：7 天花費閾值 USD（預設 150.00）
 *   AUTO_INTEL_STARTUP_DELAY_MS — 啟動後首次執行延遲（預設 60000 = 1 分鐘）
 *   WIKI_DIR                  — 知識庫路徑（預設 ~/knowledge-wiki）
 *   CLAUDE_CLI_PATH           — Claude CLI 路徑（預設 claude）
 *   CLAUDE_CWD                — Claude 工作目錄（預設 $HOME）
 *   NOTION_KEY_STATEMENTDOG   — Notion API Key（Podcast 逐字稿存取用）
 *   AUTO_INTEL_PODCAST_DB_ID  — Podcast 逐字稿 Notion Database ID
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { checkQuota } from './quota-checker.js';
import { checkNewPodcasts, markProcessed } from './podcast-checker.js';

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

/**
 * 套用使用者 profile placeholder。
 * 若 env 未設定，使用通用預設值，避免 prompt 含個資綁定。
 */
function applyUserPlaceholders(prompt, env) {
  const userName = env.AUTO_INTEL_USER_NAME || 'the user';
  const userProfile = env.AUTO_INTEL_USER_PROFILE
    || 'A knowledge worker who values high-quality, actionable information.';
  const userRelevance = env.AUTO_INTEL_USER_RELEVANCE
    || 'practical insight or actionable advice';
  return prompt
    .replaceAll('{{USER_NAME}}', userName)
    .replaceAll('{{USER_PROFILE}}', userProfile)
    .replaceAll('{{USER_RELEVANCE}}', userRelevance);
}

export function requiredEnv() {
  return ['AUTO_INTEL_CHANNEL_ID'];
}

export function register(hooks, env) {
  const channelId = env.AUTO_INTEL_CHANNEL_ID;
  const max5hPct = parseInt(env.AUTO_INTEL_MAX_5H_PCT || '80', 10);
  const max7dPct = parseInt(env.AUTO_INTEL_MAX_7D_PCT || '80', 10);
  const maxDailyCost = parseFloat(env.AUTO_INTEL_MAX_DAILY_COST || '20.00');
  const max7dayCost = parseFloat(env.AUTO_INTEL_MAX_7DAY_COST || '150.00');
  const startupDelay = parseInt(env.AUTO_INTEL_STARTUP_DELAY_MS || '60000', 10);
  const wikiDir = resolve(env.WIKI_DIR || join(homedir(), 'knowledge-wiki'));
  const cliPath = env.CLAUDE_CLI_PATH || 'claude';
  const cwd = env.CLAUDE_CWD || homedir();

  // Podcast 逐字稿偵測設定
  const notionKeyStatementdog = env.NOTION_KEY_STATEMENTDOG || '';
  const podcastDbId = env.AUTO_INTEL_PODCAST_DB_ID || '';
  const podcastEnabled = notionKeyStatementdog.length > 0 && podcastDbId.length > 0;

  let client = null;
  let timer = null;
  let isRunning = false;
  let skipUntil = 0; // 冷卻期：若無結果則延後執行
  let cycleCount = 0; // 執行次數，用於主題輪轉

  // 追蹤已發送的 auto-intel 訊息，用於 emoji 回應處理
  const trackedMessages = new Map();

  // ── 失敗追蹤與自動修復 ──
  const FAILURE_THRESHOLD = 3;           // 連續失敗幾次觸發修復
  const REPAIR_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 同功能修復冷卻 6 小時

  /** @type {Map<string, { count: number, errors: string[] }>} */
  const failureTracker = new Map();
  /** @type {Map<string, number>} 上次修復時間 */
  const lastRepairAt = new Map();
  /** @type {Set<string>} 正在修復中的功能（防止並行修復） */
  const repairInProgress = new Set();

  // 載入 prompt 模板
  const promptTemplate = readFileSync(
    join(__dirname, 'prompts', 'research.md'),
    'utf-8',
  );

  const podcastPromptTemplate = podcastEnabled
    ? readFileSync(join(__dirname, 'prompts', 'podcast-ingest.md'), 'utf-8')
    : '';

  let repairPromptTemplate = null;
  try {
    repairPromptTemplate = readFileSync(
      join(__dirname, 'prompts', 'self-repair.md'),
      'utf-8',
    );
  } catch {
    // self-repair.md 不存在時靜默停用修復功能
  }

  // 固定整點排程：台灣時間 0/6/12/18 時
  const TARGET_HOURS_TW = [0, 6, 12, 18];

  function msUntilNextSlot() {
    const twMs = (Date.now() + 8 * 3_600_000) % 86_400_000;
    const twHour = twMs / 3_600_000;
    for (const h of TARGET_HOURS_TW) {
      if (h > twHour) return { delay: (h - twHour) * 3_600_000, nextHour: h };
    }
    return { delay: (24 - twHour + TARGET_HOURS_TW[0]) * 3_600_000, nextHour: TARGET_HOURS_TW[0] };
  }

  function scheduleNext() {
    const { delay, nextHour } = msUntilNextSlot();
    timer = setTimeout(() => {
      runCycle();
      scheduleNext();
    }, delay);
    log(`下次執行：約 ${Math.round(delay / 60_000)} 分後（TW ${nextHour}:00）`);
  }

  // =========================================================================
  // Hooks
  // =========================================================================

  hooks.on('startup', (_client, _config) => {
    client = _client;

    client.once('ready', () => {
      log(`addon loaded — 固定整點排程 TW 0/6/12/18, channel ${channelId}, podcast=${podcastEnabled ? 'ON' : 'OFF'}`);

      // 首次延遲執行後進入固定整點排程
      timer = setTimeout(() => {
        runCycle();
        scheduleNext();
      }, startupDelay);
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
      clearTimeout(timer);
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

    isRunning = true;

    try {
      // 1. 額度檢查（僅影響 topic research，podcast 偵測不受限）
      const quota = await checkQuota({ max5hPct, max7dPct, maxDailyCost, max7dayCost });
      const topicEnabled = quota.ok;
      if (!quota.ok) {
        log(`quota exceeded [${quota.source}]: ${quota.reason} — skipping topic research`);
      } else if (quota.source.startsWith('rate-limit-cache')) {
        const staleTag = quota.source.includes('stale') ? '/stale' : '';
        log(`quota OK [rate-limit${staleTag}] — 5h:${quota.fiveHourPct ?? 'skipped'}% 7d:${quota.sevenDayPct ?? '?'}% (cache ${quota.cacheAgeMin}min old)`);
      } else if (quota.source === 'ccusage') {
        log(`quota OK [ccusage] — daily $${quota.dailyCost?.toFixed(2) || '?'}, 7day $${quota.weekCost?.toFixed(2) || '?'}`);
      } else {
        log(`quota OK [${quota.source}]: ${quota.reason}`);
      }

      // 2. 選擇主題（依執行次數輪轉，確保 7 個主題均等覆蓋）
      const topicIndex = cycleCount % TOPICS.length;
      cycleCount++;
      const topic = TOPICS[topicIndex];
      if (topicEnabled) log(`researching topic: ${topic.label} (${topic.id})`);

      // 3. 建構 prompt（僅 topicEnabled 時使用）
      const prompt = topicEnabled
        ? applyUserPlaceholders(
            promptTemplate
              .replaceAll('{{TOPIC_LABEL}}', topic.label)
              .replaceAll('{{TOPIC_KEYWORDS}}', topic.keywords)
              .replaceAll('{{TOPIC_ID}}', topic.id)
              .replaceAll('{{TODAY}}', todayStr())
              .replaceAll('{{WIKI_DIR}}', wikiDir),
            env,
          )
        : null;

      // 4. 平行執行：topic research（受 quota 限制）+ podcast 偵測（不受 quota 限制）
      const tasks = [
        topicEnabled ? runClaudeCli(cliPath, cwd, prompt) : Promise.resolve(null),
      ];

      if (podcastEnabled) {
        tasks.push(runPodcastIngest());
      }

      const [topicResult, podcastResult = null] = await Promise.all(tasks);

      // 5. 發送 topic research 到 Discord + 失敗追蹤
      if (topicResult !== null) {
        recordSuccess('topic-research');
        if (topicResult.trim().length > 0) {
          await postToDiscord(topicResult, topic);
          log(`posted summary for topic: ${topic.label}`);
        }
      } else if (topicEnabled) {
        log('no result from topic research');
        await recordFailure('topic-research', `claude returned null for topic: ${topic.id}`);
      } else {
        log('topic research skipped (quota exceeded)');
      }

      // 6. 發送 podcast 結果到 Discord
      if (podcastResult && podcastResult.trim().length > 0) {
        await postToDiscord(podcastResult, {
          id: 'podcast-ingest',
          label: 'Podcast 逐字稿攝入',
        });
        log('posted podcast ingest summary');
      }

      // 若兩邊都無結果，進入冷卻期
      const hasAnyResult =
        (topicResult && topicResult.trim().length > 0) ||
        (podcastResult && podcastResult.trim().length > 0);
      if (!hasAnyResult) {
        log('no results from any source, entering 6h cooldown');
        skipUntil = Date.now() + 6 * 60 * 60 * 1000;
      }
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
  // Podcast 偵測與攝入
  // =========================================================================

  /**
   * 檢查 Notion Podcast 資料庫是否有新集數，若有則觸發 Claude 攝入。
   *
   * @returns {Promise<string|null>} Claude 的攝入結果，或 null
   */
  async function runPodcastIngest() {
    try {
      const newPages = await checkNewPodcasts({
        apiKey: notionKeyStatementdog,
        databaseId: podcastDbId,
      });

      if (newPages.length === 0) {
        log('podcast: no new episodes found');
        recordSuccess('podcast-check');
        return null;
      }

      log(`podcast: found ${newPages.length} new episode(s): ${newPages.map((p) => p.title).join(', ')}`);

      // 組裝頁面清單供 prompt 使用
      const pageListText = newPages
        .map((p) => `- **${p.title}** (${p.show}, ${p.date})\n  Notion URL: ${p.url}\n  Page ID: ${p.id}`)
        .join('\n\n');

      const prompt = applyUserPlaceholders(
        podcastPromptTemplate
          .replaceAll('{{TODAY}}', todayStr())
          .replaceAll('{{WIKI_DIR}}', wikiDir)
          .replaceAll('{{PAGE_LIST}}', pageListText),
        env,
      );

      const result = await runClaudeCli(cliPath, cwd, prompt);

      if (result !== null) {
        // Claude 成功執行（含產出空內容），標記為已處理
        await markProcessed(newPages.map((p) => p.id));
        log(`podcast: marked ${newPages.length} episode(s) as processed`);
        recordSuccess('podcast-ingest');
      } else {
        // Claude 執行失敗（spawn error / non-zero exit / timeout），下次重試
        log(`podcast: claude failed, ${newPages.length} episode(s) will retry next cycle`);
        await recordFailure('podcast-ingest', `claude returned null for ${newPages.length} episodes`);
      }

      return result;
    } catch (err) {
      log(`podcast: error — ${err.message}`);
      await recordFailure('podcast-check', err.message);
      return null;
    }
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
  // 失敗追蹤與自動修復
  // =========================================================================

  const FEATURE_LABELS = {
    'topic-research': '主題情報研究',
    'podcast-ingest': 'Podcast 逐字稿攝入',
    'podcast-check': 'Podcast 資料庫偵測',
  };

  /**
   * 記錄功能失敗，達到閾值時觸發自動修復。
   *
   * @param {string} feature  功能 ID
   * @param {string} errorMsg 錯誤訊息
   */
  async function recordFailure(feature, errorMsg) {
    const entry = failureTracker.get(feature) || { count: 0, errors: [] };
    entry.count += 1;
    entry.errors.push(`[${new Date().toISOString()}] ${errorMsg}`);
    // 只保留最近 5 筆錯誤
    if (entry.errors.length > 5) entry.errors.shift();
    failureTracker.set(feature, entry);

    log(`failure recorded: ${feature} (${entry.count}/${FAILURE_THRESHOLD})`);

    if (entry.count >= FAILURE_THRESHOLD) {
      await triggerRepair(feature);
    }
  }

  /**
   * 記錄功能成功，重置失敗計數器。
   *
   * @param {string} feature 功能 ID
   */
  function recordSuccess(feature) {
    if (failureTracker.has(feature)) {
      failureTracker.delete(feature);
    }
  }

  /**
   * 觸發 Claude Code 自動修復 session。
   *
   * @param {string} feature 故障功能 ID
   */
  async function triggerRepair(feature) {
    if (!repairPromptTemplate) {
      log(`repair: self-repair disabled (prompt template not found)`);
      failureTracker.delete(feature);
      return;
    }

    if (repairInProgress.size > 0) {
      log(`repair: another repair already running (${[...repairInProgress].join(',')}), skipping ${feature}`);
      failureTracker.delete(feature);
      return;
    }

    const lastRepair = lastRepairAt.get(feature) || 0;
    if (Date.now() - lastRepair < REPAIR_COOLDOWN_MS) {
      log(`repair: ${feature} in cooldown, skipping (last repair ${Math.round((Date.now() - lastRepair) / 60_000)}min ago)`);
      failureTracker.delete(feature);
      return;
    }

    const entry = failureTracker.get(feature);
    if (!entry) return;

    log(`repair: triggering self-repair for ${feature} (${entry.count} consecutive failures)`);
    repairInProgress.add(feature);
    lastRepairAt.set(feature, Date.now());

    const errorsText = entry.errors.length > 0
      ? entry.errors.map((e) => `> ${e}`).join('\n')
      : '> (no error details captured)';

    const prompt = repairPromptTemplate
      .replaceAll('{{FEATURE_ID}}', feature)
      .replaceAll('{{FEATURE_LABEL}}', FEATURE_LABELS[feature] || feature)
      .replaceAll('{{FAIL_COUNT}}', String(entry.count))
      .replaceAll('{{RECENT_ERRORS}}', errorsText)
      .replaceAll('{{ADDON_DIR}}', __dirname.replace(/\\/g, '/'))
      .replaceAll('{{TODAY}}', todayStr());

    try {
      const result = await runRepairCli(cliPath, cwd, prompt);

      if (result && result.trim().length > 0) {
        await postToDiscord(result, {
          id: 'self-repair',
          label: `Self-Repair: ${FEATURE_LABELS[feature] || feature}`,
        });
        log(`repair: posted repair report for ${feature}`);
      } else {
        await postToDiscord(
          `**Auto-Intel Self-Repair | ${todayStr()}**\n\n` +
          `**${FEATURE_LABELS[feature] || feature}** 連續失敗 ${entry.count} 次，` +
          `自動修復 session 未產出診斷結果。請人工檢查。\n\n` +
          `最近錯誤：\n${errorsText}`,
          { id: 'self-repair', label: 'Self-Repair' },
        );
        log(`repair: claude returned no result for ${feature}`);
      }
    } catch (err) {
      log(`repair: error during repair of ${feature} — ${err.message}`);
    } finally {
      repairInProgress.delete(feature);
      failureTracker.delete(feature);
    }
  }

  /**
   * 修復專用的 Claude CLI — 限制工具權限（禁止 Write/Edit，僅允許診斷）。
   */
  function runRepairCli(cli, workDir, prompt) {
    return new Promise((resolve) => {
      const child = spawn(cli, [
        '-p', prompt,
        '--output-format', 'json',
        '--disallowedTools', 'Write,Edit,NotebookEdit',
      ], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none' },
      });

      const killTimer = setTimeout(() => {
        log('repair: claude process exceeded timeout, killing');
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
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
          log(`repair: claude exit code ${code}: ${stderr.slice(0, 300)}`);
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
        log(`repair: claude spawn error: ${err.message}`);
        resolve(null);
      });
    });
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
