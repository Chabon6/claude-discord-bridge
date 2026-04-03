/**
 * Structured NDJSON file logger.
 *
 * Writes one JSON line per log entry to daily log files (YYYY-MM-DD.ndjson).
 * Includes log rotation via pruneOldLogs.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} options
 * @param {string} [options.logDir='logs']
 * @param {number} [options.retentionDays=7]
 */
export function createLogger({ logDir = 'logs', retentionDays = 7 } = {}) {
  try { mkdirSync(logDir, { recursive: true }); } catch { /* exists */ }

  function getLogPath() {
    const date = new Date().toLocaleDateString('sv-SE');
    return join(logDir, `${date}.ndjson`);
  }

  function log(level, cat, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      cat,
      ...data,
    };
    const line = JSON.stringify(entry);

    if (level === 'error' || level === 'fatal') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    try {
      appendFileSync(getLogPath(), line + '\n', 'utf-8');
    } catch (err) {
      process.stderr.write(`[logger] Failed to write log: ${err.message}\n`);
    }
  }

  function logClaude(event, threadId, sessionId, data = {}) {
    const level = event === 'error' ? 'error' : 'info';
    log(level, `claude:${event}`, { threadId, sessionId, data });
  }

  function pruneOldLogs() {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    try {
      const files = readdirSync(logDir);
      for (const file of files) {
        if (!file.endsWith('.ndjson')) continue;
        const dateStr = file.replace('.ndjson', '');
        const fileDate = new Date(dateStr + 'T00:00:00').getTime();
        if (Number.isNaN(fileDate)) continue;
        if (fileDate < cutoff) {
          unlinkSync(join(logDir, file));
          pruned++;
        }
      }
    } catch (err) {
      process.stderr.write(`[logger] Failed to prune logs: ${err.message}\n`);
    }
    return pruned;
  }

  return { log, logClaude, pruneOldLogs };
}
