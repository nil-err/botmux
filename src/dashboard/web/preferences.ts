export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'botmux.dashboard.theme';

export function normalizeThemeMode(value: unknown): ThemeMode | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function readStoredThemeMode(storage: Storage | undefined): ThemeMode {
  return normalizeThemeMode(storage?.getItem(THEME_STORAGE_KEY)) ?? 'system';
}

// ── Skin (visual identity, orthogonal to light/dark) ──────────────────────────
// `default` = the regular botmux look (honours the light/dark theme mode).
// Every other id is a self-contained palette distilled from the kaboo webui; each
// ships its own light/dark palette and ignores the light/dark theme mode.
// `cyber` additionally layers on animated neon FX (the "2077" skin).
export type SkinId =
  | 'default'
  | 'cyber'
  | 'genshin'
  | 'fallout'
  | 'prts'
  | 'bluearchive'
  | 'zzz'
  | 'dragonball'
  | 'ikun';

export const SKIN_IDS: readonly SkinId[] = [
  'default',
  'cyber',
  'genshin',
  'fallout',
  'prts',
  'bluearchive',
  'zzz',
  'dragonball',
  'ikun',
];

export const SKIN_STORAGE_KEY = 'botmux.dashboard.skin';

export function normalizeSkin(value: unknown): SkinId | null {
  return typeof value === 'string' && (SKIN_IDS as readonly string[]).includes(value)
    ? (value as SkinId)
    : null;
}

export function readStoredSkin(storage: Storage | undefined): SkinId {
  return normalizeSkin(storage?.getItem(SKIN_STORAGE_KEY)) ?? 'default';
}
