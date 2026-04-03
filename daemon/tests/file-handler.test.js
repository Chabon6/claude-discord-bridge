import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileHandler } from '../core/file-handler.js';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createFileHandler', () => {
  let handler;

  beforeEach(() => {
    handler = createFileHandler();
  });

  describe('createOutputDir', () => {
    it('creates a directory and returns the path', () => {
      const dir = handler.createOutputDir('test-thread-123');
      expect(existsSync(dir)).toBe(true);
      handler.cleanupOutputDir(dir);
    });

    it('sanitizes thread ID in directory name', () => {
      const dir = handler.createOutputDir('thread/with:special<chars>');
      expect(dir).not.toContain('<');
      expect(dir).not.toContain('>');
      expect(existsSync(dir)).toBe(true);
      handler.cleanupOutputDir(dir);
    });
  });

  describe('buildFileContext', () => {
    it('returns empty string for no files', () => {
      expect(handler.buildFileContext([])).toBe('');
    });

    it('builds XML-tagged context for files', () => {
      const files = [
        { name: 'test.txt', contentType: 'text/plain', size: 1024, localPath: '/tmp/test.txt' },
      ];
      const context = handler.buildFileContext(files);
      expect(context).toContain('<attached_files>');
      expect(context).toContain('test.txt');
      expect(context).toContain('1KB');
      expect(context).toContain('</attached_files>');
    });

    it('escapes XML in file names', () => {
      const files = [
        { name: '<script>.txt', contentType: 'text/plain', size: 512, localPath: '/tmp/x.txt' },
      ];
      const context = handler.buildFileContext(files);
      expect(context).toContain('&lt;script&gt;.txt');
      expect(context).not.toContain('<script>');
    });
  });

  describe('buildOutputDirContext', () => {
    it('includes the output directory path', () => {
      const context = handler.buildOutputDirContext('/tmp/output_123');
      expect(context).toContain('/tmp/output_123');
      expect(context).toContain('<output_directory>');
      expect(context).toContain('</output_directory>');
    });
  });

  describe('collectOutputFiles', () => {
    const testDir = join(tmpdir(), 'bridge-test-collect');

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('returns empty array for empty directory', () => {
      const files = handler.collectOutputFiles(testDir);
      expect(files).toEqual([]);
    });

    it('collects deliverable files but skips code files', () => {
      writeFileSync(join(testDir, 'report.pdf'), 'pdf content');
      writeFileSync(join(testDir, 'data.csv'), 'col1,col2');
      writeFileSync(join(testDir, 'script.js'), 'console.log("hi")');

      const files = handler.collectOutputFiles(testDir);
      const names = files.map((f) => f.name);

      expect(names).toContain('report.pdf');
      expect(names).toContain('data.csv');
      expect(names).not.toContain('script.js');
    });

    it('skips empty files', () => {
      writeFileSync(join(testDir, 'empty.pdf'), '');
      const files = handler.collectOutputFiles(testDir);
      expect(files).toEqual([]);
    });

    it('returns empty array for non-existent directory', () => {
      const files = handler.collectOutputFiles('/tmp/does-not-exist-xyz');
      expect(files).toEqual([]);
    });
  });

  describe('cleanupOutputDir', () => {
    it('removes the directory', () => {
      const dir = handler.createOutputDir('cleanup-test');
      expect(existsSync(dir)).toBe(true);
      handler.cleanupOutputDir(dir);
      expect(existsSync(dir)).toBe(false);
    });

    it('does not throw for non-existent directory', () => {
      expect(() => handler.cleanupOutputDir('/tmp/does-not-exist-xyz')).not.toThrow();
    });
  });

  describe('downloadAttachments', () => {
    it('returns empty array for null/empty attachments', async () => {
      expect(await handler.downloadAttachments(null)).toEqual([]);
      expect(await handler.downloadAttachments(new Map())).toEqual([]);
    });
  });
});
