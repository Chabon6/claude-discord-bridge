import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create an i18n message resolver.
 *
 * @param {string} locale - 'en' or 'zh-TW'
 * @param {string} [templatesDir]
 */
export function createI18n(locale = 'en', templatesDir) {
  const dir = templatesDir || join(__dirname, '..', 'templates', 'messages');
  const filePath = join(dir, `${locale}.json`);

  let messages;
  try {
    messages = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    messages = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf-8'));
  }

  function t(key, vars = {}) {
    const parts = key.split('.');
    let value = messages;
    for (const part of parts) {
      value = value?.[part];
    }
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
  }

  return { t, locale, messages };
}
