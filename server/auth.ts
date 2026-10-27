import { getChatGPTUser } from './chatgpt-auth';
import type { Identity } from './permissions';
import { verifyFirebaseIdToken } from './firebase-auth';
import { localAdminIdentity, type LocalAdminConfig } from './local-admin.ts';
import { cliIdentity, CLI_TOKEN_HEADER } from './cli-auth.ts';

export interface Authenticator {
  authenticate(request: Request): Promise<Identity>;
}

export const sitesAuthenticator: Authenticator = {
  async authenticate(_request) {
    const user = await getChatGPTUser();
    return user ? { provider: 'chatgpt', subject: user.userId, email: user.email, emailVerified: true } : null;
  },
};

/** Explicit CLI credentials fail closed; otherwise Firebase, local admin and Sites retain their precedence. */
export function federatedAuthenticator(
  firebaseProjectId: string,
  localConfig: LocalAdminConfig = {},
  repo: import('./repository').Repository,
): Authenticator {
  return {
    async authenticate(request) {
      if (request.headers.has(CLI_TOKEN_HEADER)) return cliIdentity(request, repo);
      const authorization = request.headers.get('authorization');
      if (authorization !== null) {
        const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1];
        if (!firebaseProjectId || !token)
          throw Object.assign(new Error('Token de Firebase no autorizado'), { status: 401 });
        try {
          return await verifyFirebaseIdToken(token, firebaseProjectId);
        } catch {
          throw Object.assign(new Error('La sesión Firebase ha caducado o no es válida'), { status: 401 });
        }
      }
      const local = await localAdminIdentity(request, localConfig, repo);
      return local ?? sitesAuthenticator.authenticate(request);
    },
  };
}
