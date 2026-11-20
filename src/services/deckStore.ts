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

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDeck(raw: any): PresentationDeck {
  const slides: DeckSlideEntry[] = Array.isArray(raw.slides)
    ? raw.slides.map((s: any) => {
        // Migrate legacy { id, pageName } slide refs
        if (s && !Array.isArray(s.parts) && typeof s.pageName === 'string') {
          return {
            id: s.id || makeId(),
            title: s.titleOverride || s.pageName,
            parts: [
              {
                id: makeId(),
                kind: 'page',
                pageName: s.pageName,
                label: s.pageName,
              },
            ],
          };
        }
        return {
          id: s?.id || makeId(),
          title: s?.title || 'Untitled Slide',
          notes: s?.notes,
          layout:
            s?.layout === 'cover' || s?.layout === 'two-column' || s?.layout === 'default'
              ? s.layout
              : undefined,
          parts: Array.isArray(s?.parts) ? s.parts : [],
        };
      })
    : [];

  return {
    id: raw.id || makeId(),
    title: raw.title || 'Untitled Deck',
    theme: isValidTheme(raw.theme) ? raw.theme : 'logseq',
    aspectRatio: isValidAspectRatio(raw.aspectRatio) ? raw.aspectRatio : '16:9',
    slides,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

export class DeckStore {
  private static instance: DeckStore;
  private decks: PresentationDeck[] = [];
  private loaded = false;

  static getInstance(): DeckStore {
    if (!DeckStore.instance) {
      DeckStore.instance = new DeckStore();
    }
    return DeckStore.instance;
  }

  async load(): Promise<PresentationDeck[]> {
    if (this.loaded) return this.decks;
    try {
      const fs = (logseq as any).FileStorage;
      if (fs && typeof fs.getItem === 'function') {
        const raw = await fs.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.decks = Array.isArray(parsed) ? parsed.map(normalizeDeck) : [];
          this.loaded = true;
          return this.decks;
        }
      }
    } catch {
      // Fallback to localStorage
    }

    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.decks = Array.isArray(parsed) ? parsed.map(normalizeDeck) : [];
      }
    } catch {
      this.decks = [];
    }
    this.loaded = true;
    return this.decks;
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.decks, null, 2);
    try {
      const fs = (logseq as any).FileStorage;
      if (fs && typeof fs.setItem === 'function') {
        await fs.setItem(STORAGE_KEY, json);
      }
    } catch {
      // Ignore FileStorage error
    }
    try {
      localStorage.setItem(FALLBACK_KEY, json);
    } catch {
      // Ignore localStorage error
    }
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
    const deck = this.getDeck(id);
    if (!deck) return;
    deck.title = title.trim() || deck.title;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async updateTheme(id: string, theme: ThemeId): Promise<void> {
    const deck = this.getDeck(id);
    if (!deck) return;
    deck.theme = theme;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async updateAspectRatio(id: string, aspectRatio: AspectRatio): Promise<void> {
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
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    if (patch.title !== undefined) slide.title = patch.title;
    if (patch.notes !== undefined) slide.notes = patch.notes;
    if ('layout' in patch) slide.layout = patch.layout;
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async removeSlide(deckId: string, slideId: string): Promise<void> {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.slides = deck.slides.filter((s) => s.id !== slideId);
    deck.updatedAt = Date.now();
    await this.persist();
  }

  async moveSlide(deckId: string, fromIndex: number, toIndex: number): Promise<void> {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    if (
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
    const deck = normalizeDeck({
      ...parsed,
      id: makeId(),
      updatedAt: Date.now(),
    });
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
    const created = normalizeDeck({
      ...data,
      id: makeId(),
      updatedAt: Date.now(),
    });
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
    const deck = this.getDeck(deckId);
    const slide = deck?.slides.find((s) => s.id === slideId);
    if (!deck || !slide) return;
    if (
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
