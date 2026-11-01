import { gunzipSync, gzipSync } from 'node:zlib';

// Physical encoding of large historical JSON payloads (ADR 0001): each payload
// is gzipped on its own and stored as base64 text behind a version prefix, so
// columns, backups and restores keep handling plain text. Values without the
// prefix are legacy JSON and are returned unchanged. Never compress data that
// SQL must inspect with json_extract.
const PREFIX = 'gz1:';

export function encodePayload(json: string): string {
  return PREFIX + gzipSync(json, { level: 6 }).toString('base64');
}

export function decodePayload(stored: string): string {
  return stored.startsWith(PREFIX) ? gunzipSync(Buffer.from(stored.slice(PREFIX.length), 'base64')).toString() : stored;
}
