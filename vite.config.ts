import { defineConfig, type Plugin } from "vite";

/**
 * Dev-server only. Must never run during `vite build` / Electron production:
 * contextBridge exposes read-only `window.creator`; the web-dev stub assignment
 * throws and blanks the entire renderer (C2.1 white screen).
 */
function webDevEntryPlugin(): Plugin {
  return {
    name: "rpa-web-dev-entry",
    apply: "serve",
    transformIndexHtml(html, ctx) {
      if (!ctx.server) return html;
      return html
        .replace(
          "connect-src 'none'",
          "connect-src 'self' ws: wss: http: https:",
        )
        .replace(
          '<script type="module" src="/main.tsx"></script>',
          '<script type="module" src="/web-dev-bootstrap.ts"></script>',
        );
    },
    transform(code, id) {
      // Keep stub installed across Vite HMR re-evaluations of draft.ts.
      if (!id.replace(/\\/g, "/").endsWith("/renderer/draft.ts")) return;
      if (code.includes("installWebCreatorStub")) return;
      return {
        code: `import { installWebCreatorStub } from "./web-dev-stub";\ninstallWebCreatorStub();\n${code}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  // The preserved experiment has its own node_modules. Force its components to
  // use Creator's React instance so hooks share the renderer root dispatcher.
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "../../dist/renderer", emptyOutDir: false },
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  plugins: [webDevEntryPlugin()],
});
