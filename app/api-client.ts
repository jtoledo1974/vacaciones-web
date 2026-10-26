import { firebaseBearerToken } from './firebase-client.ts';

/** Options for a request to the app's own `/api`. */
export type ApiOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** false for requests made before any Firebase session can exist (auth-config, local-admin). */
  auth?: boolean;
};
type TokenSource = () => Promise<string | null>;

/** `verComo` only applies to campaign and election reads, as the server expects. */
export function withPreview(path: string, search: string): string {
  const preview = new URLSearchParams(search).get('verComo');
  if (!preview || !/^(campaign|election)\//.test(path) || /[?&]verComo=/.test(path)) return path;
  return path + (path.includes('?') ? '&' : '?') + 'verComo=' + encodeURIComponent(preview);
}

export function createApiClient(token: TokenSource) {
  /** Raw request: Bearer token, `verComo`, no-store and JSON body. */
  async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
    const bearer = options.auth === false ? null : await token();
    const search = typeof location === 'undefined' ? '' : location.search;
    const hasBody = options.body !== undefined;
    return fetch('/api/' + withPreview(path, search), {
      method: options.method ?? (hasBody ? 'POST' : 'GET'),
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  /** JSON request; errors carry the server's message or `fallback`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers use untyped API responses today
  async function api<T = any>(
    path: string,
    options: ApiOptions = {},
    fallback = 'No se pudo completar la operación',
  ): Promise<T> {
    const response = await apiFetch(path, options);
    const data = (await response.json()) as { error?: string } | null;
    if (!response.ok) throw new Error(data?.error ?? fallback);
    return data as T;
  }
  return { apiFetch, api };
}

export const { apiFetch, api } = createApiClient(firebaseBearerToken);
