import type { Env } from "./env";
import { oggOpusDurationSeconds } from "./ogg";
import { loadTranscript, saveTranscript } from "./store";
import { summarize } from "./summarize";
import { formatDuration, splitMessage } from "./text";
import { baseMimeType, createTranscriber, MAX_AUDIO_BYTES, UnsupportedAudioError } from "./transcribe";
import type { IncomingMessage } from "./webhook";
import { downloadMedia, getMediaInfo, markReadWithTyping, sendText } from "./whatsapp";

export const HELP_TEXT = [
  "🎙️ Forward me a voice message and I'll reply with a short summary.",
  "",
  "Commands:",
  "• full / מלא — the full transcript of the last voice note",
  "• help — this message",
].join("\n");

const HINT_TEXT = "Forward me a voice message and I'll summarize it. Send \"help\" for commands.";
const UNSUPPORTED_TEXT = "Sorry, I only handle voice messages. Forward me one and I'll summarize it.";

/** Thrown with the name of the pipeline step that failed, for the error reply. */
class StepError extends Error {
  constructor(
    readonly step: string,
    readonly userMessage: string | null,
    cause: unknown,
  ) {
    super(`${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError(name, null, err);
  }
}

async function sendLong(env: Env, to: string, text: string, replyTo?: string): Promise<void> {
  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    // Only the first part quotes the original message.
    await sendText(env, to, parts[i], i === 0 ? replyTo : undefined);
  }
}

export async function handleMessage(env: Env, msg: IncomingMessage): Promise<void> {
  switch (msg.kind) {
    case "audio":
      return handleAudio(env, msg);
    case "text":
      return handleText(env, msg);
    default:
      return sendText(env, msg.from, UNSUPPORTED_TEXT, msg.id);
  }
}

async function handleText(env: Env, msg: Extract<IncomingMessage, { kind: "text" }>): Promise<void> {
  const command = msg.text.trim().toLowerCase();

  if (command === "full" || command === "מלא") {
    const transcript = await loadTranscript(env.VOICE_KV, msg.from);
    if (!transcript) {
      return sendText(env, msg.from, "I don't have a recent transcript. Forward me a voice message first.", msg.id);
    }
    return sendLong(env, msg.from, transcript, msg.id);
  }
  if (command === "help" || command === "עזרה" || command === "?") {
    return sendText(env, msg.from, HELP_TEXT, msg.id);
  }
  return sendText(env, msg.from, HINT_TEXT, msg.id);
}

async function handleAudio(env: Env, msg: Extract<IncomingMessage, { kind: "audio" }>): Promise<void> {
  // Best effort: a failed read receipt shouldn't stop the summary.
  await markReadWithTyping(env, msg.id).catch((err) => console.warn("markRead failed", err));

  try {
    const media = await step("download", () => getMediaInfo(env, msg.mediaId));
    const tooLarge = new StepError("download", "That voice note is too large to transcribe (over 25 MB).", "too large");
    if (media.fileSize !== null && media.fileSize > MAX_AUDIO_BYTES) throw tooLarge;

    const audio = await step("download", () => downloadMedia(env, media.url));
    if (audio.byteLength > MAX_AUDIO_BYTES) throw tooLarge;

    const mime = baseMimeType(media.mimeType);
    const seconds = mime === "audio/ogg" || mime === "audio/opus" ? oggOpusDurationSeconds(audio) : null;

    const transcriber = createTranscriber(env);
    const transcript = await step("transcription", async () => {
      try {
        return await transcriber.transcribe(audio, media.mimeType);
      } catch (err) {
        if (err instanceof UnsupportedAudioError) {
          throw new StepError("transcription", `Sorry, I can't transcribe this audio format (${mime}).`, err);
        }
        throw err;
      }
    });
    if (!transcript) {
      return sendText(env, msg.from, "I couldn't hear any speech in that voice note.", msg.id);
    }

    // Saved before summarizing so "full" still works if the summary step fails.
    await step("saving", () => saveTranscript(env.VOICE_KV, msg.from, transcript));

    const summary = await step("summary", () => summarize(env, transcript));

    const header = seconds !== null ? `🎙️ ${formatDuration(seconds)} → summary` : "🎙️ Summary";
    await step("reply", () => sendLong(env, msg.from, `${header}\n\n${summary}`, msg.id));
  } catch (err) {
    console.error("voice pipeline failed", { messageId: msg.id, error: err instanceof Error ? err.message : err });
    const text = !(err instanceof StepError)
      ? "Couldn't process that voice note. Try again?"
      : (err.userMessage ?? `Couldn't process that voice note (${err.step} failed). Try again?`);
    await sendText(env, msg.from, text, msg.id).catch((e) => console.error("error reply failed", e));
  }
}
