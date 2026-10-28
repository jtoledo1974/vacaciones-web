'use client';
import { useState } from 'react';
import { useConfirmation } from './confirmation';

/** Superadmins manage all grants; team administrators only see and alter the selected team. */
export default function UserForm({ admin, busy, save, team, superuser = false }: any) {
  const confirm = useConfirmation();
  const [selected, setSelected] = useState<any>(null),
    [subject, setSubject] = useState(''),
    [provider, setProvider] = useState('chatgpt');
  const [role, setRole] = useState('team_admin'),
    [teams, setTeams] = useState<string[]>([]),
    [expires, setExpires] = useState(''),
    [vaAdmin, setVaAdmin] = useState(false);
  const ownGrants = (user: any) =>
    admin?.grants.filter((g: any) => g.user_id === user.id && (superuser || g.team_id === team)) ?? [];
  const users = (admin?.users ?? []).filter((u: any) => superuser || ownGrants(u).length > 0);
  const reset = () => {
    setSelected(null);
    setSubject('');
    setProvider('chatgpt');
    setRole('team_admin');
    setTeams([]);
    setExpires('');
    setVaAdmin(false);
  };
  const edit = (u: any) => {
    const grants = ownGrants(u);
    setSelected(u);
    setProvider(u.provider);
    setSubject(u.subject.replace(/^email:/, ''));
    setRole(grants.length ? 'team_admin' : 'viewer');
    setTeams(grants.map((g: any) => g.team_id));
    setExpires(grants[0]?.expires_at?.slice(0, 10) ?? '');
    setVaAdmin(u.va_admin === 1);
  };
  const submit = async (e: any) => {
    e.preventDefault();
    const normalized = provider === 'chatgpt' ? 'email:' + subject.trim().toLowerCase() : subject.trim();
    const existing = selected ?? admin?.users.find((u: any) => u.provider === provider && u.subject === normalized);
    const granted = role === 'team_admin' ? (superuser ? teams : [team]) : [];
    if (
      (
        await save({
          id: existing?.id,
          provider,
          subject,
          role,
          teams: granted,
          teamId: team,
          version: existing?.version ?? 0,
          expiresAt: expires ? new Date(expires).toISOString() : null,
          // Only superadmins assign it; a team administrator's save keeps the stored value.
          ...(superuser ? { vaAdmin } : {}),
        })
      )?.ok
    )
      reset();
  };
  return (
    <>
      <div className="table-wrap permissions-list">
        <table>
          <caption>{superuser ? 'Usuarios con permisos' : 'Administradores del equipo ' + team}</caption>
          <thead>
            <tr>
              <th>Cuenta</th>
              <th>Rol</th>
              <th>Equipos y caducidad</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.id}>
                <td>
                  {u.subject.replace(/^email:/, '')}
                  <br />
                  <small>{u.provider}</small>
                </td>
                <td>
                  {u.role === 'team_admin' ? 'Responsable de equipo' : u.va_admin === 1 ? 'Sin equipo' : 'Solo lectura'}
                  {superuser && u.va_admin === 1 && (
                    <>
                      <br />
                      <small>Administrador de VA</small>
                    </>
                  )}
                </td>
                <td>
                  {ownGrants(u)
                    .map((g: any) => g.team_id + (g.expires_at ? ' · hasta ' + g.expires_at.slice(0, 10) : ''))
                    .join(', ') || 'Sin equipos'}
                </td>
                <td>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => edit(u)}
                    aria-label={'Editar ' + u.subject}
                  >
                    Editar
                  </button>{' '}
                  <button
                    className="secondary"
                    disabled={busy}
                    aria-label={(superuser ? 'Eliminar ' : 'Retirar permisos de ') + u.subject}
                    onClick={async () => {
                      if (
                        await confirm(
                          'Quitar los permisos de ' +
                            u.subject +
                            (superuser ? ' en todos sus equipos' : ' en el equipo ' + team) +
                            '. La campaña y las vacaciones se conservan. El último administrador no se puede retirar.',
                        )
                      ) {
                        if ((await save({ action: 'delete', id: u.id, version: u.version, teamId: team }))?.ok) reset();
                      }
                    }}
                  >
                    {superuser ? 'Eliminar permisos' : 'Retirar permisos'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit}>
        <h3>{selected ? 'Editar permisos' : 'Asignar permisos'}</h3>
        <div className="entry-form">
          <label>
            Proveedor
            <select
              aria-label="Proveedor de identidad"
              value={provider}
              disabled={!!selected || busy}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="chatgpt">ChatGPT Sites</option>
              <option value="firebase">Firebase Auth</option>
            </select>
          </label>
          <label>
            {provider === 'chatgpt' ? 'Correo electrónico de ChatGPT' : 'UID de Firebase'}
            <input
              required
              type={provider === 'chatgpt' ? 'email' : 'text'}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={busy || (!superuser && !!selected)}
            />
          </label>
          <label>
            Rol
            <select value={role} disabled={busy} onChange={(e) => setRole(e.target.value)}>
              <option value="team_admin">Responsable de equipo</option>
              <option value="viewer">{superuser ? 'Sin equipo' : 'Retirar permisos de gestión'}</option>
            </select>
          </label>
          <label>
            Caducidad opcional
            <input type="date" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)} />
          </label>
          {superuser && (
            <label className="va-admin-check">
              <input type="checkbox" checked={vaAdmin} disabled={busy} onChange={(e) => setVaAdmin(e.target.checked)} />
              Administrador de VA
            </label>
          )}
          <button className="primary" disabled={busy || (superuser && role === 'team_admin' && !teams.length)}>
            Guardar permisos
          </button>
          {selected && (
            <button type="button" className="secondary" disabled={busy} onClick={reset}>
              Cancelar edición
            </button>
          )}
        </div>
        {superuser && (
          <div className="team-checkboxes">
            {'ABCDEFGH'.split('').map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  disabled={busy || role !== 'team_admin'}
                  checked={teams.includes(t)}
                  onChange={(e) => setTeams(e.target.checked ? [...teams, t] : teams.filter((x) => x !== t))}
                />
                Equipo {t}
              </label>
            ))}
          </div>
        )}
        <p className="muted">
          {superuser ? 'Selecciona al menos un equipo.' : 'Los cambios solo afectan al equipo ' + team + '.'} El último
          administrador permanente de cada equipo no puede ser retirado. Revisa el correo antes de guardar.
        </p>
      </form>
    </>
  );
}
