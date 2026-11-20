import '@logseq/libs';
import katexCss from 'katex/dist/katex.min.css?inline';
import hostCss from './styles/host.css?inline';
import mainCss from './styles/main.css?inline';
import { LogseqService } from './services/logseqService';
import { ICONS } from './ui/icons';
import { PresentationPlayer } from './ui/player';
import { PresentationStudio } from './ui/studio';

async function presentCurrentPage(): Promise<void> {
  const svc = LogseqService.getInstance();
  const pageName = await svc.getCurrentPageName();
  if (!pageName) {
    logseq.UI.showMsg('Open a Logseq page first to present it.', 'warning');
    return;
  }

  const slides = await svc.fetchPageSlides(pageName);
  const graphPath = await svc.getGraphPath();
  await PresentationPlayer.getInstance().open({
    title: pageName,
    slides,
    graphPath,
    presentationMode: true,
  });
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

  // Inject plugin styles into iframe and host-only styles into Logseq host DOM
  const styleEl = document.createElement('style');
  styleEl.textContent = `${katexCss}\n${mainCss}`;
  document.head.appendChild(styleEl);
  logseq.provideStyle(hostCss);

  logseq.provideModel({
    async presentCurrentPage() {
      await presentCurrentPage();
    },
    async openStudio() {
      await PresentationStudio.getInstance().open();
    },
    async toggleStudio() {
      await PresentationStudio.getInstance().toggle();
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
    await PresentationStudio.getInstance().open();
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
      await PresentationStudio.getInstance().toggle();
    }
  );

  mountLeftSidebarNav();
  mountPageTitleButton();

  logseq.App.onRouteChanged(() => {
    setTimeout(() => {
      mountLeftSidebarNav();
      mountPageTitleButton();
    }, 150);
  });

  logseq.App.onSidebarVisibleChanged(() => {
    setTimeout(() => {
      mountLeftSidebarNav();
    }, 150);
  });

  console.log('[Presentation] Plugin loaded.');
}

logseq.ready(main).catch(console.error);
