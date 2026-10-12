import vinext from "vinext";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { sites } from "./build/sites-vite-plugin";
import { connectorPreview } from "./build/connector-preview-plugin.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

function readHostingBindings(): { d1?: string; r2?: string } {
  let serialized: string;
  try { serialized = readFileSync(new URL("./.openai/hosting.json", import.meta.url), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { d1: "DB", r2: "BUCKET" };
    throw new Error("Unable to read optional hosting configuration.");
  }
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new Error("Optional hosting configuration must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Optional hosting configuration must be an object.");
  const input = value as Record<string, unknown>;
  const bindings: { d1?: string; r2?: string } = {};
  for (const kind of ["d1", "r2"] as const) {
    const name = input[kind];
    if (name === undefined || name === null || name === "") continue;
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Optional hosting binding names must be valid identifiers.");
    bindings[kind] = name;
  }
  return bindings;
}

const { d1, r2 } = readHostingBindings();

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "./build/sites-worker.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux }),
      connectorPreview(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: {
          ...localBindingConfig,
          // Development-only injection from the preview process; never written to
          // a vars file or included in a production build. Hosted secrets are
          // configured through Sites environment variables.
          ...(command === "serve" && process.env.PALACE_PREVIEW_LLM_KEY
            ? { vars: {
                LLM_API_KEY: process.env.PALACE_PREVIEW_LLM_KEY,
                LLM_BASE_URL: process.env.PALACE_PREVIEW_LLM_BASE_URL || "https://api.example.com/v1",
                LLM_MODEL: process.env.PALACE_PREVIEW_LLM_MODEL || "claude-opus-4-6",
                IMAGE_MODEL: process.env.PALACE_PREVIEW_IMAGE_MODEL || "nai-diffusion-5-full",
                ...(process.env.PALACE_PREVIEW_SETTINGS_SECRET
                  ? { PROVIDER_SETTINGS_SECRET: process.env.PALACE_PREVIEW_SETTINGS_SECRET }
                  : {}),
              } }
            : {}),
          ...(command === "serve"
            ? {
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(command === "serve"
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./build/connector-preview-worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
