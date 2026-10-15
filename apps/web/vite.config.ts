import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, defineConfig, type Plugin } from "vite";
import type * as LegalPrerender from "./src/features/legal/legalPrerender.js";

const usePolling =
  process.env.CHOKIDAR_USEPOLLING === "true" || process.env.DEV_WATCH_POLLING === "true";

export default defineConfig({
  plugins: [react(), prerenderLegalPages()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:4001",
      "/assets/images": "http://localhost:4001"
    },
    watch: usePolling
      ? {
          usePolling: true,
          interval: 300
        }
      : undefined
  }
});

/**
 * Writes /terms, /privacy and /account-deletion as static HTML beside the SPA's
 * index.html, so the policy text is in the response itself rather than only in
 * what the script renders. The rendering lives in `legalPrerender.tsx`; this is
 * only the build step that loads it through Vite's SSR loader (it is TSX and
 * reaches `@book-maker/core/legal`) and writes its files out.
 */
function prerenderLegalPages(): Plugin {
  let root = process.cwd();
  return {
    name: "prerender-legal-pages",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async writeBundle(options) {
      const outDir = options.dir ?? resolve(root, "dist");
      const template = await readFile(resolve(outDir, "index.html"), "utf8");
      const loader = await createServer({
        root,
        configFile: false,
        logLevel: "warn",
        appType: "custom",
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] }
      });
      try {
        const prerender = (await loader.ssrLoadModule(
          "/src/features/legal/legalPrerender.tsx"
        )) as typeof LegalPrerender;
        for (const file of prerender.prerenderLegalPages(template)) {
          const target = resolve(outDir, file.fileName);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.html);
        }
        this.info(`prerendered ${prerender.PRERENDERED_LEGAL_PAGES.length} legal pages`);
      } finally {
        await loader.close();
      }
    }
  };
}
