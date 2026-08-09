import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          KEYS_ENC_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          ADMIN_TOKEN: "test-admin",
          OPENAI_BASE_URL: "http://127.0.0.1:8786",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
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
