import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@logseq/libs', () => ({}));

import {
  buildDeckGraphBlocks,
  collectDeckSourcePages,
  getDeckGraphPageName,
  parseBlocksToSlides,
  parseGraphPageToDeck,
  resolveAssetPath,
  stripBlockProperties,
} from '../slideParser';
import { LogseqService } from '../logseqService';
import { DeckStore } from '../deckStore';
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
    expect(slides[1].title).toBe('Long Topic');
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

  it('normalizes Windows backslashes and URI-encodes spaces and # in asset paths', () => {
    expect(
      resolveAssetPath('../assets/my diagram #1.png', 'C:\\Users\\Alice Smith\\My Graph\\')
    ).toBe('file:///C:/Users/Alice%20Smith/My%20Graph/assets/my%20diagram%20%231.png');

    // Does not double-encode already encoded segments
    expect(resolveAssetPath('assets/100%25%20ready.png', '/home/user/graph')).toBe(
      'file:///home/user/graph/assets/100%25%20ready.png'
    );
  });
});

describe('parser edge cases and regressions', () => {
  it('does not strip :: scope operators without space outside fences and handles CRLF', () => {
    const res = stripBlockProperties(
      'title:: Demo\r\nempty-prop::\r\nstd::vector<int> v;\r\nfoo::bar()'
    );
    expect(res.properties.title).toBe('Demo');
    expect(res.properties['empty-prop']).toBe('');
    expect(res.clean).toBe('std::vector<int> v;\nfoo::bar()');
  });

  it('supports camelCase Logseq block.properties for layout, notes, and no-split', () => {
    const children: LogseqBlockNode[] = Array.from({ length: 16 }, (_, i) => ({
      uuid: `b-${i}`,
      content: `Item ${i + 1}`,
      children: [],
    }));
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Camel Props',
        properties: {
          slideLayout: 'two-column',
          slideNotes: 'Speaker cue',
          slideNoSplit: true,
        },
        children,
      },
    ];
    const slides = parseBlocksToSlides(blocks, 'CamelPage');
    expect(slides).toHaveLength(1);
    expect(slides[0].layout).toBe('two-column');
    expect(slides[0].notes).toBe('Speaker cue');
    expect(slides[0].bodyBlocks).toHaveLength(16);
  });

  it('ignores #slide inside fenced code blocks', () => {
    const blocks: LogseqBlockNode[] = [
      { uuid: '1', content: '# CSS Demo', children: [] },
      { uuid: '2', content: '```css\n#slide { color: red; }\n```', children: [] },
    ];
    const slides = parseBlocksToSlides(blocks, 'CssPage');
    expect(slides).toHaveLength(1);
    expect(slides[0].bodyBlocks[0].content).toContain('#slide { color: red; }');
  });

  it('collects nested children under Notes: blocks into speaker notes', () => {
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Intro',
        children: [
          { uuid: '1a', content: 'Visible bullet', children: [] },
          {
            uuid: '1b',
            content: 'Notes:',
            children: [
              { uuid: '1c', content: 'First talking point', children: [] },
              { uuid: '1d', content: 'Second talking point', children: [] },
            ],
          },
        ],
      },
    ];
    const slides = parseBlocksToSlides(blocks, 'NotesPage');
    expect(slides[0].bodyBlocks.map((b) => b.content)).toEqual(['Visible bullet']);
    expect(slides[0].notes).toBe('First talking point\nSecond talking point');
  });

  it('propagates trailing --- divider inside H1 children to split the next sibling', () => {
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# First',
        children: [
          { uuid: '1a', content: 'Body 1', children: [] },
          { uuid: 'sep', content: '---', children: [] },
        ],
      },
      { uuid: '2', content: 'Body 2 on new slide', children: [] },
    ];
    const slides = parseBlocksToSlides(blocks, 'TrailDiv');
    expect(slides).toHaveLength(2);
    expect(slides[0].bodyBlocks.map((b) => b.content)).toEqual(['Body 1']);
    expect(slides[1].bodyBlocks.map((b) => b.content)).toEqual(['Body 2 on new slide']);
  });

  it('auto-splits a single-child deep overflowing subtree', () => {
    const deepItems: LogseqBlockNode[] = Array.from({ length: 16 }, (_, i) => ({
      uuid: `d-${i}`,
      content: `Deep bullet ${i + 1}`,
      children: [],
    }));
    const blocks: LogseqBlockNode[] = [
      {
        uuid: '1',
        content: '# Deep Nest',
        children: [
          {
            uuid: '2',
            content: '## Section',
            children: [{ uuid: '3', content: '### Subsection', children: deepItems }],
          },
        ],
      },
    ];
    const slides = parseBlocksToSlides(blocks, 'DeepNest');
    expect(slides.length).toBeGreaterThanOrEqual(2);
    const total = slides.reduce(
      (sum, s) =>
        sum +
        s.bodyBlocks.reduce(
          (cs, b) => cs + b.children.reduce((gs, g) => gs + g.children.length, 0),
          0
        ),
      0
    );
    expect(total).toBe(16);
  });

  it('preserves nested children of custom blocks and extra slide lines in parseGraphPageToDeck', () => {
    const restored = parseGraphPageToDeck('Presentations/Edited', [
      {
        uuid: 's1',
        content: '# Slide One\nExtra intro line',
        children: [
          {
            uuid: 'c1',
            content: 'Parent point',
            children: [{ uuid: 'c2', content: 'Nested child', children: [] }],
          },
        ],
      },
      { uuid: 'sep', content: '---', children: [] },
    ]);
    expect(restored.slides).toHaveLength(1);
    expect(restored.slides[0].title).toBe('Slide One');
    expect(restored.slides[0].parts).toHaveLength(2);
    expect(restored.slides[0].parts[0].customMarkdown).toBe('Extra intro line');
    expect(restored.slides[0].parts[1].customMarkdown).toBe('Parent point\n- Nested child');
  });

  it('starts a new slide on inline slide:: true property in raw block text', () => {
    const blocks: LogseqBlockNode[] = [
      { uuid: '1', content: '# First', children: [{ uuid: '1a', content: 'One', children: [] }] },
      {
        uuid: '2',
        content: 'slide:: true\nCustom Slide',
        children: [{ uuid: '2a', content: 'Two', children: [] }],
      },
    ];
    const slides = parseBlocksToSlides(blocks, 'PropSlidePage');
    expect(slides).toHaveLength(2);
    expect(slides[1].title).toBe('Custom Slide');
    expect(slides[1].bodyBlocks[0].content).toBe('Two');
  });
});

describe('LogseqService embeds, graph save/load, and navigation', () => {
  const originalLogseq = (globalThis as any).logseq;

  afterEach(() => {
    (globalThis as any).logseq = originalLogseq;
  });

  it('resolves deeply nested block embeds without $ corruption or id:: leakage', async () => {
    const blocksByUuid: Record<string, LogseqBlockNode> = {
      'aaaa-1111': {
        uuid: 'aaaa-1111',
        content: 'id:: aaaa-1111\nFormula $$E = mc^2$$',
        children: [],
      },
    };
    (globalThis as any).logseq = {
      Editor: {
        getPageBlocksTree: vi.fn(async (name: string) => {
          if (name === 'BrokenPage') throw new Error('not found');
          return [
            {
              uuid: 'root',
              content: '# Math',
              children: [
                {
                  uuid: 'd1',
                  content: 'L1',
                  children: [
                    {
                      uuid: 'd2',
                      content: 'L2',
                      children: [
                        {
                          uuid: 'd3',
                          content: 'L3',
                          children: [
                            {
                              uuid: 'd4',
                              content: 'Deep ref: ((aaaa-1111)) and {{embed [[BrokenPage]]}}',
                              children: [],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ];
        }),
        getBlock: vi.fn(async (uuid: string) => blocksByUuid[uuid] ?? null),
      },
    };

    const svc = new LogseqService();
    const slides = await svc.fetchPageSlides('MathPage');
    const deepContent =
      slides[0].bodyBlocks[0].children[0].children[0].children[0].content;
    expect(deepContent).toContain('Formula $$E = mc^2$$');
    expect(deepContent).not.toContain('id::');
  });

  it('saveDeckToGraph preserves child order and rolls back on write failure without deleting old blocks', async () => {
    const insertedCalls: Array<{ parent: string; content: string; opts: any }> = [];
    const removedUuids: string[] = [];
    let seq = 0;

    (globalThis as any).logseq = {
      Editor: {
        getPage: vi.fn(async () => ({ name: 'Presentations/Demo' })),
        getPageBlocksTree: vi.fn(async () => [{ uuid: 'old-1', content: 'old' }]),
        appendBlockInPage: vi.fn(async (_page: string, _content: string) => ({
          uuid: `new-top-${++seq}`,
        })),
        insertBlock: vi.fn(async (parent: string, content: string, opts: any) => {
          insertedCalls.push({ parent, content, opts });
          return { uuid: `new-child-${++seq}` };
        }),
        removeBlock: vi.fn(async (uuid: string) => {
          removedUuids.push(uuid);
        }),
      },
    };

    const svc = new LogseqService();
    const deck = {
      id: 'd1',
      title: 'Demo',
      theme: 'logseq' as const,
      aspectRatio: '16:9' as const,
      updatedAt: 0,
      slides: [
        {
          id: 's1',
          title: 'Slide 1',
          parts: [
            { id: 'p1', kind: 'custom' as const, label: 'A', customMarkdown: 'First' },
            { id: 'p2', kind: 'custom' as const, label: 'B', customMarkdown: 'Second' },
          ],
        },
      ],
    };

    await svc.saveDeckToGraph(deck);
    expect(insertedCalls[0].opts).toEqual({ sibling: false });
    expect(insertedCalls[1].opts).toEqual({ sibling: true, before: false });
    expect(insertedCalls[1].parent).toBe('new-child-3');
    expect(removedUuids).toEqual(['old-1']);

    // Now simulate failure mid-save: old-1 must NOT be removed, and new-top-4 must be rolled back
    removedUuids.length = 0;
    let failCount = 0;
    (globalThis as any).logseq.Editor.appendBlockInPage = vi.fn(async () => {
      failCount++;
      if (failCount === 2) throw new Error('IPC error');
      return { uuid: 'partial-top-1' };
    });

    await expect(svc.saveDeckToGraph(deck)).rejects.toThrow('IPC error');
    expect(removedUuids).toEqual(['partial-top-1']);
  });

  it('openBlock resolves the owning page before scrolling', async () => {
    const scrollToBlockInPage = vi.fn(async () => {});
    (globalThis as any).logseq = {
      Editor: {
        getBlock: vi.fn(async () => ({ uuid: 'blk-1', page: { id: 42 } })),
        getPage: vi.fn(async () => ({ originalName: 'Target Page' })),
        scrollToBlockInPage,
      },
      App: { pushState: vi.fn(async () => {}) },
    };

    const svc = new LogseqService();
    await svc.openBlock('blk-1');
    expect(scrollToBlockInPage).toHaveBeenCalledWith('Target Page', 'blk-1');
  });

  it('resolveDeckSlideEntry preserves extra lines on matched H1 blocks and stops at nested dividers', async () => {
    (globalThis as any).logseq = {
      Editor: {
        getBlock: vi.fn(async () => ({
          uuid: 'h1-blk',
          content: '# Intro\nLead paragraph',
          children: [
            { uuid: 'c1', content: 'First bullet', children: [] },
            { uuid: 'sep', content: '---', children: [] },
            { uuid: 'c2', content: 'Next slide bullet', children: [] },
          ],
        })),
      },
    };

    const svc = new LogseqService();
    const slides = await svc.resolveDeckSlideEntry({
      id: 'entry-1',
      title: 'Intro',
      parts: [{ id: 'p1', kind: 'block', blockUuid: 'h1-blk', label: 'Intro' }],
    });
    expect(slides).toHaveLength(1);
    expect(slides[0].bodyBlocks.map((b) => b.content)).toEqual(['Lead paragraph', 'First bullet']);
  });
});

describe('DeckStore concurrency and validation', () => {
  const originalLogseq = (globalThis as any).logseq;

  afterEach(() => {
    (globalThis as any).logseq = originalLogseq;
  });

  it('deduplicates concurrent load() and serializes rapid persist() writes', async () => {
    let persistedJson = '';
    let writeCount = 0;
    const getItem = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return JSON.stringify([
        null,
        { id: 'existing', title: 'Saved Deck', theme: 'dark', slides: [] },
      ]);
    });
    const setItem = vi.fn(async (_key: string, val: string) => {
      const idx = ++writeCount;
      // Make first write slower than second write to test out-of-order protection
      await new Promise((r) => setTimeout(r, idx === 1 ? 25 : 2));
      persistedJson = val;
    });

    (globalThis as any).logseq = { FileStorage: { getItem, setItem } };

    const store = new DeckStore();
    const [d1, created] = await Promise.all([store.load(), store.createDeck('New Deck')]);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(d1.some((d) => d.id === 'existing')).toBe(true);
    expect(store.getDecks().some((d) => d.id === created.id)).toBe(true);

    // Fire two rapid renames without awaiting the first
    const p1 = store.renameDeck(created.id, 'Title A');
    const p2 = store.renameDeck(created.id, 'Title B');
    await Promise.all([p1, p2]);

    const finalSaved = JSON.parse(persistedJson);
    const savedCreated = finalSaved.find((d: any) => d.id === created.id);
    expect(savedCreated.title).toBe('Title B');
  });

  it('rejects non-object JSON in importDeckJson and regenerates IDs on valid import', async () => {
    (globalThis as any).logseq = {
      FileStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
    };

    const store = new DeckStore();
    await expect(store.importDeckJson('null')).rejects.toThrow('Invalid deck JSON');
    await expect(store.importDeckJson('[]')).rejects.toThrow('Invalid deck JSON');

    const imported = await store.importDeckJson(
      JSON.stringify({
        id: 'orig-deck',
        title: 'Imported',
        slides: [
          {
            id: 'orig-slide',
            title: 'S1',
            parts: [{ id: 'orig-part', kind: 'custom', label: 'C', customMarkdown: 'Hi' }],
          },
        ],
      })
    );
    expect(imported.id).not.toBe('orig-deck');
    expect(imported.slides[0].id).not.toBe('orig-slide');
    expect(imported.slides[0].parts[0].id).not.toBe('orig-part');
  });
});
