import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import audioFixture from "./fixtures/audio-forwarded.json";
import statusFixture from "./fixtures/status.json";
import worker from "../src/index";
import { handleMessage } from "../src/pipeline";
import { concat, makeEnv, oggPage, opusHead, signBody } from "./helpers";

vi.mock("../src/summarize", () => ({
  summarize: vi.fn(async () => "Dad is coming Friday at 18:00.\n❓ Needs your reply: can you pick him up?"),
}));

const BASE = "https://bot.example.workers.dev";

async function post(env: ReturnType<typeof makeEnv>["env"], payload: unknown, secret = env.WHATSAPP_APP_SECRET) {
  const body = JSON.stringify(payload);
  const request = new Request(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": await signBody(body, secret) },
    body,
  });
  return worker.fetch(request, env);
}

describe("GET /webhook (verification)", () => {
  it("echoes the challenge with the right token", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("rejects a wrong token", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /webhook", () => {
  it("rejects an invalid signature", async () => {
    const { env, queue } = makeEnv();
    const res = await post(env, audioFixture, "wrong-secret");
    expect(res.status).toBe(401);
    expect(queue.sent).toEqual([]);
  });

  it("queues a voice note from an allowed sender", async () => {
    const { env, queue } = makeEnv();
    const res = await post(env, audioFixture);
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([
      { kind: "audio", id: "wamid.AUDIO1", from: "972501234567", mediaId: "1003383421387256", forwarded: true },
    ]);
  });

  it("ignores senders not on the allowlist", async () => {
    const { env, queue } = makeEnv({ ALLOWED_SENDERS: "15550000000" });
    const res = await post(env, audioFixture);
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([]);
  });

  it("doesn't queue duplicate deliveries", async () => {
    const { env, queue } = makeEnv();
    await post(env, audioFixture);
    await post(env, audioFixture);
    expect(queue.sent).toHaveLength(1);
  });

  it("ignores status events", async () => {
    const { env, queue } = makeEnv();
    const res = await post(env, statusFixture);
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([]);
  });

  it("returns 404 for other paths", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(`${BASE}/`), env);
    expect(res.status).toBe(404);
  });
});

describe("pipeline", () => {
  let calls: { url: string; init?: RequestInit }[];
  let sentTexts: { to: string; body: string; replyTo?: string }[];

  function mockFetch(handlers: { transcription?: () => Response; audio?: Uint8Array } = {}) {
    const audio =
      handlers.audio ??
      concat(oggPage(0n, opusHead(312), 2), oggPage(48000n * 222n + 312n, new Uint8Array(200), 4));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/messages")) {
          const body = JSON.parse(String(init?.body));
          if (body.type === "text") {
            sentTexts.push({ to: body.to, body: body.text.body, replyTo: body.context?.message_id });
          }
          return Response.json({ messages: [{ id: "wamid.OUT" }] });
        }
        if (url.includes("/1003383421387256")) {
          return Response.json({ url: "https://lookaside.example/media", mime_type: "audio/ogg; codecs=opus", file_size: audio.length });
        }
        if (url === "https://lookaside.example/media") return new Response(audio);
        if (url.includes("api.openai.com")) {
          return handlers.transcription?.() ?? Response.json({ text: "אבא מגיע ביום שישי בשש" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  beforeEach(() => {
    calls = [];
    sentTexts = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transcribes, stores, summarizes and replies to a voice note", async () => {
    const { env, kv } = makeEnv();
    mockFetch();
    await handleMessage(env, { kind: "audio", id: "wamid.AUDIO1", from: "972501234567", mediaId: "1003383421387256", forwarded: true });

    expect(kv.store.get("last_transcript:972501234567")).toBe("אבא מגיע ביום שישי בשש");
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0].replyTo).toBe("wamid.AUDIO1");
    expect(sentTexts[0].body).toMatch(/^🎙️ 3:42 → summary\n\nDad is coming Friday/);

    const openai = calls.find((c) => c.url.includes("api.openai.com"))!;
    const form = openai.init!.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("he");
    expect((form.get("file") as File).name).toBe("voice.ogg");
  });

  it("replies with an error when transcription fails", async () => {
    const { env } = makeEnv();
    mockFetch({ transcription: () => new Response("boom", { status: 500 }) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handleMessage(env, { kind: "audio", id: "wamid.AUDIO1", from: "972501234567", mediaId: "1003383421387256", forwarded: false });

    expect(sentTexts).toEqual([
      { to: "972501234567", body: "Couldn't process that voice note (transcription failed). Try again?", replyTo: "wamid.AUDIO1" },
    ]);
  });

  it("returns the stored transcript for 'full', split into parts", async () => {
    const { env, kv } = makeEnv();
    kv.store.set("last_transcript:972501234567", "מילה ".repeat(1500));
    mockFetch();
    await handleMessage(env, { kind: "text", id: "wamid.TEXT1", from: "972501234567", text: " מלא " });

    expect(sentTexts.length).toBe(2);
    expect(sentTexts[0].replyTo).toBe("wamid.TEXT1");
    expect(sentTexts[1].replyTo).toBeUndefined();
    for (const t of sentTexts) expect(t.body.length).toBeLessThanOrEqual(4096);
  });

  it("says so when there is no transcript yet", async () => {
    const { env } = makeEnv();
    mockFetch();
    await handleMessage(env, { kind: "text", id: "wamid.TEXT1", from: "972501234567", text: "full" });
    expect(sentTexts[0].body).toMatch(/don't have a recent transcript/);
  });

  it("answers help and other messages", async () => {
    const { env } = makeEnv();
    mockFetch();
    await handleMessage(env, { kind: "text", id: "a", from: "972501234567", text: "Help" });
    await handleMessage(env, { kind: "text", id: "b", from: "972501234567", text: "hi" });
    await handleMessage(env, { kind: "other", id: "c", from: "972501234567", type: "image" });
    expect(sentTexts.map((t) => t.body)).toEqual([
      expect.stringContaining("Commands:"),
      expect.stringContaining("Forward me a voice message"),
      expect.stringContaining("only handle voice messages"),
    ]);
  });
});
