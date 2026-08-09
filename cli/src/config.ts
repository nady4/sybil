import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckDefinition } from "@agentsre/sdk";

export interface ProjectConfig {
  checks: CheckDefinition[];
}

function parseConfigText(text: string, file: string): ProjectConfig {
  if (file.endsWith(".json")) {
    return JSON.parse(text) as ProjectConfig;
  }
  // .mjs / .ts: evaluate the module and read its default export.
  const module = { exports: {} as Record<string, unknown> };
  const fn = new Function("module", "exports", "require", text);
  fn(module, module.exports, (id: string) => {
    if (id === "@agentsre/sdk") {
      return { defineCheck: (d: CheckDefinition) => d };
    }
    throw new Error(`agentsre.config: cannot require "${id}" — import from '@agentsre/sdk' only`);
  });
  const exported = (module.exports.default ?? module.exports) as ProjectConfig;
  if (!Array.isArray(exported.checks)) {
    throw new Error(`agentsre.config: expected default export with { checks: [...] }`);
  }
  return exported;
}

const CANDIDATES = ["agentsre.config.json", "agentsre.config.mjs", "agentsre.config.ts"];

export function loadProjectConfig(): ProjectConfig {
  for (const name of CANDIDATES) {
    const file = resolve(name);
    if (existsSync(file)) {
      return parseConfigText(readFileSync(file, "utf8"), file);
    }
  }
  throw new Error(
    "no agentsre.config.json / .mjs / .ts found. Run `agentsre init` to scaffold one.",
  );
}

export const INIT_CONFIG = `{
  "checks": [
    {
      "featureId": "checkout",
      "name": "checkout-works",
      "prompt": "Visit the checkout page and verify a guest can complete a single-item order.",
      "target": "https://shop.example.com/checkout",
      "allowedDomains": ["shop.example.com"],
      "successCriteria": [
        {
          "name": "order-confirmed",
          "assertion": { "type": "exact", "expected": "Order confirmed" }
        }
      ],
      "intervalMinutes": 15,
      "model": "gpt-4o-mini"
    }
  ]
}
`;
