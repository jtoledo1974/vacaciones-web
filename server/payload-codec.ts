import { gunzipSync, gzipSync } from 'node:zlib';

// Physical encoding of large historical JSON payloads (ADR 0001): each payload
// is gzipped on its own and stored as base64 text behind a version prefix, so
// columns, backups and restores keep handling plain text. Values without the
// prefix are legacy JSON and are returned unchanged. Never compress data that
// SQL must inspect with json_extract.
const PREFIX = 'gz1:';

/** Always compressed, even if larger: the history conversion must mark every row it visits. */
export function compressPayload(json: string): string {
  return PREFIX + gzipSync(json, { level: 6 }).toString('base64');
}

/** Compressed only when that is smaller: short payloads stay plain JSON. */
export function encodePayload(json: string): string {
  const compressed = compressPayload(json);
  return compressed.length < json.length ? compressed : json;
}

export function decodePayload(stored: string): string {
  return stored.startsWith(PREFIX) ? gunzipSync(Buffer.from(stored.slice(PREFIX.length), 'base64')).toString() : stored;
}
