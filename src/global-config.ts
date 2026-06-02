/**
 * Global botmux configuration stored at `~/.botmux/config.json`.
 *
 * This is a single place for "machine-wide, non-bot-specific" settings. The
 * first field is `lang` (UI language). Future settings (log level, dashboard
 * defaults, etc.) can extend the same file without proliferating env vars or
 * sidecar files.
 *
 * Read path is forgiving: missing file → empty config (callers fall back to
 * code defaults). Malformed JSON → empty config + a single stderr warning.
 * Write path is conservative: only the keys the caller actually passes get
 * touched; unknown keys in the on-disk file are preserved across writes so
 * a future client that adds a setting we don't know about doesn't lose it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isLocale, type Locale } from './i18n/types.js';
import type { VoiceConfig } from './services/voice/types.js';

export interface GlobalConfig {
  lang?: Locale;
  /** TTS engine + credentials for the voice-summary feature. See
   *  services/voice/types.ts. Presence (with usable creds) gates the
   *  "🔊 语音总结" button. */
  voice?: VoiceConfig;
}

/** Loosely validate a `voice` block: keep it only if it's an object with a
 *  recognizable engine or engine-specific creds. Deep validation (usable
 *  creds) happens in resolveVoiceConfig; here we just gate obvious garbage. */
function readVoice(raw: unknown): VoiceConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const engineOk = v.engine === 'sami' || v.engine === 'openai' || v.engine === undefined;
  if (!engineOk) return undefined;
  if (!v.sami && !v.openai && !v.engine) return undefined;
  return v as VoiceConfig;
}

export function globalConfigPath(): string {
  return join(homedir(), '.botmux', 'config.json');
}

let warnedOnce = false;

/** Load `~/.botmux/config.json`. Returns `{}` when the file is missing or
 *  unreadable. The raw JSON is also returned (untyped) so writers can
 *  preserve unknown keys round-trip — see `mergeGlobalConfig`. */
function readRawConfig(): Record<string, unknown> {
  const path = globalConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (err: any) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[botmux] Failed to parse ${path}: ${err?.message ?? err}. Ignoring file.`);
    }
    return {};
  }
}

/** Typed view of the global config. Validates `lang` so a malformed file
 *  can't propagate a bad value into the i18n module. */
export function readGlobalConfig(): GlobalConfig {
  const raw = readRawConfig();
  const out: GlobalConfig = {};
  if (isLocale(raw.lang)) out.lang = raw.lang;
  const voice = readVoice(raw.voice);
  if (voice) out.voice = voice;
  return out;
}

/** Merge a patch into the on-disk config, preserving unknown keys. Creates
 *  the file (and parent dir) on first write. Use `null` to explicitly delete
 *  a known key from the file. */
export function mergeGlobalConfig(patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>): void {
  const path = globalConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readRawConfig();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete current[k];
    else current[k] = v;
  }
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
}

/** Convenience: set the global UI locale (or clear it when `null`). */
export function setGlobalLocale(loc: Locale | null): void {
  mergeGlobalConfig({ lang: loc });
}
