import type { Env } from "./env";
import { handleMessage } from "./pipeline";
import { verifySignature } from "./signature";
import { markSeen, wasSeen } from "./store";
import { extractMessages, isAllowedSender, parseAllowedSenders, type IncomingMessage } from "./webhook";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/privacy") return privacyPolicy();
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    if (request.method === "GET") return handleVerification(url, env);
    if (request.method === "POST") return handleEvent(request, env);
    return new Response("Method not allowed", { status: 405 });
  },

  /** Runs the slow work (download → transcribe → summarize → reply) off the webhook path. */
  async queue(batch: MessageBatch<IncomingMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      // handleMessage reports its own failures to the user; anything that still
      // throws here is retried by the queue (max_retries in wrangler.toml).
      await handleMessage(env, message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, IncomingMessage>;

/** Meta requires a privacy policy URL before the app can be published. */
function privacyPolicy(): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>Privacy Policy</h1>
<p>This is a private, single-user bot. It only processes WhatsApp messages from its owner's own phone number; messages from anyone else are ignored and not stored.</p>
<p>Voice messages sent to the bot are transcribed by OpenAI and summarized by Anthropic, then the summary is sent back on WhatsApp. The latest transcript is kept for up to 7 days so it can be requested again, then deleted automatically. Nothing is sold or shared with anyone else.</p>
<p>To have any data deleted sooner, contact the owner of this bot.</p>
</body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Meta's subscription handshake: echo hub.challenge if the verify token matches. */
function handleVerification(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && env.WEBHOOK_VERIFY_TOKEN && token === env.WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  const valid = await verifySignature(raw, request.headers.get("X-Hub-Signature-256"), env.WHATSAPP_APP_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const allowed = parseAllowedSenders(env.ALLOWED_SENDERS);
  for (const msg of extractMessages(payload)) {
    if (!isAllowedSender(msg.from, allowed)) {
      console.log("ignoring message from non-allowed sender");
      continue;
    }
    if (await wasSeen(env.VOICE_KV, msg.id)) continue;

    // Enqueueing is fast, so we still answer Meta quickly. If it throws, the 500
    // makes Meta retry, and the message isn't marked seen yet.
    await env.VOICE_QUEUE.send(msg);
    await markSeen(env.VOICE_KV, msg.id);
  }
  return new Response("OK", { status: 200 });
}
