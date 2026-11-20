export type ThemeId =
  | 'logseq'
  | 'light'
  | 'dark'
  | 'minimal'
  | 'midnight'
  | 'academic'
  | 'warm-paper';
export type SlideLayout = 'default' | 'cover' | 'two-column';
export type AspectRatio = '16:9' | '4:3' | 'fluid';

export interface LogseqBlockNode {
  uuid: string;
  content: string;
  properties?: Record<string, unknown>;
  children?: LogseqBlockNode[];
}

export interface SlideBlockItem {
  uuid?: string;
  content: string;
  children: SlideBlockItem[];
  properties?: Record<string, unknown>;
}

export interface SlideNode {
  id: string;
  title: string;
  bodyBlocks: SlideBlockItem[];
  notes?: string;
  layout?: SlideLayout;
  noAutoSplit?: boolean;
  sourcePage?: string;
  sourceUuid?: string;
}

export interface PageBlockOutlineItem {
  uuid: string;
  pageName: string;
  depth: number;
  preview: string;
  kind: 'h1' | 'h2' | 'table' | 'image' | 'code' | 'block';
  childCount: number;
}

export interface DeckContentPart {
  id: string;
  kind: 'page' | 'block' | 'custom';
  pageName?: string;
  blockUuid?: string;
  label: string;
  customMarkdown?: string;
}

export interface DeckSlideEntry {
  id: string;
  title: string;
  notes?: string;
  layout?: SlideLayout;
  parts: DeckContentPart[];
}

export interface PresentationDeck {
  id: string;
  title: string;
  theme: ThemeId;
  aspectRatio?: AspectRatio;
  slides: DeckSlideEntry[];
  updatedAt: number;
}
