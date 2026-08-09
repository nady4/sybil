import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          KEYS_ENC_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          BOOTSTRAP_KEY: "dev-bootstrap",
          ADMIN_TOKEN: "test-admin",
          CLERK_WEBHOOK_SECRET: "whsec_devsecret0123456789",
          STRIPE_WEBHOOK_SECRET: "whsec_stripe_mock_0123456789",
          STRIPE_PRICE_INDIE: "price_indie_test",
          STRIPE_PRICE_TEAM: "price_team_test",
          STRIPE_PRICE_ENTERPRISE: "price_ent_test",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
