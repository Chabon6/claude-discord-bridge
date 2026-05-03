/**
 * podcast-checker — 透過 Notion API 偵測 Podcast 逐字稿資料庫的新集數
 *
 * 使用 NOTION_KEY_STATEMENTDOG 環境變數存取 Notion API，
 * 查詢 "Podcast 逐字稿 & memo" database 中近期新增的頁面，
 * 與本地狀態檔比對後回傳尚未處理的新集數清單。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 狀態檔預設路徑。 */
const DEFAULT_STATE_PATH = join(
  homedir(), '.claude', 'auto-intel-podcast-state.json',
);

/** 每次查詢最多抓幾筆（Notion 上限 100）。 */
const QUERY_PAGE_SIZE = 20;

/** 只查最近 N 天內的集數，避免回溯過深。 */
const LOOKBACK_DAYS = 7;

/**
 * 對 Notion API 發送請求的共用 helper。
 *
 * @param {string} apiKey  Notion Integration token
 * @param {string} path    API 路徑（不含 base）
 * @param {object} [body]  POST body（若為 undefined 則用 GET）
 * @returns {Promise<object>}
 */
async function notionFetch(apiKey, path, body) {
  const url = `${NOTION_API_BASE}${path}`;
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`Notion API error: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 從 Notion page properties 中萃取摘要資訊。
 *
 * @param {object} page  Notion page object
 * @returns {{ id: string, title: string, show: string, date: string, url: string }}
 */
function extractPageMeta(page) {
  const props = page.properties || {};

  const titleParts = props['集數名稱']?.title || [];
  const title = titleParts.map((t) => t.plain_text).join('');

  const selectVal = props['節目']?.select;
  const show = selectVal?.name || '';

  const dateVal = props['日期']?.date;
  const date = dateVal?.start || '';

  const downloadUrl = props['下載連結']?.url || '';

  return {
    id: page.id,
    title,
    show,
    date,
    url: page.url || '',
    downloadUrl,
  };
}

// =========================================================================
// 狀態檔管理
// =========================================================================

/**
 * 讀取本地狀態檔。
 *
 * @param {string} statePath
 * @returns {Promise<{ processedIds: string[], lastCheckedAt: string }>}
 */
async function readState(statePath = DEFAULT_STATE_PATH) {
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { processedIds: [], lastCheckedAt: '' };
  }
}

/**
 * 原子寫入本地狀態檔（先寫 tmp 再 rename，避免部分寫入造成資料遺失）。
 *
 * @param {{ processedIds: string[], lastCheckedAt: string }} state
 * @param {string} statePath
 */
async function writeState(state, statePath = DEFAULT_STATE_PATH) {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${statePath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmpPath, statePath);
}

// =========================================================================
// 公開 API
// =========================================================================

/**
 * 查詢 Notion database 中尚未處理的新 podcast 頁面。
 *
 * @param {object} opts
 * @param {string} opts.apiKey      Notion Integration token
 * @param {string} opts.databaseId  Podcast 逐字稿 database ID
 * @param {string} [opts.statePath] 狀態檔路徑
 * @returns {Promise<Array<{ id: string, title: string, show: string, date: string, url: string }>>}
 */
export async function checkNewPodcasts({ apiKey, databaseId, statePath }) {
  const state = await readState(statePath);
  const knownIds = new Set(state.processedIds);

  // 查詢近 N 天內的集數（依日期降序）
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceStr = since.toISOString().split('T')[0];

  const data = await notionFetch(apiKey, `/databases/${databaseId}/query`, {
    filter: {
      property: '日期',
      date: { on_or_after: sinceStr },
    },
    sorts: [{ property: '日期', direction: 'descending' }],
    page_size: QUERY_PAGE_SIZE,
  });

  const pages = data.results || [];
  const newPages = pages
    .filter((p) => !knownIds.has(p.id))
    .map(extractPageMeta)
    .filter((p) => p.title.length > 0); // 排除無標題的空頁面

  return newPages;
}

/**
 * 將已處理的 page IDs 寫入狀態檔。
 *
 * @param {string[]} pageIds         新處理完的 page IDs
 * @param {string}   [statePath]     狀態檔路徑
 */
export async function markProcessed(pageIds, statePath) {
  const state = await readState(statePath);
  const idSet = new Set(state.processedIds);
  for (const id of pageIds) idSet.add(id);

  // 只保留最近 200 筆，避免無限成長
  const all = [...idSet];
  const trimmed = all.length > 200 ? all.slice(all.length - 200) : all;

  await writeState({
    processedIds: trimmed,
    lastCheckedAt: new Date().toISOString(),
  }, statePath);
}
