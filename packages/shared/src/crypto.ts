/**
 * AES-256-GCM helpers for customer provider keys. Key is a hex-encoded
 * 32-byte secret (KEYS_ENC_KEY). Ciphertext format: base64(iv || ciphertext).
 */

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptSecret(plain: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const data = new TextEncoder().encode(plain) as Uint8Array<ArrayBuffer>;
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return bytesToB64(out);
}

export async function decryptSecret(cipherB64: string, keyHex: string): Promise<string> {
  const raw = b64ToBytes(cipherB64);
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, ["decrypt"]);
  const iv = raw.slice(0, 12) as Uint8Array<ArrayBuffer>;
  const ct = raw.slice(12) as Uint8Array<ArrayBuffer>;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}
