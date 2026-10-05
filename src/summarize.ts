import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

const MODEL = "claude-sonnet-5-5";

export function buildSystemPrompt(language: string): string {
  return `You summarize voice messages that a father sent to his adult son. The transcript may be in Hebrew, contain transcription errors, and ramble. Write the summary in ${language}.

Format:
- One-line gist.
- 2–5 short bullets with the actual content (news, requests, plans, dates, times, names, amounts).
- A final line "❓ Needs your reply:" listing direct questions or requests, if any. Omit this line if there are none.

Keep it under about 80 words. Don't add anything that wasn't said. Keep names and numbers exactly. If the transcript is very short, just give the gist. Reply with the summary only.`;
}

export async function summarize(env: Env, transcript: string): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // A short summary doesn't need deep reasoning; low effort keeps latency down.
    output_config: { effort: "low" },
    // If a safety classifier declines, the API retries on a fallback model server-side.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: buildSystemPrompt(env.SUMMARY_LANGUAGE || "English"),
    messages: [{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Summary refused (${response.stop_details?.category ?? "unknown"})`);
  }

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!text) throw new Error(`Empty summary (stop_reason=${response.stop_reason})`);
  return text;
}
