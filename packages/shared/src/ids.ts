/**
 * ID generation. Workers have Web Crypto; never use Math.random for IDs.
 */
const HEX = "0123456789abcdef";

export function id(prefix: string, bytes = 9): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += HEX.charAt(buf[i]! & 0x0f) + HEX.charAt(buf[i]! >> 4);
  return `${prefix}_${out}`;
}

export function sha256Hex(input: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then((h) =>
    Array.from(new Uint8Array(h))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

/** Deterministic short hash for KV cache keys. */
export async function stableHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
