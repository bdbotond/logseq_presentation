import '@logseq/libs';
import hostCss from './styles/host.css?inline';
import { LogseqService } from './services/logseqService';
import { ICONS } from './ui/icons';
import type { PresentationPlayer } from './ui/player';
import type { PresentationStudio } from './ui/studio';

let stylesInjected = false;
let playerInstance: PresentationPlayer | null = null;
let studioInstance: PresentationStudio | null = null;

async function ensurePluginStyles(): Promise<void> {
  if (stylesInjected) return;
  const [{ default: katexCss }, { default: mainCss }] = await Promise.all([
    import('katex/dist/katex.min.css?inline'),
    import('./styles/main.css?inline'),
  ]);
  if (stylesInjected) return;
  const styleEl = document.createElement('style');
  styleEl.textContent = `${katexCss}\n${mainCss}`;
  document.head.appendChild(styleEl);
  stylesInjected = true;
}

async function getPlayer(): Promise<PresentationPlayer> {
  await ensurePluginStyles();
  const { PresentationPlayer: PlayerClass } = await import('./ui/player');
  playerInstance = PlayerClass.getInstance();
  return playerInstance;
}

async function getStudio(): Promise<PresentationStudio> {
  await ensurePluginStyles();
  const { PresentationStudio: StudioClass } = await import('./ui/studio');
  studioInstance = StudioClass.getInstance();
  return studioInstance;
}

async function presentCurrentPage(): Promise<void> {
  try {
    const svc = LogseqService.getInstance();
    const pageName = await svc.getCurrentPageName();
    if (!pageName) {
      logseq.UI.showMsg('Open a Logseq page first to present it.', 'warning');
      return;
    }

    const [slides, graphPath, player] = await Promise.all([
      svc.fetchPageSlides(pageName),
      svc.getGraphPath(),
      getPlayer(),
    ]);
    const studio = studioInstance;
    await player.open({
      title: pageName,
      slides,
      graphPath,
      presentationMode: true,
      onClose: studio?.isStudioOpen()
        ? (reason) => {
            if (reason === 'navigate') studio.close();
            else if (studio.isStudioOpen()) studio.restoreBounds();
            else logseq.hideMainUI();
          }
        : undefined,
    });
  } catch (err) {
    console.error('[Presentation] Failed to present current page:', err);
    logseq.UI.showMsg('Failed to present current page.', 'error');
  }
}

function mountLeftSidebarNav(): void {
  logseq.provideUI({
    key: 'lsp-left-nav-presentations',
    path: '.left-sidebar-inner .nav-header',
    reset: true,
    template: `
      <div class="presentations-nav lsp-left-nav-item">
        <a class="item flex items-center" data-on-click="openStudio" title="Open Presentation Studio">
          <span class="ui__icon">${ICONS.presentation}</span>
          <span class="nav-title">Presentations</span>
        </a>
      </div>
    `,
  });
}

function mountPageTitleButton(): void {
  logseq.provideUI({
    key: 'lsp-page-present-btn',
    path: 'h1.page-title',
    reset: true,
    template: `
      <a class="lsp-page-present-btn" data-on-click="presentCurrentPage" title="Convert & Present Page">
        ${ICONS.presentation}
      </a>
    `,
  });
}

async function main(): Promise<void> {
  console.log('[Presentation] Plugin loading...');

  // Inject host-only styles into Logseq host DOM (plugin UI styles load lazily)
  logseq.provideStyle(hostCss);

  logseq.provideModel({
    async presentCurrentPage() {
      await presentCurrentPage();
    },
    async openStudio() {
      await (await getStudio()).open();
    },
    async toggleStudio() {
      await (await getStudio()).toggle();
    },
  });

  logseq.App.registerUIItem('toolbar', {
    key: 'lsp-present-page',
    template: `
      <a class="button" data-on-click="presentCurrentPage" title="Present Current Page">
        ${ICONS.presentation}
      </a>
    `,
  });

  logseq.App.registerUIItem('toolbar', {
    key: 'lsp-studio-toolbar',
    template: `
      <a class="button" data-on-click="toggleStudio" title="Presentation Studio">
        ${ICONS.panel}
      </a>
    `,
  });

  logseq.Editor.registerSlashCommand('Present Page', async () => {
    await presentCurrentPage();
  });

  logseq.Editor.registerSlashCommand('Presentation Studio', async () => {
    await (await getStudio()).open();
  });

  logseq.App.registerCommandPalette(
    {
      key: 'lsp-cmd-present-page',
      label: 'Presentation: Present Current Page',
      keybinding: { binding: 'mod+shift+p' },
    },
    async () => {
      await presentCurrentPage();
    }
  );

  logseq.App.registerCommandPalette(
    {
      key: 'lsp-cmd-open-studio',
      label: 'Presentation: Open Presentation Studio',
    },
    async () => {
      await (await getStudio()).toggle();
    }
  );

  mountLeftSidebarNav();
  mountPageTitleButton();

  let routeMountTimer: number | null = null;
  let sidebarMountTimer: number | null = null;

  logseq.App.onRouteChanged(() => {
    if (routeMountTimer !== null) window.clearTimeout(routeMountTimer);
    routeMountTimer = window.setTimeout(() => {
      routeMountTimer = null;
      mountLeftSidebarNav();
      mountPageTitleButton();
    }, 150);
  });

  logseq.App.onSidebarVisibleChanged(() => {
    if (sidebarMountTimer !== null) window.clearTimeout(sidebarMountTimer);
    sidebarMountTimer = window.setTimeout(() => {
      sidebarMountTimer = null;
      mountLeftSidebarNav();
    }, 150);
  });

  logseq.beforeunload(async () => {
    if (routeMountTimer !== null) window.clearTimeout(routeMountTimer);
    if (sidebarMountTimer !== null) window.clearTimeout(sidebarMountTimer);
    if (playerInstance?.isOpen()) {
      playerInstance.close();
    }
    if (studioInstance?.isStudioOpen()) {
      studioInstance.close();
    }
  });

  console.log('[Presentation] Plugin loaded.');
}

logseq.ready(main).catch(console.error);
