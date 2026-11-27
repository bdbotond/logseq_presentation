import { marked } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import type { SlideBlockItem, SlideNode } from '../types';
import { resolveAssetPath } from '../services/slideParser';

let mermaidModule: any = null;
let mermaidCounter = 0;
let placeholderNonce = 0;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeUrl(url: string): boolean {
  const cleaned = url.replace(/[\u0000-\u0020]+/g, '').trim().toLowerCase();
  if (!cleaned) return false;
  if (/^(?:javascript|vbscript):/.test(cleaned)) return false;
  if (cleaned.startsWith('data:') && !/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico);/i.test(cleaned)) {
    return false;
  }
  return true;
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: { href: string; title?: string | null; tokens: any[] }) {
      const label = this.parser.parseInline(tokens);
      if (!href || !isSafeUrl(href)) {
        return label;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const targetAttr = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href)}"${titleAttr}${targetAttr}>${label}</a>`;
    },
    image({ href, title, text }: { href: string; title?: string | null; text: string }) {
      if (!href || !isSafeUrl(href)) {
        return escapeHtml(text || '');
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text || '')}" class="lsp-img"${titleAttr} />`;
    },
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let highlighted: string;
      let resolvedLang = language;
      try {
        if (language && hljs.getLanguage(language)) {
          highlighted = hljs.highlight(text, { language }).value;
        } else {
          const auto = hljs.highlightAuto(text);
          highlighted = auto.value;
          resolvedLang = auto.language || '';
        }
      } catch {
        highlighted = escapeHtml(text);
      }
      const cls = resolvedLang ? `hljs language-${escapeHtml(resolvedLang)}` : 'hljs';
      return `<pre class="lsp-code-block"><code class="${cls}">${highlighted}</code></pre>\n`;
    },
  },
});

function renderMath(
  src: string,
  addInline: (html: string) => string,
  addBlock: (html: string) => string
): string {
  let out = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try {
      return `\n\n${addBlock(
        `<div class="lsp-math-block">${katex.renderToString(tex.trim(), {
          displayMode: true,
          throwOnError: false,
        })}</div>`
      )}\n\n`;
    } catch {
      return `\n\n${addBlock(`<pre>${escapeHtml(tex)}</pre>`)}\n\n`;
    }
  });

  out = out.replace(/(?<!\\)\$(?!\s)((?:\\.|[^\\\n$])+?(?<!\s))\$(?![0-9])/g, (_, tex) => {
    try {
      return addInline(
        katex.renderToString(tex.trim(), {
          displayMode: false,
          throwOnError: false,
        })
      );
    } catch {
      return addInline(`<code>${escapeHtml(tex)}</code>`);
    }
  });

  return out;
}

function preprocessLogseqSyntax(
  raw: string,
  graphPath: string | undefined,
  addInline: (html: string) => string,
  addBlock: (html: string) => string
): string {
  let text = raw;

  // Handle Logseq image attributes: ![alt](path){:height 200, :width 300}
  text = text.replace(
    /!\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)\{([^}\n]+)\}/g,
    (_, alt, url, attrs) => {
      const resolved = resolveAssetPath(url, graphPath);
      if (!isSafeUrl(resolved)) return escapeHtml(alt);
      const heightMatch = attrs.match(/:height\s+(\d+)/);
      const widthMatch = attrs.match(/:width\s+(\d+)/);
      const styles: string[] = [];
      if (heightMatch) styles.push(`height:${heightMatch[1]}px`);
      if (widthMatch) styles.push(`width:${widthMatch[1]}px`);
      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      return addInline(
        `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" class="lsp-img"${styleAttr} />`
      );
    }
  );

  // Standard markdown images ![alt](path)
  text = text.replace(/!\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, (_, alt, url) => {
    const resolved = resolveAssetPath(url, graphPath);
    if (!isSafeUrl(resolved)) return escapeHtml(alt);
    return addInline(`<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" class="lsp-img" />`);
  });

  // Video embeds {{video url}} or {{youtube url}}
  text = text.replace(/\{\{(?:video|youtube)\s+([^}]+)\}\}/gi, (_, url) => {
    const cleanUrl = url.trim();
    const ytMatch = cleanUrl.match(
      /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/
    );
    if (ytMatch) {
      return `\n\n${addBlock(
        `<div class="lsp-video"><iframe src="https://www.youtube.com/embed/${ytMatch[1]}" referrerpolicy="strict-origin-when-cross-origin" frameborder="0" allowfullscreen></iframe></div>`
      )}\n\n`;
    }
    const resolved = resolveAssetPath(cleanUrl, graphPath);
    if (!isSafeUrl(resolved)) return '';
    return `\n\n${addBlock(
      `<div class="lsp-video"><video controls src="${escapeHtml(resolved)}"></video></div>`
    )}\n\n`;
  });

  // Task status markers at start
  text = text.replace(
    /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED)\s+/gm,
    (_, status) => `${addInline(`<span class="lsp-task lsp-task-${status}">${status}</span>`)} `
  );

  // Highlights ==text== or ^^text^^ (require non-space boundaries so `a == b && c == d` is untouched)
  text = text.replace(
    /==(?=\S)((?:(?!==)[^\n])*?\S)==|\^\^(?=\S)((?:(?!\^\^)[^\n])*?\S)\^\^/g,
    (_, a, b) => addInline(`<mark class="lsp-mark">${escapeHtml(a ?? b)}</mark>`)
  );

  // Page references [[Page]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, page) => {
    const safe = escapeHtml(page);
    return addInline(`<span class="lsp-page-ref" data-page-ref="${safe}">${safe}</span>`);
  });

  // Tags #tag (only when preceded by start/whitespace, never markdown headings, pure numbers, or hex colors)
  text = text.replace(/(^|\s)#([a-zA-Z0-9_/-]+)/g, (match, pre, tag) => {
    if (/^\d+$/.test(tag) || /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tag)) {
      return match;
    }
    return `${pre}${addInline(`<span class="lsp-tag">#${escapeHtml(tag)}</span>`)}`;
  });

  return text;
}

export function renderMarkdownText(raw: string, graphPath?: string): string {
  const nonce = ++placeholderNonce;
  const mermaidBlocks: string[] = [];
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const safeInline: string[] = [];
  const safeBlock: string[] = [];

  const addInline = (html: string): string => {
    const idx = safeInline.length;
    safeInline.push(html);
    return `@@LSP${nonce}_INLINE_${idx}@@`;
  };
  const addBlock = (html: string): string => {
    const idx = safeBlock.length;
    safeBlock.push(html);
    return `@@LSP${nonce}_BLOCK_${idx}@@`;
  };

  // 1. Extract mermaid blocks
  let text = raw.replace(/```mermaid\s*\n([\s\S]*?)```/gi, (_, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `\n\n@@LSP${nonce}_MERMAID_${idx}@@\n\n`;
  });

  // 2. Protect fenced code blocks from Logseq/math transforms
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `@@LSP${nonce}_CODEBLOCK_${idx}@@`;
  });

  // 3. Protect inline code spans (including multi-backtick spans)
  text = text.replace(/(`+)(?!`)(?:(?!\1)[^\n])+?(?<!`)\1(?!`)/g, (match) => {
    const idx = inlineCodes.length;
    inlineCodes.push(match);
    return `@@LSP${nonce}_INLINECODE_${idx}@@`;
  });

  // 4. Render math before Logseq syntax so LaTeX is not mangled by ==, ^^, #, [[...]]
  text = renderMath(text, addInline, addBlock);
  text = preprocessLogseqSyntax(text, graphPath, addInline, addBlock);

  // 5. Restore protected code blocks before marked parses markdown (function replacer avoids $ patterns)
  codeBlocks.forEach((block, idx) => {
    text = text.replace(`@@LSP${nonce}_CODEBLOCK_${idx}@@`, () => block);
  });
  inlineCodes.forEach((code, idx) => {
    text = text.replace(`@@LSP${nonce}_INLINECODE_${idx}@@`, () => code);
  });

  let html = marked.parse(text) as string;

  // 6. Restore trusted generated HTML & mermaid blocks after marked sanitizes raw HTML
  safeBlock.forEach((snippet, idx) => {
    html = html.replace(
      new RegExp(`(?:<p>)?@@LSP${nonce}_BLOCK_${idx}@@(?:</p>)?`, 'g'),
      () => snippet
    );
  });
  safeInline.forEach((snippet, idx) => {
    html = html.replace(`@@LSP${nonce}_INLINE_${idx}@@`, () => snippet);
  });
  mermaidBlocks.forEach((code, idx) => {
    const id = `lsp-mermaid-${++mermaidCounter}`;
    const snippet = `<div class="mermaid lsp-mermaid" id="${id}">${escapeHtml(code)}</div>`;
    html = html.replace(
      new RegExp(`(?:<p>)?@@LSP${nonce}_MERMAID_${idx}@@(?:</p>)?`, 'g'),
      () => snippet
    );
  });

  return html;
}

function isHeadingBlock(content: string): RegExpMatchArray | null {
  return content.trim().match(/^(#{2,6})\s+(.+)$/);
}

function isStandaloneRichBlock(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^```/.test(trimmed)) return true; // code or mermaid
  if (/^\|.+\|\s*\n\s*\|[-:| ]+\|/.test(trimmed)) return true; // markdown table
  if (/^!\[[^\]]*\]\((?:[^()\n]|\([^()\n]*\))+\)(?:\{[^}\n]+\})?$/.test(trimmed)) return true; // standalone image
  if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) return true; // display math
  if (/^\{\{(?:video|youtube)\s+[^}]+\}\}$/i.test(trimmed)) return true; // video embed
  if (/^>/.test(trimmed)) return true; // blockquote
  return false;
}

function renderNestedBullets(blocks: SlideBlockItem[], graphPath?: string): string {
  if (blocks.length === 0) return '';
  const items = blocks
    .map((block) => {
      const contentHtml = renderMarkdownText(block.content, graphPath);
      const childrenHtml = renderNestedBullets(block.children, graphPath);
      return `<li class="lsp-bullet-item"><div class="lsp-bullet-content">${contentHtml}</div>${childrenHtml}</li>`;
    })
    .join('');
  return `<ul class="lsp-bullet-list">${items}</ul>`;
}

function renderBodyBlocks(blocks: SlideBlockItem[], graphPath?: string): string {
  if (blocks.length === 0) return '';

  const parts: string[] = [];
  let bulletBuffer: SlideBlockItem[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    parts.push(renderNestedBullets(bulletBuffer, graphPath));
    bulletBuffer = [];
  };

  for (const block of blocks) {
    const headingMatch = isHeadingBlock(block.content);
    if (headingMatch) {
      flushBullets();
      const level = Math.min(6, headingMatch[1].length);
      const headingText = renderMarkdownText(headingMatch[2], graphPath).replace(
        /^<p>|<\/p>\s*$/g,
        ''
      );
      const cls = level === 2 ? 'lsp-subtitle' : 'lsp-subsubtitle';
      const childrenHtml = renderBodyBlocks(block.children, graphPath);
      parts.push(
        `<div class="lsp-section"><h${level} class="${cls}">${headingText}</h${level}>${childrenHtml}</div>`
      );
      continue;
    }

    if (isStandaloneRichBlock(block.content)) {
      flushBullets();
      const richHtml = renderMarkdownText(block.content, graphPath);
      const childrenHtml = renderBodyBlocks(block.children, graphPath);
      parts.push(`<div class="lsp-rich-block">${richHtml}${childrenHtml}</div>`);
      continue;
    }

    bulletBuffer.push(block);
  }

  flushBullets();
  return parts.join('\n');
}

function renderTwoColumnBody(blocks: SlideBlockItem[], graphPath?: string): string {
  const rich: SlideBlockItem[] = [];
  const text: SlideBlockItem[] = [];
  for (const b of blocks) {
    if (isStandaloneRichBlock(b.content)) rich.push(b);
    else text.push(b);
  }
  let leftBlocks: SlideBlockItem[];
  let rightBlocks: SlideBlockItem[];
  if (text.length > 0 && rich.length > 0) {
    leftBlocks = text;
    rightBlocks = rich;
  } else {
    const mid = Math.ceil(blocks.length / 2);
    leftBlocks = blocks.slice(0, mid);
    rightBlocks = blocks.slice(mid);
  }
  return `
    <div class="lsp-columns">
      <div class="lsp-col">${renderBodyBlocks(leftBlocks, graphPath)}</div>
      <div class="lsp-col">${renderBodyBlocks(rightBlocks, graphPath)}</div>
    </div>
  `;
}

export interface SlideRenderMeta {
  deckTitle?: string;
  slideIndex?: number;
  slideTotal?: number;
}

export function renderSlideHtml(
  slide: SlideNode,
  graphPath?: string,
  meta?: SlideRenderMeta
): string {
  const titleHtml = renderMarkdownText(slide.title, graphPath).replace(
    /^<p>|<\/p>\s*$/g,
    ''
  );

  const layout = slide.layout ?? 'default';
  const bodyHtml =
    layout === 'two-column' && slide.bodyBlocks.length >= 2
      ? renderTwoColumnBody(slide.bodyBlocks, graphPath)
      : renderBodyBlocks(slide.bodyBlocks, graphPath);

  let footerHtml = '';
  if (layout !== 'cover' && meta && (meta.deckTitle || meta.slideTotal)) {
    const numText =
      meta.slideIndex !== undefined && meta.slideTotal
        ? `${meta.slideIndex + 1} / ${meta.slideTotal}`
        : '';
    footerHtml = `
      <footer class="lsp-slide-footer">
        <span class="lsp-slide-footer-title">${escapeHtml(meta.deckTitle || '')}</span>
        <span class="lsp-slide-footer-num">${numText}</span>
      </footer>
    `;
  }

  return `
    <div class="lsp-slide-inner lsp-layout-${layout}">
      <h1 class="lsp-slide-title">${titleHtml}</h1>
      <div class="lsp-slide-body">${bodyHtml}</div>
      ${footerHtml}
    </div>
  `;
}

export async function hydrateMermaidDiagrams(
  container: HTMLElement,
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid');
  if (nodes.length === 0) return;

  try {
    if (!mermaidModule) {
      const mod = await import('mermaid');
      mermaidModule = mod.default;
    }
    mermaidModule.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    await mermaidModule.run({ nodes: Array.from(nodes) });
  } catch (err) {
    console.warn('[Presentation] Mermaid render error:', err);
  }
}
