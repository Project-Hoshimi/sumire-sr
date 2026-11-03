/**
 * User-facing dialog text, loaded from `locales/messages.json` at import time.
 *
 * Edit `locales/messages.json` to change or translate dialog text; `SUMIRE_LANG`
 * picks the language (default `en`) and `SUMIRE_MESSAGES` points at another file.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type MessageKey =
  | 'notImplemented'
  | 'inviteOnlyLogin'
  | 'inviteOnlyBlocked'
  | 'invalidCredentials'
  | 'ownAccount'
  | 'rateLimited'
  | 'expiredToken'
  | 'invalidPassword';

const MESSAGE_KEYS: MessageKey[] = [
  'notImplemented',
  'inviteOnlyLogin',
  'inviteOnlyBlocked',
  'invalidCredentials',
  'ownAccount',
  'rateLimited',
  'expiredToken',
  'invalidPassword',
];

/** Path of the messages file: `SUMIRE_MESSAGES` or the bundled default. */
const MESSAGE_FILE = process.env.SUMIRE_MESSAGES
  ? resolve(process.env.SUMIRE_MESSAGES)
  : resolve(import.meta.dirname, '..', 'locales', 'messages.json');

type Messages = Record<string, Record<string, string>>;

function load(): Messages {
  const raw: unknown = JSON.parse(readFileSync(MESSAGE_FILE, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`messages file must be a JSON object of languages: ${MESSAGE_FILE}`);
  }
  const messages = raw as Record<string, unknown>;
  const en = messages.en;
  if (typeof en !== 'object' || en === null || Array.isArray(en)) {
    throw new Error(`messages file has no "en" object: ${MESSAGE_FILE}`);
  }
  for (const key of MESSAGE_KEYS) {
    if (typeof (en as Record<string, unknown>)[key] !== 'string') {
      throw new Error(`messages file is missing en.${key}: ${MESSAGE_FILE}`);
    }
  }
  return messages as Messages;
}

const MESSAGES = load();

/**
 * Text for `key` in the current language; a missing language or key falls back
 * to English. The language is read per call so tests can switch it in-process.
 */
export function message(key: MessageKey): string {
  const language = process.env.SUMIRE_LANG ?? 'en';
  return MESSAGES[language]?.[key] ?? MESSAGES.en[key];
}
