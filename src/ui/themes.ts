import type { AspectRatio, ThemeId } from '../types';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  polarity: 'light' | 'dark' | 'auto';
}

export const THEME_LIST: ThemeMeta[] = [
  { id: 'logseq', label: 'Logseq', polarity: 'auto' },
  { id: 'light', label: 'Light', polarity: 'light' },
  { id: 'dark', label: 'Dark', polarity: 'dark' },
  { id: 'minimal', label: 'Minimal', polarity: 'light' },
  { id: 'midnight', label: 'Midnight', polarity: 'dark' },
  { id: 'academic', label: 'Academic', polarity: 'light' },
  { id: 'warm-paper', label: 'Warm Paper', polarity: 'light' },
];

export const ASPECT_RATIO_LIST: { id: AspectRatio; label: string }[] = [
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
  { id: 'fluid', label: 'Fluid' },
];

const VALID_THEMES = new Set<string>(THEME_LIST.map((t) => t.id));
const VALID_RATIOS = new Set<string>(ASPECT_RATIO_LIST.map((r) => r.id));

export function isValidTheme(value: unknown): value is ThemeId {
  return typeof value === 'string' && VALID_THEMES.has(value);
}

export function isValidAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && VALID_RATIOS.has(value);
}

export function getThemePolarity(theme: ThemeId, logseqMode: 'light' | 'dark'): 'light' | 'dark' {
  const meta = THEME_LIST.find((t) => t.id === theme);
  if (!meta || meta.polarity === 'auto') return logseqMode;
  return meta.polarity;
}

export function getThemeClasses(theme: ThemeId, logseqMode: 'light' | 'dark'): string {
  const polarity = getThemePolarity(theme, logseqMode);
  if (theme === 'light' || theme === 'dark') {
    return `lsp-theme-${theme}`;
  }
  return `lsp-theme-${polarity} lsp-theme-${theme}`;
}

export function getAspectRatioClass(ratio?: AspectRatio): string {
  const r = ratio ?? '16:9';
  if (r === '4:3') return 'lsp-ratio-4-3';
  if (r === 'fluid') return 'lsp-ratio-fluid';
  return 'lsp-ratio-16-9';
}

export function renderThemeOptionsHtml(selected: ThemeId, logseqMode: 'light' | 'dark'): string {
  return THEME_LIST.map((t) => {
    const label = t.id === 'logseq' ? `Logseq (${logseqMode})` : t.label;
    return `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

export function renderAspectRatioOptionsHtml(selected?: AspectRatio): string {
  const cur = selected ?? '16:9';
  return ASPECT_RATIO_LIST.map(
    (r) => `<option value="${r.id}" ${r.id === cur ? 'selected' : ''}>${r.label}</option>`
  ).join('');
}

export function readLogseqHostThemeVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const hostDoc = window.parent?.document;
    if (!hostDoc) return vars;
    const style = window.parent.getComputedStyle(hostDoc.documentElement);
    const pick = (names: string[]): string => {
      for (const n of names) {
        const v = style.getPropertyValue(n).trim();
        if (v) return v;
      }
      return '';
    };

    const bg = pick(['--ls-secondary-background-color', '--ls-primary-background-color']);
    const surface = pick(['--ls-primary-background-color']);
    const panel = pick(['--ls-secondary-background-color', '--ls-tertiary-background-color']);
    const text = pick(['--ls-primary-text-color']);
    const muted = pick(['--ls-secondary-text-color']);
    const border = pick(['--ls-border-color']);
    const codeBg = pick(['--ls-tertiary-background-color', '--ls-secondary-background-color']);
    const accent = pick(['--ls-link-text-color', '--ls-active-primary-color']);

    if (bg) vars['--lsp-bg'] = bg;
    if (surface) vars['--lsp-surface'] = surface;
    if (panel) vars['--lsp-panel'] = panel;
    if (text) vars['--lsp-text'] = text;
    if (muted) vars['--lsp-muted'] = muted;
    if (border) vars['--lsp-border'] = border;
    if (codeBg) vars['--lsp-code-bg'] = codeBg;
    if (accent) vars['--lsp-accent'] = accent;
  } catch {
    // Ignore cross-origin or non-browser environments
  }
  return vars;
}

const LOGSEQ_VAR_KEYS = [
  '--lsp-bg',
  '--lsp-surface',
  '--lsp-panel',
  '--lsp-text',
  '--lsp-muted',
  '--lsp-border',
  '--lsp-code-bg',
  '--lsp-accent',
];

export function applyLogseqThemeVars(el: HTMLElement, theme: ThemeId): void {
  for (const k of LOGSEQ_VAR_KEYS) {
    el.style.removeProperty(k);
  }
  if (theme !== 'logseq') return;
  const vars = readLogseqHostThemeVars();
  for (const [k, v] of Object.entries(vars)) {
    el.style.setProperty(k, v);
  }
}
