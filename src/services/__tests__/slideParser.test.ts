import { describe, expect, it } from 'vitest';
import {
  buildDeckGraphBlocks,
  collectDeckSourcePages,
  getDeckGraphPageName,
  parseBlocksToSlides,
  parseGraphPageToDeck,
  resolveAssetPath,
  stripBlockProperties,
} from '../slideParser';
import { renderSlideHtml } from '../../ui/renderer';
import { getThemeClasses, getThemePolarity } from '../../ui/themes';
import type { LogseqBlockNode } from '../../types';

describe('stripBlockProperties', () => {
  it('extracts key:: value lines and returns clean content', () => {
    const res = stripBlockProperties('title:: My Slide\nslide-notes:: Remember demo\nHello World');
    expect(res.clean).toBe('Hello World');
    expect(res.properties.title).toBe('My Slide');
    expect(res.properties['slide-notes']).toBe('Remember demo');
  });

  it('preserves :: inside fenced code blocks', () => {
    const res = stripBlockProperties(
      'slide-layout:: cover\n```cpp\nstd::vector<int> v;\n```\nHello'
    );
    expect(res.properties['slide-layout']).toBe('cover');
    expect(res.clean).toContain('std::vector<int> v;');
  });
});

describe('parseBlocksToSlides (H1 splits, H2 subtitles)', () => {
  it('splits slides by # headings and keeps ## headings as subtitles', () => {
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Intro',
        children: [
          {
            uuid: '1a',
            content: '## Goals',
            children: [{ uuid: '1b', content: 'Ship v1', children: [] }],
          },
          { uuid: '1c', content: 'Notes: Mention Q4 metrics', children: [] },
        ],
      },
      { uuid: '2', content: '## Another Subtitle Under Intro', children: [] },
      { uuid: '3', content: 'Sibling point under Intro', children: [] },
      {
        uuid: '4',
        content: '# Architecture',
        children: [
          {
            uuid: '4a',
            content: '| Col1 | Col2 |\n|---|---|\n| A | B |',
            children: [],
          },
        ],
      },
    ];

    const slides = parseBlocksToSlides(blocks, 'Demo');
    expect(slides).toHaveLength(2);
    expect(slides[0].title).toBe('Intro');
    expect(slides[0].bodyBlocks).toHaveLength(3);
    expect(slides[0].bodyBlocks[0].content).toBe('## Goals');
    expect(slides[0].bodyBlocks[1].content).toBe('## Another Subtitle Under Intro');
    expect(slides[0].bodyBlocks[2].content).toBe('Sibling point under Intro');
    expect(slides[0].notes).toBe('Mention Q4 metrics');
    expect(slides[1].title).toBe('Architecture');
  });

  it('splits on --- divider even without # heading', () => {
    const blocks: LogseqBlockNode[] = [
      { uuid: '1', content: 'Part 1', children: [] },
      { uuid: 'sep', content: '---', children: [] },
      { uuid: '2', content: 'Part 2', children: [] },
    ];

    const slides = parseBlocksToSlides(blocks, 'MyPage');
    expect(slides).toHaveLength(2);
    expect(slides[0].title).toBe('MyPage');
    expect(slides[0].bodyBlocks[0].content).toBe('Part 1');
    expect(slides[1].bodyBlocks[0].content).toBe('Part 2');
  });

  it('splits on nested --- divider inside H1 children', () => {
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Main',
        children: [
          { uuid: '1a', content: 'Before split', children: [] },
          { uuid: 'sep', content: '---', children: [] },
          { uuid: '1b', content: 'After split', children: [] },
        ],
      },
    ];

    const slides = parseBlocksToSlides(blocks, 'NestedPage');
    expect(slides).toHaveLength(2);
    expect(slides[0].title).toBe('Main');
    expect(slides[0].bodyBlocks.map((b) => b.content)).toEqual(['Before split']);
    expect(slides[1].bodyBlocks.map((b) => b.content)).toEqual(['After split']);
  });

  it('parses slide-layout property on H1 slide', () => {
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: 'slide-layout:: cover\n# Welcome',
        children: [{ uuid: '1a', content: 'Subtitle', children: [] }],
      },
    ];
    const slides = parseBlocksToSlides(blocks, 'CoverPage');
    expect(slides[0].layout).toBe('cover');
  });

  it('auto-splits long slides into multiple continuation slides', () => {
    const children: LogseqBlockNode[] = Array.from({ length: 16 }, (_, i) => ({
      uuid: `b-${i}`,
      content: `Bullet point number ${i + 1} with enough text to occupy a line on the slide`,
      children: [],
    }));
    const blocks: LogseqBlockNode[] = [{ uuid: '1', content: '# Long Topic', children }];

    const slides = parseBlocksToSlides(blocks, 'LongPage');
    expect(slides.length).toBeGreaterThanOrEqual(2);
    expect(slides[0].title).toBe('Long Topic');
    expect(slides[1].title).toBe(`Long Topic (2/${slides.length})`);
    const totalBullets = slides.reduce((sum, s) => sum + s.bodyBlocks.length, 0);
    expect(totalBullets).toBe(16);
  });

  it('auto-splits a single overflowing section while preserving its ## heading', () => {
    const sectionChildren: LogseqBlockNode[] = Array.from({ length: 15 }, (_, i) => ({
      uuid: `c-${i}`,
      content: `Detail item ${i + 1}`,
      children: [],
    }));
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Deep Dive',
        children: [{ uuid: 'sec', content: '## Architecture', children: sectionChildren }],
      },
    ];

    const slides = parseBlocksToSlides(blocks, 'DeepPage');
    expect(slides.length).toBeGreaterThanOrEqual(2);
    expect(slides[0].bodyBlocks[0].content).toBe('## Architecture');
    expect(slides[1].bodyBlocks[0].content).toBe('## Architecture');
    const totalItems = slides.reduce(
      (sum, s) => sum + s.bodyBlocks.reduce((cs, b) => cs + b.children.length, 0),
      0
    );
    expect(totalItems).toBe(15);
  });

  it('respects slide-no-split:: true opt-out', () => {
    const children: LogseqBlockNode[] = Array.from({ length: 16 }, (_, i) => ({
      uuid: `b-${i}`,
      content: `Item ${i + 1}`,
      children: [],
    }));
    const blocks: LogseqBlockNode[] = [
      { uuid: '1', content: 'slide-no-split:: true\n# Keep Together', children },
    ];

    const slides = parseBlocksToSlides(blocks, 'NoSplitPage');
    expect(slides).toHaveLength(1);
    expect(slides[0].bodyBlocks).toHaveLength(16);
  });
});

describe('renderSlideHtml', () => {
  it('renders ## as subtitle without bullet wrapper and tables cleanly', () => {
    const html = renderSlideHtml({
      id: 's1',
      title: 'Overview',
      bodyBlocks: [
        {
          content: '## Key Points',
          children: [{ content: 'Fast', children: [] }],
        },
        {
          content: '| A | B |\n|---|---|\n| 1 | 2 |',
          children: [],
        },
      ],
    });
    expect(html).toContain('<h2 class="lsp-subtitle">Key Points</h2>');
    expect(html).not.toContain('<li class="lsp-bullet-item"><div class="lsp-bullet-content"><h2');
    expect(html).toContain('<div class="lsp-rich-block"><table>');
  });

  it('renders two-column layout and does not treat hex colors as tags', () => {
    const html = renderSlideHtml({
      id: 's2',
      title: 'Split',
      layout: 'two-column',
      bodyBlocks: [
        { content: 'Point with color #4f46e5 and #tag', children: [] },
        { content: '| A | B |\n|---|---|\n| 1 | 2 |', children: [] },
      ],
    });
    expect(html).toContain('lsp-layout-two-column');
    expect(html).toContain('<div class="lsp-columns">');
    expect(html).toContain('#4f46e5');
    expect(html).not.toContain('>#4f46e5<');
    expect(html).toContain('<span class="lsp-tag">#tag</span>');
  });

  it('highlights fenced code blocks with highlight.js', () => {
    const html = renderSlideHtml({
      id: 's3',
      title: 'Code',
      bodyBlocks: [{ content: '```ts\nconst answer: number = 42;\n```', children: [] }],
    });
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('hljs-keyword');
  });

  it('renders slide canvas footer on normal slides and hides it on cover slides', () => {
    const normal = renderSlideHtml(
      { id: 's4', title: 'Agenda', bodyBlocks: [{ content: 'Item', children: [] }] },
      undefined,
      { deckTitle: 'Q4 Review', slideIndex: 1, slideTotal: 5 }
    );
    expect(normal).toContain('lsp-slide-footer');
    expect(normal).toContain('Q4 Review');
    expect(normal).toContain('2 / 5');

    const cover = renderSlideHtml(
      { id: 's5', title: 'Welcome', layout: 'cover', bodyBlocks: [] },
      undefined,
      { deckTitle: 'Q4 Review', slideIndex: 0, slideTotal: 5 }
    );
    expect(cover).not.toContain('lsp-slide-footer');
  });
});

describe('themes', () => {
  it('resolves polarity and classes for preset and auto themes', () => {
    expect(getThemePolarity('midnight', 'light')).toBe('dark');
    expect(getThemePolarity('warm-paper', 'dark')).toBe('light');
    expect(getThemePolarity('logseq', 'light')).toBe('light');
    expect(getThemeClasses('academic', 'dark')).toBe('lsp-theme-light lsp-theme-academic');
  });
});

describe('save deck to graph serialization', () => {
  it('builds graph page blocks with [[Page]] source links and embeds', () => {
    const deck = {
      id: 'd1',
      title: 'Q4 Launch',
      theme: 'midnight' as const,
      aspectRatio: '16:9' as const,
      updatedAt: 0,
      slides: [
        {
          id: 's1',
          title: 'Intro',
          layout: 'cover' as const,
          notes: 'Welcome everyone',
          parts: [
            { id: 'p1', kind: 'page' as const, pageName: 'Roadmap', label: 'Roadmap' },
            {
              id: 'p2',
              kind: 'block' as const,
              pageName: 'Metrics',
              blockUuid: 'abcd-1234',
              label: 'KPIs',
            },
            { id: 'p3', kind: 'custom' as const, label: 'Note', customMarkdown: '## Summary' },
          ],
        },
      ],
    };

    expect(getDeckGraphPageName(deck.title)).toBe('Presentations/Q4 Launch');
    expect(collectDeckSourcePages(deck)).toEqual(['Roadmap', 'Metrics']);

    const blocks = buildDeckGraphBlocks(deck);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toContain('type:: presentation');
    expect(blocks[0].content).toContain('sources:: [[Roadmap]], [[Metrics]]');
    expect(blocks[1].content).toContain('# Intro');
    expect(blocks[1].content).toContain('slide-layout:: cover');
    expect(blocks[1].content).toContain('source:: [[Roadmap]], [[Metrics]]');
    expect(blocks[1].children?.map((c) => c.content)).toEqual([
      '{{embed [[Roadmap]]}}',
      '{{embed ((abcd-1234))}}',
      '## Summary',
    ]);

    // Round-trip back from graph page blocks into Studio deck
    const logseqBlocks: LogseqBlockNode[] = blocks.map((b, i) => ({
      uuid: `u-${i}`,
      content: b.content,
      children: (b.children ?? []).map((c, j) => ({ uuid: `u-${i}-${j}`, content: c.content })),
    }));
    const restored = parseGraphPageToDeck('Presentations/Q4 Launch', logseqBlocks);
    expect(restored.title).toBe('Q4 Launch');
    expect(restored.theme).toBe('midnight');
    expect(restored.aspectRatio).toBe('16:9');
    expect(restored.slides).toHaveLength(1);
    expect(restored.slides[0].layout).toBe('cover');
    expect(restored.slides[0].notes).toBe('Welcome everyone');
    expect(restored.slides[0].parts.map((p) => p.kind)).toEqual(['page', 'block', 'custom']);
    expect(restored.slides[0].parts[0].pageName).toBe('Roadmap');
    expect(restored.slides[0].parts[1].blockUuid).toBe('abcd-1234');
  });
});

describe('resolveAssetPath', () => {
  it('resolves ../assets/ against graphPath', () => {
    expect(resolveAssetPath('../assets/img_123.png', '/home/user/graph/')).toBe(
      'file:///home/user/graph/assets/img_123.png'
    );
  });

  it('leaves external URLs untouched', () => {
    expect(resolveAssetPath('https://example.com/a.png', '/home/user/graph')).toBe(
      'https://example.com/a.png'
    );
  });
});
