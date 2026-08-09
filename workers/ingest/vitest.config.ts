import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        workers: [
          {
            name: "agentsre-scheduler",
            modules: true,
            scriptPath: "./test/scheduler-stub.ts",
            compatibilityDate: "2026-08-08",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["miniflare", "chalk"],
        },
      },
    },
  },
});
