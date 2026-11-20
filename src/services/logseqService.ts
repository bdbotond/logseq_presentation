import '@logseq/libs';
import type {
  DeckSlideEntry,
  LogseqBlockNode,
  PageBlockOutlineItem,
  PresentationDeck,
  SlideBlockItem,
  SlideNode,
} from '../types';
import {
  autoSplitLongSlides,
  buildDeckGraphBlocks,
  getDeckGraphPageName,
  parseBlocksToSlides,
  parseGraphPageToDeck,
  stripBlockProperties,
  type GraphBlockSpec,
} from './slideParser';

const EMBED_BLOCK_RE = /\{\{embed\s+\(\(([0-9a-f-]+)\)\)\}\}|\(\(([0-9a-f-]+)\)\)/gi;
const EMBED_PAGE_RE = /\{\{embed\s+\[\[([^\]]+)\]\]\}\}/gi;

function detectBlockKind(clean: string): PageBlockOutlineItem['kind'] {
  const first = clean.split('\n')[0]?.trim() ?? '';
  if (/^#\s+/.test(first)) return 'h1';
  if (/^#{2,6}\s+/.test(first)) return 'h2';
  if (/^\|.+\|\s*\n\s*\|[-:| ]+\|/.test(clean)) return 'table';
  if (/^!\[[^\]]*\]\([^)]+\)/.test(first)) return 'image';
  if (/^```/.test(first)) return 'code';
  return 'block';
}

function makePreview(clean: string, kind: PageBlockOutlineItem['kind']): string {
  if (kind === 'table') {
    const header = clean.split('\n')[0]?.trim() || 'Table';
    return `Table: ${header.slice(0, 60)}`;
  }
  if (kind === 'image') {
    const match = clean.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    return `Image: ${match?.[1] || match?.[2]?.split('/').pop() || 'image'}`;
  }
  if (kind === 'code') {
    const lang = clean.match(/^```([a-zA-Z0-9_-]*)/)?.[1] || 'code';
    return `Code block (${lang})`;
  }
  const first = clean.split('\n')[0]?.trim() || '';
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function blockNodeToSlideItem(node: LogseqBlockNode): SlideBlockItem | null {
  const { clean } = stripBlockProperties(node.content || '');
  const children = (node.children ?? [])
    .map(blockNodeToSlideItem)
    .filter((c): c is SlideBlockItem => c !== null);

  if (!clean && children.length === 0) return null;
  // Convert top-level H1 inside a composite slide part to H2 subtitle so it fits cleanly
  const normalized = clean.replace(/^#\s+/, '## ');
  return {
    uuid: node.uuid,
    content: normalized,
    children,
    properties: node.properties,
  };
}

export class LogseqService {
  private static instance: LogseqService;

  static getInstance(): LogseqService {
    if (!LogseqService.instance) {
      LogseqService.instance = new LogseqService();
    }
    return LogseqService.instance;
  }

  async getGraphPath(): Promise<string | undefined> {
    try {
      const graph = await logseq.App.getCurrentGraph();
      return graph?.path;
    } catch {
      return undefined;
    }
  }

  async getCurrentPageName(): Promise<string | null> {
    try {
      const page = await logseq.Editor.getCurrentPage();
      if (!page) return null;
      return (page as any).originalName || (page as any).name || null;
    } catch {
      return null;
    }
  }

  async listPages(): Promise<string[]> {
    try {
      const pages = await logseq.Editor.getAllPages();
      if (!pages) return [];
      return pages
        .filter((p: any) => p && (p.originalName || p.name))
        .map((p: any) => String(p.originalName || p.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async getPageOutlineBlocks(pageName: string): Promise<PageBlockOutlineItem[]> {
    const tree = (await logseq.Editor.getPageBlocksTree(pageName)) as LogseqBlockNode[] | null;
    if (!tree) return [];

    const items: PageBlockOutlineItem[] = [];
    const walk = (nodes: LogseqBlockNode[], depth: number) => {
      for (const node of nodes) {
        const { clean } = stripBlockProperties(node.content || '');
        if (clean) {
          const kind = detectBlockKind(clean);
          items.push({
            uuid: node.uuid,
            pageName,
            depth,
            preview: makePreview(clean, kind),
            kind,
            childCount: node.children?.length ?? 0,
          });
        }
        if (node.children?.length) {
          walk(node.children, depth + 1);
        }
      }
    };

    walk(tree, 0);
    return items;
  }

  private async resolveEmbedsInBlocks(
    blocks: LogseqBlockNode[],
    visited: Set<string>,
    depth = 0
  ): Promise<LogseqBlockNode[]> {
    if (depth > 3) return blocks;
    const resolved: LogseqBlockNode[] = [];

    for (const block of blocks) {
      let content = block.content || '';
      const extraChildren: LogseqBlockNode[] = [];

      const pageMatches = [...content.matchAll(EMBED_PAGE_RE)];
      for (const m of pageMatches) {
        const refPage = m[1];
        const key = `page:${refPage}`;
        if (!visited.has(key)) {
          const branchVisited = new Set(visited);
          branchVisited.add(key);
          const tree = (await logseq.Editor.getPageBlocksTree(refPage)) as LogseqBlockNode[] | null;
          if (tree && tree.length > 0) {
            const sub = await this.resolveEmbedsInBlocks(tree, branchVisited, depth + 1);
            extraChildren.push(...sub);
          }
          content = content.replace(m[0], `**${refPage}**`);
        }
      }

      const blockMatches = [...content.matchAll(EMBED_BLOCK_RE)];
      for (const m of blockMatches) {
        const uuid = m[1] || m[2];
        const key = `block:${uuid}`;
        if (uuid && !visited.has(key)) {
          const branchVisited = new Set(visited);
          branchVisited.add(key);
          try {
            const target = (await logseq.Editor.getBlock(uuid, {
              includeChildren: true,
            })) as LogseqBlockNode | null;
            if (target) {
              if (m[0].toLowerCase().startsWith('{{embed')) {
                content = content.replace(m[0], target.content || '');
                if (target.children?.length) {
                  extraChildren.push(
                    ...(await this.resolveEmbedsInBlocks(target.children, branchVisited, depth + 1))
                  );
                }
              } else {
                const snippet = (target.content || '').split('\n')[0] || uuid;
                content = content.replace(m[0], snippet);
              }
            }
          } catch {
            // Leave unresolved reference as-is
          }
        }
      }

      const resolvedChildren = block.children
        ? await this.resolveEmbedsInBlocks(block.children, visited, depth + 1)
        : [];

      resolved.push({
        ...block,
        content,
        children: [...resolvedChildren, ...extraChildren],
      });
    }

    return resolved;
  }

  async fetchPageSlides(pageName: string): Promise<SlideNode[]> {
    const rawTree = (await logseq.Editor.getPageBlocksTree(pageName)) as LogseqBlockNode[] | null;
    if (!rawTree || rawTree.length === 0) {
      return [
        {
          id: `empty-${pageName}`,
          title: pageName,
          bodyBlocks: [],
          sourcePage: pageName,
        },
      ];
    }

    const visited = new Set<string>([`page:${pageName}`]);
    const resolvedTree = await this.resolveEmbedsInBlocks(rawTree, visited);
    return parseBlocksToSlides(resolvedTree, pageName);
  }

  async resolveDeckSlideEntry(entry: DeckSlideEntry): Promise<SlideNode[]> {
    // Special case: a single whole-page part expands into all slides of that page
    if (entry.parts.length === 1 && entry.parts[0].kind === 'page' && entry.parts[0].pageName) {
      const pageSlides = await this.fetchPageSlides(entry.parts[0].pageName);
      if (pageSlides.length === 1) {
        pageSlides[0] = {
          ...pageSlides[0],
          id: entry.id,
          title: entry.title || pageSlides[0].title,
          notes: entry.notes || pageSlides[0].notes,
          layout: entry.layout ?? pageSlides[0].layout,
        };
      } else if (entry.layout) {
        for (const s of pageSlides) {
          if (!s.layout) s.layout = entry.layout;
        }
      }
      return pageSlides;
    }

    // Composite slide built from selected blocks, page parts, and/or custom markdown
    const bodyBlocks: SlideBlockItem[] = [];
    const visited = new Set<string>();
    let sourceUuid: string | undefined;
    let sourcePage: string | undefined;

    for (const part of entry.parts) {
      if (part.kind === 'custom' && part.customMarkdown?.trim()) {
        bodyBlocks.push({
          content: part.customMarkdown.trim(),
          children: [],
        });
      } else if (part.kind === 'block' && part.blockUuid) {
        if (!sourceUuid) {
          sourceUuid = part.blockUuid;
          sourcePage = part.pageName;
        }
        try {
          const raw = (await logseq.Editor.getBlock(part.blockUuid, {
            includeChildren: true,
          })) as LogseqBlockNode | null;
          if (!raw) {
            bodyBlocks.push({
              content: `> ⚠️ Missing block: **${part.label}** (\`${part.blockUuid.slice(0, 8)}\`)`,
              children: [],
            });
            continue;
          }
          const [resolved] = await this.resolveEmbedsInBlocks([raw], visited);
          if (resolved) {
            const { clean } = stripBlockProperties(resolved.content || '');
            // If the user picked an H1 block and its title already matches slide title, lift its children directly
            if (
              /^#\s+/.test(clean) &&
              clean.replace(/^#\s+/, '').trim().toLowerCase() === entry.title.trim().toLowerCase()
            ) {
              for (const c of resolved.children ?? []) {
                const childItem = blockNodeToSlideItem(c);
                if (childItem) bodyBlocks.push(childItem);
              }
            } else {
              const item = blockNodeToSlideItem(resolved);
              if (item) bodyBlocks.push(item);
            }
          }
        } catch {
          bodyBlocks.push({
            content: `> ⚠️ Could not load block: **${part.label}**`,
            children: [],
          });
        }
      } else if (part.kind === 'page' && part.pageName) {
        if (!sourcePage) sourcePage = part.pageName;
        const subSlides = await this.fetchPageSlides(part.pageName);
        for (const s of subSlides) {
          if (s.title && s.title !== entry.title) {
            bodyBlocks.push({
              content: `## ${s.title}`,
              children: s.bodyBlocks,
            });
          } else {
            bodyBlocks.push(...s.bodyBlocks);
          }
        }
      }
    }

    return autoSplitLongSlides([
      {
        id: entry.id,
        title: entry.title || 'Untitled Slide',
        bodyBlocks,
        notes: entry.notes,
        layout: entry.layout,
        sourcePage,
        sourceUuid,
      },
    ]);
  }

  async fetchDeckSlidesWithOffsets(
    deck: PresentationDeck
  ): Promise<{ slides: SlideNode[]; slideStartIndices: number[] }> {
    const slides: SlideNode[] = [];
    const slideStartIndices: number[] = [];
    for (const entry of deck.slides) {
      slideStartIndices.push(slides.length);
      const resolved = await this.resolveDeckSlideEntry(entry);
      slides.push(...resolved);
    }
    return { slides, slideStartIndices };
  }

  async fetchDeckSlides(deck: PresentationDeck): Promise<SlideNode[]> {
    const { slides } = await this.fetchDeckSlidesWithOffsets(deck);
    return slides;
  }

  async openPage(pageName: string): Promise<void> {
    await logseq.App.pushState('page', { name: pageName });
  }

  async openBlock(uuid: string): Promise<void> {
    try {
      await logseq.Editor.scrollToBlockInPage(uuid, uuid);
    } catch {
      await logseq.App.pushState('page', { name: uuid });
    }
  }

  async saveDeckToGraph(deck: PresentationDeck): Promise<string> {
    const pageName = getDeckGraphPageName(deck.title);
    const existing = await logseq.Editor.getPage(pageName);
    if (!existing) {
      await logseq.Editor.createPage(pageName, {}, { redirect: false, createFirstBlock: false });
    } else {
      const existingTree = (await logseq.Editor.getPageBlocksTree(pageName)) as
        | LogseqBlockNode[]
        | null;
      if (existingTree?.length) {
        for (const blk of existingTree) {
          if (blk.uuid) {
            await logseq.Editor.removeBlock(blk.uuid);
          }
        }
      }
    }

    const specs = buildDeckGraphBlocks(deck);
    const insertChildren = async (parentUuid: string, children?: GraphBlockSpec[]) => {
      if (!children?.length) return;
      for (const child of children) {
        const inserted = await logseq.Editor.insertBlock(parentUuid, child.content, {
          sibling: false,
        });
        if (inserted?.uuid && child.children?.length) {
          await insertChildren(inserted.uuid, child.children);
        }
      }
    };

    for (const spec of specs) {
      const top = await logseq.Editor.appendBlockInPage(pageName, spec.content);
      if (top?.uuid && spec.children?.length) {
        await insertChildren(top.uuid, spec.children);
      }
    }

    return pageName;
  }

  async loadDeckFromGraphPage(
    pageName: string
  ): Promise<Omit<PresentationDeck, 'id' | 'updatedAt'> | null> {
    const tree = (await logseq.Editor.getPageBlocksTree(pageName)) as LogseqBlockNode[] | null;
    if (!tree || tree.length === 0) return null;
    const deck = parseGraphPageToDeck(pageName, tree);
    // Resolve readable labels for embedded block parts
    for (const slide of deck.slides) {
      for (const part of slide.parts) {
        if (part.kind === 'block' && part.blockUuid) {
          try {
            const blk = (await logseq.Editor.getBlock(part.blockUuid)) as LogseqBlockNode | null;
            if (blk?.content) {
              const { clean } = stripBlockProperties(blk.content);
              if (clean) part.label = makePreview(clean, detectBlockKind(clean));
            }
          } catch {
            // Keep default label
          }
        }
      }
    }
    return deck;
  }
}
