import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Node-side global setup: boots the mock OpenAI-compatible server so the
 * workflow tests can run the synthetic runner against a real HTTP target.
 * The pool's global setup runs in Node (not workerd), so child_process
 * and fs work here.
 */
let server: ReturnType<typeof spawn> | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  const mockPath = fileURLToPath(new URL("../../../scripts/mock-openai.mjs", import.meta.url));
  server = spawn(process.execPath, [mockPath], {
    env: { ...process.env, PORT: "8786" },
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch("http://127.0.0.1:8786/page");
        if (res.ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error("mock-openai did not start"));
      setTimeout(poll, 250);
    };
    void poll();
  });
  return async () => {
    server?.kill();
  };
}
