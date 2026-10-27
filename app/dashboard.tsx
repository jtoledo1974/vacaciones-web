'use client';
import { download } from './download';
import { useEffect, useRef, useState } from 'react';
import { buildInfo } from './build-info';
import {
  initialiseFirebase,
  subscribeFirebaseSession,
  firebaseUser,
  firebaseSignInWithGoogle,
  firebaseSignOut,
} from './firebase-client';
import UserForm from './user-permissions';
import LocalAdminLogin from './local-admin-login';
import { HeaderSession, SidebarSession } from './session-identity';
import CampaignAccessNotice from './campaign-access-notice';
import { requiresAccountLinkNotice } from './campaign-access-state';
import { api as apiJson, apiFetch } from './api-client';
import { resolveLandingCampaign } from './landing-campaign';
import { runElectionCommand } from './election-command';
import RosterEditor from './roster-editor';
import ElectionWorkspace from './election-workspace';
import { ActivationPanel } from './election-activation';
import { CampaignForm, ConfigForm } from './campaign-forms';
import SimulationTools from './simulation-tools';
import Help from './help';
import { ConfirmationProvider, useConfirmation } from './confirmation';
import {
  CalendarDays,
  ShieldCheck,
  ArrowUpRight,
  Plus,
  Download,
  ChevronRight,
  Layers,
  Menu,
  X,
  BookOpen,
  Bell,
} from 'lucide-react';
const labels: any = { open: 'Abierta', closed: 'Cerrada', published: 'Publicada' };
const api = (path: string, body?: any) => apiJson(path, body === undefined ? {} : { body });
function Dashboard() {
  const confirm = useConfirmation();
  const [index, setIndex] = useState<any>(null),
    [data, setData] = useState<any>(null),
    [cid, setCid] = useState(''),
    [nav, setNav] = useState('eleccion'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [admin, setAdmin] = useState<any>(null),
    [menu, setMenu] = useState(false),
    [identity, setIdentity] = useState(''),
    [signinUrl, setSigninUrl] = useState('/signin-with-chatgpt?return_to=/');
  const [yearChoice, setYearChoice] = useState<number | null>(null);
  const [previewCode, setPreviewCode] = useState('');
  const [jumpToActivation, setJumpToActivation] = useState(false);
  const [firebaseEnabled, setFirebaseEnabled] = useState(false);
  const [localAdminEnabled, setLocalAdminEnabled] = useState(false);
  const [syncState, setSyncState] = useState<'ready' | 'checking' | 'offline'>('checking');
  const [sessionProvider, setSessionProvider] = useState('chatgpt');
  const [sessionEmail, setSessionEmail] = useState('');
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [publicConsultation, setPublicConsultation] = useState(false);
  const currentCid = useRef('');
  // Native <details> do not dismiss on Escape or outside interaction.
  useEffect(() => {
    const opened = () =>
      document.querySelectorAll<HTMLDetailsElement>('.election-more-actions[open],.scenario-actions[open]');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape')
        opened().forEach((menu) => {
          menu.open = false;
        });
    };
    const onPointer = (event: PointerEvent) => {
      opened().forEach((menu) => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  const preferenceGuard = useRef<null | (() => Promise<boolean>)>(null);
  const canNavigate = async () => !preferenceGuard.current || (await preferenceGuard.current());
  const isBusy = useRef(false);
  const lastRevision = useRef<number | null>(null);
  useEffect(() => {
    currentCid.current = cid;
  }, [cid]);
  useEffect(() => {
    isBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    setPublicConsultation(false);
  }, [cid, identity]);
  // Success notices float over the page (#64) and fade on their own; errors stay until closed.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function loadIndex() {
    const i = await api('index');
    setIndex(i);
    return i;
  }
  function selectLanding(i: any) {
    if (currentCid.current) return;
    const selection = resolveLandingCampaign(i, location.search);
    setYearChoice(selection.year);
    if (selection.campaignId) {
      currentCid.current = selection.campaignId;
      setCid(selection.campaignId);
    }
  }
  useEffect(() => {
    let active = true;
    const readSession = () =>
      api('session')
        .then((s) => {
          if (!active) return;
          setIdentity(s.identity?.subject ?? '');
          setSessionEmail(s.identity?.email ?? '');
          setSessionProvider(s.identity?.provider ?? 'chatgpt');
          setSessionLoaded(true);
        })
        .catch(() => {
          if (active) setSessionLoaded(true);
        });
    const unregister = subscribeFirebaseSession(() => {
      if (!active) return;
      lastRevision.current = null;
      readSession();
      loadIndex()
        .then((i) => {
          const selected = currentCid.current;
          if (!active) return;
          if (selected && !i.campaigns.some((x: any) => x.id === selected)) {
            currentCid.current = '';
            setCid('');
          } else if (selected)
            api('campaign/' + selected)
              .then((next) => {
                if (active) setData(next);
              })
              .catch(() => {});
          else selectLanding(i);
        })
        .catch(() => {});
    });
    apiFetch('auth-config', { auth: false })
      .then(async (r) => (r.ok ? ((await r.json()) as { localAdminEnabled?: boolean }) : null))
      .then((c) => {
        if (active) setLocalAdminEnabled(c?.localAdminEnabled === true);
      })
      .catch(() => {});
    initialiseFirebase()
      .then((configured) => {
        if (active) {
          setFirebaseEnabled(configured);
          readSession();
        }
      })
      .catch(() => {
        if (active) setFirebaseEnabled(false);
      });
    loadIndex()
      .then((i) => {
        if (!active) return;
        const p = new URLSearchParams(location.search);
        setPreviewCode(p.get('verComo') ?? '');
        setSigninUrl('/signin-with-chatgpt?return_to=' + encodeURIComponent(location.pathname + location.search));
        selectLanding(i);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    readSession();
    return () => {
      active = false;
      unregister();
    };
  }, []);
  useEffect(() => {
    if (!cid) {
      setData(null);
      return;
    }
    let cancelled = false;
    setData(null);
    api('campaign/' + cid)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        const u = new URL(location.href);
        u.searchParams.set('equipo', d.campaign.team_id);
        u.searchParams.set('year', d.campaign.year);
        if (d.campaign.scope_key === 'live') u.searchParams.delete('escenario');
        else u.searchParams.set('escenario', d.campaign.id);
        history.replaceState({}, '', u);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);
  // D1 does not publish change events. Poll one revision integer every 5 seconds,
  // and reload the selected campaign/index only if a transaction changed the data.
  useEffect(() => {
    let active = true;
    let running = false;
    async function synchronise() {
      if (!active || running || isBusy.current || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const state = await api('revision');
        if (!active) return;
        if (lastRevision.current === null || lastRevision.current !== state.revision) {
          lastRevision.current = state.revision;
          const current = currentCid.current;
          const [newIndex, next] = await Promise.all([
            api('index'),
            current ? api('campaign/' + current) : Promise.resolve(null),
          ]);
          if (!active) return;
          setIndex(newIndex);
          if (next && current === currentCid.current) {
            setData((previous: any) =>
              previous?.campaign.id === next.campaign.id && previous.campaign.version > next.campaign.version
                ? previous
                : next,
            );
          }
          if (current && !newIndex.campaigns.some((x: any) => x.id === current)) setCid('');
        }
        setSyncState('ready');
      } catch (e) {
        if (active) {
          lastRevision.current = null;
          setSyncState('offline');
        }
      } finally {
        running = false;
      }
    }
    const timer = setInterval(synchronise, 5000);
    const foreground = () => {
      if (document.visibilityState === 'visible') void synchronise();
    };
    const focused = () => void synchronise();
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', focused);
    void synchronise();
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', focused);
    };
  }, []);
  async function perform(fn: () => Promise<any>, message: string, options: { refreshIndex?: boolean } = {}) {
    isBusy.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (result?.campaign && (options.refreshIndex !== false || currentCid.current === result.campaign.id))
        setData(result);
      // Election responses already contain the committed campaign metadata.
      // Do not delay their success (or negate it on failure) with another read.
      if (options.refreshIndex !== false) await loadIndex();
      else if (result?.campaign)
        setIndex((previous: any) =>
          previous
            ? {
                ...previous,
                campaigns: previous.campaigns.map((c: any) =>
                  c.id === result.campaign.id ? { ...c, ...result.campaign } : c,
                ),
              }
            : previous,
        );
      lastRevision.current = null;
      setSyncState('ready');
      setNotice(message);
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      isBusy.current = false;
      setBusy(false);
    }
  }
  const mutateElection = (body: any, msg: string) =>
    perform(
      async () => {
        const outcome = await runElectionCommand(
          (command) => api('election/' + cid, command),
          body,
          data.campaign.version,
          (next) => {
            if (currentCid.current === next.campaign.id) setData(next);
          },
        );
        if (outcome.continuationError)
          setError(
            'La operación se ha guardado, pero no se han completado los automatismos. Puedes continuar los pendientes sin repetir la elección.',
          );
        return outcome.result;
      },
      msg,
      { refreshIndex: false },
    );
  const mutate = (body: any, msg: string) =>
    perform(() => api('campaign/' + cid, { ...body, version: data.campaign.version }), msg);
  // Persist roster changes first, then apply only modified account links. Every
  // account operation uses the revision returned by the previous request.
  const saveRoster = async (
    rows: any[],
    accountChanges: any[],
    rosterDirty: boolean,
    scoresDirty: boolean,
    previousScores: Record<string, number>,
    scoreSource: string,
  ) => {
    isBusy.current = true;
    setBusy(true);
    setError('');
    let current = data;
    const sync = (next: any) => {
      // Commit results are chained by version, then delivered to the editor
      // once. Otherwise intermediate renders can erase edits made in flight.
      current = next;
    };
    try {
      if (rosterDirty)
        sync(await api('campaign/' + cid, { action: 'bulk_members', rows, version: current.campaign.version }));
      if (scoresDirty)
        sync(
          await api('campaign/' + cid, {
            action: 'config',
            config: { ...current.config, previousScores, previousScoresSource: scoreSource },
            version: current.campaign.version,
          }),
        );
      for (const account of accountChanges) {
        const memberId =
          account.memberId ??
          current.members.find((m: any) => m.code.toUpperCase() === account.code.trim().toUpperCase())?.id;
        if (!memberId)
          throw new Error('No se ha encontrado el nuevo controlador ' + account.code + ' para vincular su acceso.');
        sync(
          await api('election/' + cid, {
            action: 'link_account',
            version: current.campaign.version,
            memberId,
            provider: account.provider || 'chatgpt',
            subject: account.subject.trim(),
            accountVersion: account.accountVersion,
          }),
        );
      }
      if (currentCid.current === current.campaign.id) setData(current);
      try {
        await loadIndex();
      } catch {
        lastRevision.current = null;
      }
      lastRevision.current = null;
      setSyncState('ready');
      return current;
    } catch (error) {
      // Some steps may have committed; preserve their version for a retry.
      if (current !== data && currentCid.current === current.campaign.id) setData(current);
      throw error;
    } finally {
      isBusy.current = false;
      setBusy(false);
    }
  };
  const superuser = index?.principal.role === 'superadmin' && !previewCode,
    canManage = !!data?.editable && !previewCode,
    write = data?.editable && data?.campaign.status === 'open';
  const roleLabel = previewCode
    ? 'Controlador ' + (data?.preview?.code ?? previewCode) + ' (vista previa)'
    : superuser
      ? 'Superadministrador'
      : index?.principal.role === 'team_admin'
        ? 'Responsable de equipo'
        : data?.election?.myMemberId
          ? 'Controlador'
          : index?.myCampaignIds?.length
            ? 'Controlador (otro equipo)'
            : identity
              ? 'Cuenta sin vincular'
              : 'Visitante';
  const accessNoticeRequired = requiresAccountLinkNotice({
    sessionLoaded,
    authenticated: !!identity,
    isLive: data?.campaign?.scope_key === 'live',
    canManage: !!data?.editable,
    hasMember: !!data?.election?.myMemberId,
    inPreview: !!previewCode || !!data?.preview,
  });
  const sessionDetails = {
    loaded: sessionLoaded,
    subject: identity,
    email: sessionEmail,
    provider: sessionProvider,
    role: roleLabel,
    signinUrl,
  };
  const team = data?.campaign.team_id ?? '',
    year =
      data?.campaign.year ??
      yearChoice ??
      Math.max(2026, ...(index?.campaigns ?? []).filter((c: any) => c.scope_key === 'live').map((c: any) => c.year)),
    result = data?.result;
  const links = [
    ['eleccion', 'Vacaciones', CalendarDays],
    ...(index?.principal.role === 'superadmin' || index?.principal.role === 'team_admin'
      ? [['administracion', 'Administración', ShieldCheck] as const]
      : []),
    ['ayuda', 'Ayuda', BookOpen],
  ] as const;
  async function go(n: string) {
    if (n !== nav && !(await canNavigate())) return false;
    setNav(n);
    setMenu(false);
    if (n === 'administracion' && (index?.principal.role === 'superadmin' || index?.principal.role === 'team_admin')) {
      try {
        setAdmin(await api('admin'));
      } catch (e: any) {
        setError(e.message);
      }
    }
    return true;
  }
  useEffect(() => {
    if (!jumpToActivation || nav !== 'administracion' || !canManage || data?.election?.state) return;
    const panel = document.getElementById('activation-panel') as HTMLDetailsElement | null;
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setJumpToActivation(false);
  }, [jumpToActivation, nav, canManage, cid, data?.campaign.version]);
  const simulationName = data && data.campaign.scope_key !== 'live' ? data.campaign.simulation_name : '';
  return (
    <div
      className={
        'app' +
        (data && !canManage && nav === 'eleccion' ? ' controller-ux' : '') +
        (simulationName ? ' is-simulation' : '')
      }
    >
      <aside className={'sidebar ' + (menu ? 'shown' : '')}>
        <a className="brand" href="/">
          <span className="brand-mark">
            V<span>·</span>
          </span>
          <div>
            Vacaciones<small>OCHO EQUIPOS</small>
          </div>
        </a>
        <button className="close-mobile" onClick={() => setMenu(false)} aria-label="Cerrar menú">
          <X />
        </button>
        <SidebarSession {...sessionDetails} />
        <div className="nav-caption">ESPACIO DE TRABAJO</div>
        <nav>
          {links.map(([key, label, Icon]) => (
            <button key={key} className={nav === key ? 'active' : ''} onClick={() => go(key)}>
              <Icon size={19} />
              {label}
              {nav === key && <ChevronRight size={15} />}
            </button>
          ))}
          <a href="/notificaciones" className="notification-nav-link">
            <Bell size={19} /> Notificaciones
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div>
            <span className="env-dot" /> Consulta pública disponible
          </div>
          <div className="sidebar-foot">
            Gestión anual de equipos
            <br />
            Datos por equipo y ejercicio
          </div>
          {firebaseEnabled &&
            (firebaseUser() ? (
              <button
                type="button"
                className="firebase-login"
                onClick={async () => {
                  try {
                    await firebaseSignOut();
                  } catch (e: any) {
                    setError(e.message ?? 'Error al cerrar sesión Firebase');
                  }
                }}
              >
                Cerrar sesión de Google
              </button>
            ) : (
              <details className="alternative-login">
                <summary>Otras formas de acceso</summary>
                <button
                  type="button"
                  className="firebase-login"
                  onClick={async () => {
                    try {
                      await firebaseSignInWithGoogle();
                    } catch (e: any) {
                      setError(e.message ?? 'Error de inicio de sesión Firebase');
                    }
                  }}
                >
                  Entrar con Google (Firebase)
                </button>
              </details>
            ))}
          <LocalAdminLogin enabled={localAdminEnabled} loggedIn={sessionProvider === 'local_admin'} />
        </div>
      </aside>
      {menu && (
        <button type="button" className="sidebar-backdrop" aria-label="Cerrar menú" onClick={() => setMenu(false)} />
      )}
      <main>
        {simulationName && (
          <div className="simulation-band" role="note">
            <strong>Simulación · {simulationName}</strong>
            <span>Los cambios no afectan a la campaña real</span>
          </div>
        )}
        <header className="topbar">
          <button className="menu-mobile" onClick={() => setMenu(true)} aria-label="Abrir menú">
            <Menu />
          </button>
          <span>
            Equipos <ChevronRight size={13} />{' '}
            <b>{nav === 'eleccion' ? 'Vacaciones' : nav === 'administracion' ? 'Administración' : 'Ayuda'}</b>
          </span>
          <HeaderSession
            {...sessionDetails}
            onOpenMenu={() => {
              setMenu(true);
              document.getElementById('session-account')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          />
        </header>
        <div className="content">
          {previewCode && (
            <div
              className="alert warning"
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>
                <strong>Vista como controlador {data?.preview?.code ?? previewCode}</strong> ·{' '}
                {data?.preview?.writable
                  ? 'Simulación privada: puedes guardar sus preferencias y elecciones'
                  : 'Campaña real: prueba los controles, sin guardar cambios'}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const target = new URL(location.href);
                  target.searchParams.delete('verComo');
                  location.assign(target.toString());
                }}
              >
                Salir de vista previa
              </button>
            </div>
          )}
          <div className="heading">
            <div>
              <div className="eyebrow">PLANIFICACIÓN · {index ? year : '…'}</div>
              <h1>
                {nav === 'eleccion'
                  ? 'Vacaciones del equipo'
                  : nav === 'ayuda'
                    ? 'Ayuda y documentación'
                    : superuser
                      ? 'Administración general'
                      : 'Administración del equipo'}
              </h1>
              <p>
                {nav === 'eleccion'
                  ? 'Elige en tu turno o prepara tu lista. Consulta lo que va quedando libre.'
                  : 'Cada cambio se guarda en la campaña seleccionada.'}
              </p>
            </div>
            <div className="selectors">
              <label>
                Ejercicio
                <select
                  aria-label="Ejercicio"
                  value={index ? year : ''}
                  disabled={!index}
                  onChange={async (e) => {
                    const selectedYear = Number(e.target.value);
                    if (!index || !(await canNavigate())) return;
                    setYearChoice(selectedYear);
                    if (team)
                      setCid(
                        index.campaigns.find(
                          (c: any) => c.year === selectedYear && c.team_id === team && c.scope_key === 'live',
                        )?.id ?? '',
                      );
                    else {
                      const u = new URL(location.href);
                      u.searchParams.set('year', String(selectedYear));
                      history.replaceState({}, '', u);
                    }
                  }}
                >
                  {!index ? (
                    <option value="">Cargando…</option>
                  ) : (
                    Array.from(
                      new Set(index.campaigns.filter((c: any) => c.scope_key === 'live').map((c: any) => c.year)),
                    ).map((y: any) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label>
                Equipo
                <select
                  aria-label="Equipo"
                  value={team}
                  disabled={!index}
                  onChange={async (e) => {
                    const nextTeam = e.target.value;
                    if (!index || !(await canNavigate())) return;
                    if (!nextTeam) {
                      setCid('');
                      const u = new URL(location.href);
                      u.searchParams.delete('equipo');
                      history.replaceState({}, '', u);
                    } else
                      setCid(
                        index.campaigns.find(
                          (c: any) => c.team_id === nextTeam && c.year === year && c.scope_key === 'live',
                        )?.id ?? '',
                      );
                  }}
                >
                  <option value="">Selecciona un equipo</option>
                  {(index?.teams ?? 'ABCDEFGH'.split('').map((id) => ({ id, name: 'Equipo ' + id }))).map((t: any) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {canManage && data && (
                <label>
                  Escenario
                  <select
                    aria-label="Escenario"
                    value={cid}
                    onChange={async (e) => {
                      const next = e.target.value;
                      if (await canNavigate()) setCid(next);
                    }}
                  >
                    {index?.campaigns
                      .filter((c: any) => c.team_id === team && c.year === year)
                      .map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.scope_key === 'live' ? 'Campaña real' : `Simulación: ${c.simulation_name}`}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {canManage && data && (
                <button
                  type="button"
                  className="secondary scenario-create"
                  onClick={async () => {
                    await go('administracion');
                    setTimeout(
                      () =>
                        document
                          .getElementById('simulations-panel')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                      50,
                    );
                  }}
                >
                  <Plus size={15} />
                  Nueva simulación
                </button>
              )}
              {canManage && data?.campaign.scope_key !== 'live' && data && (
                <details className="scenario-actions">
                  <summary aria-label="Opciones de simulación" title="Opciones de simulación">
                    Opciones
                  </summary>
                  <div className="scenario-menu">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async (e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open');
                        if (!(await canNavigate())) return;
                        if (
                          !(await confirm(
                            `¿Eliminar definitivamente la simulación «${data.campaign.simulation_name}»? Se borrarán sus elecciones, preferencias e historial. La campaña real no cambiará.`,
                          ))
                        )
                          return;
                        await perform(async () => {
                          await api('simulations/' + cid, { action: 'delete', version: data.campaign.version });
                          const live = index.campaigns.find(
                            (c: any) => c.team_id === team && c.year === year && c.scope_key === 'live',
                          );
                          setData(null);
                          setCid(live?.id ?? '');
                          return { ok: true };
                        }, 'Simulación eliminada');
                      }}
                    >
                      Eliminar simulación
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirm(
                            '¿Reiniciar esta simulación? Se borrarán todas sus elecciones y preferencias ficticias, sin afectar a la campaña real.',
                          )
                        )
                          mutate(
                            { action: 'reset_vacations', confirmation: team + '-' + year },
                            'Simulación reiniciada',
                          );
                      }}
                    >
                      Reiniciar simulación
                    </button>
                  </div>
                </details>
              )}
              {canManage && data?.campaign.scope_key !== 'live' && (
                <label>
                  Probar como
                  <select
                    aria-label="Probar simulación como controlador"
                    value={previewCode}
                    onChange={(e) => {
                      const url = new URL(location.href);
                      if (e.target.value) url.searchParams.set('verComo', e.target.value);
                      else url.searchParams.delete('verComo');
                      location.assign(url.toString());
                    }}
                  >
                    <option value="">Administrador</option>
                    {data.members.map((m: any) => (
                      <option key={m.id} value={m.code}>
                        {m.code}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Cerrar error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              {notice}
            </div>
          )}
          {nav === 'ayuda' ? (
            <Help />
          ) : !index ? (
            <div className="panel empty">Cargando el espacio de trabajo…</div>
          ) : !index.teams.length ? (
            <div className="panel empty">
              <Layers size={36} />
              <h2>Tu espacio de vacaciones</h2>
              <p>
                Prepara ocho equipos y una campaña de prueba de 2026.
                <br />
                Todos los identificadores iniciales son ficticios.
              </p>
              {superuser ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      const i = await api('initialize', {});
                      setCid('');
                      return i;
                    }, 'Espacio de prueba preparado')
                  }
                >
                  Preparar campaña de prueba <ArrowUpRight size={16} />
                </button>
              ) : (
                <p>Un superadministrador debe preparar la primera campaña.</p>
              )}
            </div>
          ) : !cid ? (
            <div className="panel empty">
              <Layers size={36} />
              <h2>Selecciona un equipo</h2>
              <p>Elige el equipo y ejercicio que quieres consultar.</p>
            </div>
          ) : !data ? (
            <div className="panel empty">Cargando campaña…</div>
          ) : (
            <>
              <div className="campaign-strip">
                <span>
                  <span className={'status-dot ' + data.campaign.status} />
                  <b>
                    Equipo {team} · {year}
                  </b>
                  <span className="status">{labels[data.campaign.status]}</span>
                  {data.campaign.scope_key !== 'live' && (
                    <span className="tag simulation-tag">Simulación privada: {data.campaign.simulation_name}</span>
                  )}
                  {data.campaign.data_kind === 'demo' && <span className="tag">Datos de ejemplo</span>}
                </span>
                <span className="campaign-strip-meta">
                  {data.preview
                    ? data.preview.writable
                      ? 'Simulación editable como controlador'
                      : 'Vista previa de solo lectura'
                    : data.editable
                      ? 'Área de gestión'
                      : data.election?.myMemberId
                        ? 'Controlador · preferencias propias'
                        : accessNoticeRequired && !publicConsultation
                          ? 'Cuenta sin acceso a esta campaña'
                          : 'Consulta pública'}{' '}
                  <span className="separator">/</span>{' '}
                  {data.campaign.scope_key === 'live'
                    ? 'Ocupación actual · Consulta pública'
                    : 'Datos aislados · Solo administradores'}{' '}
                  <span className="separator">/</span>{' '}
                  <span aria-live="polite" className={'campaign-strip-sync is-' + syncState}>
                    {syncState === 'offline'
                      ? 'Sin conexión · reintentando'
                      : syncState === 'checking'
                        ? 'Conectando…'
                        : 'Actualización automática · hasta 5 s'}
                  </span>
                </span>
              </div>
              {nav === 'eleccion' &&
                (accessNoticeRequired && !publicConsultation ? (
                  <CampaignAccessNotice
                    email={sessionEmail}
                    provider={sessionProvider}
                    team={team}
                    year={year}
                    hasOtherAccess={!!index?.myCampaignIds?.length || index?.principal?.role === 'team_admin'}
                    onPublicView={() => setPublicConsultation(true)}
                    onFirebaseSignOut={async () => {
                      try {
                        await firebaseSignOut();
                        setPublicConsultation(false);
                      } catch (e: any) {
                        setError(e.message ?? 'No se pudo cerrar sesión');
                      }
                    }}
                  />
                ) : (
                  <>
                    {accessNoticeRequired && publicConsultation && (
                      <div className="alert warning" role="status">
                        Estás consultando la campaña públicamente. Tu cuenta autenticada no está vinculada a un
                        controlador de este equipo.{' '}
                        <button className="secondary" type="button" onClick={() => setPublicConsultation(false)}>
                          Volver al aviso de acceso
                        </button>
                      </div>
                    )}
                    <ElectionWorkspace
                      onConfigureElection={async () => {
                        if (await go('administracion')) setJumpToActivation(true);
                      }}
                      onPreferenceEdit={() => setNotice('')}
                      navigationGuard={preferenceGuard}
                      key={cid}
                      data={data}
                      busy={busy}
                      act={mutateElection}
                      legacy={mutate}
                      identity={identity}
                      superuser={canManage}
                      signinUrl={signinUrl}
                    />
                    <section className="panel">
                      <h2>Compartir y exportar</h2>
                      <div className="button-row">
                        <button
                          className="secondary"
                          onClick={() => {
                            const url = new URL(location.href);
                            url.searchParams.set('equipo', team);
                            url.searchParams.set('year', year);
                            url.searchParams.delete('verComo');
                            url.searchParams.delete('escenario');
                            navigator.clipboard.writeText(url.toString()).then(() => setNotice('Enlace copiado'));
                          }}
                        >
                          Copiar enlace de consulta
                        </button>
                        <button
                          className="secondary"
                          onClick={() => {
                            const rows = [
                              ['identificador', 'fecha', 'baremo'],
                              ...data.awards.map((a: any) => [
                                data.members.find((m: any) => m.id === a.member_id)?.code,
                                a.cycle_date,
                                result.cycles.find((c: any) => c.date === a.cycle_date)?.score,
                              ]),
                            ];
                            download(
                              `vacaciones-${team}-${year}.csv`,
                              rows
                                .map((r) =>
                                  r.map((s: any) => '"' + String(s ?? '').replaceAll('"', '""') + '"').join(','),
                                )
                                .join('\r\n'),
                              'text/csv',
                            );
                          }}
                        >
                          Exportar adjudicaciones CSV
                        </button>
                      </div>
                    </section>
                  </>
                ))}

              {nav === 'administracion' &&
                (canManage ? (
                  <>
                    <section className="panel campaign-status" aria-label="Estado de la campaña">
                      <h2>Estado de la campaña</h2>
                      <p className="campaign-status-line">
                        <strong>{labels[data.campaign.status]}</strong>
                        {' · '}
                        {!data.election?.state
                          ? 'Elección sin iniciar'
                          : data.election.state.status === 'active'
                            ? 'Elección en curso, ronda ' + (data.election.turn?.round ?? 1)
                            : data.election.state.status === 'paused'
                              ? 'Elección en pausa'
                              : 'Elección completada'}
                        {' · '}
                        {data.awards.length} de {data.members.length * (data.config?.cyclesPerPerson ?? 6)} ciclos
                        adjudicados
                      </p>
                    </section>
                    <ActivationPanel
                      data={data}
                      busy={busy}
                      act={mutateElection}
                      onResolveScores={(missing: string[]) => {
                        const roster = document.getElementById('roster-panel');
                        const field = Array.from(
                          roster?.querySelectorAll<HTMLInputElement>('input[aria-label^="Puntuación anterior de "]') ??
                            [],
                        ).find((x) => x.getAttribute('aria-label') === 'Puntuación anterior de ' + missing[0]);
                        (field ?? roster)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        field?.focus({ preventScroll: true });
                      }}
                      onResolveCycles={() => {
                        const panel = document.getElementById('campaign-config-panel') as HTMLDetailsElement | null;
                        if (panel) {
                          panel.open = true;
                          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                      }}
                      onSaveSource={(source: string) =>
                        mutate(
                          { action: 'config', config: { ...data.config, previousScoresSource: source } },
                          'Procedencia de las puntuaciones guardada',
                        )
                      }
                      onActivated={() => {
                        setJumpToActivation(false);
                        setNav('eleccion');
                      }}
                    />
                    <details id="campaign-config-panel" className="panel">
                      <summary>Parámetros del ejercicio</summary>
                      {data.config ? (
                        <ConfigForm
                          key={cid}
                          config={data.config}
                          year={year}
                          disabled={!write}
                          busy={busy}
                          save={(c: any) =>
                            mutate({ action: 'config', config: c }, 'Parámetros guardados para este ejercicio')
                          }
                        />
                      ) : (
                        <p>Los parámetros no están disponibles.</p>
                      )}
                    </details>
                    <RosterEditor
                      key={cid}
                      data={data}
                      busy={busy}
                      readOnly={!write}
                      manageAccounts={canManage}
                      teams={
                        data.campaign.scope_key === 'live'
                          ? index.campaigns.filter(
                              (c: any) =>
                                c.scope_key === 'live' && (superuser || index.principal.teams.includes(c.team_id)),
                            )
                          : []
                      }
                      retire={(memberId: string) =>
                        mutate({ action: 'retire_member', memberId }, 'Baja guardada en este ejercicio')
                      }
                      transfer={(memberId: string, targetTeam: string, targetVersion: number) =>
                        mutate(
                          { action: 'transfer_member', memberId, targetTeam, targetVersion },
                          'Cambio de turno guardado en este ejercicio',
                        )
                      }
                      save={saveRoster}
                      importRoster={(source: any) =>
                        mutate({ action: 'import_roster', source }, 'Plantilla y selecciones originales importadas')
                      }
                    />
                    <section className="panel">
                      <h2>Responsables y permisos</h2>
                      <p className="muted">
                        Da o retira permisos de gestión del equipo con el correo con el que cada persona inicia sesión.
                      </p>
                      <UserForm
                        admin={admin}
                        team={team}
                        superuser={superuser}
                        busy={busy}
                        save={(b: any) =>
                          perform(async () => {
                            await api('users', b);
                            setAdmin(await api('admin'));
                            return { ok: true };
                          }, 'Permisos guardados')
                        }
                      />
                    </section>
                    {
                      <section className="panel campaign-close">
                        <h2>Cerrar o reabrir el equipo</h2>
                        <p className="muted">
                          Cerrar bloquea elecciones y preferencias; la consulta sigue disponible. Reabrir no reanuda la
                          elección automáticamente.
                        </p>
                        <div className="button-row">
                          <button
                            className="secondary"
                            disabled={busy || data.campaign.status !== 'open'}
                            onClick={async () => {
                              if (await confirm('¿Cerrar esta campaña? Los resultados se conservarán.'))
                                mutate({ action: 'close' }, 'Campaña cerrada');
                            }}
                          >
                            Cerrar equipo {team}
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || data.campaign.status === 'open'}
                            onClick={async () => {
                              if (await confirm('¿Reabrir esta campaña?'))
                                mutate({ action: 'reopen' }, 'Campaña reabierta');
                            }}
                          >
                            Reabrir equipo {team}
                          </button>
                        </div>
                      </section>
                    }
                    <SimulationTools
                      data={data}
                      busy={busy}
                      create={(body: any) =>
                        perform(async () => {
                          const source = index.campaigns.find(
                            (c: any) => c.team_id === team && c.year === year && c.scope_key === 'live',
                          );
                          if (!source) throw new Error('Campaña real no encontrada');
                          const live = await api('campaign/' + source.id);
                          const created = await api('simulations/' + source.id, {
                            ...body,
                            version: live.campaign.version,
                          });
                          setCid(created.id);
                          return api('campaign/' + created.id);
                        }, 'Simulación privada creada')
                      }
                    />
                    <details className="panel admin-advanced">
                      <summary>Herramientas avanzadas</summary>
                      <section className="panel">
                        <h2>Corregir o empezar de cero</h2>
                        <p>
                          Vacía las preferencias, las elecciones y el estado del turno de este equipo y ejercicio.
                          Conserva plantilla, configuración y resultados publicados. Para corregir solo la última
                          adjudicación, usa «Deshacer» en el historial de la elección.
                        </p>
                        <div className="button-row">
                          <button
                            className="secondary"
                            disabled={
                              busy ||
                              data.campaign.status !== 'open' ||
                              (!data.requests.length &&
                                !data.awards.length &&
                                !data.election.preferences.length &&
                                !data.election.state)
                            }
                            onClick={async () => {
                              const expected = `${team}-${year}`;
                              if (
                                await confirm(
                                  `Para empezar de cero el equipo ${team}, ejercicio ${year}, se borrarán las preferencias, elecciones y el estado del turno. Podrás deshacerlo inmediatamente.`,
                                  expected,
                                )
                              )
                                mutate(
                                  { action: 'reset_vacations', confirmation: expected },
                                  'Vacaciones reiniciadas. Puedes deshacer este cambio.',
                                );
                            }}
                          >
                            Empezar de cero las vacaciones
                          </button>
                        </div>
                      </section>
                      {superuser && (
                        <section className="panel">
                          <h2>Copias de seguridad</h2>
                          <p className="muted">
                            Descarga una copia JSON con todos los datos y su huella SHA-256. La restauración verifica la
                            integridad y se aplica en una sola transacción.
                          </p>
                          <div className="button-row">
                            {firebaseUser() ? (
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={async () => {
                                  try {
                                    const b = await api('backup');
                                    download(
                                      'vacaciones-copia-' + new Date().toISOString().slice(0, 10) + '.json',
                                      JSON.stringify(b, null, 2),
                                    );
                                  } catch (e: any) {
                                    setError(e.message);
                                  }
                                }}
                              >
                                <Download size={16} /> Descargar copia completa
                              </button>
                            ) : (
                              <a className="primary" href="/api/backup?download=1">
                                <Download size={16} /> Descargar copia completa
                              </a>
                            )}
                            <label className="secondary file-label">
                              Restaurar copia
                              <input
                                type="file"
                                accept=".json"
                                disabled={busy}
                                onChange={async (e) => {
                                  const f = e.target.files?.[0];
                                  if (!f) return;
                                  if (
                                    !(await confirm(
                                      '¿Restaurar todos los datos desde esta copia? Sustituirá las campañas y permisos actuales. Descarga una copia antes de continuar.',
                                    ))
                                  )
                                    return;
                                  await perform(async () => {
                                    const b = JSON.parse(await f.text());
                                    const a = await api('admin');
                                    await api('restore', { backup: b, revision: a.revision });
                                    setData(await api('campaign/' + cid));
                                    setAdmin(await api('admin'));
                                  }, 'Copia restaurada');
                                  e.target.value = '';
                                }}
                              />
                            </label>
                          </div>
                        </section>
                      )}
                      {superuser && (
                        <section className="panel">
                          <h2>Actividad reciente</h2>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Operación</th>
                                  <th>Equipo</th>
                                  <th>Fecha</th>
                                </tr>
                              </thead>
                              <tbody>
                                {admin?.audit.map((a: any) => (
                                  <tr key={a.id}>
                                    <td>{a.action}</td>
                                    <td>{a.team_id ?? 'General'}</td>
                                    <td>{new Date(a.created_at).toLocaleString('es-ES')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      )}
                    </details>
                    {superuser && data.campaign.scope_key === 'live' && (
                      <section className="panel all-teams">
                        <span className="eyebrow">TODOS LOS EQUIPOS</span>
                        <h2>Campañas anuales</h2>
                        <p className="muted">
                          Crea los ocho equipos para el nuevo ejercicio. Elige plantilla y parámetros por separado; no
                          se copian vacaciones.
                        </p>
                        <CampaignForm
                          campaigns={index.campaigns}
                          busy={busy}
                          create={(b: any) =>
                            perform(() => api('campaigns', b), 'Nuevo ejercicio creado para los ocho equipos')
                          }
                        />
                      </section>
                    )}
                  </>
                ) : (
                  <div className="panel empty">
                    <ShieldCheck size={32} />
                    <h2>Administración reservada</h2>
                    <p>
                      Tu cuenta tiene permisos de{' '}
                      {index.principal.role === 'team_admin' ? 'responsable de equipo' : 'consulta'}.
                    </p>
                  </div>
                ))}
            </>
          )}
          <footer>
            Vacaciones <span>·</span> Ocho equipos <span>·</span> Consulta pública{' '}
            <span className="footer-right">{busy ? 'Guardando…' : 'Datos persistentes · Campañas independientes'}</span>
            <small
              className="footer-build"
              aria-label="Versión del código en ejecución"
              title={buildInfo.commitDate ? 'Fecha del commit: ' + buildInfo.commitDate : 'Fecha de compilación'}
            >
              Código {buildInfo.revision} · compilado{' '}
              <time dateTime={buildInfo.buildTimestamp}>{buildInfo.buildDate}</time>
            </small>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <ConfirmationProvider>
      <Dashboard />
    </ConfirmationProvider>
  );
}
