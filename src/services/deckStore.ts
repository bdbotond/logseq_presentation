import '@logseq/libs';
import type {
  AspectRatio,
  DeckContentPart,
  DeckSlideEntry,
  PresentationDeck,
  SlideLayout,
  ThemeId,
} from '../types';
import { isValidAspectRatio, isValidTheme } from '../ui/themes';

const STORAGE_KEY = 'decks.json';
const FALLBACK_KEY = 'logseq-presentation:decks';

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePart(raw: any, regenerateIds: boolean): DeckContentPart | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'page' && raw.kind !== 'block' && raw.kind !== 'custom') return null;

  const id = !regenerateIds && typeof raw.id === 'string' && raw.id ? raw.id : makeId();
  if (raw.kind === 'page') {
    const pageName = typeof raw.pageName === 'string' ? raw.pageName.trim() : '';
    if (!pageName) return null;
    return {
      id,
      kind: 'page',
      pageName,
      label: typeof raw.label === 'string' && raw.label ? raw.label : pageName,
    };
  }
  if (raw.kind === 'block') {
    const blockUuid = typeof raw.blockUuid === 'string' ? raw.blockUuid.trim() : '';
    if (!blockUuid) return null;
    return {
      id,
      kind: 'block',
      pageName: typeof raw.pageName === 'string' ? raw.pageName : undefined,
      blockUuid,
      label:
        typeof raw.label === 'string' && raw.label ? raw.label : `Block ${blockUuid.slice(0, 8)}`,
    };
  }
  const customMarkdown = typeof raw.customMarkdown === 'string' ? raw.customMarkdown : '';
  return {
    id,
    kind: 'custom',
    label:
      typeof raw.label === 'string' && raw.label
        ? raw.label
        : customMarkdown.trim().split('\n')[0]?.slice(0, 60) || 'Custom block',
    customMarkdown,
  };
}

function normalizeDeck(raw: any, regenerateIds = false): PresentationDeck {
  const safeRaw = raw && typeof raw === 'object' ? raw : {};
  const slides: DeckSlideEntry[] = Array.isArray(safeRaw.slides)
    ? safeRaw.slides
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => {
          // Migrate legacy { id, pageName } slide refs
          if (!Array.isArray(s.parts) && typeof s.pageName === 'string') {
            return {
              id: !regenerateIds && typeof s.id === 'string' && s.id ? s.id : makeId(),
              title: s.titleOverride || s.pageName,
              parts: [
                {
                  id: makeId(),
                  kind: 'page' as const,
                  pageName: s.pageName,
                  label: s.pageName,
                },
              ],
            };
          }
          const parts = Array.isArray(s.parts)
            ? s.parts
                .map((p: any) => normalizePart(p, regenerateIds))
                .filter((p: DeckContentPart | null): p is DeckContentPart => p !== null)
            : [];
          return {
            id: !regenerateIds && typeof s.id === 'string' && s.id ? s.id : makeId(),
            title: typeof s.title === 'string' && s.title ? s.title : 'Untitled Slide',
            notes: typeof s.notes === 'string' ? s.notes : undefined,
            layout:
              s.layout === 'cover' || s.layout === 'two-column' || s.layout === 'default'
                ? s.layout
                : undefined,
            parts,
          };
        })
    : [];

  return {
    id: !regenerateIds && typeof safeRaw.id === 'string' && safeRaw.id ? safeRaw.id : makeId(),
    title: typeof safeRaw.title === 'string' && safeRaw.title ? safeRaw.title : 'Untitled Deck',
    theme: isValidTheme(safeRaw.theme) ? safeRaw.theme : 'logseq',
    aspectRatio: isValidAspectRatio(safeRaw.aspectRatio) ? safeRaw.aspectRatio : '16:9',
    slides,
    updatedAt: typeof safeRaw.updatedAt === 'number' ? safeRaw.updatedAt : Date.now(),
  };
}

export class DeckStore {
  private static instance: DeckStore;
  private decks: PresentationDeck[] = [];
  private loaded = false;
  private loadPromise: Promise<PresentationDeck[]> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  static getInstance(): DeckStore {
    if (!DeckStore.instance) {
      DeckStore.instance = new DeckStore();
    }
    return DeckStore.instance;
  }

  async load(): Promise<PresentationDeck[]> {
    if (this.loaded) return this.decks;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const fs = (logseq as any)?.FileStorage;
        if (fs && typeof fs.getItem === 'function') {
          const raw = await fs.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              this.decks = parsed
                .filter((d: unknown) => Boolean(d && typeof d === 'object'))
                .map((d) => normalizeDeck(d));
              this.loaded = true;
              return this.decks;
            }
          }
        }
      } catch {
        // Fallback to localStorage
      }

      try {
        const raw = getBrowserStorage()?.getItem(FALLBACK_KEY) ?? null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.decks = parsed
              .filter((d: unknown) => Boolean(d && typeof d === 'object'))
              .map((d) => normalizeDeck(d));
          }
        }
      } catch {
        this.decks = [];
      }
      this.loaded = true;
      return this.decks;
    })();

    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private persist(): Promise<void> {
    const run = async () => {
      // Serialize the latest state at execution time so rapid writes never overwrite newer state
      const json = JSON.stringify(this.decks, null, 2);
      try {
        const fs = (logseq as any)?.FileStorage;
        if (fs && typeof fs.setItem === 'function') {
          await fs.setItem(STORAGE_KEY, json);
        }
      } catch {
        // Ignore FileStorage error
      }
      try {
        getBrowserStorage()?.setItem(FALLBACK_KEY, json);
      } catch {
        // Ignore localStorage error
      }
    };

    const next = this.persistQueue.then(run, run);
    this.persistQueue = next;
    return next;
  }

  getDecks(): PresentationDeck[] {
    return this.decks;
  }

  getDeck(id: string): PresentationDeck | undefined {
    return this.decks.find((d) => d.id === id);
  }

  async createDeck(title: string, theme: ThemeId = 'logseq'): Promise<PresentationDeck> {
    await this.load();
    const deck: PresentationDeck = {
      id: makeId(),
      title: title.trim() || 'Untitled Deck',
      theme,
      aspectRatio: '16:9',
      slides: [],
      updatedAt: Date.now(),
    };
    this.decks.unshift(deck);
    await this.persist();
    return deck;
  }

  async deleteDeck(id: string): Promise<void> {
    await this.load();
    this.decks = this.decks.filter((d) => d.id !== id);
    await this.persist();
  }

  async renameDeck(id: string, title: string): Promise<void> {
    await this.load();
    const deck = this.getDeck(id);
    if (!deck) return;
    deck.title = title.trim() || deck.title;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async updateTheme(id: string, theme: ThemeId): Promise<void> {
    await this.load();
    const deck = this.getDeck(id);
    if (!deck) return;
    deck.theme = theme;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async updateAspectRatio(id: string, aspectRatio: AspectRatio): Promise<void> {
    await this.load();
    const deck = this.getDeck(id);
    if (!deck) return;
    deck.aspectRatio = aspectRatio;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async addSlide(
    deckId: string,
    title: string,
    parts: Omit<DeckContentPart, 'id'>[] = [],
    notes?: string,
    layout?: SlideLayout
  ): Promise<DeckSlideEntry | null> {
    await this.load();
    const deck = this.getDeck(deckId);
    if (!deck) return null;
    const entry: DeckSlideEntry = {
      id: makeId(),
      title: title.trim() || `Slide ${deck.slides.length + 1}`,
      notes,
      layout,
      parts: parts.map((p) => ({ ...p, id: makeId() })),
    };
    deck.slides.push(entry);
    deck.updatedAt = Date.now();
    await this.persist();
    return entry;
  }

  async updateSlide(
    deckId: string,
    slideId: string,
    patch: Partial<Pick<DeckSlideEntry, 'title' | 'notes' | 'layout'>>
  ): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    if (patch.title !== undefined) slide.title = patch.title;
    if ('notes' in patch) slide.notes = patch.notes;
    if ('layout' in patch) slide.layout = patch.layout;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async removeSlide(deckId: string, slideId: string): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.slides = deck.slides.filter((s) => s.id !== slideId);
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async moveSlide(deckId: string, fromIndex: number, toIndex: number): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    if (!deck) return;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= deck.slides.length ||
      toIndex >= deck.slides.length
    ) {
      return;
    }
    const [item] = deck.slides.splice(fromIndex, 1);
    deck.slides.splice(toIndex, 0, item);
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async addPartsToSlide(
    deckId: string,
    slideId: string,
    parts: Omit<DeckContentPart, 'id'>[]
  ): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    for (const p of parts) {
      slide.parts.push({ ...p, id: makeId() });
    }
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async removePartFromSlide(deckId: string, slideId: string, partId: string): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    slide.parts = slide.parts.filter((p) => p.id !== partId);
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async updatePartInSlide(
    deckId: string,
    slideId: string,
    partId: string,
    customMarkdown: string
  ): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    const part = slide?.parts.find((p) => p.id === partId);
    if (!deck || !slide || !part || part.kind !== 'custom') return;
    part.customMarkdown = customMarkdown;
    part.label = customMarkdown.trim().split('\n')[0].slice(0, 60) || 'Custom block';
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async importDeckJson(rawJson: string): Promise<PresentationDeck> {
    await this.load();
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid deck JSON: expected a deck object');
    }
    const deck = normalizeDeck(
      {
        ...parsed,
        id: makeId(),
        updatedAt: Date.now(),
      },
      true
    );
    this.decks.unshift(deck);
    await this.persist();
    return deck;
  }

  async loadOrReplaceGraphDeck(
    data: Omit<PresentationDeck, 'id' | 'updatedAt'>
  ): Promise<PresentationDeck> {
    await this.load();
    const existing = this.decks.find(
      (d) => d.title.trim().toLowerCase() === data.title.trim().toLowerCase()
    );
    if (existing) {
      existing.theme = data.theme;
      existing.aspectRatio = data.aspectRatio ?? '16:9';
      existing.slides = data.slides.map((s) => ({
        ...s,
        id: makeId(),
        parts: s.parts.map((p) => ({ ...p, id: makeId() })),
      }));
      existing.updatedAt = Date.now();
      await this.persist();
      return existing;
    }
    const created = normalizeDeck(
      {
        ...data,
        id: makeId(),
        updatedAt: Date.now(),
      },
      true
    );
    this.decks.unshift(created);
    await this.persist();
    return created;
  }

  async movePartInSlide(
    deckId: string,
    slideId: string,
    fromIndex: number,
    toIndex: number
  ): Promise<void> {
    await this.load();
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= slide.parts.length ||
      toIndex >= slide.parts.length
    ) {
      return;
    }
    const [item] = slide.parts.splice(fromIndex, 1);
    slide.parts.splice(toIndex, 0, item);
    deck.updatedAt = Date.now();
    await this.persist();
  }
}
