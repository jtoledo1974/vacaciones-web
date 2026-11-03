'use client';
import type { ImportReview } from '../domain/import-review-types';
import { download } from './download';
import PersonalCalendarDownload from './personal-calendar-download';
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
import { downloadBackup } from '../lib/backup-v2.mjs';
import { resolveLandingCampaign } from './landing-campaign';
import { unitWords } from './unit-words';
import { runElectionCommand } from './election-command';
import RosterEditor from './roster-editor';
import ElectionWorkspace from './election-workspace';
import { ActivationPanel } from './election-activation';
import { CampaignForm, ConfigForm } from './campaign-forms';
import SimulationTools from './simulation-tools';
import HrExportPanel from './hr-export-panel';
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
  BarChart3,
  Award,
} from 'lucide-react';
import VaCensusPanel from './va-census-panel';
import VaSection from './va-section';
import CampaignStats from './campaign-stats';
import { sectionFromPath, sectionPaths, type DashboardSection } from './section-routes';
const labels: any = { open: 'Abierta', closed: 'Cerrada', published: 'Publicada' };
const api = (path: string, body?: any) => apiJson(path, body === undefined ? {} : { body });
/** Whether the index still lists the campaign, the VA one included. */
const known = (i: any, id: string) => i.campaigns.some((x: any) => x.id === id) || i.vaCampaign?.id === id;
function Dashboard({ initialSection }: { initialSection: DashboardSection }) {
  const confirm = useConfirmation();
  const [index, setIndex] = useState<any>(null),
    [data, setData] = useState<any>(null),
    [selectedCid, setCid] = useState(''),
    [nav, setNav] = useState<DashboardSection>(initialSection),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [admin, setAdmin] = useState<any>(null),
    [menu, setMenu] = useState(false),
    [identity, setIdentity] = useState(''),
    [signinUrl, setSigninUrl] = useState('/signin-with-chatgpt?return_to=/');
  // «Antigüedad» shows the year's VA campaign on the same screens as an ordinary one
  // (ADR 0002): election for participants, administration in its own tab.
  // Who only administers VA lands on its administration straight from «Administración».
  const onlyVaAdmin =
    !!index?.va?.admin &&
    index.principal.role !== 'superadmin' &&
    !index.principal.teams.some((t: string) => t !== 'va');
  const vaCampaignId =
    (nav === 'antiguedad' || nav === 'antiguedad-admin' || (nav === 'administracion' && onlyVaAdmin)) &&
    index?.vaCampaign
      ? index.vaCampaign.id
      : '';
  const cid = vaCampaignId || selectedCid;
  const view: DashboardSection = vaCampaignId ? (nav === 'antiguedad' ? 'eleccion' : 'administracion') : nav;
  const [yearChoice, setYearChoice] = useState<number | null>(null);
  const [individualPdfCode, setIndividualPdfCode] = useState('');
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
  const currentSection = useRef<DashboardSection>(initialSection);
  const navigationIndex = useRef(0);
  // Dashboard index of the entry a cancelled Back/Forward returns to, if any.
  const revertingTo = useRef<number | null>(null);
  const navigationPending = useRef(false);
  const lastSectionUrl = useRef('');
  const adminPrincipal = useRef('');
  const currentIndex = useRef<Parameters<typeof resolveLandingCampaign>[0] | null>(null);
  useEffect(() => {
    // Tag dashboard-created history entries to restore the correct entry when
    // a user rejects leaving an unsaved preference draft.
    navigationIndex.current =
      typeof history.state?.vacationNavigationIndex === 'number' ? history.state.vacationNavigationIndex : 0;
    lastSectionUrl.current = location.href;
    history.replaceState({ ...history.state, vacationNavigationIndex: navigationIndex.current }, '', location.href);
  }, []);
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
    currentIndex.current = index;
  }, [index]);
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
  function acceptIndex(i: { principal: { id: string | null; role: string } }) {
    // Another account (or none, after signing out) must never see the previous one's users and grants.
    const principal = i.principal.id + ':' + i.principal.role;
    if (principal !== adminPrincipal.current) setAdmin(null);
    adminPrincipal.current = principal;
    setIndex(i);
  }
  async function loadIndex() {
    const i = await api('index');
    acceptIndex(i);
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
          if (selected && !known(i, selected)) {
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
        // The VA campaign is reached by its section, not by team and year.
        if (d.campaign.team_id === 'va') return;
        const u = new URL(location.href);
        u.searchParams.set('equipo', d.campaign.team_id);
        u.searchParams.set('year', d.campaign.year);
        if (d.campaign.scope_key === 'live') u.searchParams.delete('escenario');
        else u.searchParams.set('escenario', d.campaign.id);
        history.replaceState(history.state, '', u);
        lastSectionUrl.current = u.toString();
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
          acceptIndex(newIndex);
          if (next && current === currentCid.current) {
            setData((previous: any) =>
              previous?.campaign.id === next.campaign.id && previous.campaign.version > next.campaign.version
                ? previous
                : next,
            );
          }
          if (current && !known(newIndex, current)) setCid('');
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
  // VA administrators administer the reserved team 'va'; only other teams make a team manager.
  const ordinaryAdmin = index?.principal.role === 'team_admin' && index.principal.teams.some((t: string) => t !== 'va'),
    superuser = index?.principal.role === 'superadmin' && !previewCode,
    canManage = !!data?.editable && !previewCode,
    write = data?.editable && data?.campaign.status === 'open';
  const roleLabel = previewCode
    ? 'Controlador ' + (data?.preview?.code ?? previewCode) + ' (vista previa)'
    : superuser
      ? 'Superadministrador'
      : ordinaryAdmin
        ? 'Responsable de equipo'
        : data?.election?.myMemberId
          ? 'Controlador'
          : index?.va?.admin
            ? 'Administrador de VA'
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
  const sectionParams = new URLSearchParams();
  // Use the selected campaign ID, never a previously loaded campaign while
  // changing team/year/scenario (the request to load the new one is async).
  const sectionCampaign = index?.campaigns?.find((campaign: any) => campaign.id === cid);
  if (sectionCampaign) {
    sectionParams.set('equipo', sectionCampaign.team_id);
    sectionParams.set('year', String(sectionCampaign.year));
    if (sectionCampaign.scope_key !== 'live') sectionParams.set('escenario', sectionCampaign.id);
  } else if (yearChoice) {
    sectionParams.set('year', String(yearChoice));
  }
  if (previewCode) sectionParams.set('verComo', previewCode);
  const sectionQuery = sectionParams.size ? '?' + sectionParams.toString() : '';
  const links = [
    ['eleccion', 'Vacaciones', CalendarDays],
    // Only for VA participants and administrators (server/va-census.ts).
    ...(index?.va?.entry ? [['antiguedad', 'Antigüedad', Award] as const] : []),
    ...(index?.principal.role === 'superadmin' || index?.principal.role === 'team_admin' || index?.va?.admin
      ? [['administracion', 'Administración', ShieldCheck] as const]
      : []),
    // Signed-in users only: the server refuses anonymous requests too.
    ...(index?.principal.id ? [['estadisticas', 'Estadísticas', BarChart3] as const] : []),
    ['ayuda', 'Ayuda', BookOpen],
  ] as const;
  // VA administration is a tab of «Administración», not a menu entry of its own.
  const isCurrent = (key: DashboardSection) => nav === key || (key === 'administracion' && nav === 'antiguedad-admin');
  async function go(n: DashboardSection, updateHistory = true) {
    if (n !== currentSection.current && !(await canNavigate())) return false;
    currentSection.current = n;
    setNav(n);
    setMenu(false);
    if (updateHistory && location.pathname !== sectionPaths[n]) {
      // Same query as the section links: the selected campaign and «verComo».
      // Before any campaign is selected, keep whatever the address already says.
      const url = new URL(sectionPaths[n] + (sectionQuery || location.search), location.href);
      const nextIndex = navigationIndex.current + 1;
      history.pushState({ ...history.state, vacationNavigationIndex: nextIndex }, '', url);
      navigationIndex.current = nextIndex;
    }
    lastSectionUrl.current = location.href;
    setSigninUrl('/signin-with-chatgpt?return_to=' + encodeURIComponent(location.pathname + location.search));
    return true;
  }
  const adminRole = index?.principal.role === 'superadmin' || ordinaryAdmin;
  // Who only administers VA lands on it straight from «Administración».
  const vaAdmin = !!index?.va?.admin && !previewCode,
    vaAdminView = vaAdmin && (nav === 'antiguedad-admin' || (nav === 'administracion' && !adminRole));
  useEffect(() => {
    // Direct /administracion loads and browser Back/Forward both use the same
    // path as a sidebar click. Do not fetch from go(): it would miss initial loads.
    // Refetch on each visit and after each change so recent activity stays current.
    if (nav !== 'administracion' || !adminRole) return;
    let cancelled = false;
    api('admin')
      .then((details) => {
        if (!cancelled) setAdmin(details);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [nav, adminRole, index?.principal.id, cid, data?.campaign.version]);
  useEffect(() => {
    const onPopState = async (event: PopStateEvent) => {
      const nextIndex = event.state?.vacationNavigationIndex;
      // Only the entry a cancelled navigation returned to is skipped; any other
      // popstate (the revert never fired, or the user moved again) is handled.
      const reverted = revertingTo.current;
      revertingTo.current = null;
      if (reverted !== null && reverted === nextIndex) return;
      if (navigationPending.current) return;
      navigationPending.current = true;
      try {
        const previous = currentSection.current;
        const next = sectionFromPath(location.pathname);
        const previousIndex = navigationIndex.current;
        const allowed = (next === previous && location.href === lastSectionUrl.current) || (await canNavigate());
        if (!allowed) {
          if (typeof nextIndex === 'number' && nextIndex !== previousIndex) {
            // Go back to the original entry, not replace the destination entry.
            revertingTo.current = previousIndex;
            history.go(previousIndex - nextIndex);
          } else {
            // Unknown browser entries have no dashboard index. Preserve the
            // destination entry rather than overwriting it with replaceState.
            history.pushState({ ...history.state, vacationNavigationIndex: previousIndex }, '', lastSectionUrl.current);
          }
        } else {
          currentSection.current = next;
          setNav(next);
          setMenu(false);
          if (typeof nextIndex === 'number') navigationIndex.current = nextIndex;
          // The entry also names a team, year and scenario: show what loading that URL would.
          if (currentIndex.current) {
            const selection = resolveLandingCampaign(currentIndex.current, location.search);
            setYearChoice(selection.year);
            const target = selection.campaignId ?? '';
            if (target !== currentCid.current) {
              currentCid.current = target;
              setCid(target);
            }
          }
          lastSectionUrl.current = location.href;
          setSigninUrl('/signin-with-chatgpt?return_to=' + encodeURIComponent(location.pathname + location.search));
        }
      } finally {
        navigationPending.current = false;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    if (!jumpToActivation || view !== 'administracion' || !canManage || data?.election?.state) return;
    const panel = document.getElementById('activation-panel') as HTMLDetailsElement | null;
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setJumpToActivation(false);
  }, [jumpToActivation, view, canManage, cid, data?.campaign.version]);
  const simulationName = data && data.campaign.scope_key !== 'live' ? data.campaign.simulation_name : '';
  return (
    <div
      className={
        'app' +
        (data && !canManage && view === 'eleccion' ? ' controller-ux' : '') +
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
            <button key={key} className={isCurrent(key) ? 'active' : ''} onClick={() => go(key)}>
              <Icon size={19} />
              {label}
              {isCurrent(key) && <ChevronRight size={15} />}
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
            <b>
              {nav === 'eleccion'
                ? 'Vacaciones'
                : nav === 'antiguedad'
                  ? 'Antigüedad'
                  : nav === 'administracion' || nav === 'antiguedad-admin'
                    ? 'Administración'
                    : nav === 'estadisticas'
                      ? 'Estadísticas'
                      : 'Ayuda'}
            </b>
          </span>
          <HeaderSession
            {...sessionDetails}
            onOpenMenu={() => {
              setMenu(true);
              document.getElementById('session-account')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          />
        </header>
        <nav className="section-navigation" aria-label="Ir a una sección">
          {links.map(([key, label]) => (
            <a
              key={key}
              href={sectionPaths[key] + sectionQuery}
              aria-current={isCurrent(key) ? 'page' : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                void go(key);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
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
                  : nav === 'antiguedad'
                    ? 'Vacaciones de antigüedad'
                    : vaAdminView
                      ? 'Administración de VA'
                      : nav === 'ayuda'
                        ? 'Ayuda y documentación'
                        : nav === 'estadisticas'
                          ? 'Estadísticas'
                          : superuser
                            ? 'Administración general'
                            : 'Administración del equipo'}
              </h1>
              <p>
                {nav === 'eleccion'
                  ? 'Elige en tu turno o prepara tu lista. Consulta lo que va quedando libre.'
                  : nav === 'antiguedad'
                    ? 'Tus días por antigüedad. Consulta el calendario, prepara tus preferencias y elige en tu turno.'
                    : vaAdminView
                      ? 'Censo de toda LECS, accesos, cupos de RRHH y turnos de elección.'
                      : nav === 'estadisticas'
                        ? 'Cómo avanza la elección en cada equipo y cuánto tarda cada turno.'
                        : 'Cada cambio se guarda en la campaña seleccionada.'}
              </p>
            </div>
            <div className="selectors" style={nav === 'antiguedad' || vaAdminView ? { display: 'none' } : undefined}>
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
                      history.replaceState(history.state, '', u);
                      lastSectionUrl.current = u.toString();
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
                      history.replaceState(history.state, '', u);
                      lastSectionUrl.current = u.toString();
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
          {adminRole && vaAdmin && (nav === 'administracion' || nav === 'antiguedad-admin') && (
            <nav className="va-tabs" aria-label="Tipo de administración">
              {(
                [
                  ['administracion', 'Ordinarias'],
                  ['antiguedad-admin', 'Antigüedad'],
                ] as const
              ).map(([key, label]) => (
                <a
                  key={key}
                  href={sectionPaths[key] + sectionQuery}
                  aria-current={nav === key ? 'page' : undefined}
                  onClick={(event) => {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    void go(key);
                  }}
                >
                  {label}
                </a>
              ))}
            </nav>
          )}
          {nav === 'ayuda' ? (
            <Help />
          ) : !index ? (
            <div className="panel empty">Cargando el espacio de trabajo…</div>
          ) : nav === 'estadisticas' ? (
            index.principal.id ? (
              <CampaignStats />
            ) : (
              <section className="panel empty">
                <BarChart3 size={32} />
                <h2>Estadísticas reservadas</h2>
                <p>Inicia sesión para consultar las estadísticas de las campañas.</p>
              </section>
            )
          ) : vaAdminView && !vaCampaignId ? (
            <VaCensusPanel />
          ) : nav === 'antiguedad' && !vaCampaignId ? (
            <VaSection admin={vaAdmin} viewAs={previewCode && team ? { team, code: previewCode } : null} />
          ) : nav === 'administracion' && !adminRole && !vaCampaignId ? (
            <section className="panel empty">
              <ShieldCheck size={32} />
              <h2>Administración reservada</h2>
              <p>
                {index.principal.id
                  ? 'Tu cuenta no tiene permisos de administración.'
                  : 'Inicia sesión con una cuenta de administración para gestionar los equipos.'}
              </p>
            </section>
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
                  <b>{team === 'va' ? 'Vacaciones de antigüedad · ' + year : 'Equipo ' + team + ' · ' + year}</b>
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
              {view === 'eleccion' &&
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
                        if (await go(vaCampaignId ? 'antiguedad-admin' : 'administracion')) setJumpToActivation(true);
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
                    <PersonalCalendarDownload data={data} />
                    <section className="panel">
                      <h2>Situación actual en PDF</h2>
                      <p className="muted">
                        {vaCampaignId
                          ? 'Se abre en el navegador; desde ahí puedes guardarlo o compartirlo.'
                          : data.campaign.scope_key === 'live'
                            ? 'Se abre en el navegador; desde ahí puedes guardarlo o compartirlo (por ejemplo, por WhatsApp). Muestra lo mismo que la consulta pública.'
                            : 'Se abre en el navegador con los datos de esta simulación, para probar cómo quedaría.'}
                      </p>
                      <div className="button-row">
                        {/* VA is not public: like simulations, it goes through the session. */}
                        {data.campaign.scope_key === 'live' && !vaCampaignId ? (
                          <a
                            className="secondary"
                            href={`/lite/pdf?equipo=${encodeURIComponent(team)}&year=${encodeURIComponent(year)}`}
                            target="_blank"
                            rel="noopener"
                            // Fresh URL per click: phone PDF viewers key their copy on the URL.
                            onClick={(e) => {
                              e.currentTarget.href = `/lite/pdf?equipo=${encodeURIComponent(team)}&year=${encodeURIComponent(year)}&t=${Date.now()}`;
                            }}
                          >
                            Ver PDF de la situación
                          </a>
                        ) : (
                          <button
                            className="secondary"
                            onClick={async () => {
                              // Simulations and VA are private: fetch with the session, then show the PDF in a new tab.
                              // The tab opens synchronously so the browser does not block it as a pop-up.
                              const tab = window.open('', '_blank');
                              try {
                                const response = await apiFetch('campaign/' + cid + '/pdf');
                                if (!response.ok) throw new Error('No se pudo generar el PDF');
                                const url = URL.createObjectURL(await response.blob());
                                if (tab) tab.location.href = url;
                                else location.href = url;
                                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                              } catch (e: unknown) {
                                tab?.close();
                                setError(e instanceof Error ? e.message : 'No se pudo generar el PDF');
                              }
                            }}
                          >
                            Ver PDF de la situación
                          </button>
                        )}
                      </div>
                      <div className="button-row">
                        <label>
                          Calendario individual de
                          <select
                            aria-label="Controlador para calendario PDF"
                            value={
                              data.members.some((m: { code: string }) => m.code === individualPdfCode)
                                ? individualPdfCode
                                : ''
                            }
                            onChange={(event) => setIndividualPdfCode(event.target.value)}
                          >
                            <option value="">Selecciona un controlador</option>
                            {data.members.map((member: { id: string; code: string }) => (
                              <option key={member.id} value={member.code}>
                                {member.code}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="secondary"
                          disabled={!data.members.some((m: { code: string }) => m.code === individualPdfCode)}
                          onClick={async () => {
                            const code = individualPdfCode;
                            const tab = window.open('', '_blank');
                            try {
                              // VA is not a public team: like simulations, it needs the session.
                              if (data.campaign.scope_key === 'live' && !vaCampaignId) {
                                const href = `/lite/individual-pdf?equipo=${encodeURIComponent(team)}&year=${encodeURIComponent(year)}&cta=${encodeURIComponent(code)}`;
                                if (tab) tab.location.href = href;
                                else window.location.href = href;
                              } else {
                                const response = await apiFetch(
                                  'campaign/' + cid + '/individual-pdf?cta=' + encodeURIComponent(code),
                                );
                                if (!response.ok) throw new Error('No se pudo generar el calendario individual');
                                const url = URL.createObjectURL(await response.blob());
                                if (tab) tab.location.href = url;
                                else window.location.href = url;
                                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                              }
                            } catch (e: unknown) {
                              tab?.close();
                              setError(e instanceof Error ? e.message : 'No se pudo generar el calendario individual');
                            }
                          }}
                        >
                          Ver calendario individual en PDF
                        </button>
                      </div>
                    </section>
                  </>
                ))}

              {/* The census, its accounts and HR's quotas stay with the VA campaign's administration. */}
              {vaCampaignId && view === 'administracion' && canManage && <VaCensusPanel />}
              {view === 'administracion' &&
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
                        {data.awards.length} de{' '}
                        {data.members.reduce(
                          (n: number, m: any) => n + (m.entitlement ?? data.config?.cyclesPerPerson ?? 6),
                          0,
                        )}{' '}
                        {unitWords(data.election?.policyPresentation).many} adjudicados
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
                        void go(vaCampaignId ? 'antiguedad' : 'eleccion').then((moved) => {
                          if (!moved)
                            setNotice('Elección activada. Ve a Vacaciones cuando termines con tus preferencias.');
                        });
                      }}
                    />
                    {/* VA keeps no ordinary parameters, roster edits nor HR workbook (ADR 0002). */}
                    {!vaCampaignId && (
                      <details id="campaign-config-panel" className="panel">
                        <summary>Parámetros del ejercicio</summary>
                        {data.config ? (
                          <ConfigForm
                            key={cid}
                            config={data.config}
                            scoringVersion={data.result.scoringVersion}
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
                    )}
                    {!vaCampaignId && (
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
                        previewImportRoster={(source: unknown) =>
                          api('campaign/' + cid, {
                            action: 'preview_import_roster',
                            source,
                            version: data.campaign.version,
                          })
                        }
                        importRoster={(source: unknown, review: ImportReview) =>
                          mutate(
                            {
                              action: 'import_roster',
                              source,
                              reviewToken: review.reviewToken,
                              acceptViolations: review.findings.length > 0,
                            },
                            'Plantilla y selecciones originales importadas',
                          )
                        }
                      />
                    )}
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
                        <h2>{vaCampaignId ? 'Cerrar o reabrir la campaña' : 'Cerrar o reabrir el equipo'}</h2>
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
                            {vaCampaignId ? 'Cerrar la campaña' : 'Cerrar equipo ' + team}
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || data.campaign.status === 'open'}
                            onClick={async () => {
                              if (await confirm('¿Reabrir esta campaña?'))
                                mutate({ action: 'reopen' }, 'Campaña reabierta');
                            }}
                          >
                            {vaCampaignId ? 'Reabrir la campaña' : 'Reabrir equipo ' + team}
                          </button>
                        </div>
                      </section>
                    }
                    {data.campaign.scope_key === 'live' && !vaCampaignId && (
                      <HrExportPanel
                        cid={cid}
                        team={team}
                        superuser={superuser}
                        busy={busy}
                        closed={data.campaign.status !== 'open'}
                        perform={perform}
                      />
                    )}
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
                          Empezar de cero cancela la elección en curso, elimina todas las adjudicaciones confirmadas,
                          solicitudes y preferencias, y vacía la cola del equipo. No hace falta pausar primero. Conserva
                          plantilla, configuración y resultados publicados. Para corregir solo la última adjudicación,
                          usa «Deshacer» en el historial de la elección.
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
                                  `ATENCIÓN: vas a cancelar la elección${data.election.state?.status === 'active' ? ' EN CURSO' : ''} del equipo ${team} (${year}). Se eliminarán TODAS las adjudicaciones ya confirmadas (${data.awards.length}), solicitudes, preferencias y la cola de turnos. No requiere pausa previa. El deshacer inmediato deja de estar disponible si otra operación cambia la campaña. La instantánea anterior queda en la auditoría para revisión, pero no existe recuperación automática de estados antiguos. ¿Quieres empezar de cero?`,
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
                            El método habitual es la copia v1 (un único JSON, que se restaura con el formulario
                            inferior; con el CLI: node scripts/admin-cli.mjs get backup --out copia.json). La copia
                            completa v2 es la alternativa para bases que no caben en una sola lectura: se escribe por
                            fragmentos en disco y conserva todo el historial. Si hay cambios durante la descarga se
                            cancela, sin presentar el parcial como una copia válida. Requiere un navegador con guardado
                            directo a disco (o el CLI). La restauración v2 se verifica fuera de línea con
                            scripts/restore-backup-v2.mjs.
                          </p>
                          <div className="button-row">
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={async () => {
                                let writable: FileSystemWritableFileStream | undefined;
                                try {
                                  const picker = (
                                    window as Window & {
                                      showSaveFilePicker?: (options: {
                                        suggestedName: string;
                                      }) => Promise<FileSystemFileHandle>;
                                    }
                                  ).showSaveFilePicker;
                                  if (!picker)
                                    throw new Error(
                                      'Usa el CLI: node scripts/admin-cli.mjs backup --out copia.ndjson. Este navegador no permite escritura acotada a disco.',
                                    );
                                  const handle = await picker({
                                    suggestedName:
                                      'vacaciones-copia-' + new Date().toISOString().slice(0, 10) + '.ndjson',
                                  });
                                  const writer = await handle.createWritable();
                                  writable = writer;
                                  setBusy(true);
                                  await downloadBackup(
                                    async (_method: string, path: string, body: unknown) => api(path, body),
                                    async (line: string) => writer.write(line),
                                  );
                                  await writer.close();
                                } catch (e: unknown) {
                                  if (writable) await writable.abort().catch(() => {});
                                  setError(e instanceof Error ? e.message : String(e));
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <Download size={16} /> Descargar copia completa v2
                            </button>
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
                    <p>Tu cuenta tiene permisos de {ordinaryAdmin ? 'responsable de equipo' : 'consulta'}.</p>
                  </div>
                ))}
            </>
          )}
          <footer>
            Vacaciones <span>·</span> Ocho equipos <span>·</span> Consulta pública{' '}
            <span className="footer-right">{busy ? 'Guardando…' : 'Datos persistentes · Campañas independientes'}</span>{' '}
            <a href="/lite">Versión sencilla para móviles antiguos</a>
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

export default function Page({ initialSection = 'eleccion' }: { initialSection?: DashboardSection }) {
  return (
    <ConfirmationProvider>
      <Dashboard initialSection={initialSection} />
    </ConfirmationProvider>
  );
}
