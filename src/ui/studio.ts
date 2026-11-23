import '@logseq/libs';
import { DeckStore } from '../services/deckStore';
import { LogseqService } from '../services/logseqService';
import type {
  AspectRatio,
  DeckContentPart,
  DeckSlideEntry,
  PageBlockOutlineItem,
  PresentationDeck,
  SlideLayout,
  ThemeId,
} from '../types';
import { exportDeckToHtml, printDeckToPdf } from './exporter';
import { ICONS } from './icons';
import { PresentationPlayer } from './player';
import { hydrateMermaidDiagrams, renderSlideHtml } from './renderer';
import {
  applyLogseqThemeVars,
  getAspectRatioClass,
  getThemeClasses,
  getThemePolarity,
  renderAspectRatioOptionsHtml,
  renderThemeOptionsHtml,
} from './themes';

export class PresentationStudio {
  private static instance: PresentationStudio;
  private container: HTMLElement | null = null;
  private isOpen = false;
  private logseqMode: 'light' | 'dark' = 'dark';
  private graphPath?: string;

  private selectedDeckId: string | null = null;
  private selectedSlideId: string | null = null;
  private editingPartId: string | null = null;
  private confirmDeleteDeckId: string | null = null;
  private confirmDeleteTimer: number | null = null;

  private allPages: string[] = [];
  private pageSearch = '';
  private inspectedPage: string | null = null;
  private inspectedBlocks: PageBlockOutlineItem[] = [];
  private checkedBlockUuids = new Set<string>();
  private loadingBlocks = false;

  private keyHandler: (e: KeyboardEvent) => void;

  private constructor() {
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen) {
        if (PresentationPlayer.getInstance().isOpen()) return;
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          (document.activeElement as HTMLElement).blur();
          return;
        }
        this.close();
      }
    };
  }

  static getInstance(): PresentationStudio {
    if (!PresentationStudio.instance) {
      PresentationStudio.instance = new PresentationStudio();
    }
    return PresentationStudio.instance;
  }

  isStudioOpen(): boolean {
    return this.isOpen;
  }

  restoreBounds(): void {
    if (this.isOpen) {
      this.applyFullWindowStyle();
    }
  }

  private clearDeleteConfirm(): void {
    this.confirmDeleteDeckId = null;
    if (this.confirmDeleteTimer !== null) {
      window.clearTimeout(this.confirmDeleteTimer);
      this.confirmDeleteTimer = null;
    }
  }

  async toggle(): Promise<void> {
    if (this.isOpen) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    this.isOpen = true;
    const store = DeckStore.getInstance();
    const svc = LogseqService.getInstance();

    try {
      const cfg = await logseq.App.getUserConfigs();
      this.logseqMode = cfg.preferredThemeMode === 'light' ? 'light' : 'dark';
    } catch {
      this.logseqMode = 'dark';
    }

    this.graphPath = await svc.getGraphPath();
    let decks = await store.load();
    if (decks.length === 0) {
      const created = await store.createDeck('My Presentation', 'logseq');
      decks = [created];
    }

    if (!this.selectedDeckId || !store.getDeck(this.selectedDeckId)) {
      this.selectedDeckId = decks[0].id;
    }

    const activeDeck = store.getDeck(this.selectedDeckId)!;
    if (!this.selectedSlideId || !activeDeck.slides.some((s) => s.id === this.selectedSlideId)) {
      this.selectedSlideId = activeDeck.slides[0]?.id ?? null;
    }

    this.allPages = await svc.listPages();

    // Auto-inspect current Logseq page if none selected yet
    if (!this.inspectedPage) {
      const currentPage = await svc.getCurrentPageName();
      if (currentPage) {
        await this.inspectPage(currentPage, false);
      } else if (this.allPages.length > 0) {
        await this.inspectPage(this.allPages[0], false);
      }
    }

    if (!this.isOpen) return;
    this.applyFullWindowStyle();
    logseq.showMainUI({ autoFocus: true });
    window.addEventListener('keydown', this.keyHandler);
    await this.render();
  }

  close(): void {
    this.isOpen = false;
    this.clearDeleteConfirm();
    window.removeEventListener('keydown', this.keyHandler);
    this.container?.remove();
    this.container = null;
    logseq.hideMainUI();
  }

  private applyFullWindowStyle(): void {
    logseq.setMainUIInlineStyle({
      position: 'fixed',
      zIndex: 9999,
      top: '48px',
      left: '0',
      right: '0',
      bottom: '0',
      width: '100vw',
      height: 'calc(100vh - 48px)',
      border: 'none',
      background: 'transparent',
    });
  }

  private async inspectPage(pageName: string, rerender = true): Promise<void> {
    this.inspectedPage = pageName;
    this.checkedBlockUuids.clear();
    this.loadingBlocks = true;
    if (rerender) await this.render();

    let blocks: PageBlockOutlineItem[] = [];
    try {
      blocks = await LogseqService.getInstance().getPageOutlineBlocks(pageName);
    } catch {
      blocks = [];
    }
    if (this.inspectedPage !== pageName) return;
    this.inspectedBlocks = blocks;
    this.loadingBlocks = false;
    if (rerender && this.isOpen) await this.render();
  }

  private getEffectivePolarity(deck?: PresentationDeck): 'light' | 'dark' {
    return getThemePolarity(deck?.theme ?? 'logseq', this.logseqMode);
  }

  private async render(): Promise<void> {
    if (!this.isOpen) return;
    const store = DeckStore.getInstance();
    const decks = store.getDecks();
    const activeDeck = decks.find((d) => d.id === this.selectedDeckId) ?? decks[0];
    if (activeDeck) this.selectedDeckId = activeDeck.id;

    const activeSlide: DeckSlideEntry | undefined = activeDeck?.slides.find(
      (s) => s.id === this.selectedSlideId
    ) ?? activeDeck?.slides[0];
    if (activeSlide) this.selectedSlideId = activeSlide.id;
    else this.selectedSlideId = null;

    const activeTheme: ThemeId = activeDeck?.theme ?? 'logseq';
    const effectivePolarity = this.getEffectivePolarity(activeDeck);

    // Save scroll positions before re-rendering
    const scrollSlides = this.container?.querySelector('.lsp-col-slides .lsp-col-scroll')?.scrollTop ?? 0;
    const scrollPages = this.container?.querySelector('.lsp-pages-list')?.scrollTop ?? 0;
    const scrollOutline = this.container?.querySelector('.lsp-outline-list')?.scrollTop ?? 0;

    this.container?.remove();
    const root = document.createElement('div');
    root.className = `lsp-studio-backdrop ${getThemeClasses(activeTheme, this.logseqMode)}`;
    applyLogseqThemeVars(root, activeTheme);

    const graphPresPages = this.allPages.filter((p) => /^presentations\//i.test(p));
    const localDeckOptions = decks
      .map(
        (d) =>
          `<option value="${this.esc(d.id)}" ${d.id === activeDeck?.id ? 'selected' : ''}>${this.esc(d.title)} (${d.slides.length})</option>`
      )
      .join('');
    const deckOptions = graphPresPages.length
      ? `<optgroup label="Decks">${localDeckOptions}</optgroup><optgroup label="Saved in Graph">${graphPresPages
          .map(
            (p) =>
              `<option value="graph:${this.esc(p)}">↗ ${this.esc(p.replace(/^presentations\//i, ''))}</option>`
          )
          .join('')}</optgroup>`
      : localDeckOptions;

    const filteredPages = this.allPages
      .filter((p) => !this.pageSearch || p.toLowerCase().includes(this.pageSearch.toLowerCase()))
      .slice(0, 80);

    const pagesHtml = filteredPages
      .map(
        (p) => `
        <button class="lsp-page-row ${p === this.inspectedPage ? 'active' : ''}" data-action="inspect-page" data-page="${this.esc(p)}" title="${this.esc(p)}">
          <span class="lsp-page-name">${this.esc(p)}</span>
        </button>`
      )
      .join('');

    const outlineHtml = this.loadingBlocks
      ? `<div class="lsp-empty-hint">Loading page blocks...</div>`
      : this.inspectedBlocks.length === 0
        ? `<div class="lsp-empty-hint">No blocks found on this page.</div>`
        : this.inspectedBlocks
            .map((b) => {
              const checked = this.checkedBlockUuids.has(b.uuid) ? 'checked' : '';
              const pad = Math.min(b.depth, 4) * 14;
              const badge =
                b.kind === 'h1'
                  ? '<span class="lsp-kind lsp-kind-h1">H1</span>'
                  : b.kind === 'h2'
                    ? '<span class="lsp-kind lsp-kind-h2">H2</span>'
                    : b.kind === 'table'
                      ? '<span class="lsp-kind lsp-kind-table">TBL</span>'
                      : b.kind === 'image'
                        ? '<span class="lsp-kind lsp-kind-img">IMG</span>'
                        : b.kind === 'code'
                          ? '<span class="lsp-kind lsp-kind-code">CODE</span>'
                          : '';
              const childHint = b.childCount > 0 ? `<span class="lsp-child-count">+${b.childCount}</span>` : '';
              return `
                <div class="lsp-block-row" style="padding-left:${8 + pad}px">
                  <label class="lsp-block-check-label">
                    <input type="checkbox" class="lsp-block-checkbox" data-uuid="${this.esc(b.uuid)}" ${checked} />
                    ${badge}
                    <span class="lsp-block-preview">${this.esc(b.preview)}</span>
                    ${childHint}
                  </label>
                  <button class="lsp-mini-btn" data-action="quick-add-block" data-uuid="${this.esc(b.uuid)}" title="Add this block to current slide">${ICONS.plus}</button>
                </div>`;
            })
            .join('');

    const slideStripHtml = activeDeck?.slides.length
      ? activeDeck.slides
          .map(
            (s, idx) => `
            <div class="lsp-slide-card ${s.id === activeSlide?.id ? 'active' : ''}" draggable="true" data-drag-slide="${idx}" data-action="select-slide" data-slide-id="${this.esc(s.id)}">
              <div class="lsp-slide-card-top">
                <span class="lsp-slide-num">${idx + 1}</span>
                <span class="lsp-slide-card-title">${this.esc(s.title)}</span>
              </div>
              <div class="lsp-slide-card-meta">
                <span>${s.parts.length} part${s.parts.length === 1 ? '' : 's'}</span>
                <div class="lsp-slide-card-btns">
                  <button class="lsp-mini-btn" data-action="move-slide-up" data-index="${idx}" title="Move up">${ICONS.up}</button>
                  <button class="lsp-mini-btn" data-action="move-slide-down" data-index="${idx}" title="Move down">${ICONS.down}</button>
                  <button class="lsp-mini-btn lsp-danger" data-action="delete-slide" data-slide-id="${this.esc(s.id)}" title="Delete slide">${ICONS.trash}</button>
                </div>
              </div>
            </div>`
          )
          .join('')
      : `<div class="lsp-empty-hint">No slides yet. Pick a page or blocks on the right, or click "+ Blank".</div>`;

    const editingPart = activeSlide?.parts.find((p) => p.id === this.editingPartId && p.kind === 'custom');
    if (this.editingPartId && !editingPart) this.editingPartId = null;

    const partsListHtml = activeSlide?.parts.length
      ? activeSlide.parts
          .map(
            (p, idx) => `
            <div class="lsp-part-chip ${p.id === this.editingPartId ? 'editing' : ''}" draggable="true" data-drag-part="${idx}">
              <span class="lsp-kind lsp-kind-${p.kind === 'page' ? 'h1' : p.kind === 'custom' ? 'code' : 'h2'}">${p.kind.toUpperCase()}</span>
              <span class="lsp-part-label" ${p.kind === 'custom' ? `data-action="edit-custom-part" data-part-id="${this.esc(p.id)}" style="cursor:pointer"` : ''} title="${this.esc(p.pageName ? `${p.pageName}: ${p.label}` : p.label)}">
                ${p.pageName ? `<strong>${this.esc(p.pageName)}</strong>: ` : ''}${this.esc(p.label)}
              </span>
              <div class="lsp-part-actions">
                <button class="lsp-mini-btn" data-action="move-part-up" data-index="${idx}" title="Move up">${ICONS.up}</button>
                <button class="lsp-mini-btn" data-action="move-part-down" data-index="${idx}" title="Move down">${ICONS.down}</button>
                <button class="lsp-mini-btn lsp-danger" data-action="remove-part" data-part-id="${this.esc(p.id)}" title="Remove">${ICONS.trash}</button>
              </div>
            </div>`
          )
          .join('')
      : `<div class="lsp-empty-hint-sm">Empty slide — select blocks from the right panel or add custom markdown below.</div>`;

    root.innerHTML = `
      <div class="lsp-studio-shell">
        <header class="lsp-studio-topbar">
          <div class="lsp-studio-brand">
            ${ICONS.presentation}
            <span>Presentation Studio</span>
          </div>

          <div class="lsp-studio-deck-controls">
            <select class="lsp-select" id="lsp-deck-select">${deckOptions}</select>
            <input type="text" class="lsp-input" id="lsp-deck-title" value="${this.esc(activeDeck?.title || '')}" placeholder="Deck title" />
            <select class="lsp-select lsp-select-sm" id="lsp-deck-theme" title="Theme">
              ${renderThemeOptionsHtml(activeTheme, this.logseqMode)}
            </select>
            <select class="lsp-select lsp-select-xs" id="lsp-deck-ratio" title="Aspect Ratio">
              ${renderAspectRatioOptionsHtml(activeDeck?.aspectRatio)}
            </select>
            <button type="button" class="lsp-btn" data-action="new-deck" title="New Deck">${ICONS.plus} New</button>
            <button type="button" class="lsp-btn" data-action="export-json" title="Backup Deck JSON">JSON</button>
            <button type="button" class="lsp-btn" data-action="import-json" title="Import Deck JSON">Import</button>
            <button type="button" class="lsp-btn lsp-danger ${this.confirmDeleteDeckId === activeDeck?.id ? 'lsp-btn-danger-active' : ''}" data-action="delete-deck" title="Delete Deck">
              ${ICONS.trash}${this.confirmDeleteDeckId === activeDeck?.id ? ' Confirm?' : ''}
            </button>
          </div>

          <div class="lsp-studio-actions">
            <button type="button" class="lsp-btn" data-action="save-to-graph" ${!activeDeck?.slides.length ? 'disabled' : ''} title="Save presentation as a Logseq page with [[Page]] links">
              Save to Graph
            </button>
            <button type="button" class="lsp-btn lsp-btn-primary" data-action="present-deck" ${!activeDeck?.slides.length ? 'disabled' : ''}>
              ${ICONS.play} Present
            </button>
            <button type="button" class="lsp-btn" data-action="export-html" ${!activeDeck?.slides.length ? 'disabled' : ''}>${ICONS.download} HTML</button>
            <button type="button" class="lsp-btn" data-action="export-pdf" ${!activeDeck?.slides.length ? 'disabled' : ''}>${ICONS.download} PDF</button>
            <button type="button" class="lsp-btn-icon" data-action="close" title="Close (Esc)">${ICONS.close}</button>
          </div>
        </header>

        <div class="lsp-studio-workspace">
          <!-- Left: Slide Filmstrip -->
          <aside class="lsp-studio-col lsp-col-slides">
            <div class="lsp-col-header">
              <span>Slides (${activeDeck?.slides.length ?? 0})</span>
              <button class="lsp-btn lsp-btn-sm" data-action="new-blank-slide">${ICONS.plus} Blank</button>
            </div>
            <div class="lsp-col-scroll">${slideStripHtml}</div>
          </aside>

          <!-- Center: Live Slide Preview & Content Parts -->
          <section class="lsp-studio-col lsp-col-canvas">
            ${
              activeSlide
                ? `
              <div class="lsp-canvas-toolbar">
                <input type="text" class="lsp-input lsp-slide-title-input" id="lsp-slide-title" value="${this.esc(activeSlide.title)}" placeholder="Slide Title" />
                <select class="lsp-select lsp-select-sm" id="lsp-slide-layout" title="Slide Layout">
                  <option value="default" ${!activeSlide.layout || activeSlide.layout === 'default' ? 'selected' : ''}>Default</option>
                  <option value="cover" ${activeSlide.layout === 'cover' ? 'selected' : ''}>Cover</option>
                  <option value="two-column" ${activeSlide.layout === 'two-column' ? 'selected' : ''}>2 Columns</option>
                </select>
                <button class="lsp-btn lsp-btn-sm" data-action="present-from-here">${ICONS.play} From here</button>
              </div>
              <div class="lsp-canvas-preview-wrap">
                <div class="lsp-slide-frame lsp-preview-frame ${getAspectRatioClass(activeDeck?.aspectRatio)}" id="lsp-live-preview">
                  <div class="lsp-empty-hint">Rendering preview...</div>
                </div>
              </div>
              <div class="lsp-canvas-inspector">
                <div class="lsp-inspector-block">
                  <div class="lsp-sp-label">Slide Content Parts (drag to reorder; click custom to edit)</div>
                  <div class="lsp-parts-list">${partsListHtml}</div>
                  <div class="lsp-custom-add-row">
                    <textarea class="lsp-textarea lsp-custom-textarea" id="lsp-custom-md" rows="2" placeholder="Add ## Subtitle, bullets, or markdown (Ctrl+Enter to save)...">${this.esc(editingPart?.customMarkdown || '')}</textarea>
                    <div class="lsp-custom-btns">
                      <button class="lsp-btn lsp-btn-primary" data-action="add-custom-part">${editingPart ? 'Save' : 'Add'}</button>
                      ${editingPart ? `<button class="lsp-btn lsp-btn-sm" data-action="cancel-edit-part">Cancel</button>` : ''}
                    </div>
                  </div>
                </div>
                <div class="lsp-inspector-block lsp-notes-box">
                  <div class="lsp-sp-label">Speaker Notes</div>
                  <textarea class="lsp-textarea" id="lsp-slide-notes" rows="2" placeholder="Notes visible with 'S' while presenting...">${this.esc(activeSlide.notes || '')}</textarea>
                </div>
              </div>
            `
                : `<div class="lsp-canvas-empty">Select or create a slide to preview and assemble content from your Logseq pages.</div>`
            }
          </section>

          <!-- Right: Logseq Page & Block Picker -->
          <aside class="lsp-studio-col lsp-col-picker">
            <div class="lsp-col-header">
              <span>Pages & Content</span>
              <button class="lsp-btn lsp-btn-sm" data-action="inspect-current-page">Current Page</button>
            </div>
            <div class="lsp-picker-search">
              <input type="text" class="lsp-input" id="lsp-page-search" value="${this.esc(this.pageSearch)}" placeholder="Search Logseq pages..." />
            </div>
            <div class="lsp-pages-list">${pagesHtml}</div>
            <div class="lsp-outline-header">
              <span class="lsp-outline-title" title="${this.esc(this.inspectedPage || '')}">${this.esc(this.inspectedPage || 'Select a page')}</span>
              ${
                this.inspectedPage
                  ? `<button class="lsp-btn lsp-btn-sm lsp-btn-primary" data-action="add-whole-page" title="Import all # slides from this page">+ Whole Page</button>`
                  : ''
              }
            </div>
            <div class="lsp-outline-list">${outlineHtml}</div>
            <div class="lsp-outline-footer">
              <button class="lsp-btn lsp-btn-primary lsp-grow" data-action="new-slide-from-checked" ${this.checkedBlockUuids.size === 0 ? 'disabled' : ''}>
                + New Slide (${this.checkedBlockUuids.size})
              </button>
              <button class="lsp-btn lsp-grow" data-action="append-checked" ${this.checkedBlockUuids.size === 0 || !activeSlide ? 'disabled' : ''}>
                + To Slide
              </button>
            </div>
          </aside>
        </div>
      </div>
    `;

    this.bindEvents(root, activeDeck, activeSlide);
    document.body.appendChild(root);
    this.container = root;

    // Restore scroll positions
    const slidesEl = root.querySelector('.lsp-col-slides .lsp-col-scroll');
    const pagesEl = root.querySelector('.lsp-pages-list');
    const outlineEl = root.querySelector('.lsp-outline-list');
    if (slidesEl) slidesEl.scrollTop = scrollSlides;
    if (pagesEl) pagesEl.scrollTop = scrollPages;
    if (outlineEl) outlineEl.scrollTop = scrollOutline;

    if (activeSlide && activeDeck) {
      const idx = Math.max(
        0,
        activeDeck.slides.findIndex((s) => s.id === activeSlide.id)
      );
      await this.renderLivePreview(root, activeSlide, effectivePolarity, {
        deckTitle: activeDeck.title,
        slideIndex: idx,
        slideTotal: activeDeck.slides.length,
        aspectRatio: activeDeck.aspectRatio ?? '16:9',
      });
    }
  }

  private async renderLivePreview(
    root: HTMLElement,
    slideEntry: DeckSlideEntry,
    polarity: 'light' | 'dark' = 'light',
    meta?: { deckTitle: string; slideIndex: number; slideTotal: number; aspectRatio: AspectRatio }
  ): Promise<void> {
    const previewEl = root.querySelector<HTMLElement>('#lsp-live-preview');
    if (!previewEl) return;

    try {
      const resolvedSlides = await LogseqService.getInstance().resolveDeckSlideEntry(slideEntry);
      if (this.container !== root) return;
      const first = resolvedSlides[0];
      if (!first) {
        previewEl.innerHTML = `<div class="lsp-empty-hint">Empty slide.</div>`;
        return;
      }
      previewEl.innerHTML = renderSlideHtml(first, this.graphPath, meta);
      if (resolvedSlides.length > 1) {
        const badge = document.createElement('div');
        badge.className = 'lsp-multi-slide-badge';
        badge.textContent = `Expands into ${resolvedSlides.length} slides when presenting`;
        previewEl.prepend(badge);
      }
      await hydrateMermaidDiagrams(previewEl, polarity);
      if (this.container !== root) return;
      if (meta?.aspectRatio !== 'fluid' && previewEl.scrollHeight > previewEl.clientHeight + 8) {
        const warn = document.createElement('div');
        warn.className = 'lsp-overflow-badge';
        warn.textContent = 'Content overflows frame — consider splitting or switching to Fluid';
        previewEl.prepend(warn);
      }
    } catch {
      if (this.container === root) {
        previewEl.innerHTML = `<div class="lsp-empty-hint">Could not render preview.</div>`;
      }
    }
  }

  private getSelectedPartsFromOutline(): Omit<DeckContentPart, 'id'>[] {
    return this.inspectedBlocks
      .filter((b) => this.checkedBlockUuids.has(b.uuid))
      .map((b) => ({
        kind: 'block' as const,
        pageName: b.pageName,
        blockUuid: b.uuid,
        label: b.preview,
      }));
  }

  private bindEvents(
    root: HTMLElement,
    activeDeck?: PresentationDeck,
    activeSlide?: DeckSlideEntry
  ): void {
    const store = DeckStore.getInstance();
    const svc = LogseqService.getInstance();

    root.querySelector('#lsp-deck-select')?.addEventListener('change', async (e) => {
      const val = (e.target as HTMLSelectElement).value;
      this.clearDeleteConfirm();
      if (val.startsWith('graph:')) {
        const pageName = val.slice('graph:'.length);
        const loaded = await svc.loadDeckFromGraphPage(pageName);
        if (loaded) {
          const deck = await store.loadOrReplaceGraphDeck(loaded);
          this.selectedDeckId = deck.id;
          this.selectedSlideId = deck.slides[0]?.id ?? null;
          this.editingPartId = null;
          logseq.UI.showMsg(`Loaded from graph: [[${pageName}]]`, 'success');
        } else {
          logseq.UI.showMsg(`Could not load [[${pageName}]].`, 'warning');
        }
        await this.render();
        return;
      }
      this.selectedDeckId = val;
      const d = store.getDeck(this.selectedDeckId);
      this.selectedSlideId = d?.slides[0]?.id ?? null;
      this.editingPartId = null;
      await this.render();
    });

    root.querySelector('#lsp-deck-title')?.addEventListener('input', async (e) => {
      if (!activeDeck) return;
      const val = (e.target as HTMLInputElement).value;
      await store.renameDeck(activeDeck.id, val);
      const opt = Array.from(root.querySelectorAll<HTMLOptionElement>('#lsp-deck-select option')).find(
        (o) => o.value === activeDeck.id
      );
      if (opt) opt.textContent = `${activeDeck.title} (${activeDeck.slides.length})`;
      const footerTitle = root.querySelector<HTMLElement>('.lsp-slide-footer-title');
      if (footerTitle) footerTitle.textContent = activeDeck.title;
    });

    root.querySelector('#lsp-deck-theme')?.addEventListener('change', async (e) => {
      if (!activeDeck) return;
      await store.updateTheme(activeDeck.id, (e.target as HTMLSelectElement).value as ThemeId);
      await this.render();
    });

    root.querySelector('#lsp-deck-ratio')?.addEventListener('change', async (e) => {
      if (!activeDeck) return;
      await store.updateAspectRatio(
        activeDeck.id,
        (e.target as HTMLSelectElement).value as AspectRatio
      );
      await this.render();
    });

    root.querySelector('#lsp-slide-title')?.addEventListener('input', async (e) => {
      if (!activeDeck || !activeSlide) return;
      const val = (e.target as HTMLInputElement).value;
      await store.updateSlide(activeDeck.id, activeSlide.id, { title: val });
      const card = Array.from(root.querySelectorAll<HTMLElement>('.lsp-slide-card')).find(
        (c) => c.dataset.slideId === activeSlide.id
      );
      const cardTitle = card?.querySelector<HTMLElement>('.lsp-slide-card-title');
      if (cardTitle) cardTitle.textContent = val;
      const previewTitle = root.querySelector<HTMLElement>('#lsp-live-preview .lsp-slide-title');
      if (previewTitle) previewTitle.textContent = val || 'Untitled Slide';
    });

    root.querySelector('#lsp-slide-layout')?.addEventListener('change', async (e) => {
      if (!activeDeck || !activeSlide) return;
      const val = (e.target as HTMLSelectElement).value as SlideLayout;
      await store.updateSlide(activeDeck.id, activeSlide.id, { layout: val });
      await this.render();
    });

    root.querySelector('#lsp-custom-md')?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') {
        ke.preventDefault();
        root.querySelector<HTMLButtonElement>('[data-action="add-custom-part"]')?.click();
      }
    });

    // Drag and drop for slides and parts
    let dragSlideIdx: number | null = null;
    let dragPartIdx: number | null = null;
    const toEl = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;

    root.addEventListener('dragstart', (e) => {
      const el = toEl(e.target);
      const slideCard = el?.closest<HTMLElement>('[data-drag-slide]');
      if (slideCard) {
        dragSlideIdx = Number(slideCard.dataset.dragSlide);
        dragPartIdx = null;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragSlideIdx));
        }
        return;
      }
      const partChip = el?.closest<HTMLElement>('[data-drag-part]');
      if (partChip) {
        dragPartIdx = Number(partChip.dataset.dragPart);
        dragSlideIdx = null;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragPartIdx));
        }
      }
    });

    root.addEventListener('dragend', () => {
      dragSlideIdx = null;
      dragPartIdx = null;
    });

    root.addEventListener('dragover', (e) => {
      const el = toEl(e.target);
      if (dragSlideIdx !== null && el?.closest('[data-drag-slide]')) {
        e.preventDefault();
      } else if (dragPartIdx !== null && el?.closest('[data-drag-part]')) {
        e.preventDefault();
      }
    });

    root.addEventListener('drop', async (e) => {
      const el = toEl(e.target);
      if (dragSlideIdx !== null && activeDeck) {
        const target = el?.closest<HTMLElement>('[data-drag-slide]');
        const fromIdx = dragSlideIdx;
        dragSlideIdx = null;
        if (target) {
          e.preventDefault();
          const toIdx = Number(target.dataset.dragSlide);
          if (!Number.isNaN(fromIdx) && !Number.isNaN(toIdx) && fromIdx !== toIdx) {
            await store.moveSlide(activeDeck.id, fromIdx, toIdx);
            await this.render();
          }
        }
      } else if (dragPartIdx !== null && activeDeck && activeSlide) {
        const target = el?.closest<HTMLElement>('[data-drag-part]');
        const fromIdx = dragPartIdx;
        dragPartIdx = null;
        if (target) {
          e.preventDefault();
          const toIdx = Number(target.dataset.dragPart);
          if (!Number.isNaN(fromIdx) && !Number.isNaN(toIdx) && fromIdx !== toIdx) {
            await store.movePartInSlide(activeDeck.id, activeSlide.id, fromIdx, toIdx);
            await this.render();
          }
        }
      }
    });

    root.querySelector('#lsp-slide-notes')?.addEventListener('input', async (e) => {
      if (!activeDeck || !activeSlide) return;
      await store.updateSlide(activeDeck.id, activeSlide.id, {
        notes: (e.target as HTMLTextAreaElement).value,
      });
    });

    const searchInput = root.querySelector<HTMLInputElement>('#lsp-page-search');
    searchInput?.addEventListener('input', (e) => {
      this.pageSearch = (e.target as HTMLInputElement).value;
      const listEl = root.querySelector('.lsp-pages-list');
      if (listEl) {
        const filtered = this.allPages
          .filter((p) => !this.pageSearch || p.toLowerCase().includes(this.pageSearch.toLowerCase()))
          .slice(0, 80);
        listEl.innerHTML = filtered
          .map(
            (p) => `
            <button class="lsp-page-row ${p === this.inspectedPage ? 'active' : ''}" data-action="inspect-page" data-page="${this.esc(p)}" title="${this.esc(p)}">
              <span class="lsp-page-name">${this.esc(p)}</span>
            </button>`
          )
          .join('');
      }
    });

    root.addEventListener('change', (e) => {
      const cb = (e.target as HTMLElement).closest<HTMLInputElement>('.lsp-block-checkbox');
      if (!cb || !cb.dataset.uuid) return;
      if (cb.checked) this.checkedBlockUuids.add(cb.dataset.uuid);
      else this.checkedBlockUuids.delete(cb.dataset.uuid);

      const newBtn = root.querySelector<HTMLButtonElement>('[data-action="new-slide-from-checked"]');
      const appBtn = root.querySelector<HTMLButtonElement>('[data-action="append-checked"]');
      if (newBtn) {
        newBtn.disabled = this.checkedBlockUuids.size === 0;
        newBtn.textContent = `+ New Slide (${this.checkedBlockUuids.size})`;
      }
      if (appBtn) {
        appBtn.disabled = this.checkedBlockUuids.size === 0 || !activeSlide;
      }
    });

    root.addEventListener('click', async (e) => {
      try {
      const targetEl = e.target as Element | null;
      if (!targetEl) return;
      const pageRef = targetEl.closest<HTMLElement>('[data-page-ref]');
      if (pageRef?.dataset.pageRef) {
        await this.inspectPage(pageRef.dataset.pageRef);
        return;
      }

      const btn = targetEl.closest<HTMLElement>('[data-action]');
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const action = btn.dataset.action;

      if (action === 'close') {
        this.close();
      } else if (action === 'new-deck') {
        const deck = await store.createDeck(`Presentation ${store.getDecks().length + 1}`);
        this.selectedDeckId = deck.id;
        this.selectedSlideId = null;
        this.editingPartId = null;
        this.clearDeleteConfirm();
        await this.render();
      } else if (action === 'export-json' && activeDeck) {
        const json = JSON.stringify(activeDeck, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeName =
          activeDeck.title
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'deck';
        a.href = url;
        a.download = `${safeName}.deck.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        logseq.UI.showMsg(`Exported "${safeName}.deck.json".`, 'success');
      } else if (action === 'import-json') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        const cleanup = () => input.remove();
        input.onchange = async () => {
          const file = input.files?.[0];
          cleanup();
          if (!file) return;
          try {
            const text = await file.text();
            const imported = await store.importDeckJson(text);
            this.selectedDeckId = imported.id;
            this.selectedSlideId = imported.slides[0]?.id ?? null;
            this.editingPartId = null;
            await this.render();
            logseq.UI.showMsg(`Imported "${imported.title}".`, 'success');
          } catch {
            logseq.UI.showMsg('Invalid deck JSON file.', 'error');
          }
        };
        input.addEventListener('cancel', cleanup);
        input.click();
      } else if (action === 'delete-deck' && activeDeck) {
        if (this.confirmDeleteDeckId !== activeDeck.id) {
          this.confirmDeleteDeckId = activeDeck.id;
          if (this.confirmDeleteTimer !== null) window.clearTimeout(this.confirmDeleteTimer);
          this.confirmDeleteTimer = window.setTimeout(() => {
            this.confirmDeleteDeckId = null;
            this.confirmDeleteTimer = null;
            if (this.isOpen) this.render();
          }, 3500);
          await this.render();
          return;
        }
        this.clearDeleteConfirm();
        await store.deleteDeck(activeDeck.id);
        let decks = store.getDecks();
        if (decks.length === 0) {
          decks = [await store.createDeck('My Presentation')];
        }
        this.selectedDeckId = decks[0].id;
        this.selectedSlideId = decks[0].slides[0]?.id ?? null;
        this.editingPartId = null;
        await this.render();
      } else if (action === 'save-to-graph' && activeDeck) {
        const pageName = await svc.saveDeckToGraph(activeDeck);
        this.allPages = await svc.listPages();
        logseq.UI.showMsg(`Saved presentation to graph: [[${pageName}]]`, 'success');
        await this.render();
      } else if (action === 'new-blank-slide' && activeDeck) {
        const created = await store.addSlide(activeDeck.id, `Slide ${activeDeck.slides.length + 1}`);
        if (created) this.selectedSlideId = created.id;
        this.editingPartId = null;
        await this.render();
      } else if (action === 'select-slide' && btn.dataset.slideId) {
        this.selectedSlideId = btn.dataset.slideId;
        this.editingPartId = null;
        await this.render();
      } else if (action === 'delete-slide' && activeDeck && btn.dataset.slideId) {
        e.stopPropagation();
        await store.removeSlide(activeDeck.id, btn.dataset.slideId);
        if (this.selectedSlideId === btn.dataset.slideId) {
          this.selectedSlideId = activeDeck.slides[0]?.id ?? null;
        }
        await this.render();
      } else if (action === 'move-slide-up' && activeDeck) {
        e.stopPropagation();
        const idx = Number(btn.dataset.index);
        await store.moveSlide(activeDeck.id, idx, idx - 1);
        await this.render();
      } else if (action === 'move-slide-down' && activeDeck) {
        e.stopPropagation();
        const idx = Number(btn.dataset.index);
        await store.moveSlide(activeDeck.id, idx, idx + 1);
        await this.render();
      } else if (action === 'inspect-page' && btn.dataset.page) {
        await this.inspectPage(btn.dataset.page);
      } else if (action === 'inspect-current-page') {
        const cur = await svc.getCurrentPageName();
        if (cur) await this.inspectPage(cur);
        else logseq.UI.showMsg('No active page in Logseq.', 'warning');
      } else if (action === 'add-whole-page' && activeDeck && this.inspectedPage) {
        // Parse the page into its # slides and add them individually so user can edit/reorder them
        const pageSlides = await svc.fetchPageSlides(this.inspectedPage);
        if (pageSlides.length <= 1) {
          const created = await store.addSlide(
            activeDeck.id,
            pageSlides[0]?.title || this.inspectedPage,
            [{ kind: 'page', pageName: this.inspectedPage, label: this.inspectedPage }],
            pageSlides[0]?.notes,
            pageSlides[0]?.layout
          );
          if (created) this.selectedSlideId = created.id;
        } else {
          const topLevelUuids = new Set(
            this.inspectedBlocks.filter((b) => b.depth === 0).map((b) => b.uuid)
          );
          let firstCreatedId: string | null = null;
          for (const s of pageSlides) {
            const parts: Omit<DeckContentPart, 'id'>[] = [];
            const seen = new Set<string>();
            if (s.sourceUuid) {
              seen.add(s.sourceUuid);
              parts.push({
                kind: 'block',
                pageName: this.inspectedPage,
                blockUuid: s.sourceUuid,
                label: s.title,
              });
            }
            for (const b of s.bodyBlocks) {
              if (b.uuid && !seen.has(b.uuid) && (!s.sourceUuid || topLevelUuids.has(b.uuid))) {
                seen.add(b.uuid);
                parts.push({
                  kind: 'block',
                  pageName: this.inspectedPage,
                  blockUuid: b.uuid,
                  label: b.content.split('\n')[0].slice(0, 60),
                });
              }
            }
            const created = await store.addSlide(activeDeck.id, s.title, parts, s.notes, s.layout);
            if (!firstCreatedId && created) firstCreatedId = created.id;
          }
          if (firstCreatedId) this.selectedSlideId = firstCreatedId;
        }
        await this.render();
      } else if (action === 'quick-add-block' && activeDeck && btn.dataset.uuid) {
        const block = this.inspectedBlocks.find((b) => b.uuid === btn.dataset.uuid);
        if (!block) return;
        const part: Omit<DeckContentPart, 'id'> = {
          kind: 'block',
          pageName: block.pageName,
          blockUuid: block.uuid,
          label: block.preview,
        };
        if (activeSlide) {
          await store.addPartsToSlide(activeDeck.id, activeSlide.id, [part]);
        } else {
          const title = block.preview.replace(/^#+\s*/, '') || block.pageName;
          const created = await store.addSlide(activeDeck.id, title, [part]);
          if (created) this.selectedSlideId = created.id;
        }
        await this.render();
      } else if (action === 'new-slide-from-checked' && activeDeck) {
        const parts = this.getSelectedPartsFromOutline();
        if (parts.length === 0) return;
        const firstTitle = parts[0].label.replace(/^#+\s*/, '') || this.inspectedPage || 'New Slide';
        const created = await store.addSlide(activeDeck.id, firstTitle, parts);
        if (created) this.selectedSlideId = created.id;
        this.checkedBlockUuids.clear();
        await this.render();
      } else if (action === 'append-checked' && activeDeck && activeSlide) {
        const parts = this.getSelectedPartsFromOutline();
        if (parts.length === 0) return;
        await store.addPartsToSlide(activeDeck.id, activeSlide.id, parts);
        this.checkedBlockUuids.clear();
        await this.render();
      } else if (action === 'edit-custom-part' && btn.dataset.partId) {
        this.editingPartId = btn.dataset.partId;
        await this.render();
      } else if (action === 'cancel-edit-part') {
        this.editingPartId = null;
        await this.render();
      } else if (action === 'add-custom-part' && activeDeck && activeSlide) {
        const input = root.querySelector<HTMLTextAreaElement>('#lsp-custom-md');
        const val = input?.value.trim();
        if (!val) return;
        if (this.editingPartId) {
          await store.updatePartInSlide(activeDeck.id, activeSlide.id, this.editingPartId, val);
          this.editingPartId = null;
        } else {
          await store.addPartsToSlide(activeDeck.id, activeSlide.id, [
            { kind: 'custom', label: val.split('\n')[0].slice(0, 60), customMarkdown: val },
          ]);
        }
        await this.render();
      } else if (action === 'remove-part' && activeDeck && activeSlide && btn.dataset.partId) {
        if (this.editingPartId === btn.dataset.partId) this.editingPartId = null;
        await store.removePartFromSlide(activeDeck.id, activeSlide.id, btn.dataset.partId);
        await this.render();
      } else if (action === 'move-part-up' && activeDeck && activeSlide) {
        const idx = Number(btn.dataset.index);
        await store.movePartInSlide(activeDeck.id, activeSlide.id, idx, idx - 1);
        await this.render();
      } else if (action === 'move-part-down' && activeDeck && activeSlide) {
        const idx = Number(btn.dataset.index);
        await store.movePartInSlide(activeDeck.id, activeSlide.id, idx, idx + 1);
        await this.render();
      } else if (action === 'present-deck' && activeDeck) {
        await this.launchPlayer(activeDeck, 0);
      } else if (action === 'present-from-here' && activeDeck && activeSlide) {
        const idx = Math.max(
          0,
          activeDeck.slides.findIndex((s) => s.id === activeSlide.id)
        );
        await this.launchPlayer(activeDeck, idx);
      } else if (action === 'export-html' && activeDeck) {
        const slides = await svc.fetchDeckSlides(activeDeck);
        await exportDeckToHtml(activeDeck.title, slides, activeDeck.theme, this.graphPath, {
          logseqMode: this.logseqMode,
          aspectRatio: activeDeck.aspectRatio,
        });
      } else if (action === 'export-pdf' && activeDeck) {
        const slides = await svc.fetchDeckSlides(activeDeck);
        await printDeckToPdf(activeDeck.title, slides, activeDeck.theme, this.graphPath, {
          logseqMode: this.logseqMode,
          aspectRatio: activeDeck.aspectRatio,
        });
      }
      } catch (err) {
        console.error('[Presentation] Studio action error:', err);
        logseq.UI.showMsg('Action failed. Check console for details.', 'error');
      }
    });
  }

  private async launchPlayer(deck: PresentationDeck, entryIndex: number): Promise<void> {
    const { slides, slideStartIndices } = await LogseqService.getInstance().fetchDeckSlidesWithOffsets(deck);
    if (slides.length === 0) {
      logseq.UI.showMsg('Add at least one slide to present.', 'warning');
      return;
    }
    const startIndex = slideStartIndices[entryIndex] ?? 0;
    await PresentationPlayer.getInstance().open({
      title: deck.title,
      slides,
      theme: deck.theme,
      aspectRatio: deck.aspectRatio,
      graphPath: this.graphPath,
      startIndex,
      presentationMode: true,
      onClose: () => {
        if (this.isOpen) {
          this.applyFullWindowStyle();
        } else {
          logseq.hideMainUI();
        }
      },
    });
  }

  private esc(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
