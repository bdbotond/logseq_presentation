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

const PROP_LINE_RE = /^([a-zA-Z0-9_-]+)::(?:\s+(.*)|\s*)$/;
const SLIDE_TAG_RE = /(?:^|\s)#slide\b|\[\[slide\]\]/i;
const DIVIDER_RE = /^(?:---+|\*\*\*+)$/;
const H1_RE = /^#\s+(.+)$/;

function mapOutsideFences(text: string, fn: (line: string) => string): string {
  let inFence = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : fn(line);
    })
    .join('\n');
}

function someLineOutsideFences(text: string, predicate: (line: string) => boolean): boolean {
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && predicate(line)) return true;
  }
  return false;
}

export function stripBlockProperties(content: string): {
  clean: string;
  properties: Record<string, string>;
} {
  const properties: Record<string, string> = {};
  const kept: string[] = [];
  let inFence = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const match = !inFence ? line.match(PROP_LINE_RE) : null;
    if (match) {
      properties[match[1].toLowerCase()] = (match[2] ?? '').trim();
    } else {
      kept.push(line);
    }
  }

  return {
    clean: kept.join('\n').trim(),
    properties,
  };
}

function getRawProp(
  rawProps: Record<string, unknown> | undefined,
  kebab: string,
  camel: string
): unknown {
  if (!rawProps) return undefined;
  return rawProps[kebab] !== undefined ? rawProps[kebab] : rawProps[camel];
}

function parseLayout(
  parsedProps: Record<string, string>,
  rawProps?: Record<string, unknown>
): SlideLayout | undefined {
  const rawProp = getRawProp(rawProps, 'slide-layout', 'slideLayout');
  const raw = (typeof rawProp === 'string' && rawProp) || parsedProps['slide-layout'];
  const val = raw?.trim().toLowerCase();
  if (val === 'cover' || val === 'two-column' || val === 'default') return val;
  return undefined;
}

function isNoAutoSplit(
  parsedProps: Record<string, string>,
  rawProps?: Record<string, unknown>
): boolean {
  const raw = getRawProp(rawProps, 'slide-no-split', 'slideNoSplit') ?? parsedProps['slide-no-split'];
  return raw === true || String(raw ?? '').trim().toLowerCase() === 'true';
}

function getSlideNotesProp(
  parsedProps: Record<string, string>,
  rawProps?: Record<string, unknown>
): string | undefined {
  const raw = getRawProp(rawProps, 'slide-notes', 'slideNotes');
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (parsedProps['slide-notes']) return parsedProps['slide-notes'];
  return undefined;
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
  const safeBudget = Math.max(1, budget);

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

    // If a single block overflows and has children, recursively split its children across slides
    if (w > safeBudget && block.children.length >= 1) {
      const ownWeight = estimateBlockWeight({ ...block, children: [] }, 0);
      const childBudget = Math.max(4, safeBudget - ownWeight);
      const childChunks = splitBodyBlocks(block.children, childBudget);

      for (const childChunk of childChunks) {
        const piece: SlideBlockItem = {
          ...block,
          children: childChunk,
        };
        const pieceWeight = estimateBlockWeight(piece, 0);
        if (current.length > 0 && currentWeight + pieceWeight > safeBudget) {
          flush();
        }
        current.push(piece);
        currentWeight += pieceWeight;
        if (currentWeight >= safeBudget) {
          flush();
        }
      }
      continue;
    }

    if (current.length > 0 && currentWeight + w > safeBudget) {
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
  if (someLineOutsideFences(block.content || '', (line) => SLIDE_TAG_RE.test(line))) return true;
  if (block.properties && (block.properties.slide === true || block.properties.slide === 'true')) {
    return true;
  }
  return false;
}

function cleanSlideTag(text: string): string {
  return mapOutsideFences(text, (line) =>
    line.replace(/(?:^|\s)#slide\b/gi, '').replace(/\[\[slide\]\]/gi, '')
  ).trim();
}

export function isNoteText(clean: string): boolean {
  return /^notes?:\s*/i.test(clean) || /(?:^|\s)#notes?\b/i.test(clean);
}

export function extractNoteText(clean: string): string {
  return clean.replace(/^notes?:\s*/i, '').replace(/#notes?\b/gi, '').trim();
}

function collectNoteChildren(children: LogseqBlockNode[] | undefined, notesOut: string[]): void {
  if (!children?.length) return;
  for (const child of children) {
    const { clean, properties } = stripBlockProperties(child.content || '');
    const propNote = getSlideNotesProp(properties, child.properties);
    if (propNote) notesOut.push(propNote);
    const text = extractNoteText(cleanSlideTag(clean));
    if (text) notesOut.push(text);
    collectNoteChildren(child.children, notesOut);
  }
}

export function toSlideBlockItem(block: LogseqBlockNode, notesOut: string[]): SlideBlockItem | null {
  const { clean, properties } = stripBlockProperties(block.content || '');
  const propNote = getSlideNotesProp(properties, block.properties);
  if (propNote) {
    notesOut.push(propNote);
  }

  const cleanedText = cleanSlideTag(clean);
  if (isNoteText(cleanedText)) {
    const note = extractNoteText(cleanedText);
    if (note) notesOut.push(note);
    collectNoteChildren(block.children, notesOut);
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
): boolean {
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
    if (isDividerBlock(block.content || '')) {
      forceNewSlide = true;
      continue;
    }

    const { clean, properties } = stripBlockProperties(block.content || '');
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

      const propNote = getSlideNotesProp(properties, block.properties);
      if (propNote) {
        notes.push(propNote);
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
        const childClean = stripBlockProperties(child.content || '').clean;
        const childFirst = childClean.split('\n')[0]?.trim() ?? '';
        if (isDividerBlock(child.content || '') || H1_RE.test(childFirst) || hasSlideTag(child)) {
          appendNotes(slide, notes);
          forceNewSlide = processBlockList(children.slice(i), slides, pageName);
          currentSlide = slides[slides.length - 1] ?? null;
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
    const notes: string[] = [];
    const item = toSlideBlockItem(block, notes);
    if (!item && notes.length === 0) {
      continue;
    }
    if (!item && currentSlide && !forceNewSlide) {
      appendNotes(currentSlide, notes);
      continue;
    }
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
    if (item && currentSlide) {
      currentSlide.bodyBlocks.push(item);
    }
    if (currentSlide) {
      appendNotes(currentSlide, notes);
    }
  }

  return forceNewSlide;
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

    const safeTitle = (slide.title || 'Untitled Slide').replace(/\r?\n+/g, ' ').trim() || 'Untitled Slide';
    const slideLines = [`# ${safeTitle}`];
    if (slide.layout && slide.layout !== 'default') {
      slideLines.push(`slide-layout:: ${slide.layout}`);
    }
    if (slide.notes?.trim()) {
      slideLines.push(`slide-notes:: ${slide.notes.trim().replace(/\r?\n+/g, ' ')}`);
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

function flattenNestedCustomChildren(children: LogseqBlockNode[] | undefined, depth = 0): string[] {
  if (!children?.length) return [];
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const child of children) {
    const { clean } = stripBlockProperties(child.content || '');
    if (clean) {
      const [first, ...rest] = clean.split('\n');
      lines.push(`${indent}- ${first}`);
      for (const line of rest) {
        lines.push(`${indent}  ${line}`);
      }
    }
    lines.push(...flattenNestedCustomChildren(child.children, depth + 1));
  }
  return lines;
}

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

    const rawTheme =
      properties['presentation-theme'] ||
      String(getRawProp(blk.properties, 'presentation-theme', 'presentationTheme') ?? '').trim();
    if (rawTheme && VALID_THEMES_SET.has(rawTheme as ThemeId)) {
      theme = rawTheme as ThemeId;
    }

    const rawRatio =
      properties['presentation-ratio'] ||
      String(getRawProp(blk.properties, 'presentation-ratio', 'presentationRatio') ?? '').trim();
    if (rawRatio === '16:9' || rawRatio === '4:3' || rawRatio === 'fluid') {
      aspectRatio = rawRatio;
    }

    // Header property-only block
    if (!clean && (!blk.children || blk.children.length === 0)) {
      continue;
    }

    const cleanLines = clean.split('\n');
    const title = cleanLines[0]?.replace(/^#\s+/, '').trim() || `Slide ${slides.length + 1}`;
    const extraSlideLines = cleanLines.slice(1).join('\n').trim();
    const layout = parseLayout(properties, blk.properties);
    const notes = getSlideNotesProp(properties, blk.properties);
    const sourceMatch = properties.source?.match(/\[\[([^\]]+)\]\]/);
    const defaultSourcePage = sourceMatch?.[1];
    const parts: DeckContentPart[] = [];

    if (extraSlideLines) {
      parts.push({
        id: nextId(),
        kind: 'custom',
        label: extraSlideLines.split('\n')[0].slice(0, 60),
        customMarkdown: extraSlideLines,
      });
    }

    for (const child of blk.children ?? []) {
      const childClean = stripBlockProperties(child.content || '').clean;
      if (!childClean && (!child.children || child.children.length === 0)) continue;
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
      const nestedLines = flattenNestedCustomChildren(child.children, 0);
      const fullMarkdown = [childClean, ...nestedLines].filter(Boolean).join('\n');
      if (!fullMarkdown) continue;
      parts.push({
        id: nextId(),
        kind: 'custom',
        label: fullMarkdown.split('\n')[0].slice(0, 60),
        customMarkdown: fullMarkdown,
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

function encodeFilePathSegments(pathStr: string): string {
  return pathStr
    .split('/')
    .map((seg, idx) => {
      // Preserve Windows drive letter segment like "C:"
      if (idx === 0 && /^[a-zA-Z]:$/.test(seg)) return seg;
      if (idx === 1 && seg === '' && pathStr.startsWith('/')) return seg;
      try {
        // Avoid double-encoding already percent-encoded sequences
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join('/');
}

function toFileUrl(graphPath: string, relativeAssetPath: string): string {
  const normalizedGraph = graphPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedAsset = relativeAssetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const fullPath = `${normalizedGraph}/${normalizedAsset}`;
  const encoded = encodeFilePathSegments(fullPath);
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

export function resolveAssetPath(url: string, graphPath?: string): string {
  const trimmed = url.trim();
  if (!graphPath) return trimmed;
  if (/^(?:https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;

  const normalizedUrl = trimmed.replace(/\\/g, '/');
  if (normalizedUrl.startsWith('../assets/')) {
    return toFileUrl(graphPath, `assets/${normalizedUrl.slice('../assets/'.length)}`);
  }
  if (normalizedUrl.startsWith('./assets/')) {
    return toFileUrl(graphPath, `assets/${normalizedUrl.slice('./assets/'.length)}`);
  }
  if (normalizedUrl.startsWith('assets/')) {
    return toFileUrl(graphPath, normalizedUrl);
  }
  if (normalizedUrl.startsWith('/assets/')) {
    return toFileUrl(graphPath, normalizedUrl.slice(1));
  }
  return trimmed;
}
