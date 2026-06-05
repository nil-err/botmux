import {
  DASHBOARD_LOCALE_STORAGE_KEY,
  createDashboardTranslator,
  readStoredDashboardLocale,
  type DashboardLocale,
} from './i18n.js';
import {
  THEME_STORAGE_KEY,
  SKIN_STORAGE_KEY,
  readStoredThemeMode,
  readStoredSkin,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode,
  type SkinId,
} from './preferences.js';
import { applyCyberFx } from './cyber-fx.js';

type UiListener = () => void;

class DashboardUiState {
  locale: DashboardLocale = 'zh';
  themeMode: ThemeMode = 'system';
  resolvedTheme: ResolvedTheme = 'light';
  skin: SkinId = 'default';
  private listeners = new Set<UiListener>();
  private translate = createDashboardTranslator(this.locale);
  private mediaQuery: MediaQueryList | null = null;

  init(): void {
    const w = typeof window !== 'undefined' ? window : undefined;
    this.locale = readStoredDashboardLocale(w?.localStorage, navigatorLanguages());
    this.translate = createDashboardTranslator(this.locale);
    this.themeMode = readStoredThemeMode(w?.localStorage);
    this.skin = readStoredSkin(w?.localStorage);
    this.mediaQuery = w?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this.mediaQuery?.addEventListener('change', () => {
      this.applyTheme();
      this.emit();
    });
    this.applyTheme();
    this.applySkin();
    this.applyLocale();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.translate(key, params);
  }

  setLocale(locale: DashboardLocale): void {
    if (this.locale === locale) return;
    this.locale = locale;
    this.translate = createDashboardTranslator(locale);
    window.localStorage.setItem(DASHBOARD_LOCALE_STORAGE_KEY, locale);
    this.applyLocale();
    this.emit();
  }

  // The topbar exposes a single "Theme" dropdown whose value is either a base
  // colour mode (system/light/dark → the `default` skin) or a named skin id.
  get theme(): string {
    return this.skin === 'default' ? this.themeMode : this.skin;
  }

  setTheme(value: string): void {
    const isMode = value === 'system' || value === 'light' || value === 'dark';
    const nextSkin: SkinId = isMode ? 'default' : (value as SkinId);
    const skinChanged = nextSkin !== this.skin;
    if (isMode && this.themeMode !== value) {
      this.themeMode = value as ThemeMode;
      window.localStorage.setItem(THEME_STORAGE_KEY, this.themeMode);
    }
    if (skinChanged) {
      this.skin = nextSkin;
      window.localStorage.setItem(SKIN_STORAGE_KEY, this.skin);
    }
    this.applyTheme();
    this.applySkin(skinChanged);
    this.emit();
  }

  on(fn: UiListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private applyTheme(): void {
    this.resolvedTheme = resolveThemeMode(this.themeMode, !!this.mediaQuery?.matches);
    document.documentElement.dataset.theme = this.resolvedTheme;
    document.documentElement.dataset.themeMode = this.themeMode;
  }

  // `animate` plays the boot loader — true when the user actively switches in,
  // false on initial load so a refresh doesn't replay the 3s decrypt overlay.
  private applySkin(animate = false): void {
    document.documentElement.dataset.skin = this.skin;
    applyCyberFx(this.skin === 'cyber', animate);
  }

  private applyLocale(): void {
    document.documentElement.lang = this.locale === 'zh' ? 'zh-CN' : 'en';
  }
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export const ui = new DashboardUiState();

export function t(key: string, params?: Record<string, string | number>): string {
  return ui.t(key, params);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

export function relTime(ms: number): string {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('common.now');
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}
