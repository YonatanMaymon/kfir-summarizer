import type { Env } from "../src/env";
import type { IncomingMessage } from "../src/webhook";

/** Minimal in-memory stand-in for a KV namespace (get/put only). */
export class FakeKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

export class FakeQueue {
  sent: IncomingMessage[] = [];
  async send(msg: IncomingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const kv = new FakeKV();
  const queue = new FakeQueue();
  const env = {
    VOICE_KV: kv as unknown as KVNamespace,
    VOICE_QUEUE: queue as unknown as Queue<IncomingMessage>,
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
    WHATSAPP_APP_SECRET: "app-secret",
    WEBHOOK_VERIFY_TOKEN: "verify-me",
    ALLOWED_SENDERS: "+972 50-123-4567",
    OPENAI_API_KEY: "openai-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    SUMMARY_LANGUAGE: "English",
    TRANSCRIBE_LANGUAGE: "he",
    ...overrides,
  } satisfies Env;
  return { env, kv, queue };
}

export async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds one Ogg page (CRC left as zero — the duration parser doesn't check it). */
export function oggPage(granule: bigint, payload: Uint8Array, headerType = 0): Uint8Array {
  const segments: number[] = [];
  let left = payload.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);

  const page = new Uint8Array(27 + segments.length + payload.length);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = headerType;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, 1234, true); // serial
  page[26] = segments.length;
  page.set(segments, 27);
  page.set(payload, 27 + segments.length);
  return page;
}

export function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // channels
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, 48000, true);
  return head;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
