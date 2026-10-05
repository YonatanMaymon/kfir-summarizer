/** WhatsApp's limit for a text message body. */
export const WHATSAPP_TEXT_LIMIT = 4096;

/**
 * Splits text into chunks of at most `limit` characters, preferring to break at
 * a paragraph, line, then word boundary. If more than `maxParts` chunks would be
 * needed, the last one is cut short and ends with a truncation marker.
 */
export function splitMessage(text: string, limit = WHATSAPP_TEXT_LIMIT, maxParts = 5): string[] {
  const parts: string[] = [];
  let rest = text.trim();

  while (rest.length > 0) {
    if (parts.length === maxParts - 1 && rest.length > limit) {
      const marker = "\n…(truncated)";
      parts.push(cutAtBoundary(rest, limit - marker.length).trimEnd() + marker);
      break;
    }
    if (rest.length <= limit) {
      parts.push(rest);
      break;
    }
    const chunk = cutAtBoundary(rest, limit);
    parts.push(chunk.trimEnd());
    rest = rest.slice(chunk.length).trimStart();
  }
  return parts;
}

function cutAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  for (const sep of ["\n\n", "\n", " "]) {
    const idx = window.lastIndexOf(sep);
    // Only accept a boundary that keeps the chunk reasonably full.
    if (idx > limit * 0.5) return window.slice(0, idx + sep.length);
  }
  return window;
}

/** 222 → "3:42", 3725 → "1:02:05". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
