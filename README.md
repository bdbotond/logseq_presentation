# Logseq Presentation Plugin

Convert Logseq pages into fullscreen slide presentations, compose multi-page decks in **Presentation Studio**, and export to standalone HTML or PDF.

![Presentation Studio Screenshot](20261120_195656.png)

## Features

- **One-click Page Presentation**: Icon next to the page title, toolbar button, `/Present Page` slash command, and `Mod+Shift+P` shortcut convert the current Logseq page and launch directly into full-bleed **Presentation Mode**.
- **Slide Splitting & Layouts**:
  - `# H1` headings or `#slide` / `slide:: true` start a new slide; `##`–`######` headings render as subtitles.
  - `---` or `***` blocks force a slide break (including nested blocks).
  - Long slides automatically split into continuation slides (`Title`, `Title (2/N)`, ...); set `slide-no-split:: true` to opt out on a slide.
  - `slide-notes::` property or `Notes:` / `#notes` child blocks become speaker notes (`S` to toggle).
  - `slide-layout:: cover | two-column | default` sets slide layout.
- **Full Content Support**: Tables, images (including `../assets/`), syntax-highlighted code blocks (`highlight.js`, offline), KaTeX math (`$...$`, `$$...$$`), Mermaid diagrams (light & dark themes), video/YouTube embeds, clickable `[[Page]]` refs, tags, highlights, and task badges.
- **Presentation Studio**: Fullscreen workspace (`Presentations` in left sidebar or toolbar icon) to manage multiple decks, drag-and-drop reorder slides and content parts, pick whole pages or individual blocks, edit multiline custom markdown, choose layouts (`Default`, `Cover`, `2 Columns`), aspect ratios (`16:9`, `4:3`, `Fluid`), and themes (`Logseq` live CSS sync, `Light`, `Dark`, `Minimal`, `Midnight`, `Academic`, `Warm Paper`), and backup/import decks as JSON.
- **Presenter Controls**: `←`/`→`/`Space` (or click stage in Presentation Mode) to navigate, `P` to toggle Presentation Mode (auto-hiding chrome), `G` for slide overview grid, `B` for blackout, `S` for speaker notes, `F` for fullscreen, and an elapsed timer in the footer.
- **Offline Export**: Standalone interactive HTML (with bundled KaTeX CSS & pre-rendered Mermaid SVGs) and landscape PDF via print stylesheet.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load the plugin in Logseq via **Plugins -> Load unpacked plugin** and select the project root directory.
# logseq_presentation
