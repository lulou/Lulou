import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execSync } from "child_process";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    // All Replit-specific plugins are gated on REPL_ID so a Vercel / CI build
    // (where REPL_ID is undefined) never tries to load them.
    ...(process.env.REPL_ID !== undefined
      ? [
          runtimeErrorOverlay(),
          ...(process.env.NODE_ENV !== "production"
            ? [
                await import("@replit/vite-plugin-cartographer").then((m) =>
                  m.cartographer(),
                ),
                await import("@replit/vite-plugin-dev-banner").then((m) =>
                  m.devBanner(),
                ),
              ]
            : []),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Manual chunk splitting — prevents all vendor code landing in one
         * 557 kB index.js that blocks first paint on every visit.
         *
         * Strategy:
         *   vendor-react    — React + ReactDOM + scheduler (~45 kB gz)
         *                     Smallest, parsed first, almost never changes.
         *   vendor-supabase — @supabase/* (~80 kB gz)
         *                     Largest single vendor. Separate chunk means the
         *                     browser caches it across every app deployment.
         *   vendor-query    — @tanstack/react-query (~15 kB gz)
         *   vendor-radix    — All @radix-ui/* primitives (~25 kB gz)
         *
         * On first visit:  same total bytes, but browser downloads all 4 in
         *                  parallel over HTTP/2 and can start parsing each as
         *                  it arrives (vs waiting for the entire 557 kB blob).
         * On repeat visits: all 4 vendor chunks are served from browser cache —
         *                  only the hashed app-code chunks are re-fetched.
         */
        manualChunks(id) {
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          if (
            id.includes("node_modules/@supabase/") ||
            id.includes("node_modules/realtime-js/")
          ) {
            return "vendor-supabase";
          }
          if (id.includes("node_modules/@tanstack/")) {
            return "vendor-query";
          }
          if (id.includes("node_modules/@radix-ui/")) {
            return "vendor-radix";
          }
        },
      },
    },
  },
  // Expose both VITE_ (standard) and vite_ (lowercase) prefixed variables.
  // Vercel sometimes stores env var names in lowercase; this ensures both
  // VITE_SUPABASE_URL and vite_supabase_url are visible in import.meta.env.
  define: (() => {
    let commitHash = "dev";
    try { commitHash = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim(); } catch {}
    return {
      __COMMIT_HASH__: JSON.stringify(commitHash),
      __BUILD_TIME__:  JSON.stringify(new Date().toISOString()),
    };
  })(),
  envPrefix: ["VITE_", "vite_"],
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
