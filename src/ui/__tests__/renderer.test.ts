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
  });
});

describe('sanitizeExportKatexCss', () => {
  it('rewrites local file:// and hashed Vite KaTeX font URLs to CDN without leaking paths', () => {
    const raw =
      '@font-face{src:url(file:///home/alice/.logseq/plugins/lsp/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2) format("woff2"),url(file:///home/alice/other.ttf)}';
    const out = sanitizeExportKatexCss(raw);
    expect(out).not.toContain('file://');
    expect(out).not.toContain('alice');
    expect(out).toContain(
      'url(https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_AMS-Regular.woff2)'
    );
  });
});
