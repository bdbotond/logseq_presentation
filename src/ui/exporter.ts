import type { AspectRatio, SlideNode, ThemeId } from '../types';
import { hydrateMermaidDiagrams, renderSlideHtml } from './renderer';
import {
  getAspectRatioClass,
  getThemeClasses,
  getThemePolarity,
  readLogseqHostThemeVars,
} from './themes';
import mainCss from '../styles/main.css?inline';
import katexCss from 'katex/dist/katex.min.css?inline';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderSlidesWithMermaid(
  title: string,
  slides: SlideNode[],
  polarity: 'light' | 'dark',
  ratioClass: string,
  graphPath?: string
): Promise<string> {
  const rawMarkup = slides
    .map(
      (s, i) => `
      <section class="lsp-export-slide ${i === 0 ? 'active' : ''}" data-index="${i}">
        <div class="lsp-slide-frame ${ratioClass}">
          ${renderSlideHtml(s, graphPath, { deckTitle: title, slideIndex: i, slideTotal: slides.length })}
        </div>
      </section>`
    )
    .join('\n');

  if (!rawMarkup.includes('class="mermaid')) return rawMarkup;

  const offscreen = document.createElement('div');
  offscreen.style.cssText = 'position:fixed;left:-99999px;top:0;width:1120px;visibility:hidden;';
  offscreen.innerHTML = rawMarkup;
  document.body.appendChild(offscreen);
  try {
    await hydrateMermaidDiagrams(offscreen, polarity);
    return offscreen.innerHTML;
  } finally {
    offscreen.remove();
  }
}

async function buildStandaloneDocument(
  title: string,
  slides: SlideNode[],
  theme: ThemeId,
  graphPath?: string,
  forPrint = false,
  options?: { logseqMode?: 'light' | 'dark'; aspectRatio?: AspectRatio }
): Promise<string> {
  const logseqMode = options?.logseqMode ?? 'dark';
  const polarity = getThemePolarity(theme, logseqMode);
  const themeClasses = getThemeClasses(theme, logseqMode);
  const ratioClass = getAspectRatioClass(options?.aspectRatio);
  const slidesMarkup = await renderSlidesWithMermaid(title, slides, polarity, ratioClass, graphPath);

  const logseqVarsCss =
    theme === 'logseq'
      ? (() => {
          const entries = Object.entries(readLogseqHostThemeVars());
          if (entries.length === 0) return '';
          return `:root, body { ${entries.map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
        })()
      : '';

  const interactiveScript = forPrint
    ? `<script>
        window.addEventListener('load', () => {
          setTimeout(() => window.print(), 250);
        });
      </script>`
    : `<script>
        (function() {
          const slides = Array.from(document.querySelectorAll('.lsp-export-slide'));
          const counter = document.getElementById('counter');
          const bar = document.getElementById('bar');
          let idx = 0;
          function show(n) {
            idx = Math.max(0, Math.min(slides.length - 1, n));
            slides.forEach((s, i) => s.classList.toggle('active', i === idx));
            if (counter) counter.textContent = (idx + 1) + ' / ' + slides.length;
            if (bar) bar.style.width = (((idx + 1) / Math.max(1, slides.length)) * 100) + '%';
          }
          document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); show(idx + 1); }
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(idx - 1); }
            if (e.key === 'Home') show(0);
            if (e.key === 'End') show(slides.length - 1);
            if (e.key.toLowerCase() === 'f') {
              if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
              else document.exitFullscreen?.();
            }
          });
          document.getElementById('prev')?.addEventListener('click', () => show(idx - 1));
          document.getElementById('next')?.addEventListener('click', () => show(idx + 1));
          show(0);
        })();
      </script>`;

  const extraStyles = forPrint
    ? `
      @page { size: landscape; margin: 0; }
      html, body {
        margin: 0;
        padding: 0;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        background: var(--lsp-bg) !important;
        color: var(--lsp-text) !important;
      }
      .lsp-export-slide {
        display: flex !important;
        width: 100vw;
        height: 100vh;
        box-sizing: border-box;
        padding: 48px 64px;
        page-break-after: always;
        break-after: page;
        align-items: center;
        justify-content: center;
        background: var(--lsp-bg);
      }
      .lsp-export-controls,
      .lsp-export-progress { display: none !important; }
    `
    : `
      body { margin: 0; overflow: hidden; }
      .lsp-export-deck { width: 100vw; height: 100vh; position: relative; }
      .lsp-export-slide {
        display: none;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 48px 72px;
        align-items: center;
        justify-content: center;
        overflow: auto;
      }
      .lsp-export-slide.active { display: flex; }
      .lsp-export-controls {
        position: fixed; bottom: 16px; right: 20px; display: flex; gap: 8px; align-items: center;
        background: rgba(15, 23, 42, 0.72); color: #fff; padding: 6px 12px; border-radius: 999px;
        font-family: system-ui, sans-serif; font-size: 13px;
      }
      .lsp-export-controls button {
        background: transparent; border: none; color: #fff; cursor: pointer; font-size: 14px; padding: 2px 6px;
      }
      .lsp-export-progress { position: fixed; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(128,128,128,0.2); }
      .lsp-export-progress-bar { height: 100%; background: #4f46e5; transition: width 0.2s ease; }
    `;

  return `<!DOCTYPE html>
<html lang="en" class="${themeClasses}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${katexCss}
    ${mainCss}
    ${logseqVarsCss}
    ${extraStyles}
  </style>
</head>
<body class="${themeClasses}">
  <main class="lsp-export-deck">
    ${slidesMarkup}
  </main>
  <div class="lsp-export-controls">
    <button id="prev">←</button>
    <span id="counter">1 / ${slides.length}</span>
    <button id="next">→</button>
  </div>
  <div class="lsp-export-progress"><div id="bar" class="lsp-export-progress-bar"></div></div>
  ${interactiveScript}
</body>
</html>`;
}

export async function exportDeckToHtml(
  title: string,
  slides: SlideNode[],
  theme: ThemeId,
  graphPath?: string,
  options?: { logseqMode?: 'light' | 'dark'; aspectRatio?: AspectRatio }
): Promise<void> {
  const html = await buildStandaloneDocument(title, slides, theme, graphPath, false, options);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = title.toLowerCase().replace(/[^a-z0-9-_]+/g, '-') || 'presentation';
  a.href = url;
  a.download = `${safeName}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function printDeckToPdf(
  title: string,
  slides: SlideNode[],
  theme: ThemeId,
  graphPath?: string,
  options?: { logseqMode?: 'light' | 'dark'; aspectRatio?: AspectRatio }
): Promise<void> {
  const html = await buildStandaloneDocument(title, slides, theme, graphPath, true, options);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    iframe.remove();
  }, 60_000);
}
