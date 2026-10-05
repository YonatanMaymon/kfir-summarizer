import type { IncomingMessage } from "./webhook";

export interface Env {
  VOICE_KV: KVNamespace;
  VOICE_QUEUE: Queue<IncomingMessage>;

  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_APP_SECRET: string;
  WEBHOOK_VERIFY_TOKEN: string;
  ALLOWED_SENDERS: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;

  SUMMARY_LANGUAGE: string;
  TRANSCRIBE_LANGUAGE: string;
}
