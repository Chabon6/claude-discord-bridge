/**
 * quota-checker — 透過 ECC rate limit 快取 + ccusage 檢查 Claude Code 使用額度
 *
 * 優先讀取 ~/.claude/rate-limits-cache.json（由 statusline.sh 每次被 Claude Code
 * 呼叫時寫入，包含真實的 5h / 7d rate limit 百分比）。
 *
 * 快取新鮮（<2h）：檢查 5h + 7d 兩項指標。
 * 快取過期（2h-48h）：僅檢查 7d 指標（5h 已重設，舊值無意義）。
 * 快取硬過期（>48h）：回退到 ccusage CLI 以美元花費判斷。
 * 若兩者都不可用，預設放行（fail-open）。
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

const RATE_LIMIT_CACHE_PATH = join(homedir(), '.claude', 'rate-limits-cache.json');
const CCUSAGE_PATH = join(homedir(), 'AppData', 'Roaming', 'npm', 'ccusage.cmd');

/** 快取超過此時間視為「新鮮」，可信賴 5h 數值。 */
const CACHE_FRESH_MS = 2 * 60 * 60 * 1000;   // 2 小時

/** 快取超過此時間視為完全過期，回退到 ccusage。 */
const CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 小時

// =========================================================================
// Rate limit cache（主要來源）
// =========================================================================

/**
 * 讀取 ECC statusline 寫入的 rate limit 快取。
 *
 * @returns {Promise<{five_hour_pct: number|null, seven_day_pct: number|null, age_ms: number, stale: boolean}|null>}
 *   回傳快取資料，若檔案不存在、格式錯誤、或硬過期（>48h）則回傳 null。
 *   stale=true 表示快取介於 2h-48h，5h 數值不可信。
 */
async function readRateLimitCache() {
  try {
    const raw = await readFile(RATE_LIMIT_CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);

    const updatedAt = new Date(data.updated_at).getTime();
    if (Number.isNaN(updatedAt)) return null;

    const ageMs = Date.now() - updatedAt;
    if (ageMs > CACHE_MAX_AGE_MS) return null;

    return {
      five_hour_pct: typeof data.five_hour_pct === 'number' ? data.five_hour_pct : null,
      seven_day_pct: typeof data.seven_day_pct === 'number' ? data.seven_day_pct : null,
      age_ms: ageMs,
      stale: ageMs > CACHE_FRESH_MS,
    };
  } catch {
    return null;
  }
}

// =========================================================================
// ccusage（回退來源）
// =========================================================================

/** YYYYMMDD 格式 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function sumCostForToday(dailyRows) {
  const todayStr = new Date().toISOString().split('T')[0];
  return dailyRows
    .filter((row) => row.date === todayStr)
    .reduce((sum, row) => sum + (row.totalCost || 0), 0);
}

function sumCostForDays(dailyRows, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return dailyRows
    .filter((row) => row.date >= cutoffStr)
    .reduce((sum, row) => sum + (row.totalCost || 0), 0);
}

/**
 * 透過 ccusage 檢查美元花費（回退邏輯）。
 */
async function checkViaCcusage({ maxDailyCost, max7dayCost }) {
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { stdout } = await execFileAsync(CCUSAGE_PATH, [
    'daily', '-j',
    '-s', formatDate(sevenDaysAgo),
    '-u', formatDate(today),
  ], { timeout: 30_000, shell: true });

  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : (parsed.daily || []);

  const dailyCost = sumCostForToday(rows);
  const weekCost = sumCostForDays(rows, 7);

  if (dailyCost >= maxDailyCost) {
    return {
      ok: false,
      source: 'ccusage',
      reason: `daily cost $${dailyCost.toFixed(2)} >= $${maxDailyCost.toFixed(2)}`,
      dailyCost,
      weekCost,
    };
  }

  if (weekCost >= max7dayCost) {
    return {
      ok: false,
      source: 'ccusage',
      reason: `7-day cost $${weekCost.toFixed(2)} >= $${max7dayCost.toFixed(2)}`,
      dailyCost,
      weekCost,
    };
  }

  return { ok: true, source: 'ccusage', reason: 'within budget', dailyCost, weekCost };
}

// =========================================================================
// 公開 API
// =========================================================================

/**
 * 檢查 Claude Code 額度是否有餘裕。
 *
 * @param {object} options
 * @param {number} options.max5hPct      - 5 小時 rate limit 百分比上限（預設 80）
 * @param {number} options.max7dPct      - 7 天 rate limit 百分比上限（預設 80）
 * @param {number} options.maxDailyCost  - 回退用：當日花費閾值 USD（預設 20.00）
 * @param {number} options.max7dayCost   - 回退用：7 天花費閾值 USD（預設 150.00）
 * @returns {Promise<{ ok: boolean, source: string, reason: string, ... }>}
 */
export async function checkQuota({
  max5hPct = 80,
  max7dPct = 80,
  maxDailyCost = 20.0,
  max7dayCost = 150.0,
} = {}) {
  // 1. 優先使用 rate limit 快取
  const cache = await readRateLimitCache();

  if (cache) {
    const { five_hour_pct, seven_day_pct, age_ms, stale } = cache;
    const ageMin = Math.round(age_ms / 60_000);
    const source = stale ? 'rate-limit-cache(stale)' : 'rate-limit-cache';

    if (stale) {
      console.warn(`[quota-checker] 快取已過期 ${ageMin} 分鐘，5h 數值不可信，僅檢查 7d 指標。`);
    }

    // 快取過期時跳過 5h 檢查：5h rate limit 在重設後舊值已無意義
    if (!stale && five_hour_pct !== null && five_hour_pct >= max5hPct) {
      return {
        ok: false,
        source,
        reason: `5h rate limit ${five_hour_pct}% >= ${max5hPct}%`,
        fiveHourPct: five_hour_pct,
        sevenDayPct: seven_day_pct,
        cacheAgeMin: ageMin,
      };
    }

    if (seven_day_pct !== null && seven_day_pct >= max7dPct) {
      return {
        ok: false,
        source,
        reason: `7d rate limit ${seven_day_pct}% >= ${max7dPct}%`,
        fiveHourPct: five_hour_pct,
        sevenDayPct: seven_day_pct,
        cacheAgeMin: ageMin,
      };
    }

    return {
      ok: true,
      source,
      reason: stale ? `within 7d rate limit (stale cache, 5h skipped)` : 'within rate limits',
      fiveHourPct: five_hour_pct,
      sevenDayPct: seven_day_pct,
      cacheAgeMin: ageMin,
    };
  }

  // 2. 快取不可用，回退到 ccusage
  try {
    return await checkViaCcusage({ maxDailyCost, max7dayCost });
  } catch (err) {
    // 3. 兩者都不可用，預設放行
    return {
      ok: true,
      source: 'none',
      reason: `both sources unavailable (${err.message}), proceeding cautiously`,
    };
  }
}
