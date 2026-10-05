import type { Env } from "./env";

/** Kept behind an interface so the speech-to-text provider can be swapped. */
export interface Transcriber {
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

/** OpenAI's transcription endpoint rejects uploads larger than this. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

/** File extensions the OpenAI endpoint accepts, keyed by MIME type. */
const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

export class UnsupportedAudioError extends Error {}

/** "audio/ogg; codecs=opus" → "audio/ogg". */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

export class OpenAITranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly language: string,
  ) {}

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const ext = EXTENSIONS[baseMimeType(mimeType)];
    if (!ext) throw new UnsupportedAudioError(`Unsupported audio format: ${mimeType}`);

    const form = new FormData();
    form.append("file", new File([audio], `voice.${ext}`, { type: baseMimeType(mimeType) }));
    form.append("model", OPENAI_TRANSCRIBE_MODEL);
    form.append("response_format", "json");
    if (this.language) form.append("language", this.language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI transcription ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }
}

export function createTranscriber(env: Env): Transcriber {
  return new OpenAITranscriber(env.OPENAI_API_KEY, (env.TRANSCRIBE_LANGUAGE ?? "").trim());
}
