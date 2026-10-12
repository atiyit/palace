import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localRoot = fileURLToPath(new URL("./", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  root: localRoot,
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  plugins: [react()],
  appType: "spa",
  define: { "import.meta.env.VITE_PALACE_LOCAL": JSON.stringify("true") },
  resolve: {
    alias: [
      { find: /^@\/app\/chatgpt-auth$/, replacement: fileURLToPath(new URL("./auth.ts", import.meta.url)) },
      { find: "cloudflare:workers", replacement: fileURLToPath(new URL("./runtime.ts", import.meta.url)) },
      { find: "@", replacement: projectRoot },
    ],
  },
  optimizeDeps: { exclude: ["node:sqlite"] },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1"],
    middlewareMode: true,
    fs: {
      allow: [projectRoot],
      deny: [
        "**/.git/**", "**/.env*", "**/.dev.vars*", "**/*.{crt,pem,key}",
        "**/.palace*/**", "**/.sites-runtime/**", "**/.wrangler/**", "**/*.sqlite*",
        "**/local/runtime.ts", "**/local/storage.ts", "**/local/auth.ts", "**/local/bootstrap.mjs",
      ],
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist-local/client", import.meta.url)),
    emptyOutDir: true,
  },
});
