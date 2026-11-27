import '@logseq/libs';
import { LogseqService } from '../services/logseqService';
import type { AspectRatio, SlideNode, ThemeId } from '../types';
import { escapeHtml, hydrateMermaidDiagrams, renderSlideHtml } from './renderer';
import { exportDeckToHtml, printDeckToPdf } from './exporter';
import { ICONS } from './icons';
import {
  applyLogseqThemeVars,
  getAspectRatioClass,
  getThemeClasses,
  getThemePolarity,
  renderAspectRatioOptionsHtml,
  renderThemeOptionsHtml,
} from './themes';

export class PresentationPlayer {
  private static instance: PresentationPlayer;
  private overlay: HTMLElement | null = null;
  private slides: SlideNode[] = [];
  private currentIndex = 0;
  private theme: ThemeId = 'logseq';
  private aspectRatio: AspectRatio = '16:9';
  private logseqMode: 'light' | 'dark' = 'dark';
  private title = 'Presentation';
  private graphPath?: string;
  private showNotes = false;
  private showGrid = false;
  private blackout = false;
  private presentationMode = false;
  private isOsFullscreen = false;
  private chromeHideTimer: number | null = null;
  private startedAt = 0;
  private timerHandle: number | null = null;
  private onCloseCallback?: (reason?: 'close' | 'navigate') => void;
  private keyHandler: (e: KeyboardEvent) => void;
  private mouseMoveHandler: () => void;
  private fullscreenHandler: () => void;

  private constructor() {
    this.keyHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    this.mouseMoveHandler = () => this.bumpChromeVisibility();
    this.fullscreenHandler = () => {
      if (!document.fullscreenElement && this.isOsFullscreen) {
        this.isOsFullscreen = false;
        try {
          logseq.App.setFullScreen(false);
        } catch {
          // Ignore if host API unavailable
        }
      }
      this.syncMainUIBounds();
    };
  }

  static getInstance(): PresentationPlayer {
    if (!PresentationPlayer.instance) {
      PresentationPlayer.instance = new PresentationPlayer();
    }
    return PresentationPlayer.instance;
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }

  private resolveEffectivePolarity(): 'light' | 'dark' {
    return getThemePolarity(this.theme, this.logseqMode);
  }

  private buildOverlayClass(): string {
    return `lsp-player-overlay ${getThemeClasses(this.theme, this.logseqMode)}${
      this.presentationMode ? ' lsp-presentation-mode lsp-chrome-visible' : ''
    }`;
  }

  async open(options: {
    title: string;
    slides: SlideNode[];
    theme?: ThemeId;
    aspectRatio?: AspectRatio;
    graphPath?: string;
    startIndex?: number;
    presentationMode?: boolean;
    onClose?: (reason?: 'close' | 'navigate') => void;
  }): Promise<void> {
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.chromeHideTimer !== null) {
      window.clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
    if (this.overlay && !options.presentationMode) {
      this.exitRealFullscreen();
    }

    this.title = options.title;
    this.slides = options.slides;
    this.theme = options.theme ?? 'logseq';
    this.aspectRatio = options.aspectRatio ?? '16:9';
    this.graphPath = options.graphPath;
    this.currentIndex = Math.max(0, Math.min(options.startIndex ?? 0, this.slides.length - 1));
    this.presentationMode = Boolean(options.presentationMode);
    this.onCloseCallback = options.onClose;

    try {
      const cfg = await logseq.App.getUserConfigs();
      this.logseqMode = cfg.preferredThemeMode === 'light' ? 'light' : 'dark';
    } catch {
      this.logseqMode = 'dark';
    }

    this.isOsFullscreen = false;
    this.syncMainUIBounds();
    logseq.showMainUI({ autoFocus: true });

    this.showNotes = false;
    this.showGrid = false;
    this.blackout = false;
    this.startedAt = Date.now();
    this.mount();
    this.startTimer();
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('fullscreenchange', this.fullscreenHandler);
    if (this.presentationMode) {
      this.enterRealFullscreen();
      this.bumpChromeVisibility();
    }
    await this.renderCurrentSlide();
  }

  private enterRealFullscreen(): void {
    this.isOsFullscreen = true;
    try {
      logseq.App.setFullScreen(true);
    } catch {
      // Ignore if host API unavailable
    }
    try {
      (window.frameElement as HTMLIFrameElement | null)?.setAttribute('allowfullscreen', 'true');
      document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {
      // Ignore browser fullscreen denial
    }
    this.syncMainUIBounds();
  }

  private exitRealFullscreen(): void {
    const wasFullscreen = this.isOsFullscreen || Boolean(document.fullscreenElement);
    this.isOsFullscreen = false;
    if (wasFullscreen) {
      try {
        logseq.App.setFullScreen(false);
      } catch {
        // Ignore if host API unavailable
      }
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
    this.syncMainUIBounds();
  }

  private syncMainUIBounds(): void {
    const full = this.isOsFullscreen || this.presentationMode || Boolean(document.fullscreenElement);
    logseq.setMainUIInlineStyle({
      position: 'fixed',
      top: full ? '0' : '48px',
      left: '0',
      right: '0',
      bottom: '0',
      width: '100vw',
      height: full ? '100vh' : 'calc(100vh - 48px)',
      zIndex: 9999,
      border: 'none',
      background: 'transparent',
    });
  }

  close(reason: 'close' | 'navigate' = 'close'): void {
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.chromeHideTimer !== null) {
      window.clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('fullscreenchange', this.fullscreenHandler);
    this.exitRealFullscreen();
    this.overlay?.remove();
    this.overlay = null;
    if (this.onCloseCallback) {
      this.onCloseCallback(reason);
    } else {
      logseq.hideMainUI();
    }
  }

  private bumpChromeVisibility(): void {
    if (!this.overlay || !this.presentationMode) return;
    this.overlay.classList.add('lsp-chrome-visible');
    if (this.chromeHideTimer !== null) window.clearTimeout(this.chromeHideTimer);
    this.chromeHideTimer = window.setTimeout(() => {
      this.overlay?.classList.remove('lsp-chrome-visible');
    }, 2200);
  }

  private togglePresentationMode(force?: boolean): void {
    this.presentationMode = force ?? !this.presentationMode;
    if (!this.overlay) return;
    this.overlay.classList.toggle('lsp-presentation-mode', this.presentationMode);
    if (this.presentationMode) {
      this.enterRealFullscreen();
      this.bumpChromeVisibility();
    } else {
      if (this.chromeHideTimer !== null) {
        window.clearTimeout(this.chromeHideTimer);
        this.chromeHideTimer = null;
      }
      this.overlay.classList.remove('lsp-chrome-visible');
      this.exitRealFullscreen();
    }
    const pmBtn = this.overlay.querySelector<HTMLButtonElement>('[data-action="presentation-mode"]');
    if (pmBtn) {
      pmBtn.classList.toggle('lsp-btn-primary', this.presentationMode);
    }
  }

  private startTimer(): void {
    if (this.timerHandle !== null) window.clearInterval(this.timerHandle);
    const update = () => {
      const el = this.overlay?.querySelector<HTMLElement>('.lsp-player-timer');
      if (!el) return;
      const secs = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      el.textContent = `${mm}:${ss}`;
    };
    update();
    this.timerHandle = window.setInterval(update, 1000);
  }

  private mount(): void {
    this.overlay?.remove();
    const el = document.createElement('div');
    el.className = this.buildOverlayClass();
    applyLogseqThemeVars(el, this.theme);
    el.innerHTML = `
      <header class="lsp-player-topbar">
        <div class="lsp-player-title"></div>
        <div class="lsp-player-actions">
          <select class="lsp-theme-select" title="Theme">
            ${renderThemeOptionsHtml(this.theme, this.logseqMode)}
          </select>
          <select class="lsp-ratio-select" title="Aspect Ratio">
            ${renderAspectRatioOptionsHtml(this.aspectRatio)}
          </select>
          <button class="lsp-btn-icon ${this.presentationMode ? 'lsp-btn-primary' : ''}" data-action="presentation-mode" title="Toggle Presentation Mode (P)">${ICONS.play} Present</button>
          <button class="lsp-btn-icon" data-action="source" title="Open Source in Logseq">${ICONS.external}</button>
          <button class="lsp-btn-icon" data-action="grid" title="Slide Overview (G)">${ICONS.grid}</button>
          <button class="lsp-btn-icon" data-action="notes" title="Toggle Speaker Notes (S)">${ICONS.notes}</button>
          <button class="lsp-btn-icon" data-action="html" title="Export HTML">${ICONS.download} HTML</button>
          <button class="lsp-btn-icon" data-action="pdf" title="Export PDF">${ICONS.download} PDF</button>
          <button class="lsp-btn-icon" data-action="fullscreen" title="Fullscreen (F)">${ICONS.fullscreen}</button>
          <button class="lsp-btn-icon" data-action="close" title="Close (Esc)">${ICONS.close}</button>
        </div>
      </header>
      <main class="lsp-player-stage">
        <div class="lsp-slide-frame ${getAspectRatioClass(this.aspectRatio)}"></div>
      </main>
      <div class="lsp-grid-overlay" hidden></div>
      <div class="lsp-blackout-overlay" hidden title="Click or press B/Esc to resume"></div>
      <aside class="lsp-notes-drawer" hidden>
        <div class="lsp-notes-header">Speaker Notes</div>
        <div class="lsp-notes-content"></div>
      </aside>
      <footer class="lsp-player-footer">
        <button class="lsp-nav-btn" data-action="prev">← Prev</button>
        <span class="lsp-slide-counter">1 / 1</span>
        <button class="lsp-nav-btn" data-action="next">Next →</button>
        <button class="lsp-player-timer" data-action="reset-timer" title="Elapsed time (click to reset)">00:00</button>
      </footer>
      <div class="lsp-progress-track"><div class="lsp-progress-fill"></div></div>
    `;

    el.querySelector('.lsp-player-title')!.textContent = this.title;
    const themeSelect = el.querySelector<HTMLSelectElement>('.lsp-theme-select')!;
    themeSelect.value = this.theme;
    themeSelect.addEventListener('change', () => {
      this.theme = themeSelect.value as ThemeId;
      el.className = this.buildOverlayClass();
      applyLogseqThemeVars(el, this.theme);
      if (this.presentationMode) this.bumpChromeVisibility();
      this.renderCurrentSlide();
    });

    const ratioSelect = el.querySelector<HTMLSelectElement>('.lsp-ratio-select')!;
    ratioSelect.addEventListener('change', () => {
      this.aspectRatio = ratioSelect.value as AspectRatio;
      const frame = el.querySelector<HTMLElement>('.lsp-slide-frame');
      if (frame) frame.className = `lsp-slide-frame ${getAspectRatioClass(this.aspectRatio)}`;
    });

    el.addEventListener('click', async (e) => {
      const targetEl = e.target as HTMLElement;
      const pageRef = targetEl.closest<HTMLElement>('[data-page-ref]');
      if (pageRef?.dataset.pageRef) {
        const targetPage = pageRef.dataset.pageRef;
        this.close('navigate');
        await LogseqService.getInstance().openPage(targetPage);
        return;
      }

      if (targetEl.closest('.lsp-blackout-overlay')) {
        this.toggleBlackout(false);
        return;
      }

      const gridCard = targetEl.closest<HTMLElement>('[data-grid-index]');
      if (gridCard) {
        const idx = Number(gridCard.dataset.gridIndex);
        this.toggleGrid(false);
        await this.go(idx);
        return;
      }

      const target = targetEl.closest<HTMLElement>('[data-action]');
      if (!target) {
        // In presentation mode, clicking the stage advances/rewinds slides
        if (
          this.presentationMode &&
          !this.showGrid &&
          !this.blackout &&
          targetEl.closest('.lsp-player-stage') &&
          !targetEl.closest('a, button, select, input, textarea, video, iframe, pre, code') &&
          !window.getSelection()?.toString()
        ) {
          const rect = el.getBoundingClientRect();
          if (e.clientX - rect.left < rect.width * 0.25) {
            await this.go(this.currentIndex - 1);
          } else {
            await this.go(this.currentIndex + 1);
          }
        }
        return;
      }
      const action = target.dataset.action;
      if (action === 'close') this.close();
      else if (action === 'prev') this.go(this.currentIndex - 1);
      else if (action === 'next') this.go(this.currentIndex + 1);
      else if (action === 'notes') this.toggleNotes();
      else if (action === 'grid') this.toggleGrid();
      else if (action === 'presentation-mode') this.togglePresentationMode();
      else if (action === 'reset-timer') {
        this.startedAt = Date.now();
        this.startTimer();
      } else if (action === 'source') {
        const slide = this.slides[this.currentIndex];
        if (slide?.sourceUuid) {
          this.close('navigate');
          await LogseqService.getInstance().openBlock(slide.sourceUuid, slide.sourcePage);
        } else if (slide?.sourcePage) {
          this.close('navigate');
          await LogseqService.getInstance().openPage(slide.sourcePage);
        }
      } else if (action === 'fullscreen') this.toggleFullscreen();
      else if (action === 'html')
        await exportDeckToHtml(this.title, this.slides, this.theme, this.graphPath, {
          logseqMode: this.logseqMode,
          aspectRatio: this.aspectRatio,
        });
      else if (action === 'pdf')
        await printDeckToPdf(this.title, this.slides, this.theme, this.graphPath, {
          logseqMode: this.logseqMode,
          aspectRatio: this.aspectRatio,
        });
    });

    document.body.appendChild(el);
    this.overlay = el;
  }

  private async go(index: number): Promise<void> {
    if (this.slides.length === 0) return;
    const next = Math.max(0, Math.min(index, this.slides.length - 1));
    if (next === this.currentIndex && this.overlay?.querySelector('.lsp-slide-frame')?.innerHTML) {
      return;
    }
    this.currentIndex = next;
    await this.renderCurrentSlide();
  }

  private async renderCurrentSlide(): Promise<void> {
    if (!this.overlay) return;
    const prevBtn = this.overlay.querySelector<HTMLButtonElement>('[data-action="prev"]');
    const nextBtn = this.overlay.querySelector<HTMLButtonElement>('[data-action="next"]');
    if (this.slides.length === 0) {
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      this.overlay.querySelector<HTMLElement>('.lsp-slide-counter')!.textContent = '0 / 0';
      return;
    }
    const slide = this.slides[this.currentIndex];
    const frame = this.overlay.querySelector<HTMLElement>('.lsp-slide-frame')!;
    frame.innerHTML = renderSlideHtml(slide, this.graphPath, {
      deckTitle: this.title,
      slideIndex: this.currentIndex,
      slideTotal: this.slides.length,
    });
    frame.scrollTop = 0;

    if (prevBtn) prevBtn.disabled = this.currentIndex === 0;
    if (nextBtn) nextBtn.disabled = this.currentIndex >= this.slides.length - 1;

    const sourceBtn = this.overlay.querySelector<HTMLButtonElement>('[data-action="source"]');
    if (sourceBtn) {
      sourceBtn.hidden = !slide.sourceUuid && !slide.sourcePage;
    }

    const counter = this.overlay.querySelector<HTMLElement>('.lsp-slide-counter')!;
    counter.textContent = `${this.currentIndex + 1} / ${this.slides.length}`;

    const fill = this.overlay.querySelector<HTMLElement>('.lsp-progress-fill')!;
    fill.style.width = `${((this.currentIndex + 1) / this.slides.length) * 100}%`;

    const notesDrawer = this.overlay.querySelector<HTMLElement>('.lsp-notes-drawer')!;
    const notesContent = this.overlay.querySelector<HTMLElement>('.lsp-notes-content')!;
    notesContent.textContent = slide.notes || 'No speaker notes for this slide.';
    notesDrawer.hidden = !this.showNotes;

    await hydrateMermaidDiagrams(frame, this.resolveEffectivePolarity());
  }

  private toggleNotes(): void {
    this.showNotes = !this.showNotes;
    const notesDrawer = this.overlay?.querySelector<HTMLElement>('.lsp-notes-drawer');
    if (notesDrawer) notesDrawer.hidden = !this.showNotes;
  }

  private toggleGrid(force?: boolean): void {
    this.showGrid = force ?? !this.showGrid;
    const grid = this.overlay?.querySelector<HTMLElement>('.lsp-grid-overlay');
    if (!grid) return;
    if (this.showGrid) {
      grid.innerHTML = `
        <div class="lsp-grid-header">
          <span>Slide Overview (${this.slides.length})</span>
          <button class="lsp-btn-icon" data-action="grid">${ICONS.close}</button>
        </div>
        <div class="lsp-grid-cards">
          ${this.slides
            .map(
              (s, i) => `
              <button class="lsp-grid-card ${i === this.currentIndex ? 'active' : ''}" data-grid-index="${i}">
                <span class="lsp-grid-num">${i + 1}</span>
                <span class="lsp-grid-title">${escapeHtml(s.title)}</span>
              </button>`
            )
            .join('')}
        </div>
      `;
    }
    grid.hidden = !this.showGrid;
  }

  private toggleBlackout(force?: boolean): void {
    this.blackout = force ?? !this.blackout;
    const el = this.overlay?.querySelector<HTMLElement>('.lsp-blackout-overlay');
    if (el) el.hidden = !this.blackout;
  }

  private toggleFullscreen(): void {
    if (!this.isOsFullscreen && !document.fullscreenElement) {
      this.enterRealFullscreen();
    } else {
      this.exitRealFullscreen();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const activeEl = document.activeElement as HTMLElement | null;
    const isFormControl = Boolean(activeEl?.closest('input, textarea, select'));

    if (e.key === 'Escape') {
      e.preventDefault();
      if (isFormControl) {
        activeEl?.blur();
        return;
      }
      if (this.blackout) {
        this.toggleBlackout(false);
        return;
      }
      if (this.showGrid) {
        this.toggleGrid(false);
        return;
      }
      this.close();
      return;
    }

    if (isFormControl || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      this.toggleBlackout();
    } else if (e.key.toLowerCase() === 'g') {
      e.preventDefault();
      this.toggleGrid();
    } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      this.go(this.currentIndex + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      this.go(this.currentIndex - 1);
    } else if (e.key === 'Home') {
      this.go(0);
    } else if (e.key === 'End') {
      this.go(this.slides.length - 1);
    } else if (e.key.toLowerCase() === 'f') {
      this.toggleFullscreen();
    } else if (e.key.toLowerCase() === 'p') {
      e.preventDefault();
      this.togglePresentationMode();
    } else if (e.key.toLowerCase() === 's') {
      this.toggleNotes();
    }
  }
}
