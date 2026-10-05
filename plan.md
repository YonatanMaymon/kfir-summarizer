# WhatsApp Voice Note Summarizer — Project Plan

## Goal

A personal WhatsApp bot. When I forward a long voice message (mostly from my father, usually in Hebrew) to the bot's number, it replies within about a minute with a short summary of what was said.

This is a personal tool with a single user (me). Keep it simple, cheap and reliable.

## How it works

```
Dad's voice note → I forward it to the bot number (WhatsApp)
        → Meta WhatsApp Cloud API → webhook (our server)
        → download the audio from Meta
        → speech-to-text (Hebrew-capable)
        → LLM summary (Claude API)
        → reply to me on WhatsApp with the summary
```

## Tech choices

- **Runtime / hosting:** Cloudflare Workers (TypeScript). It's free tier, always on (no cold-start sleep like free Render or Heroku), and HTTPS is included.
- **Storage:** Cloudflare KV for deduplication (Meta retries webhooks) and for keeping the last transcript so I can ask for the full text.
- **WhatsApp:** Meta WhatsApp Business **Cloud API**, using Meta's free **test number** at first.
- **Transcription:** OpenAI transcription API (`gpt-4o-transcribe` or `whisper-1`). It supports Hebrew and accepts WhatsApp's `.ogg` (Opus) audio directly. Keep this behind a small interface so it can be swapped later (e.g. Google Speech-to-Text or an ivrit.ai Hebrew model).
- **Summarization:** Anthropic Claude API, via the Messages API, with a current Sonnet model.

> Claude Code: check the current docs for the Meta Graph API version, the OpenAI transcription model names and the Anthropic model names before writing code. Don't rely on memory for version strings.

## Phase 0: Manual setup (I do this, Claude Code guides me)

1. Create a Meta developer account at developers.facebook.com.
2. Create an app (type: Business) and add the **WhatsApp** product. This creates a Meta Business portfolio and a free **test phone number**.
3. In WhatsApp > API Setup:
   - Note the **Phone Number ID** and the **WhatsApp Business Account ID**.
   - Add **my personal number** as an allowed recipient and verify it with the code WhatsApp sends.
4. Create a **permanent access token**: Business Settings > Users > System Users > add a system user with admin role > assign the app and the WhatsApp account > generate a token with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. (The temporary token on the API Setup page expires after 24 hours.)
5. Copy the **App Secret** (App settings > Basic). It's used to verify webhook signatures.
6. Get an **OpenAI API key** and an **Anthropic API key**.
7. Create a free Cloudflare account and install Wrangler (`npm i -g wrangler`, then `wrangler login`).

## Phase 1: Scaffold

- `npm create cloudflare@latest` → a "Hello World" Worker in TypeScript.
- Create a KV namespace `VOICE_KV` and bind it in `wrangler.toml`.
- Secrets (set with `wrangler secret put`, never committed):

| Name | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Permanent system-user access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Bot's phone number ID (for sending) |
| `WHATSAPP_APP_SECRET` | Verifies the `X-Hub-Signature-256` header |
| `WEBHOOK_VERIFY_TOKEN` | Any random string I choose; used in the webhook handshake |
| `ALLOWED_SENDERS` | Comma-separated phone numbers (international format, no `+`) the bot will respond to — just mine |
| `OPENAI_API_KEY` | Transcription |
| `ANTHROPIC_API_KEY` | Summarization |
| `SUMMARY_LANGUAGE` | Language for summaries, e.g. `English` or `Hebrew` (plain var, not secret) |

- Add `.dev.vars.example` listing these names with no values, and a `README.md` with setup and deploy steps.

## Phase 2: Webhook endpoint

Single route `/webhook`:

- **GET (verification handshake):** if `hub.mode === "subscribe"` and `hub.verify_token === WEBHOOK_VERIFY_TOKEN`, return `hub.challenge` as plain text with 200. Otherwise return 403.
- **POST (incoming events):**
  1. Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `WHATSAPP_APP_SECRET`). Reject with 401 on mismatch.
  2. Parse `entry[].changes[].value.messages[]`. Ignore `statuses` events (delivery receipts).
  3. Ignore any sender not in `ALLOWED_SENDERS`.
  4. **Return 200 immediately** and do the slow work in `ctx.waitUntil(...)`. Meta expects a fast response and retries otherwise.
  5. Dedupe by message `id` in KV (TTL about 24h). Skip if already seen.

Message handling:
- `type === "audio"` (forwarded voice notes arrive like this, possibly with `context.forwarded: true`) → run the voice pipeline.
- `type === "text"`:
  - `full` / `מלא` → reply with the full transcript of the last voice note (stored in KV).
  - `help` → reply with short usage instructions.
  - Anything else → reply with a short hint ("Forward me a voice message and I'll summarize it").
- Other types → reply that only voice messages are supported.

## Phase 3: Voice pipeline

1. **Acknowledge** right away if useful, for example by marking the message as read (`POST /{PHONE_NUMBER_ID}/messages` with `status: "read"`). A "⏳ working on it" reply is optional; skip it if it adds noise.
2. **Get the media URL:** `GET https://graph.facebook.com/{version}/{audio.id}` with a Bearer token → returns `url`.
3. **Download the audio:** `GET {url}` with the same Bearer token → binary `.ogg` (Opus). The URL expires within minutes, so download immediately.
4. **Transcribe:** send to the OpenAI transcriptions endpoint as multipart form data (file name `voice.ogg`). Pass `language: "he"` as a hint, but allow auto-detect since Dad sometimes mixes languages. Respect the 25 MB limit; if exceeded, reply with a clear error.
5. **Summarize** with Claude (see the prompt below).
6. **Store** the transcript in KV under `last_transcript:{sender}` (TTL about 7 days).
7. **Reply** to the sender: `POST /{PHONE_NUMBER_ID}/messages` with a `text` body, quoting the original voice note via `context.message_id` so it's clear which message the summary belongs to.

Error handling: if any step fails, log it and reply with a short message such as "Couldn't process that voice note (transcription failed). Try again?" Never fail silently.

## Phase 4: Summary prompt

System prompt (roughly):

> You summarize voice messages that a father sent to his adult son. The transcript may be in Hebrew, contain transcription errors, and ramble. Write the summary in {SUMMARY_LANGUAGE}.
>
> Format:
> - One-line gist.
> - 2–5 short bullets with the actual content (news, requests, plans, dates, times, names, amounts).
> - A final line "❓ Needs your reply:" listing direct questions or requests, if any. Omit this line if there are none.
>
> Keep it under about 80 words. Don't add anything that wasn't said. Keep names and numbers exactly. If the transcript is very short, just give the gist.

Include the voice note length in seconds in the reply header, e.g. `🎙️ 3:42 → summary`, so I can see how much time it saved.

WhatsApp text limit is 4096 characters. Truncate the `full` transcript replies and split them into several messages if needed.

## Phase 5: Deploy and connect

1. `wrangler deploy` → note the Worker URL.
2. In the Meta app: WhatsApp > Configuration > Webhook → callback URL `https://<worker>/webhook`, verify token = `WEBHOOK_VERIFY_TOKEN` → Verify and save.
3. Subscribe to the **messages** webhook field.
4. Save the test number in my phone's contacts as "Dad Summarizer" or similar.

## Phase 6: Testing

- **Unit tests** (Vitest): signature verification, payload parsing (audio / text / status events), allowlist, dedupe, message splitting.
- Keep **sample webhook payloads** in `test/fixtures/`.
- **Local testing:** `wrangler dev` plus a tunnel (`cloudflared tunnel`) to receive real webhooks before deploying.
- **End-to-end:** forward a real Hebrew voice note → a summary arrives in under about 60 seconds → `full` returns the transcript.

## Acceptance criteria

- [ ] Forwarding a 3–5 minute Hebrew voice note returns a summary in under 60 seconds.
- [ ] Messages from numbers not in `ALLOWED_SENDERS` are ignored.
- [ ] Duplicate webhook deliveries don't produce duplicate replies.
- [ ] Invalid signatures are rejected.
- [ ] `full` returns the last transcript.
- [ ] No secrets in the repo.
- [ ] README explains setup, deploy, and how to rotate the token.

## Costs (rough)

- Cloudflare Workers + KV: free tier.
- WhatsApp: replying within 24 hours of a message I sent to the bot is free.
- Transcription: about a cent or less per minute of audio.
- Claude summary: a fraction of a cent per message.

## Later ideas (not in v1)

- Move from the test number to a real number (prepaid SIM or business landline) if I want others to use it.
- Daily digest of all of Dad's voice notes.
- Auto-detect and reply in the language of the voice note.
- Reuse the same pipeline for guest voice messages at the guesthouse.
