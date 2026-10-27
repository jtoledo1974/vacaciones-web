/** @param {string} value */
export async function cliHash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
/** @param {unknown} value */
export function normalizeCliCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-F0-9]{16}$/.test(code) ? code : null;
}
export const CLI_TOKEN_HEADER = 'X-Vacaciones-CLI-Token';
export const CLI_SESSION_MS = 15 * 60 * 1000;
export const CLI_PAIRING_MS = 5 * 60 * 1000;
