#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "@agentsre/sdk";
import { defaultBaseUrl, loadAuth, saveAuth } from "./auth.js";
import { INIT_CONFIG, loadProjectConfig } from "./config.js";
import { importHelicone } from "./import-helicone.js";

const COMMANDS = ["init", "login", "deploy", "status", "runs", "alerts", "skill", "import-helicone", "help"] as const;

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function client(): Client {
  const auth = loadAuth();
  if (!auth) {
    console.error("not logged in. Run: agentsre login");
    process.exit(1);
  }
  return new Client({ baseUrl: auth.baseUrl, apiKey: auth.apiKey });
}

async function cmdInit(): Promise<void> {
  const { writeFileSync, existsSync } = await import("node:fs");
  if (existsSync("agentsre.config.json")) {
    console.log("agentsre.config.json already exists — leaving it alone.");
    return;
  }
  writeFileSync("agentsre.config.json", INIT_CONFIG);
  console.log("created agentsre.config.json — edit it, then run `agentsre deploy`.");
}

async function cmdLogin(): Promise<void> {
  const baseUrl = (await prompt(`API base URL [${defaultBaseUrl()}]: `)) || defaultBaseUrl();
  const apiKey = await prompt("API key: ");
  if (!apiKey) {
    console.error("api key required");
    process.exit(1);
  }
  saveAuth({ baseUrl, apiKey });
  console.log("saved credentials to ~/.agentsre.json");
}

async function cmdDeploy(): Promise<void> {
  const config = loadProjectConfig();
  const c = client();
  for (const def of config.checks) {
    const check = await c.deployCheck(def);
    console.log(`deployed "${check.name}" (${check.id}) — every ${check.intervalMinutes}m`);
  }
  console.log(`${config.checks.length} check(s) deployed.`);
}

async function cmdStatus(): Promise<void> {
  const c = client();
  const { checks } = await c.checksList();
  const { openAlerts, runsToday, successRate, costTodayUsd } = await c.summary();
  console.log(`open alerts: ${openAlerts} | runs today: ${runsToday} | success rate: ${successRate === null ? "-" : (successRate * 100).toFixed(1) + "%"} | cost today: $${costTodayUsd.toFixed(4)}`);
  for (const check of checks) {
    const state = check.enabled ? (check.lastRunAt ? `last run ${check.lastRunAt.slice(0, 16)}` : "never run") : "disabled";
    console.log(`  ${check.enabled ? "✓" : "·"} ${check.name} [${check.featureId}] ${state}`);
  }
}

async function cmdRuns(): Promise<void> {
  const c = client();
  const { runs } = await c.runsList({ limit: 20 });
  for (const run of runs as unknown as Array<Record<string, unknown>>) {
    const started = String(run.started_at ?? "");
    const score = run.eval_score !== undefined && run.eval_score !== null ? ` score=${Number(run.eval_score).toFixed(2)}` : "";
    const cost = run.cost_usd !== undefined && run.cost_usd !== null ? ` cost=$${Number(run.cost_usd).toFixed(4)}` : "";
    console.log(
      `${started.slice(0, 16)} ${String(run.source).padEnd(10)} ${String(run.status).padEnd(8)} ${String(run.feature_id).padEnd(20)} ${run.model ?? "-"}${score}${cost}`,
    );
  }
}

async function cmdAlerts(): Promise<void> {
  const c = client();
  const { alerts } = await c.alertsList("open");
  if (alerts.length === 0) {
    console.log("no open alerts. 🎉");
    return;
  }
  for (const a of alerts) {
    console.log(`${a.openedAt.slice(0, 16)} [${a.severity}] ${a.featureId} ${a.type}: ${a.message}`);
  }
}

async function cmdSkill(): Promise<void> {
  const { generateSkillMd } = await import("@agentsre/sdk");
  const auth = loadAuth();
  if (!auth) {
    console.error("not logged in. Run: agentsre login");
    process.exit(1);
  }
  console.log(generateSkillMd({ baseUrl: auth.baseUrl, apiKey: auth.apiKey }));
}

async function cmdImportHelicone(): Promise<void> {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: agentsre import-helicone <export.jsonl|export.csv> [--feature <featureId>]");
    process.exit(1);
  }
  const featureArg = process.argv.findIndex((a) => a === "--feature");
  const featureId = featureArg !== -1 && process.argv[featureArg + 1] ? process.argv[featureArg + 1]! : "helicone-import";
  await importHelicone(client(), file, featureId);
}

const HELP = `agentsre — Agent SRE CLI

usage: agentsre <command>

commands:
  init     scaffold agentsre.config.json
  login    store your API key (~/.agentsre.json)
  deploy   upsert checks from agentsre.config.{json,mjs,ts}
  status   org summary + check states
  runs     recent 20 runs
  alerts   open alerts
  import-helicone <file> [--feature <id>]
           replay a Helicone JSONL/CSV export as production runs
  skill    print the Agent Skills file for Claude Code / Cursor
  help     this message
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  if (!COMMANDS.includes(cmd as (typeof COMMANDS)[number])) {
    console.error(`unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
  switch (cmd) {
    case "init": return cmdInit();
    case "login": return cmdLogin();
    case "deploy": return cmdDeploy();
    case "status": return cmdStatus();
    case "runs": return cmdRuns();
    case "alerts": return cmdAlerts();
    case "skill": return cmdSkill();
    case "import-helicone": return cmdImportHelicone();
    case "help": console.log(HELP); return;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
