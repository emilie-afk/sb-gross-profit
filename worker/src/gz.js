/**
 * gz.js — bounded gzip, hashing and body helpers for the Free-tier routes.
 * Native streams only (CompressionStream / DecompressionStream / WebCrypto), so
 * the per-request CPU stays inside the Workers Free limit.
 */
import { ApiError } from './http.js';

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256Bytes = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
export const sha256Text = text => sha256Bytes(new TextEncoder().encode(text));
export const HEX64 = /^[0-9a-f]{64}$/;

/** Read a binary body with a hard byte cap. */
export async function readBytes(request, max) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new ApiError(413, 'compressed_too_large', `Body larger than ${max} bytes`);
  const b = new Uint8Array(await request.arrayBuffer());
  if (b.byteLength > max) throw new ApiError(413, 'compressed_too_large', `Body larger than ${max} bytes`);
  return b;
}

/** Streaming gunzip that aborts as soon as `cap` decompressed bytes are exceeded (zip-bomb guard). */
export async function gunzipCapped(bytes, cap) {
  let reader;
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) { await reader.cancel().catch(() => {}); throw new ApiError(413, 'decompressed_too_large', 'Decompressed body exceeds its limit'); }
      parts.push(value);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(out);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'gzip_invalid', 'Body is not valid gzip UTF-8');
  }
}

export async function gzipText(text) {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** D1 returns BLOB columns as ArrayBuffer (Workers) or Uint8Array (local); normalize. */
export const blobBytes = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v) : new Uint8Array(0));
