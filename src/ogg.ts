/**
 * Duration of an Ogg Opus file (WhatsApp voice notes), in seconds.
 *
 * The webhook doesn't include the voice note's length, so it's read from the
 * file: the granule position of the last Ogg page is the sample count at 48 kHz
 * (Opus always uses 48 kHz granules), minus the encoder pre-skip from OpusHead.
 * Returns null if the data isn't recognisable Ogg Opus.
 */
export function oggOpusDurationSeconds(data: Uint8Array): number | null {
  if (data.length < 28 || !isCapture(data, 0)) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // OpusHead lives in the first page's payload; pre-skip is at offset 10.
  let preSkip = 0;
  const head = indexOf(data, OPUS_HEAD, 0, Math.min(data.length, 512));
  if (head < 0) return null;
  if (head + 12 <= data.length) preSkip = view.getUint16(head + 10, true);

  // Walk backwards to the last page header with a valid granule position.
  for (let i = data.length - 27; i >= 0; i--) {
    if (!isCapture(data, i) || data[i + 4] !== 0) continue; // byte 4 = stream version, always 0
    const granule = view.getBigInt64(i + 6, true);
    if (granule < 0n) continue; // -1 means "no packet ends on this page"
    const samples = Number(granule) - preSkip;
    return samples > 0 ? samples / 48000 : 0;
  }
  return null;
}

const OGG_S = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"

function isCapture(data: Uint8Array, i: number): boolean {
  return data[i] === OGG_S[0] && data[i + 1] === OGG_S[1] && data[i + 2] === OGG_S[2] && data[i + 3] === OGG_S[3];
}

function indexOf(data: Uint8Array, needle: number[], from: number, to: number): number {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
