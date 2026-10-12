export type Identity = {
    provider: string;
    subject: string;
    email: string;
    emailVerified?:boolean;
} | null;
export type Principal = {
    id: string | null;
    role: 'viewer' | 'team_admin' | 'superadmin';
    teams: string[];
};
export function canWrite(p: Principal, team: string) { return p.id !== null && (p.role === 'superadmin' || p.role === 'team_admin' && p.teams.includes(team)); }
export function requireWrite(p: Principal, team: string) { if (!canWrite(p, team))
    throw Object.assign(new Error('No tienes permiso para modificar este equipo'), { status: 403 }); }
export function requireSuper(p: Principal) { if (!p.id || p.role !== 'superadmin')
    throw Object.assign(new Error('Esta operación requiere superadministrador'), { status: 403 }); }
