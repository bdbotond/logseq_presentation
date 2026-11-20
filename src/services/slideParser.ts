import type {
  AspectRatio,
  DeckContentPart,
  DeckSlideEntry,
  LogseqBlockNode,
  PresentationDeck,
  SlideBlockItem,
  SlideLayout,
  SlideNode,
  ThemeId,
} from '../types';

const PROP_LINE_RE = /^([a-zA-Z0-9_-]+)::\s*(.*)$/;
const SLIDE_TAG_RE = /(?:^|\s)#slide\b|\[\[slide\]\]/i;
const DIVIDER_RE = /^(?:---+|\*\*\*+)$/;
const H1_RE = /^#\s+(.+)$/;

export function stripBlockProperties(content: string): {
  clean: string;
  properties: Record<string, string>;
} {
  const properties: Record<string, string> = {};
  const kept: string[] = [];
  let inFence = false;

  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const match = !inFence ? line.match(PROP_LINE_RE) : null;
    if (match) {
      properties[match[1].toLowerCase()] = match[2].trim();
    } else {
      kept.push(line);
    }
  }

  return {
    clean: kept.join('\n').trim(),
    properties,
  };
}

function parseLayout(
  parsedProps: Record<string, string>,
  rawProps?: Record<string, unknown>
): SlideLayout | undefined {
  const raw =
    (typeof rawProps?.['slide-layout'] === 'string' && rawProps['slide-layout']) ||
    parsedProps['slide-layout'];
  const val = raw?.trim().toLowerCase();
  if (val === 'cover' || val === 'two-column' || val === 'default') return val;
  return undefined;
}

function isNoAutoSplit(
  parsedProps: Record<string, string>,
  rawProps?: Record<string, unknown>
): boolean {
  const raw = rawProps?.['slide-no-split'] ?? parsedProps['slide-no-split'];
  return raw === true || String(raw ?? '').trim().toLowerCase() === 'true';
}

export const DEFAULT_SLIDE_BUDGET = 14;

export function estimateBlockWeight(block: SlideBlockItem, depth = 0): number {
  const text = block.content.trim();
  let weight = 0;

  if (text) {
    if (/^```/.test(text)) {
      const lines = text.split('\n').length;
      weight += Math.min(12, lines * 0.85 + 2);
    } else if (/^\|.+\|\s*\n\s*\|[-:| ]+\|/.test(text)) {
      const rows = text.split('\n').filter((l) => l.trim().startsWith('|')).length;
      weight += Math.min(12, rows * 1.1 + 1.5);
    } else if (/^!\[[^\]]*\]\([^)]+\)/.test(text) || /^\{\{(?:video|youtube)\s+/i.test(text)) {
      weight += 6.5;
    } else if (/^\$\$[\s\S]+\$\$$/.test(text)) {
      weight += 3.0;
    } else if (/^#{2,6}\s+/.test(text)) {
      weight += 1.6;
    } else {
      const lines = text
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 78)), 0);
      weight += lines * 1.0 + (depth === 0 ? 0.5 : 0.35);
    }
  }

  for (const child of block.children) {
    weight += estimateBlockWeight(child, depth + 1);
  }

  return weight;
}

function splitBodyBlocks(blocks: SlideBlockItem[], budget: number): SlideBlockItem[][] {
  if (blocks.length === 0) return [[]];

  const chunks: SlideBlockItem[][] = [];
  let current: SlideBlockItem[] = [];
  let currentWeight = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentWeight = 0;
    }
  };

  for (const block of blocks) {
    const w = estimateBlockWeight(block, 0);

    // If a single block overflows and has multiple children, split its children across slides
    if (w > budget && block.children.length >= 2) {
      const ownWeight = estimateBlockWeight({ ...block, children: [] }, 0);
      const childBudget = Math.max(4, budget - ownWeight);
      const childChunks = splitBodyBlocks(block.children, childBudget);

      for (const childChunk of childChunks) {
        const piece: SlideBlockItem = {
          ...block,
          children: childChunk,
        };
        const pieceWeight = estimateBlockWeight(piece, 0);
        if (current.length > 0 && currentWeight + pieceWeight > budget) {
          flush();
        }
        current.push(piece);
        currentWeight += pieceWeight;
        if (currentWeight >= budget) {
          flush();
        }
      }
      continue;
    }

    if (current.length > 0 && currentWeight + w > budget) {
      flush();
    }
    current.push(block);
    currentWeight += w;
  }

  flush();
  return chunks.length > 0 ? chunks : [[]];
}

export function autoSplitLongSlides(
  slides: SlideNode[],
  budget = DEFAULT_SLIDE_BUDGET
): SlideNode[] {
  const result: SlideNode[] = [];

  for (const slide of slides) {
    if (slide.noAutoSplit || slide.layout === 'cover' || slide.bodyBlocks.length === 0) {
      result.push(slide);
      continue;
    }

    const effectiveBudget = slide.layout === 'two-column' ? Math.round(budget * 1.6) : budget;
    const totalWeight = slide.bodyBlocks.reduce((sum, b) => sum + estimateBlockWeight(b, 0), 0);
    if (totalWeight <= effectiveBudget) {
      result.push(slide);
      continue;
    }

    const chunks = splitBodyBlocks(slide.bodyBlocks, effectiveBudget);
    if (chunks.length <= 1) {
      result.push(slide);
      continue;
    }

    chunks.forEach((chunk, idx) => {
      result.push({
        ...slide,
        id: idx === 0 ? slide.id : `${slide.id}-part-${idx + 1}`,
        title: idx === 0 ? slide.title : `${slide.title} (${idx + 1}/${chunks.length})`,
        bodyBlocks: chunk,
      });
    });
  }

  return result;
}

export function isDividerBlock(content: string): boolean {
  const { clean } = stripBlockProperties(content);
  return DIVIDER_RE.test(clean.trim());
}

export function hasSlideTag(block: LogseqBlockNode): boolean {
  if (SLIDE_TAG_RE.test(block.content)) return true;
  if (block.properties && (block.properties.slide === true || block.properties.slide === 'true')) {
    return true;
  }
  return false;
}

function cleanSlideTag(text: string): string {
  return text.replace(/(?:^|\s)#slide\b/gi, '').replace(/\[\[slide\]\]/gi, '').trim();
}

function isNoteText(clean: string): boolean {
  return /^notes?:\s*/i.test(clean) || /(?:^|\s)#notes?\b/i.test(clean);
}

function extractNoteText(clean: string): string {
  return clean.replace(/^notes?:\s*/i, '').replace(/#notes?\b/gi, '').trim();
}

function toSlideBlockItem(block: LogseqBlockNode, notesOut: string[]): SlideBlockItem | null {
  const { clean, properties } = stripBlockProperties(block.content);
  if (typeof block.properties?.['slide-notes'] === 'string') {
    notesOut.push(block.properties['slide-notes']);
  } else if (properties['slide-notes']) {
    notesOut.push(properties['slide-notes']);
  }

  const cleanedText = cleanSlideTag(clean);
  if (isNoteText(cleanedText)) {
    const note = extractNoteText(cleanedText);
    if (note) notesOut.push(note);
    return null;
  }

  const children = (block.children ?? [])
    .map((c) => toSlideBlockItem(c, notesOut))
    .filter((c): c is SlideBlockItem => c !== null);

  if (!cleanedText && children.length === 0) return null;

  return {
    uuid: block.uuid,
    content: cleanedText,
    children,
    properties: { ...(block.properties ?? {}), ...properties },
  };
}

function appendNotes(slide: SlideNode, notes: string[]): void {
  if (notes.length === 0) return;
  slide.notes = slide.notes ? `${slide.notes}\n${notes.join('\n')}` : notes.join('\n');
}

function processBlockList(
  blocks: LogseqBlockNode[],
  slides: SlideNode[],
  pageName?: string
): void {
  let currentSlide: SlideNode | null = slides.length > 0 ? slides[slides.length - 1] : null;
  let forceNewSlide = false;

  const startSlide = (title: string, uuid?: string): SlideNode => {
    const slide: SlideNode = {
      id: uuid || `slide-${slides.length}`,
      title: title || pageName || `Slide ${slides.length + 1}`,
      bodyBlocks: [],
      sourcePage: pageName,
      sourceUuid: uuid,
    };
    slides.push(slide);
    currentSlide = slide;
    forceNewSlide = false;
    return slide;
  };

  for (const block of blocks) {
    if (isDividerBlock(block.content)) {
      forceNewSlide = true;
      continue;
    }

    const { clean, properties } = stripBlockProperties(block.content);
    const cleanedText = cleanSlideTag(clean);

    // Skip empty property-only page header blocks
    if (!cleanedText && (!block.children || block.children.length === 0)) {
      continue;
    }

    const lines = cleanedText.split('\n');
    const firstLine = lines[0]?.trim() ?? '';
    const restLines = lines.slice(1).join('\n').trim();
    const h1Match = firstLine.match(H1_RE);
    const taggedSlide = hasSlideTag(block);

    // Case 1: H1 (`# Title`) or explicit `#slide` tag starts a new slide
    if (h1Match || taggedSlide) {
      const title = h1Match ? h1Match[1].trim() : firstLine.replace(/^#{1,6}\s+/, '').trim();
      const slide = startSlide(title, block.uuid);
      const layout = parseLayout(properties, block.properties);
      if (layout) slide.layout = layout;
      if (isNoAutoSplit(properties, block.properties)) slide.noAutoSplit = true;
      const notes: string[] = [];

      if (typeof block.properties?.['slide-notes'] === 'string') {
        notes.push(block.properties['slide-notes']);
      } else if (properties['slide-notes']) {
        notes.push(properties['slide-notes']);
      }

      if (restLines) {
        slide.bodyBlocks.push({
          uuid: block.uuid,
          content: restLines,
          children: [],
        });
      }

      // Process children: a child that is `# ` or `---` or `#slide` splits from that point onward
      const children = block.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childClean = stripBlockProperties(child.content).clean;
        const childFirst = childClean.split('\n')[0]?.trim() ?? '';
        if (isDividerBlock(child.content) || H1_RE.test(childFirst) || hasSlideTag(child)) {
          appendNotes(slide, notes);
          processBlockList(children.slice(i), slides, pageName);
          currentSlide = slides[slides.length - 1];
          notes.length = 0;
          break;
        }
        const item = toSlideBlockItem(child, notes);
        if (item) slide.bodyBlocks.push(item);
      }

      appendNotes(slide, notes);
      continue;
    }

    // Case 2: Regular block (including `## Subtitle`, paragraphs, tables, images, etc.)
    if (!currentSlide || forceNewSlide) {
      startSlide(pageName || `Slide ${slides.length + 1}`, block.uuid);
    }
    const layout = parseLayout(properties, block.properties);
    if (layout && currentSlide && !currentSlide.layout) {
      currentSlide.layout = layout;
    }
    if (isNoAutoSplit(properties, block.properties) && currentSlide) {
      currentSlide.noAutoSplit = true;
    }

    const notes: string[] = [];
    const item = toSlideBlockItem(block, notes);
    if (item && currentSlide) {
      currentSlide.bodyBlocks.push(item);
    }
    if (currentSlide) {
      appendNotes(currentSlide, notes);
    }
  }
}

export function parseBlocksToSlides(
  blocks: LogseqBlockNode[],
  pageName?: string,
  options?: { autoSplit?: boolean; maxWeight?: number }
): SlideNode[] {
  const slides: SlideNode[] = [];
  processBlockList(blocks, slides, pageName);

  if (slides.length === 0 && pageName) {
    slides.push({
      id: `empty-${pageName}`,
      title: pageName,
      bodyBlocks: [],
      sourcePage: pageName,
    });
  }

  if (options?.autoSplit === false) {
    return slides;
  }
  return autoSplitLongSlides(slides, options?.maxWeight ?? DEFAULT_SLIDE_BUDGET);
}

export interface GraphBlockSpec {
  content: string;
  children?: GraphBlockSpec[];
}

export function collectDeckSourcePages(deck: PresentationDeck): string[] {
  const seen = new Set<string>();
  const pages: string[] = [];
  for (const slide of deck.slides) {
    for (const part of slide.parts) {
      const name = part.pageName?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        pages.push(name);
      }
    }
  }
  return pages;
}

export function getDeckGraphPageName(deckTitle: string): string {
  const clean = deckTitle.trim() || 'Untitled Presentation';
  return /^presentations\//i.test(clean) ? clean : `Presentations/${clean}`;
}

export function buildDeckGraphBlocks(deck: PresentationDeck): GraphBlockSpec[] {
  const sourcePages = collectDeckSourcePages(deck);
  const headerLines = [
    'type:: presentation',
    `presentation-theme:: ${deck.theme}`,
    `presentation-ratio:: ${deck.aspectRatio ?? '16:9'}`,
    `presentation-deck-id:: ${deck.id}`,
  ];
  if (sourcePages.length > 0) {
    headerLines.push(`sources:: ${sourcePages.map((p) => `[[${p}]]`).join(', ')}`);
  }

  const blocks: GraphBlockSpec[] = [{ content: headerLines.join('\n') }];

  for (const slide of deck.slides) {
    const slidePages: string[] = [];
    const seenSlidePages = new Set<string>();
    const children: GraphBlockSpec[] = [];

    for (const part of slide.parts) {
      if (part.pageName?.trim() && !seenSlidePages.has(part.pageName.trim())) {
        seenSlidePages.add(part.pageName.trim());
        slidePages.push(part.pageName.trim());
      }

      if (part.kind === 'page' && part.pageName) {
        children.push({ content: `{{embed [[${part.pageName}]]}}` });
      } else if (part.kind === 'block' && part.blockUuid) {
        children.push({ content: `{{embed ((${part.blockUuid}))}}` });
      } else if (part.kind === 'custom' && part.customMarkdown?.trim()) {
        children.push({ content: part.customMarkdown.trim() });
      }
    }

    const slideLines = [`# ${slide.title || 'Untitled Slide'}`];
    if (slide.layout && slide.layout !== 'default') {
      slideLines.push(`slide-layout:: ${slide.layout}`);
    }
    if (slide.notes?.trim()) {
      slideLines.push(`slide-notes:: ${slide.notes.trim().replace(/\n+/g, ' ')}`);
    }
    if (slidePages.length > 0) {
      slideLines.push(`source:: ${slidePages.map((p) => `[[${p}]]`).join(', ')}`);
    }

    blocks.push({
      content: slideLines.join('\n'),
      children,
    });
  }

  return blocks;
}

const VALID_THEMES_SET = new Set<ThemeId>([
  'logseq',
  'light',
  'dark',
  'minimal',
  'midnight',
  'academic',
  'warm-paper',
]);

export function parseGraphPageToDeck(
  pageName: string,
  blocks: LogseqBlockNode[]
): Omit<PresentationDeck, 'id' | 'updatedAt'> {
  let theme: ThemeId = 'logseq';
  let aspectRatio: AspectRatio = '16:9';
  const slides: DeckSlideEntry[] = [];
  let idSeq = 0;
  const nextId = () => `g-${++idSeq}`;

  for (const blk of blocks) {
    const { clean, properties } = stripBlockProperties(blk.content || '');

    if (properties['presentation-theme'] && VALID_THEMES_SET.has(properties['presentation-theme'] as ThemeId)) {
      theme = properties['presentation-theme'] as ThemeId;
    }
    if (
      properties['presentation-ratio'] === '16:9' ||
      properties['presentation-ratio'] === '4:3' ||
      properties['presentation-ratio'] === 'fluid'
    ) {
      aspectRatio = properties['presentation-ratio'];
    }

    // Header property-only block
    if (!clean && (!blk.children || blk.children.length === 0)) {
      continue;
    }

    const title = clean.replace(/^#\s+/, '').trim() || `Slide ${slides.length + 1}`;
    const layout = parseLayout(properties, blk.properties);
    const notes = properties['slide-notes'];
    const sourceMatch = properties.source?.match(/\[\[([^\]]+)\]\]/);
    const defaultSourcePage = sourceMatch?.[1];
    const parts: DeckContentPart[] = [];

    for (const child of blk.children ?? []) {
      const childClean = stripBlockProperties(child.content || '').clean;
      if (!childClean) continue;
      const embedPage = childClean.match(/^\{\{embed\s+\[\[([^\]]+)\]\]\}\}$/i);
      if (embedPage) {
        parts.push({
          id: nextId(),
          kind: 'page',
          pageName: embedPage[1],
          label: embedPage[1],
        });
        continue;
      }
      const embedBlock = childClean.match(/^\{\{embed\s+\(\(([0-9a-f-]+)\)\)\}\}$/i);
      if (embedBlock) {
        parts.push({
          id: nextId(),
          kind: 'block',
          pageName: defaultSourcePage,
          blockUuid: embedBlock[1],
          label: `Block ${embedBlock[1].slice(0, 8)}`,
        });
        continue;
      }
      parts.push({
        id: nextId(),
        kind: 'custom',
        label: childClean.split('\n')[0].slice(0, 60),
        customMarkdown: childClean,
      });
    }

    slides.push({
      id: nextId(),
      title,
      layout,
      notes,
      parts,
    });
  }

  return {
    title: pageName.replace(/^presentations\//i, '').trim() || pageName,
    theme,
    aspectRatio,
    slides,
  };
}

export function resolveAssetPath(url: string, graphPath?: string): string {
  const trimmed = url.trim();
  if (!graphPath) return trimmed;
  if (/^(?:https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;

  const normalizedGraph = graphPath.replace(/\/+$/, '');
  if (trimmed.startsWith('../assets/')) {
    return `file://${normalizedGraph}/assets/${trimmed.slice('../assets/'.length)}`;
  }
  if (trimmed.startsWith('./assets/')) {
    return `file://${normalizedGraph}/assets/${trimmed.slice('./assets/'.length)}`;
  }
  if (trimmed.startsWith('assets/')) {
    return `file://${normalizedGraph}/${trimmed}`;
  }
  if (trimmed.startsWith('/assets/')) {
    return `file://${normalizedGraph}${trimmed}`;
  }
  return trimmed;
}
