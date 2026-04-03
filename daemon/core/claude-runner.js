/**
 * Claude CLI Runner — spawn `claude -p` and handle streaming/buffered output.
 *
 * Factory function pattern: accepts cliPath, cwd, and logger as parameters.
 * No global config imports — fully dependency-injected.
 *
 * Returns: { runClaude, killClaude, getActiveProcess, listActiveProcesses }
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Valid permission modes for Claude CLI execution.
 *
 * - 'full-auto': Uses --allowedTools '*' — all tools pre-approved, no prompts.
 * - 'auto':      Uses --permission-mode auto — background classifier reviews actions.
 * - 'acceptEdits': Uses --permission-mode acceptEdits — auto-accept edits only.
 * - 'plan':      Uses --permission-mode plan — read-only analysis, no edits.
 * - 'dontAsk':   Uses --permission-mode dontAsk — only pre-approved tools allowed.
 */
const VALID_PERMISSION_MODES = new Set([
  'full-auto',
  'auto',
  'acceptEdits',
  'plan',
  'dontAsk',
]);

/**
 * Validate and normalize a permission mode string.
 *
 * @param {string} mode
 * @returns {string}
 */
export function normalizePermissionMode(mode) {
  if (VALID_PERMISSION_MODES.has(mode)) return mode;
  return 'full-auto';
}

export { VALID_PERMISSION_MODES };

/**
 * Create a Claude runner instance.
 *
 * @param {object} options
 * @param {string}  [options.cliPath='claude']   - Path to the `claude` CLI binary
 * @param {string}  [options.cwd]                - Working directory for Claude processes
 * @param {object}  [options.logger]             - Logger with logClaude(event, threadId, sessionId, data) method
 * @returns {{ runClaude: Function, killClaude: Function, getActiveProcess: Function, listActiveProcesses: Function }}
 */
export function createClaudeRunner({ cliPath = 'claude', cwd, logger } = {}) {
  const activeProcesses = new Map();
  const logClaude = logger?.logClaude ?? (() => {});

  /**
   * Run `claude -p` with stream-json output and return { text, sessionId }.
   *
   * @param {string} prompt
   * @param {object} options
   * @param {string}   [options.resumeSessionId]
   * @param {number}   [options.timeoutMs]
   * @param {string}   [options.threadId]
   * @param {function} [options.onProgress]
   * @param {number}   [options.progressIntervalMs]
   * @param {function} [options.onStreamEvent]
   * @param {string}   [options.permissionMode='full-auto'] - Claude permission mode
   */
  function runClaude(prompt, {
    resumeSessionId,
    timeoutMs = 3_600_000,
    threadId,
    onProgress,
    progressIntervalMs = 900_000,
    onStreamEvent,
    permissionMode = 'full-auto',
  } = {}) {
    const useStreaming = Boolean(onStreamEvent) && timeoutMs > 120_000;

    logClaude('start', threadId, resumeSessionId, {
      phase: timeoutMs <= 120_000 ? 1 : 2,
      promptSnippet: prompt.slice(0, 100),
      timeoutMs,
      useStreaming,
      permissionMode,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let progressTimer = null;

      const cleanup = () => {
        if (progressTimer) clearInterval(progressTimer);
        if (threadId) activeProcesses.delete(threadId);
      };

      // Build args array — no shell interpolation, defence-in-depth
      const outputFormat = useStreaming ? 'stream-json' : 'json';
      const mode = normalizePermissionMode(permissionMode);
      const args = ['-p', prompt, '--output-format', outputFormat];

      // Permission mode determines tool approval strategy
      if (mode === 'full-auto') {
        args.push('--allowedTools', '*');
      } else {
        args.push('--permission-mode', mode);
      }

      if (useStreaming) args.push('--verbose');
      if (resumeSessionId) {
        // Validate session ID format before passing to CLI
        if (!/^[a-f0-9-]{8,36}$/.test(resumeSessionId)) {
          return reject(new Error(`Invalid session ID format: ${resumeSessionId.slice(0, 20)}`));
        }
        args.push('--resume', resumeSessionId);
      }

      const child = spawn(cliPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, BROWSER: 'none' },
      });

      if (threadId) {
        activeProcesses.set(threadId, { child, startTime, prompt: prompt.slice(0, 100) });
      }

      if (onProgress && progressIntervalMs > 0) {
        progressTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 60_000);
          onProgress({ elapsedMin: elapsed, startTime });
        }, progressIntervalMs);
      }

      if (useStreaming) {
        handleStreamingOutput(child, startTime, threadId, onStreamEvent, logClaude, cleanup, resolve, reject);
      } else {
        handleBufferedOutput(child, startTime, threadId, logClaude, cleanup, resolve, reject);
      }

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }

  /**
   * Force-kill an active Claude process by thread ID.
   *
   * @param {string} threadId
   * @returns {boolean}
   */
  function killClaude(threadId) {
    const entry = activeProcesses.get(threadId);
    if (!entry) return false;

    logClaude('kill', threadId, null, { reason: 'manual' });

    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
    }

    activeProcesses.delete(threadId);
    return true;
  }

  /**
   * @param {string} threadId
   * @returns {{ elapsedMin: number, prompt: string } | null}
   */
  function getActiveProcess(threadId) {
    const entry = activeProcesses.get(threadId);
    if (!entry) return null;
    return {
      elapsedMin: Math.round((Date.now() - entry.startTime) / 60_000),
      prompt: entry.prompt,
    };
  }

  /**
   * @returns {Array<{ threadId: string, elapsedMin: number, prompt: string }>}
   */
  function listActiveProcesses() {
    const result = [];
    for (const [threadId, entry] of activeProcesses) {
      result.push({
        threadId,
        elapsedMin: Math.round((Date.now() - entry.startTime) / 60_000),
        prompt: entry.prompt,
      });
    }
    return result;
  }

  return { runClaude, killClaude, getActiveProcess, listActiveProcesses };
}

// --- Internal helpers ---

function handleStreamingOutput(child, startTime, threadId, onStreamEvent, logClaude, cleanup, resolve, reject) {
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const errChunks = [];
  let finalResult = null;
  let permissionDenied = false;

  child.stderr.on('data', (data) => errChunks.push(data));

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const { type } = event;

    if (type === 'assistant') {
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          emitSafe(onStreamEvent, {
            type: 'text',
            text: block.text,
            sessionId: event.session_id,
            elapsedMs: Date.now() - startTime,
          });
        } else if (block.type === 'tool_use') {
          emitSafe(onStreamEvent, {
            type: 'tool_use',
            toolName: block.name,
            toolInput: block.input,
            sessionId: event.session_id,
            elapsedMs: Date.now() - startTime,
          });
          logClaude('tool', threadId, event.session_id, { toolName: block.name });
        }
      }
    } else if (type === 'tool_result') {
      const isError = event.is_error ?? false;

      // Detect permission denial from tool error content
      if (isError) {
        const errorContent = String(event.content || event.error || '');
        if (/permission|denied|not.?allowed|blocked|forbidden/i.test(errorContent)) {
          permissionDenied = true;
        }
      }

      emitSafe(onStreamEvent, {
        type: 'tool_result',
        toolName: event.tool_name ?? null,
        isError,
        sessionId: event.session_id,
        elapsedMs: Date.now() - startTime,
      });
      logClaude('tool_result', threadId, event.session_id, {
        toolName: event.tool_name ?? null,
        isError,
      });
    } else if (type === 'result') {
      finalResult = {
        text: event.result ?? '',
        sessionId: event.session_id ?? null,
        cost: event.total_cost_usd ?? null,
        durationMs: event.duration_ms ?? null,
        numTurns: event.num_turns ?? null,
      };
    }
  });

  child.on('close', (code) => {
    cleanup();
    const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
    const durationMs = Date.now() - startTime;

    if (finalResult) {
      logClaude('done', threadId, finalResult.sessionId, {
        durationMs,
        numTurns: finalResult.numTurns,
        cost: finalResult.cost,
        exitCode: code,
        permissionDenied,
      });
      resolve({ ...finalResult, permissionDenied });
    } else if (code === 0) {
      logClaude('done', threadId, null, { durationMs, exitCode: 0, note: 'no result line' });
      resolve({ text: '', sessionId: null, permissionDenied });
    } else if (code === null) {
      logClaude('error', threadId, null, {
        durationMs,
        exitCode: code,
        signal: child.signalCode,
        stderrSnippet: stderr.slice(0, 500),
      });
      reject(new Error(
        `claude process terminated after ${Math.round(durationMs / 60_000)}min` +
        ` (${child.signalCode || 'unknown signal'}): ${stderr.slice(0, 200) || 'no stderr'}`
      ));
    } else {
      logClaude('error', threadId, null, {
        durationMs,
        exitCode: code,
        stderrSnippet: stderr.slice(0, 500),
      });
      reject(new Error(`claude exited with code ${code}: ${stderr}`));
    }
  });
}

function handleBufferedOutput(child, startTime, threadId, logClaude, cleanup, resolve, reject) {
  const chunks = [];
  const errChunks = [];

  child.stdout.on('data', (data) => chunks.push(data));
  child.stderr.on('data', (data) => errChunks.push(data));

  child.on('close', (code) => {
    cleanup();
    const stdout = Buffer.concat(chunks).toString('utf-8').trim();
    const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
    const durationMs = Date.now() - startTime;

    if (code === 0) {
      try {
        const json = JSON.parse(stdout);
        logClaude('done', threadId, json.session_id ?? null, { durationMs, exitCode: 0 });
        resolve({ text: json.result ?? stdout, sessionId: json.session_id ?? null });
      } catch {
        logClaude('done', threadId, null, { durationMs, exitCode: 0, note: 'non-json output' });
        resolve({ text: stdout, sessionId: null });
      }
    } else if (code === null) {
      logClaude('error', threadId, null, {
        durationMs,
        exitCode: code,
        signal: child.signalCode,
        stderrSnippet: stderr.slice(0, 500),
      });
      reject(new Error(
        `claude process terminated after ${Math.round(durationMs / 60_000)}min` +
        ` (${child.signalCode || 'unknown signal'}): ${stderr.slice(0, 200) || 'no stderr'}`
      ));
    } else {
      logClaude('error', threadId, null, {
        durationMs,
        exitCode: code,
        stderrSnippet: stderr.slice(0, 500),
      });
      reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
    }
  });
}

function emitSafe(fn, event) {
  try {
    const result = fn(event);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch { /* swallow */ }
}
