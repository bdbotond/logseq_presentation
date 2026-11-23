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
  toSlideBlockItem,
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

function demoteH1Recursive(item: SlideBlockItem): SlideBlockItem {
  return {
    ...item,
    content: item.content.replace(/^#\s+/, '## '),
    children: item.children.map(demoteH1Recursive),
  };
}

function blockNodeToSlideItem(node: LogseqBlockNode, notesOut: string[]): SlideBlockItem | null {
  const item = toSlideBlockItem(node, notesOut);
  if (!item) return null;
  // Convert top-level H1 inside a composite slide part to H2 subtitle so it fits cleanly
  return demoteH1Recursive(item);
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
    embedDepth = 0
  ): Promise<LogseqBlockNode[]> {
    if (embedDepth > 3) return blocks;
    const resolved: LogseqBlockNode[] = [];

    for (const block of blocks) {
      let content = block.content || '';
      const extraChildren: LogseqBlockNode[] = [];

      const pageMatches = [...content.matchAll(EMBED_PAGE_RE)];
      for (const m of pageMatches) {
        const refPage = m[1];
        const key = `page:${refPage.toLowerCase()}`;
        if (!visited.has(key)) {
          const branchVisited = new Set(visited);
          branchVisited.add(key);
          try {
            const tree = (await logseq.Editor.getPageBlocksTree(refPage)) as
              | LogseqBlockNode[]
              | null;
            if (tree && tree.length > 0) {
              const sub = await this.resolveEmbedsInBlocks(tree, branchVisited, embedDepth + 1);
              extraChildren.push(...sub);
            }
            content = content.replace(m[0], () => `**${refPage}**`);
          } catch {
            // Leave unresolved page embed as-is
          }
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
              const [resolvedTarget] = await this.resolveEmbedsInBlocks(
                [target],
                branchVisited,
                embedDepth + 1
              );
              const { clean: targetClean } = stripBlockProperties(resolvedTarget?.content || '');
              if (m[0].toLowerCase().startsWith('{{embed')) {
                content = content.replace(m[0], () => targetClean);
                if (resolvedTarget?.children?.length) {
                  extraChildren.push(...resolvedTarget.children);
                }
              } else {
                const snippet = targetClean.split('\n')[0]?.trim() || uuid;
                content = content.replace(m[0], () => snippet);
              }
            }
          } catch {
            // Leave unresolved reference as-is
          }
        }
      }

      // Walking existing block children does NOT increase embed recursion depth
      const resolvedChildren = block.children
        ? await this.resolveEmbedsInBlocks(block.children, visited, embedDepth)
        : [];

      resolved.push({
        ...block,
        content,
        children: [...resolvedChildren, ...extraChildren],
      });
    }

    return resolved;
  }

  async fetchPageSlides(
    pageName: string,
    options?: { autoSplit?: boolean }
  ): Promise<SlideNode[]> {
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

    const visited = new Set<string>([`page:${pageName.toLowerCase()}`]);
    const resolvedTree = await this.resolveEmbedsInBlocks(rawTree, visited, 0);
    return parseBlocksToSlides(resolvedTree, pageName, options);
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
      } else {
        for (let i = 0; i < pageSlides.length; i++) {
          const s = pageSlides[i];
          s.id = i === 0 ? entry.id : `${entry.id}-${i}`;
          if (entry.layout && !s.layout) {
            s.layout = entry.layout;
          }
        }
        if (entry.notes?.trim() && pageSlides[0]) {
          pageSlides[0].notes = pageSlides[0].notes
            ? `${entry.notes.trim()}\n${pageSlides[0].notes}`
            : entry.notes.trim();
        }
      }
      return pageSlides;
    }

    // Composite slide built from selected blocks, page parts, and/or custom markdown
    const bodyBlocks: SlideBlockItem[] = [];
    const extractedNotes: string[] = [];
    if (entry.notes?.trim()) {
      extractedNotes.push(entry.notes.trim());
    }
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
          const blockVisited = new Set<string>([`block:${part.blockUuid}`]);
          const [resolved] = await this.resolveEmbedsInBlocks([raw], blockVisited, 0);
          if (resolved) {
            const { clean } = stripBlockProperties(resolved.content || '');
            // If the user picked an H1 block and its title already matches slide title, lift its children directly
            if (
              /^#\s+/.test(clean) &&
              clean.replace(/^#\s+/, '').trim().toLowerCase() === entry.title.trim().toLowerCase()
            ) {
              for (const c of resolved.children ?? []) {
                const childItem = blockNodeToSlideItem(c, extractedNotes);
                if (childItem) bodyBlocks.push(childItem);
              }
            } else {
              const item = blockNodeToSlideItem(resolved, extractedNotes);
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
        const subSlides = await this.fetchPageSlides(part.pageName, { autoSplit: false });
        for (const s of subSlides) {
          if (s.notes?.trim()) {
            extractedNotes.push(s.notes.trim());
          }
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
        notes: extractedNotes.length > 0 ? extractedNotes.join('\n') : undefined,
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

  async openBlock(uuid: string, pageName?: string): Promise<void> {
    try {
      let targetPage = pageName;
      if (!targetPage) {
        const block = (await logseq.Editor.getBlock(uuid)) as any;
        if (block?.page?.id) {
          const page = (await logseq.Editor.getPage(block.page.id)) as any;
          targetPage = page?.originalName || page?.name;
        }
      }
      if (targetPage) {
        await logseq.Editor.scrollToBlockInPage(targetPage, uuid);
        return;
      }
      await logseq.Editor.scrollToBlockInPage(uuid, uuid);
    } catch {
      await logseq.App.pushState('page', { name: uuid });
    }
  }

  async saveDeckToGraph(deck: PresentationDeck): Promise<string> {
    const pageName = getDeckGraphPageName(deck.title);
    const existing = await logseq.Editor.getPage(pageName);
    let oldUuids: string[] = [];

    if (!existing) {
      await logseq.Editor.createPage(pageName, {}, { redirect: false, createFirstBlock: false });
    } else {
      const existingTree = (await logseq.Editor.getPageBlocksTree(pageName)) as
        | LogseqBlockNode[]
        | null;
      oldUuids = (existingTree ?? [])
        .map((blk) => blk.uuid)
        .filter((uuid): uuid is string => Boolean(uuid));
    }

    const specs = buildDeckGraphBlocks(deck);
    const insertChildren = async (parentUuid: string, children?: GraphBlockSpec[]) => {
      if (!children?.length) return;
      let prevUuid: string | null = null;
      for (const child of children) {
        const inserted: { uuid?: string } | null = prevUuid
          ? await logseq.Editor.insertBlock(prevUuid, child.content, {
              sibling: true,
              before: false,
            })
          : await logseq.Editor.insertBlock(parentUuid, child.content, {
              sibling: false,
            });
        if (inserted?.uuid) {
          prevUuid = inserted.uuid;
          if (child.children?.length) {
            await insertChildren(inserted.uuid, child.children);
          }
        }
      }
    };

    const createdTopUuids: string[] = [];
    try {
      for (const spec of specs) {
        const top = await logseq.Editor.appendBlockInPage(pageName, spec.content);
        if (top?.uuid) {
          createdTopUuids.push(top.uuid);
          if (spec.children?.length) {
            await insertChildren(top.uuid, spec.children);
          }
        }
      }
    } catch (err) {
      // Roll back partially written blocks so the previous graph page remains intact
      for (const uuid of createdTopUuids) {
        try {
          await logseq.Editor.removeBlock(uuid);
        } catch {
          // Best-effort rollback
        }
      }
      throw err;
    }

    // Remove previous blocks only after all new blocks were written successfully
    for (const uuid of oldUuids) {
      try {
        await logseq.Editor.removeBlock(uuid);
      } catch {
        // Ignore already-removed block
      }
    }

    return pageName;
  }

  async loadDeckFromGraphPage(
    pageName: string
  ): Promise<Omit<PresentationDeck, 'id' | 'updatedAt'> | null> {
    let tree: LogseqBlockNode[] | null = null;
    try {
      tree = (await logseq.Editor.getPageBlocksTree(pageName)) as LogseqBlockNode[] | null;
    } catch {
      return null;
    }
    if (!tree || tree.length === 0) return null;
    const deck = parseGraphPageToDeck(pageName, tree);
    // Resolve readable labels and actual source page names for embedded block parts
    for (const slide of deck.slides) {
      for (const part of slide.parts) {
        if (part.kind === 'block' && part.blockUuid) {
          try {
            const blk = (await logseq.Editor.getBlock(part.blockUuid)) as any;
            if (blk?.content) {
              const { clean } = stripBlockProperties(blk.content);
              if (clean) part.label = makePreview(clean, detectBlockKind(clean));
            }
            if (blk?.page?.id) {
              const page = (await logseq.Editor.getPage(blk.page.id)) as any;
              const resolvedName = page?.originalName || page?.name;
              if (resolvedName) part.pageName = String(resolvedName);
            }
          } catch {
            // Keep default label/pageName
          }
        }
      }
    }
    return deck;
  }
}
