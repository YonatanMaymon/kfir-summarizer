/** A normalized incoming WhatsApp message — also the queue job payload. */
export type IncomingMessage =
  | { kind: "audio"; id: string; from: string; mediaId: string; forwarded: boolean }
  | { kind: "text"; id: string; from: string; text: string }
  | { kind: "other"; id: string; from: string; type: string };

/**
 * Pulls messages out of a WhatsApp Cloud API webhook payload
 * (`entry[].changes[].value.messages[]`). Status events (delivery/read
 * receipts) live under `value.statuses` and are ignored.
 */
export function extractMessages(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (payload as any)?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const messages = change?.value?.messages;
      if (!Array.isArray(messages)) continue;

      for (const m of messages) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        const base = { id: m.id, from: m.from };

        if (m.type === "audio" && typeof m.audio?.id === "string") {
          out.push({
            ...base,
            kind: "audio",
            mediaId: m.audio.id,
            forwarded: Boolean(m.context?.forwarded || m.context?.frequently_forwarded),
          });
        } else if (m.type === "text" && typeof m.text?.body === "string") {
          out.push({ ...base, kind: "text", text: m.text.body });
        } else {
          out.push({ ...base, kind: "other", type: String(m.type) });
        }
      }
    }
  }
  return out;
}

/** Normalizes a phone number to digits only (WhatsApp `from` has no "+"). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function parseAllowedSenders(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(normalizePhone)
      .filter((p) => p.length > 0),
  );
}

export function isAllowedSender(from: string, allowed: Set<string>): boolean {
  return allowed.has(normalizePhone(from));
}
