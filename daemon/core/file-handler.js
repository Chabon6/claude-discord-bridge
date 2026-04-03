/**
 * File Handler — download Discord attachments + upload Claude output files.
 *
 * Download: user uploads files -> bot downloads -> Claude reads them
 * Upload:   Claude writes files to output dir -> bot uploads to Discord thread
 *
 * Factory function: fully dependency-injected.
 */

import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const BASE_DIR = join(tmpdir(), 'discord-bridge-files');
mkdirSync(BASE_DIR, { recursive: true });

const OUTPUT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const MAX_FILES_PER_MESSAGE = 5;

const DEFAULT_DELIVERABLE_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.md', '.txt', '.rtf',
  '.csv', '.xlsx', '.xls', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.json', '.xml', '.yaml', '.yml',
  '.zip', '.tar', '.gz',
]);

const DEFAULT_CODE_EXTS = new Set([
  '.js', '.ts', '.py', '.sh', '.bat', '.ps1', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
  '.jsx', '.tsx', '.mjs', '.cjs',
  '.log', '.tmp', '.bak',
]);

/**
 * @param {object} options
 * @param {Set<string>}  [options.deliverableExts]
 * @param {Set<string>}  [options.codeExts]
 */
export function createFileHandler({ deliverableExts, codeExts } = {}) {
  const DELIVERABLE_EXTS = deliverableExts ?? DEFAULT_DELIVERABLE_EXTS;
  const CODE_EXTS = codeExts ?? DEFAULT_CODE_EXTS;

  /**
   * Download all attachments from a Discord message.
   *
   * @param {import('discord.js').Collection<string, import('discord.js').Attachment>} attachments
   * @returns {Promise<Array<{ localPath: string, name: string, contentType: string, size: number }>>}
   */
  async function downloadAttachments(attachments) {
    if (!attachments || attachments.size === 0) return [];

    const results = [];
    let count = 0;

    for (const [, attachment] of attachments) {
      if (count >= MAX_FILES_PER_MESSAGE) break;
      if (attachment.size > MAX_FILE_SIZE) {
        process.stderr.write(`[file-handler] Skipping oversized file ${attachment.name}: ${Math.round(attachment.size / 1024 / 1024)}MB\n`);
        continue;
      }
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) continue;

        const buffer = Buffer.from(await res.arrayBuffer());

        const prefix = randomBytes(4).toString('hex');
        const safeName = (attachment.name || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
        const localPath = join(BASE_DIR, `${prefix}_${safeName}`);
        writeFileSync(localPath, buffer);

        results.push({
          localPath,
          name: attachment.name,
          contentType: attachment.contentType || 'application/octet-stream',
          size: attachment.size,
        });
        count++;
      } catch (err) {
        process.stderr.write(`[file-handler] Error downloading ${attachment.name}: ${err.message}\n`);
      }
    }

    return results;
  }

  /**
   * Build a prompt section describing attached files.
   *
   * @param {Array<object>} downloadedFiles
   * @returns {string}
   */
  function buildFileContext(downloadedFiles) {
    if (downloadedFiles.length === 0) return '';

    const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const fileList = downloadedFiles.map((f, i) => {
      const sizeKB = Math.round(f.size / 1024);
      return `  ${i + 1}. "${escapeXml(f.name)}" (${escapeXml(f.contentType)}, ${sizeKB}KB)\n     Local path: ${f.localPath}`;
    }).join('\n');

    return [
      '',
      '<attached_files>',
      'The user attached the following files. You can read them using the Read tool (for text/code/CSV/JSON)',
      'or view them directly (for images). Process them as the user requests.',
      '',
      fileList,
      '</attached_files>',
    ].join('\n');
  }

  function createOutputDir(threadId) {
    const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join(BASE_DIR, `output_${safeId}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function buildOutputDirContext(outputDir) {
    return [
      '',
      '<output_directory>',
      `If the user requests you to generate deliverable files (reports, charts, CSVs, Excel, images, PDFs, etc.), save them to: ${outputDir}`,
      'Files in this directory will be automatically uploaded to the Discord thread.',
      'Use the Write tool to create files there. Example: Write to "' + outputDir + '/report.csv"',
      '',
      'IMPORTANT: Only save FINAL DELIVERABLES here — files the user explicitly asked for.',
      'Do NOT save intermediate files, scratch code, debug logs, or temporary scripts here.',
      '</output_directory>',
    ].join('\n');
  }

  function collectOutputFiles(outputDir) {
    try {
      const entries = readdirSync(outputDir);
      const files = [];

      for (const entry of entries) {
        const fullPath = join(outputDir, entry);
        try {
          const stat = statSync(fullPath);
          if (!stat.isFile() || stat.size === 0) continue;

          const ext = ('.' + entry.split('.').pop()).toLowerCase();
          if (CODE_EXTS.has(ext)) continue;

          files.push({
            localPath: fullPath,
            name: entry,
            size: stat.size,
          });
        } catch { /* skip */ }
      }

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Upload files to a Discord channel/thread.
   *
   * @param {import('discord.js').TextBasedChannel} channel
   * @param {Array<{ localPath: string, name: string }>} files
   */
  async function uploadFilesToDiscord(channel, files) {
    if (files.length === 0) return;

    const discordFiles = files.map((f) => ({
      attachment: readFileSync(f.localPath),
      name: f.name,
    }));

    // Discord allows up to 10 files per message
    for (let i = 0; i < discordFiles.length; i += 10) {
      const batch = discordFiles.slice(i, i + 10);
      try {
        await channel.send({ files: batch });
      } catch (err) {
        process.stderr.write(`[file-handler] Failed to upload files: ${err.message}\n`);
      }
    }
  }

  function cleanupOutputDir(outputDir) {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  function pruneStaleFiles() {
    const now = Date.now();
    let pruned = 0;

    try {
      const entries = readdirSync(BASE_DIR);
      for (const entry of entries) {
        const fullPath = join(BASE_DIR, entry);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > OUTPUT_MAX_AGE_MS) {
            rmSync(fullPath, { recursive: true, force: true });
            pruned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    return pruned;
  }

  return {
    downloadAttachments,
    buildFileContext,
    createOutputDir,
    buildOutputDirContext,
    collectOutputFiles,
    uploadFilesToDiscord,
    cleanupOutputDir,
    pruneStaleFiles,
  };
}
