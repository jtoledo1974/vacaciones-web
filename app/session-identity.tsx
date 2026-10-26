'use client';

import { ArrowUpRight, LogIn, LogOut, ShieldCheck, UserRound } from 'lucide-react';

export type SessionDetails = {
  loaded: boolean;
  subject: string;
  email: string;
  provider: string;
  role: string;
  signinUrl: string;
};

function providerLabel(provider: string): string {
  if (provider === 'firebase') return 'Google (Firebase)';
  if (provider === 'local_admin') return 'Administrador local';
  return 'ChatGPT';
}

/** Primary session area in the sidebar, separate from public navigation. */
export function SidebarSession({ loaded, subject, email, provider, role, signinUrl }: SessionDetails) {
  const signedIn = Boolean(subject);
  const name = email || subject;
  return (
    <section className="sidebar-session" aria-label="Tu sesión" id="session-account">
      {!loaded ? (
        <p className="session-pending">Comprobando sesión…</p>
      ) : !signedIn ? (
        <>
          <div className="sidebar-session-heading">
            <UserRound size={18} />
            <strong>No has iniciado sesión</strong>
          </div>
          <p>Accede para consultar tu turno, preparar preferencias y participar en la elección de vacaciones.</p>
          <a className="sidebar-signin" href={signinUrl} target="_top">
            <LogIn size={17} /> Iniciar sesión con ChatGPT
          </a>
          <small>También puedes consultar la disponibilidad sin iniciar sesión.</small>
        </>
      ) : (
        <>
          <div className="sidebar-session-heading">
            <UserRound size={18} />
            <strong>Sesión iniciada</strong>
          </div>
          <div className="session-detail-label">Usuario</div>
          <div className="session-user" title={name}>
            {name}
          </div>
          <div className="session-detail-label">Rol</div>
          <div className="session-role">
            <ShieldCheck size={15} />
            {role}
          </div>
          <small>Acceso mediante {providerLabel(provider)}</small>
          {provider === 'chatgpt' && (
            <a className="session-signout" href="/signout-with-chatgpt?return_to=/" target="_top">
              <LogOut size={13} /> Cerrar sesión
            </a>
          )}
        </>
      )}
    </section>
  );
}

/** Account/role remain visible in the header even with the mobile drawer closed. */
export function HeaderSession({
  loaded,
  subject,
  email,
  role,
  signinUrl,
  onOpenMenu,
}: SessionDetails & { onOpenMenu: () => void }) {
  if (!loaded) return <span className="header-session-pending">Comprobando sesión…</span>;
  if (!subject)
    return (
      <a className="header-signin" href={signinUrl} target="_top">
        <LogIn size={16} /> Iniciar sesión <span>con ChatGPT</span>
        <ArrowUpRight size={14} />
      </a>
    );
  const name = email || subject;
  return (
    <button
      type="button"
      className="header-account"
      onClick={onOpenMenu}
      aria-label={`Cuenta: ${name}. Rol: ${role}. Ver detalles de sesión`}
    >
      <UserRound size={18} />
      <span className="header-account-info">
        <strong title={name}>{name}</strong>
        <small>Rol: {role}</small>
      </span>
    </button>
  );
}
