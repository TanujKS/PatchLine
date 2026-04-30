/**
 * MIME parsing wrapper around postal-mime.
 *
 * Email Workers expose `message.raw` as a ReadableStream. We tee it: one branch
 * is consumed for parsing, the other is uploaded to R2 unchanged.
 */

import PostalMime from 'postal-mime';

export interface ParsedAttachment {
  filename: string;
  mimeType: string | null;
  size: number;
  content: ArrayBuffer;
}

export interface ParsedEmail {
  messageId: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

/**
 * Reads the raw stream into memory once, then parses. Email Workers have a
 * ~25 MB inbound limit so this is safe.
 */
export async function parseRaw(raw: ReadableStream | ArrayBuffer): Promise<{ parsed: ParsedEmail; rawBytes: Uint8Array }> {
  const rawBytes = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : await streamToBytes(raw);

  const parser = new PostalMime();
  const email = await parser.parse(rawBytes);

  const attachments: ParsedAttachment[] = (email.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'attachment',
    mimeType: a.mimeType ?? null,
    size: byteLength(a.content),
    content: toArrayBuffer(a.content),
  }));

  return {
    parsed: {
      messageId: email.messageId ?? null,
      subject: email.subject ?? null,
      text: email.text ?? null,
      html: email.html ?? null,
      attachments,
    },
    rawBytes,
  };
}

async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === 'string') return new TextEncoder().encode(content).byteLength;
  return content.byteLength;
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    // Copy out into a fresh ArrayBuffer so the result is never a SharedArrayBuffer
    // (some TextDecoder/TypedArray paths leave .buffer typed as SharedArrayBuffer).
    const copy = new Uint8Array(content.byteLength);
    copy.set(content);
    return copy.buffer;
  }
  const enc = new TextEncoder().encode(content);
  const copy = new Uint8Array(enc.byteLength);
  copy.set(enc);
  return copy.buffer;
}
