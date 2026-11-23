import { defineConfig, type Plugin } from 'vite';

/**
 * Electron/Chromium natively supports .woff2; stripping legacy .woff and .ttf
 * fallbacks from katex.min.css eliminates 40 unused font assets (~900 KB).
 */
function stripLegacyKatexFonts(): Plugin {
  return {
    name: 'strip-legacy-katex-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !id.includes('.css')) return null;
      const stripped = code
        .replace(/,url\(fonts\/KaTeX_[^)]+\.woff\)\s*format\("woff"\)/g, '')
        .replace(/,url\(fonts\/KaTeX_[^)]+\.ttf\)\s*format\("truetype"\)/g, '');
      return { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [stripLegacyKatexFonts()],
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/katex')) return 'vendor-katex';
          if (id.includes('node_modules/highlight.js')) return 'vendor-hljs';
          if (id.includes('node_modules/marked')) return 'vendor-marked';
        },
      },
    },
  },
});
