import { describe, expect, it } from "vitest";
import audioFixture from "./fixtures/audio-forwarded.json";
import imageFixture from "./fixtures/image.json";
import statusFixture from "./fixtures/status.json";
import textFixture from "./fixtures/text-full.json";
import { oggOpusDurationSeconds } from "../src/ogg";
import { verifySignature } from "../src/signature";
import { markSeen, wasSeen } from "../src/store";
import { formatDuration, splitMessage } from "../src/text";
import { extractMessages, isAllowedSender, parseAllowedSenders } from "../src/webhook";
import { concat, FakeKV, oggPage, opusHead, signBody } from "./helpers";

describe("verifySignature", () => {
  const body = JSON.stringify(audioFixture);
  const bytes = new TextEncoder().encode(body);

  it("accepts a correct signature", async () => {
    expect(await verifySignature(bytes, await signBody(body, "secret"), "secret")).toBe(true);
  });

  it("rejects a signature made with another secret", async () => {
    expect(await verifySignature(bytes, await signBody(body, "other"), "secret")).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await signBody(body, "secret");
    expect(await verifySignature(new TextEncoder().encode(body + " "), sig, "secret")).toBe(false);
  });

  it("rejects missing or malformed headers", async () => {
    expect(await verifySignature(bytes, null, "secret")).toBe(false);
    expect(await verifySignature(bytes, "sha1=abcd", "secret")).toBe(false);
    expect(await verifySignature(bytes, "sha256=nothex", "secret")).toBe(false);
  });
});

describe("extractMessages", () => {
  it("parses a forwarded voice note", () => {
    expect(extractMessages(audioFixture)).toEqual([
      { kind: "audio", id: "wamid.AUDIO1", from: "972501234567", mediaId: "1003383421387256", forwarded: true },
    ]);
  });

  it("parses a text message", () => {
    expect(extractMessages(textFixture)).toEqual([
      { kind: "text", id: "wamid.TEXT1", from: "972501234567", text: "full" },
    ]);
  });

  it("ignores status events", () => {
    expect(extractMessages(statusFixture)).toEqual([]);
  });

  it("marks other message types", () => {
    expect(extractMessages(imageFixture)).toEqual([
      { kind: "other", id: "wamid.IMAGE1", from: "972501234567", type: "image" },
    ]);
  });

  it("tolerates junk", () => {
    expect(extractMessages(null)).toEqual([]);
    expect(extractMessages({ entry: [{ changes: [{ value: { messages: [{}] } }] }] })).toEqual([]);
  });
});

describe("allowlist", () => {
  const allowed = parseAllowedSenders("+972 50-123-4567, 15551234567,");

  it("normalizes formatting", () => {
    expect([...allowed]).toEqual(["972501234567", "15551234567"]);
    expect(isAllowedSender("972501234567", allowed)).toBe(true);
  });

  it("rejects other numbers", () => {
    expect(isAllowedSender("972509999999", allowed)).toBe(false);
  });

  it("allows nobody when unset", () => {
    expect(isAllowedSender("972501234567", parseAllowedSenders(""))).toBe(false);
    expect(isAllowedSender("972501234567", parseAllowedSenders(undefined))).toBe(false);
  });
});

describe("dedupe", () => {
  it("remembers seen message ids", async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    expect(await wasSeen(kv, "wamid.1")).toBe(false);
    await markSeen(kv, "wamid.1");
    expect(await wasSeen(kv, "wamid.1")).toBe(true);
    expect(await wasSeen(kv, "wamid.2")).toBe(false);
  });
});

describe("splitMessage", () => {
  it("leaves short text alone", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits on word boundaries within the limit", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const parts = splitMessage(words, 60, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(60);
      expect(p).not.toMatch(/^\s|\s$/);
    }
    expect(parts.join(" ")).toBe(words);
  });

  it("hard-cuts text with no spaces", () => {
    const parts = splitMessage("x".repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  it("truncates beyond maxParts", () => {
    const parts = splitMessage("y ".repeat(1000), 100, 3);
    expect(parts).toHaveLength(3);
    expect(parts[2].endsWith("…(truncated)")).toBe(true);
    expect(parts[2].length).toBeLessThanOrEqual(100);
  });

  it("keeps every part within WhatsApp's limit by default", () => {
    const parts = splitMessage("שלום עולם ".repeat(2000));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(222)).toBe("3:42");
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});

describe("oggOpusDurationSeconds", () => {
  it("reads the last granule minus pre-skip", () => {
    const file = concat(
      oggPage(0n, opusHead(312), 2),
      oggPage(0n, new TextEncoder().encode("OpusTags")),
      oggPage(48000n * 100n + 312n, new Uint8Array(500)),
      oggPage(48000n * 222n + 312n, new Uint8Array(300), 4),
    );
    expect(oggOpusDurationSeconds(file)).toBe(222);
  });

  it("skips trailing pages without a granule", () => {
    const file = concat(
      oggPage(0n, opusHead(0), 2),
      oggPage(48000n * 10n, new Uint8Array(100)),
      oggPage(-1n, new Uint8Array(100)),
    );
    expect(oggOpusDurationSeconds(file)).toBe(10);
  });

  it("returns null for non-Ogg data", () => {
    expect(oggOpusDurationSeconds(new Uint8Array(100))).toBeNull();
    const noHead = concat(oggPage(0n, new Uint8Array(40)), oggPage(48000n, new Uint8Array(10)));
    expect(oggOpusDurationSeconds(noHead)).toBeNull();
  });
});
