/**
 * Verifies Meta's `X-Hub-Signature-256` header: "sha256=" + hex HMAC-SHA256 of
 * the raw request body, keyed with the app secret.
 */
export async function verifySignature(
  rawBody: ArrayBuffer | Uint8Array,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // subtle.verify does a constant-time comparison.
  return crypto.subtle.verify("HMAC", key, hexToBytes(match[1]), rawBody);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
