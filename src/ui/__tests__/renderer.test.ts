import { describe, expect, it } from 'vitest';
import { renderMarkdownText } from '../renderer';
import { sanitizeExportKatexCss } from '../exporter';

describe('renderMarkdownText security and edge cases', () => {
  it('escapes raw HTML tags to prevent XSS', () => {
    const html = renderMarkdownText('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('strips javascript: and vbscript: URLs from links, images, and videos', () => {
    const html = renderMarkdownText(
      '[click](javascript:alert(1)) ![pic](javascript:alert(2)) {{video javascript:alert(3)}}'
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
  });

  it('adds target and rel attributes to external http(s) links', () => {
    const html = renderMarkdownText('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('preserves $&, $$, and $1 inside fenced and inline code blocks', () => {
    const html = renderMarkdownText('Inline `$& $$ $1`\n\n```js\nconst s = "$& $$ $1";\n```');
    expect(html).toContain('$&amp; $$ $1');
  });

  it('renders math before Logseq syntax so ==, ^^, #, and [[...]] inside LaTeX are not mangled', () => {
    const html = renderMarkdownText('Math $a == b$ and $[[x]]$ and ==highlight==');
    expect(html).toContain('katex');
    expect(html).not.toContain('lsp-page-ref');
    expect(html).toContain('<mark class="lsp-mark">highlight</mark>');
  });

  it('adds strict-origin-when-cross-origin referrerpolicy on YouTube iframes', () => {
    const html = renderMarkdownText('{{youtube https://youtu.be/dQw4w9WgXcQ}}');
    expect(html).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');

    const shortsHtml = renderMarkdownText(
      '{{video https://www.youtube.com/shorts/dQw4w9WgXcQ}}'
    );
    expect(shortsHtml).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('does not treat currency amounts, equality operators, or numeric #1 as math/highlights/tags', () => {
    const html = renderMarkdownText(
      'Saved $10k in Q1 and $25k in Q2; check a == b && c == d; Goal #1 with #roadmap'
    );
    expect(html).not.toContain('katex');
    expect(html).not.toContain('<mark');
    expect(html).not.toContain('>#1<');
    expect(html).toContain('<span class="lsp-tag">#roadmap</span>');
  });

  it('supports multi-backtick code spans and asset paths containing parentheses', () => {
    const html = renderMarkdownText(
      'Use ``code with ` backtick and $x$``\n\n![diagram](../assets/arch (1).png)',
      '/home/user/graph'
    );
    expect(html).toContain('code with ` backtick and $x$');
    expect(html).not.toContain('katex');
    expect(html).toContain('file:///home/user/graph/assets/arch%20(1).png');
  });
});

describe('sanitizeExportKatexCss', () => {
  it('rewrites local file:// and hashed Vite KaTeX font URLs to CDN without leaking paths', () => {
    const raw =
      "@font-face{src:url(file:///Users/Alice's%20PC/.logseq/plugins/lsp/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2) format(\"woff2\"),url(file:///Users/Alice's%20PC/other.ttf)}";
    const out = sanitizeExportKatexCss(raw);
    expect(out).not.toContain('file://');
    expect(out).not.toContain('Alice');
    expect(out).toContain(
      'url(https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_AMS-Regular.woff2)'
    );
  });
});
