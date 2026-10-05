# kfir-summarizer

A personal WhatsApp bot. Forward it a voice note and it replies with a short summary. Send `full` (or `מלא`) to get the whole transcript of the last voice note.

```
WhatsApp → Meta Cloud API → POST /webhook (Cloudflare Worker)
        → verify signature, check allowlist, dedupe, enqueue → 200
        → queue consumer: download audio → OpenAI gpt-4o-transcribe → Claude summary → reply
```

The webhook enqueues each message on a Cloudflare Queue rather than using `ctx.waitUntil`, because `waitUntil` only gets 30 seconds after the response, which a long voice note can exceed. Queue consumers can run for up to 15 minutes, and Queues is included in the Workers Free plan.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | `fetch` (webhook GET/POST) and `queue` handlers |
| `src/pipeline.ts` | Voice pipeline and text commands |
| `src/whatsapp.ts` | Graph API calls (media, send, read receipts). Graph API version is set here |
| `src/transcribe.ts` | `Transcriber` interface + OpenAI implementation (swap providers here) |
| `src/summarize.ts` | Claude prompt and call |
| `src/signature.ts`, `src/webhook.ts`, `src/store.ts`, `src/text.ts`, `src/ogg.ts` | Signature check, payload parsing/allowlist, KV, message splitting, voice note duration |

## 1. Meta / WhatsApp setup (one time)

1. Create a developer account at <https://developers.facebook.com>.
2. **My Apps → Create app**, type **Business**, then add the **WhatsApp** product. This creates a Business portfolio and a free test phone number.
3. **WhatsApp → API Setup**:
   - Note the **Phone Number ID** (`WHATSAPP_PHONE_NUMBER_ID`).
   - Under "To", add your personal number as a recipient and verify it with the code.
4. **Permanent token**: business.facebook.com → **Business Settings → Users → System users → Add** (role: Admin). Then **Assign assets**: the app (full control) and the WhatsApp account. Then **Generate new token** for the app with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions, and set expiry to "Never". This is `WHATSAPP_TOKEN`. The token on the API Setup page expires after 24 hours, so don't use that one.
5. **App settings → Basic → App secret** → `WHATSAPP_APP_SECRET`.
6. Make up a random string for `WEBHOOK_VERIFY_TOKEN`, for example with `openssl rand -hex 16`.
7. Get an OpenAI API key and an Anthropic API key.

## 2. Cloudflare setup (one time)

```sh
npm install
npx wrangler login
npx wrangler kv namespace create VOICE_KV     # paste the printed id into wrangler.toml
npx wrangler queues create voice-jobs
```

Set the secrets. Each command prompts for the value:

```sh
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put ALLOWED_SENDERS        # e.g. 972501234567 (international format, comma-separated)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

`SUMMARY_LANGUAGE` (e.g. `English` or `Hebrew`) and `TRANSCRIBE_LANGUAGE` (`he`, or empty to auto-detect) are plain vars in `wrangler.toml`.

## 3. Deploy and connect

```sh
npm run deploy        # prints https://kfir-summarizer.<subdomain>.workers.dev
```

In the Meta app, go to **WhatsApp → Configuration → Webhook → Edit**:
- Callback URL: `https://kfir-summarizer.<subdomain>.workers.dev/webhook`
- Verify token: your `WEBHOOK_VERIFY_TOKEN`
- **Verify and save**, then under Webhook fields subscribe to **messages**.

Save the test number in your phone's contacts (for example as "Dad Summarizer"), forward it a voice note, and the summary should arrive within about a minute.

Note that the bot can only message you inside WhatsApp's 24-hour window after you last wrote to it. Since you always message it first, that's never an issue.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in values (never commit this file)
npm run dev                      # http://localhost:8787, with a local KV and queue
cloudflared tunnel --url http://localhost:8787
```

Point the Meta webhook at `https://<random>.trycloudflare.com/webhook` while testing, and switch it back to the Worker URL afterwards.

Logs from the deployed Worker: `npx wrangler tail`.

## Tests

```sh
npm test           # Vitest: signature, parsing, allowlist, dedupe, splitting, duration, pipeline with mocked APIs
npm run typecheck
```

Sample webhook payloads are in `test/fixtures/`.

## Rotating the WhatsApp token

1. In Business Settings → System users, select the system user and click **Generate new token**, with the same app and permissions as before.
2. `npx wrangler secret put WHATSAPP_TOKEN` and paste the new token. This takes effect immediately and doesn't need a redeploy.
3. Send the bot a message to confirm it still replies, then revoke the old token in the same screen.

Other keys rotate the same way: `wrangler secret put <NAME>`. If you reset the App Secret in Meta, update `WHATSAPP_APP_SECRET` right away, or every webhook will be rejected with 401.

## Commands

| Send | Reply |
|---|---|
| a voice note (forwarded or recorded) | `🎙️ 3:42 → summary` followed by the summary |
| `full` / `מלא` | The full transcript of the last voice note, split into several messages if it's long |
| `help` | Usage |
| anything else | A short hint |
