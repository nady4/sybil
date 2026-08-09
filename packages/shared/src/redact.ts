/**
 * PII redaction for stored agent step I/O. Applied at write time so raw
 * prompt/tool payloads never hit D1. The postmortem content engine reads
 * from the same redacted store — this is the ethical floor for that too.
 */

const DEFAULT_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: "api-key", re: /\b(?:sk|rk|pk|ak|ars_)-?[A-Za-z0-9_-]{16,}\b/g, replacement: "[API_KEY]" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, replacement: "Bearer [TOKEN]" },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL]" },
  { name: "phone", re: /\b(?:\+?\d{1,3}[-. ]?)?\(?\d{2,4}\)?[-. ]?\d{3,4}[-. ]?\d{3,4}\b/g, replacement: "[PHONE]" },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[CARD]" },
  { name: "ip", re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[IP]" },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS_KEY]" },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[GH_TOKEN]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[JWT]" },
];

export function redactText(
  text: string,
  extraPatterns: string[] = [],
): string {
  let out = text;
  const compiled: RegExp[] = [];
  for (const p of extraPatterns) {
    try {
      compiled.push(new RegExp(p, "g"));
    } catch {
      // Invalid customer-provided rule: skip silently.
    }
  }
  for (const { re, replacement } of DEFAULT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  for (const re of compiled) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function redactValue(value: unknown, extraPatterns: string[] = []): unknown {
  if (typeof value === "string") return redactText(value, extraPatterns);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extraPatterns));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      out[k] =
        lk.includes("key") || lk.includes("token") || lk.includes("secret") || lk.includes("authorization") || lk === "auth"
          ? "[REDACTED]"
          : redactValue(v, extraPatterns);
    }
    return out;
  }
  return value;
}
