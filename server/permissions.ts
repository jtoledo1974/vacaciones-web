import { VA_TEAM } from './teams.ts';
export type Identity = {
  provider: string;
  subject: string;
  email: string;
  emailVerified?: boolean;
} | null;
export type Principal = {
  id: string | null;
  role: 'viewer' | 'team_admin' | 'superadmin';
  teams: string[];
  /** Derived only from a provider-verified email; never from client input. */
  emailKey?: string;
  /** Verified superadmin's effective controller view. Never trusted directly from client input. */
  preview?: { campaignId: string; memberId: string; code: string; writable: boolean };
};
export function canWrite(p: Principal, team: string) {
  return p.id !== null && (p.role === 'superadmin' || (p.role === 'team_admin' && p.teams.includes(team)));
}
export function requireWrite(p: Principal, team: string) {
  if (!canWrite(p, team))
    throw Object.assign(new Error('No tienes permiso para modificar este equipo'), { status: 403 });
}
/** VA administrators administer the reserved team 'va' (ADR 0002). */
export function canAdminVa(p: Principal) {
  return canWrite(p, VA_TEAM);
}
export function requireVaAdmin(p: Principal) {
  if (!canAdminVa(p)) throw Object.assign(new Error('Esta operación requiere administrador de VA'), { status: 403 });
}
export function requireSuper(p: Principal) {
  if (!p.id || p.role !== 'superadmin')
    throw Object.assign(new Error('Esta operación requiere superadministrador'), { status: 403 });
}
