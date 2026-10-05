import type { Env } from "./env";

export const GRAPH_API_VERSION = "v26.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface MediaInfo {
  url: string;
  mimeType: string;
  fileSize: number | null;
}

async function graphFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph API ${res.status} for ${url.split("?")[0]}: ${body.slice(0, 500)}`);
  }
  return res;
}

/** Resolves a media id to a short-lived download URL. */
export async function getMediaInfo(env: Env, mediaId: string): Promise<MediaInfo> {
  const res = await graphFetch(env, `${GRAPH}/${encodeURIComponent(mediaId)}`);
  const json = (await res.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!json.url) throw new Error(`Media ${mediaId} has no url`);
  return {
    url: json.url,
    mimeType: json.mime_type ?? "application/octet-stream",
    fileSize: typeof json.file_size === "number" ? json.file_size : null,
  };
}

/** Downloads media bytes. The URL expires within minutes, so call right after getMediaInfo. */
export async function downloadMedia(env: Env, url: string): Promise<Uint8Array> {
  const res = await graphFetch(env, url);
  return new Uint8Array(await res.arrayBuffer());
}

/** Sends a text message, optionally quoting the message it replies to. */
export async function sendText(env: Env, to: string, body: string, replyTo?: string): Promise<void> {
  await graphFetch(env, `${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body, preview_url: false },
      ...(replyTo ? { context: { message_id: replyTo } } : {}),
    }),
  });
}

/** Marks a message as read and shows a typing indicator while we work. */
export async function markReadWithTyping(env: Env, messageId: string): Promise<void> {
  await graphFetch(env, `${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  });
}
