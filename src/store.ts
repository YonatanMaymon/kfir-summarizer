const SEEN_TTL_SECONDS = 24 * 60 * 60;
const TRANSCRIPT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Meta retries webhooks; a message id we've already queued is skipped. */
export async function wasSeen(kv: KVNamespace, messageId: string): Promise<boolean> {
  return (await kv.get(`seen:${messageId}`)) !== null;
}

export async function markSeen(kv: KVNamespace, messageId: string): Promise<void> {
  await kv.put(`seen:${messageId}`, "1", { expirationTtl: SEEN_TTL_SECONDS });
}

export async function saveTranscript(kv: KVNamespace, sender: string, transcript: string): Promise<void> {
  await kv.put(`last_transcript:${sender}`, transcript, { expirationTtl: TRANSCRIPT_TTL_SECONDS });
}

export async function loadTranscript(kv: KVNamespace, sender: string): Promise<string | null> {
  return kv.get(`last_transcript:${sender}`);
}
