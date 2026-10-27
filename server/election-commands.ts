import {
  advanceAutomatic,
  choose,
  chooseJoint,
  currentTurn,
  defer,
  consumePreferences,
  validateElectionState,
  resolveTie,
  drawTie,
  registerJointAgreement,
  cancelJointAgreement,
  ELECTION_POLICY_VERSION,
  PREFERENCE_COLUMNS,
  PREFERENCE_MODES,
  MAX_WAIT_MINUTES,
  preferenceRow,
  cleanLabels,
  MAX_LABEL_LENGTH,
  type ElectionState,
  type Preference,
  type PreferenceMode,
  activeList,
  choiceIssues,
  type ElectionContext,
} from '../domain/election.ts';
import { cycleTable } from '../domain/vacations.ts';
import { earlyEntry, earlyProof } from '../domain/early-election.ts';
import { occupancyFor } from '../domain/policy.ts';
import { restoreStatements, validateSnapshot } from './campaign-snapshot.ts';
import { ApiError } from './errors.ts';
import { auditAfter } from './audit-context.ts';
import type { Principal } from './permissions.ts';
import type { Repository, Statement } from './repository.ts';
import type { ElectionService } from './election-service.ts';
import type { Service } from './service.ts';

export function resultDates(ctx: ElectionContext) {
  return cycleTable(ctx.year, ctx.team, ctx.config, [], []).map((c) => c.date);
}
// A list's content as its owner saved it, ignoring the active flag that awards consume.
function listContent(items: Preference[], id: string) {
  const p = items.find((item) => item.member_id === id);
  return p
    ? JSON.stringify({
        dates: p.dates,
        automatic: p.automatic !== false,
        persistent: p.persistent === true,
        mode: p.mode ?? 'immediate',
        waitMinutes: p.waitMinutes ?? 0,
        labels: p.labels ?? {},
      })
    : null;
}
// Lists for an undo/redo snapshot: the snapshot's copy when the content is unchanged
// (or it is the list being restored), otherwise the current list.
function restoredPreferences(prior: Preference[], current: Preference[], restoredMember: string | null): Preference[] {
  const ids = new Set([...prior, ...current].map((p) => p.member_id));
  return [...ids].flatMap((id) => {
    const keep =
      id === restoredMember || listContent(prior, id) === listContent(current, id)
        ? prior.find((p) => p.member_id === id)
        : current.find((p) => p.member_id === id);
    return keep ? [keep] : [];
  });
}

/**
 * Everything an election command reads, plus the working copy it edits. The pipeline
 * then persists `state`, `preferences` and `choices` in one CAS-protected batch.
 */
export type ElectionCommandContext = {
  service: ElectionService;
  repo: Repository;
  actor: Principal;
  cid: string;
  body: any;
  d: Awaited<ReturnType<Service['load']>>;
  c: Awaited<ReturnType<Service['load']>>['campaign'];
  ctx: ElectionContext;
  manage: boolean;
  mine: string | null;
  raw: { state: ElectionState | null; preferences: Preference[] };
  now: number;
  ops: Statement[];
  state: ElectionState | null;
  preferences: Preference[];
  /** New awards; an early choice brings its own id, already referenced by the state. */
  choices: { id?: string; member_id: string; cycle_date: string }[];
  recordUndo: boolean;
  /** Throws unless the actor may act for this member (own member, or a manager). */
  authorizeMember: (memberId: string) => void;
};
/**
 * One action of `ElectionService.mutate`. The pipeline checks preview, session, link,
 * open campaign, CAS version and reconstruction freeze, then the declared
 * preconditions in this order: live campaign, manager, configured election.
 */
export type ElectionCommand = {
  preconditions?: {
    /** Only on the real campaign. */
    liveOnly?: string;
    /** Only a team manager; the message to show otherwise. */
    manager?: string;
    /** Needs a configured election; the message to show otherwise. */
    state?: string;
  };
  /** Undo/redo restore their snapshot exactly: no preference flags, no new turn clock. */
  restoresSnapshot?: boolean;
  /** Restarts the turn clock (start and resume). */
  restartsClock?: boolean;
  /** Returns `{ changed: false }` when there is nothing to commit. */
  execute: (x: ElectionCommandContext) => Promise<void | { changed: false }> | void | { changed: false };
  /** Extra fields of the audit payload. */
  audited?: (x: ElectionCommandContext) => Record<string, unknown>;
};
export function electionPreconditionError(
  command: ElectionCommand,
  x: { live: boolean; manage: boolean; state: unknown },
) {
  const p = command.preconditions ?? {};
  if (p.liveOnly && !x.live) return { message: p.liveOnly, status: 400 };
  if (p.manager && !x.manage) return { message: p.manager, status: 403 };
  if (p.state && !x.state) return { message: p.state, status: 400 };
  return null;
}
export function electionCommandFor(action: unknown): ElectionCommand | undefined {
  return typeof action === 'string' && Object.hasOwn(ELECTION_COMMANDS, action) ? ELECTION_COMMANDS[action] : undefined;
}

async function executePreferences(x: ElectionCommandContext) {
  const { body, d, cid, ctx } = x;
  x.authorizeMember(body.memberId);
  if (!(await x.service.preferenceMemberIds(d, x.mine)).includes(body.memberId))
    throw new ApiError(
      'Las preferencias de un controlador con cuenta vinculada solo pueden modificarlas su titular o un superadministrador',
      403,
    );
  const dates = body.dates,
    validDates = new Set(resultDates(ctx));
  if (
    !Array.isArray(dates) ||
    dates.length > 100 ||
    dates.some((date) => typeof date !== 'string' || !validDates.has(date)) ||
    new Set(dates).size !== dates.length ||
    (body.persistent !== undefined && typeof body.persistent !== 'boolean')
  )
    throw new ApiError('Lista de preferencias no válida: usa ciclos del calendario, sin duplicados');
  // Older clients send no mode: their lists keep applying at once.
  const mode: PreferenceMode = body.mode ?? 'immediate',
    waitMinutes = mode === 'wait' ? body.waitMinutes : 0;
  if (
    !PREFERENCE_MODES.includes(mode) ||
    !Number.isInteger(waitMinutes) ||
    waitMinutes < 0 ||
    waitMinutes > MAX_WAIT_MINUTES ||
    (mode === 'wait' && waitMinutes < 1)
  )
    throw new ApiError('Indica un plazo de espera entre 1 minuto y 24 horas');
  const persistent = body.persistent === true,
    active = dates.length > 0;
  const labels = cleanLabels(body.labels, dates);
  if (!labels)
    throw new ApiError('Los nombres de los ciclos deben tener como mucho ' + MAX_LABEL_LENGTH + ' caracteres');
  const saved: Preference = {
    member_id: body.memberId,
    dates,
    automatic: true,
    persistent,
    active,
    mode,
    waitMinutes,
    labels,
  };
  x.preferences = [...x.preferences.filter((p) => p.member_id !== body.memberId), saved];
  x.ops.push({
    sql: `INSERT INTO preferences(${PREFERENCE_COLUMNS.join(',')}) VALUES(${PREFERENCE_COLUMNS.map(() => '?').join(',')}) ON CONFLICT(member_id) DO UPDATE SET dates_json=excluded.dates_json,automatic=excluded.automatic,persistent=excluded.persistent,active=excluded.active,mode=excluded.mode,wait_minutes=excluded.wait_minutes,labels_json=excluded.labels_json`,
    args: preferenceRow(saved, cid),
  });
}

function executeStart(x: ElectionCommandContext) {
  const { body, d, ctx, state } = x;
  if (d.config.cyclesPerPerson < 1 || d.config.cyclesPerPerson > 6)
    throw new ApiError('La elección admite entre uno y seis ciclos por persona');
  if (state && (d.awards.length || state.tieResolutions?.length))
    throw new ApiError('No cambies el orden después de comenzar a elegir');
  if (body.rulesConfirmed !== true || typeof body.allowDeferral !== 'boolean')
    throw new ApiError('Confirma las reglas de elección');
  const scores = d.config.previousScores,
    source = d.config.previousScoresSource;
  if (!scores || d.members.some((m) => !Number.isFinite(scores[m.code])) || !d.members.length)
    throw new ApiError('Faltan puntuaciones anteriores: complétalas en Administración antes de activar');
  if (typeof source !== 'string' || source.trim().length < 10)
    throw new ApiError('Indica y guarda el origen de las puntuaciones anteriores');
  const order = [...d.members].sort((a, b) => scores[a.code] - scores[b.code]).map((m) => m.id);
  const groups = new Map<number, string[]>();
  for (const id of order) {
    const m = d.members.find((candidate) => candidate.id === id),
      score = scores[m.code];
    groups.set(score, [...(groups.get(score) ?? []), id]);
  }
  const tieGroups = [...groups.values()].filter((group) => group.length > 1);
  const rules = occupancyFor(ctx.year);
  if (rules) {
    const feasibility = rules.canComplete(rules.state(ctx, ctx.members, ctx.awards));
    if (feasibility.status !== 'possible')
      throw new ApiError(
        'La campaña no tiene completación validada conforme a ' +
          rules.authority +
          ': ' +
          (feasibility.reason ?? feasibility.status),
      );
  }
  x.state = {
    status: 'active',
    order,
    cursor: 0,
    credits: {},
    source: source.trim(),
    allowDeferral: body.allowDeferral,
    policyVersion: ELECTION_POLICY_VERSION,
    tieGroups,
    pendingTieGroups: structuredClone(tieGroups),
    tieResolutions: [],
    jointGroups: [],
    jointAgreements: [],
  };
  validateElectionState(x.state, d.members);
}

function executeResolveTie(x: ElectionCommandContext) {
  const { body, ctx } = x,
    state = x.state!;
  const group =
    body.groupMemberIds === undefined
      ? currentTurn(ctx, state).pendingTie
      : Array.isArray(body.groupMemberIds)
        ? (state.pendingTieGroups ?? []).find(
            (pending: string[]) =>
              pending.length === body.groupMemberIds.length && pending.every((id) => body.groupMemberIds.includes(id)),
          )
        : undefined;
  if (!group) throw new ApiError('No hay un empate pendiente para el grupo indicado');
  if (!['random', 'external'].includes(body.method)) throw new ApiError('Método de sorteo no válido');
  x.state = resolveTie(
    ctx,
    state,
    body.method === 'random' ? drawTie(group) : body.order,
    body.method,
    x.actor.id!,
    new Date().toISOString(),
    body.groupMemberIds,
  );
  // The result must be visible and reviewable before an automatic choice uses it.
}

const executeJoint = (action: 'register_joint' | 'cancel_joint') => (x: ElectionCommandContext) => {
  const at = new Date().toISOString();
  x.state =
    action === 'register_joint'
      ? registerJointAgreement(x.ctx, x.state!, x.body.members, x.body.round, x.actor.id!, at)
      : cancelJointAgreement(x.ctx, x.state!, x.body.members, x.body.round, x.actor.id!, at);
};
const jointAudit = (x: ElectionCommandContext) => ({
  joint: { round: x.body.round, members: x.body.members, actor: x.actor.id, at: new Date().toISOString() },
});

const noOrder = 'El administrador debe confirmar el orden de elección primero';
function executeChoose(x: ElectionCommandContext) {
  const { body, ctx } = x;
  x.authorizeMember(body.memberId);
  if (!x.state) throw new ApiError(noOrder);
  if (!Array.isArray(body.dates) || body.dates.some((v: unknown) => typeof v !== 'string'))
    throw new ApiError('Selección no válida');
  const next = choose(ctx, x.state, body.memberId, body.dates);
  x.state = next.state;
  x.choices = next.choices;
  x.preferences = consumePreferences(x.preferences, [body.memberId]);
}
function executeChooseJoint(x: ElectionCommandContext) {
  if (!x.state) throw new ApiError(noOrder);
  const next = chooseJoint(x.ctx, x.state, x.body.entries);
  x.state = next.state;
  x.choices = next.choices;
  x.preferences = consumePreferences(
    x.preferences,
    x.body.entries.map((entry: { member_id: string }) => entry.member_id),
  );
}
function executeDefer(x: ElectionCommandContext) {
  x.authorizeMember(x.body.memberId);
  if (!x.state) throw new ApiError(noOrder);
  x.state = defer(x.ctx, x.state, x.body.memberId);
}

function executeAdvance(x: ElectionCommandContext) {
  // advanceAutomatic checks stored preferences and validates its chosen
  // cycles; do not perform an identical, expensive solver search beforehand.
  // Each successful advance still commits EXACTLY ONE undoable turn.
  const next = advanceAutomatic(x.ctx, x.state!, x.preferences, 1, x.now);
  if (!next.choices.length) {
    // No ordinary turn to apply: an immediate list may still choose ahead of time.
    const early = pendingEarlyListChoice(x.ctx, x.state!, x.preferences);
    if (!early) return { changed: false } as const;
    awardEarly(x, early.window, early.date);
    // Like an ordinary turn, the list is used up once it has chosen everything owed there.
    if (early.window.owed === 1) x.preferences = consumePreferences(x.preferences, [early.window.memberId]);
    return;
  }
  x.state = next.state;
  x.preferences = next.preferences;
  x.choices = next.choices;
}

async function executeLinkAccount(x: ElectionCommandContext) {
  const { body, d, c, actor, ops } = x;
  x.authorizeMember(body.memberId);
  x.recordUndo = false;
  const member = d.members.find((m) => m.id === body.memberId),
    existing = (await x.repo.all('SELECT * FROM controller_accounts WHERE person_id=?', [member.person_id]))[0];
  if ((existing?.version ?? 0) !== body.accountVersion)
    throw new ApiError('La vinculación cambió. Recarga antes de guardar.', 409);
  const subject = String(body.subject ?? '').trim(),
    provider = body.provider ?? 'chatgpt';
  const email = subject.toLowerCase();
  const isEmail =
    provider === 'chatgpt' &&
    /^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(email) &&
    email.length <= 250;
  const isFirebaseUid =
    provider === 'firebase' && subject.length <= 250 && subject.length > 0 && !/[\s\r\n:]/.test(subject);
  if ((subject && !isEmail && !isFirebaseUid) || !['chatgpt', 'firebase'].includes(provider))
    throw new ApiError('Introduce un correo válido de ChatGPT Sites o un UID de Firebase');
  if (
    c.scope_key === 'live' &&
    actor.role !== 'superadmin' &&
    existing?.principal_key &&
    existing.principal_key !== (provider === 'chatgpt' ? 'chatgpt-email:' + email : 'firebase:' + subject)
  )
    throw new ApiError('Solo el superadministrador puede sustituir una cuenta ya vinculada', 403);
  if (subject)
    ops.push({
      sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1) ON CONFLICT(person_id) DO UPDATE SET principal_key=excluded.principal_key,version=controller_accounts.version+1',
      args: [member.person_id, provider === 'chatgpt' ? 'chatgpt-email:' + email : 'firebase:' + subject],
    });
  else ops.push({ sql: 'DELETE FROM controller_accounts WHERE person_id=?', args: [member.person_id] });
}

const executeHistory = (action: 'election_undo' | 'election_redo') => async (x: ElectionCommandContext) => {
  const { body, d, c, cid, mine, actor, preferences } = x;
  const history = await x.service.managerHistory(cid, d, mine);
  const entry = action === 'election_undo' ? history.undo : history.redo;
  const privateDenied = 'Solo el titular o un superadministrador pueden restaurar preferencias de cuentas vinculadas';
  if (
    action === 'election_undo' &&
    entry?.id !== body.historyId &&
    history.done.some((e) => e.id === body.historyId && history.isPrivate(e))
  )
    throw new ApiError(privateDenied, 403);
  if (!entry || entry.id !== body.historyId)
    throw new ApiError('El cambio ya no está disponible para deshacer o rehacer', 409);
  const prior = validateSnapshot(JSON.parse(entry.before_json), 'election-undo-v1');
  if (!prior) throw new ApiError('La copia para deshacer no es válida', 409);
  // Restore the undone list edit itself and list flags (active) consumed by an
  // undone award; every other list keeps what its owner has saved since.
  const original = action === 'election_undo' ? entry : history.redoOriginal;
  const next = restoredPreferences(
    prior.preferences ?? [],
    preferences,
    original?.action === 'preferences' ? auditAfter(original)?.memberId : null,
  );
  // Linked accounts' private lists are protected.
  if (c.scope_key === 'live' && actor.role !== 'superadmin') {
    const linked = await x.repo.all(
      'SELECT m.id FROM campaign_members m JOIN controller_accounts a ON m.person_id=a.person_id WHERE m.campaign_id=?',
      [cid],
    );
    if (linked.some((m) => m.id !== mine && listContent(next, m.id) !== listContent(preferences, m.id)))
      throw new ApiError(privateDenied, 403);
  }
  // The undone awards take their early-choice entries with them.
  let state = prior.state ?? null;
  // Undo must leave the recovered turn editable, never automatically re-award it.
  // Redo restores the prior snapshot exactly (including the old pause state).
  if (action === 'election_undo' && state) state = { ...state, automaticPaused: true };
  x.state = state;
  x.preferences = next;
  x.ops.push(
    ...restoreStatements(cid, { awards: prior.awards, requests: prior.requests ?? d.requests, preferences: next }),
  );
};

const notYet = 'Todavía no puedes adelantar tu elección: solo cuando quede un único turno antes del tuyo';
function executeEarlyChoose(x: ElectionCommandContext) {
  const { body, ctx } = x;
  x.authorizeMember(body.memberId);
  if (!x.state) throw new ApiError(noOrder);
  if (typeof body.date !== 'string') throw new ApiError('Selección no válida');
  const proof = earlyProof(ctx, x.state, body.memberId, resultDates(ctx), { only: [body.date] });
  if (!proof) throw new ApiError(notYet, 409);
  if (!proof.guaranteed.includes(body.date))
    throw new ApiError(
      proof.indeterminate
        ? 'No se ha podido comprobar a tiempo que ese ciclo esté garantizado. Elígelo en tu turno.'
        : 'Ese ciclo no está garantizado frente a quien elige antes que tú',
      409,
    );
  awardEarly(x, proof.window, body.date);
  if (proof.window.owed === 1) x.preferences = consumePreferences(x.preferences, [body.memberId]);
}
function awardEarly(x: ElectionCommandContext, window: Parameters<typeof earlyEntry>[0], date: string) {
  const id = crypto.randomUUID();
  x.choices = [{ id, member_id: window.memberId, cycle_date: date }];
  x.state = {
    ...x.state!,
    earlyChoices: [...(x.state!.earlyChoices ?? []), earlyEntry(window, id, new Date(x.now).toISOString())],
  };
}
/**
 * Immediate lists choose ahead of time too: the FIRST still possible cycle of the list,
 * and only if it is guaranteed. A possible but unproved first cycle stops the list
 * (the next one is never taken instead); an impossible one gives way to the next.
 */
export function earlyListChoice(ctx: ElectionContext, state: ElectionState, pref: Preference, dates: string[]) {
  const owned = new Set(ctx.awards.filter((a) => a.member_id === pref.member_id).map((a) => a.cycle_date));
  for (const date of pref.dates) {
    if (owned.has(date) || choiceIssues(ctx, pref.member_id, [date]).length) continue;
    const proof = earlyProof(ctx, state, pref.member_id, dates, { only: [date] });
    return proof?.guaranteed.includes(date) ? { date, window: proof.window } : null;
  }
  return null;
}
/** The first immediate list that may choose ahead of time now, if any. */
export function pendingEarlyListChoice(ctx: ElectionContext, state: ElectionState, preferences: Preference[]) {
  if (state.status !== 'active' || state.automaticPaused) return null;
  const dates = resultDates(ctx);
  for (const pref of preferences) {
    if (!activeList(pref) || (pref.mode ?? 'immediate') !== 'immediate') continue;
    const found = earlyListChoice(ctx, state, pref, dates);
    if (found) return found;
  }
  return null;
}
function executeEarlyCancel(x: ElectionCommandContext) {
  const { body, ctx, cid, manage } = x;
  if (!x.state) throw new ApiError(noOrder);
  const entry = (x.state.earlyChoices ?? []).find((e) => e.awardId === body.awardId);
  const award = entry && ctx.awards.find((a) => a.id === entry.awardId);
  if (!entry || !award) throw new ApiError('Esa elección anticipada ya no existe', 404);
  x.authorizeMember(entry.memberId);
  // Its owner may withdraw it until their slot arrives; afterwards only a manager.
  const passed = x.state.status === 'complete' || currentTurn(ctx, x.state).state.cursor >= entry.cursor;
  if (!manage && passed) throw new ApiError('Tu turno ya ha llegado: pide al responsable que anule la elección', 403);
  x.state = {
    ...x.state,
    status: x.state.status === 'complete' ? 'active' : x.state.status,
    automaticPaused: passed ? true : x.state.automaticPaused,
    earlyChoices: x.state.earlyChoices!.filter((e) => e !== entry),
  };
  // The recovered right is offered at the next slot without replaying normal choices.
  if (passed) delete x.state.turnSince;
  x.ops.push(
    { sql: 'DELETE FROM awards WHERE id=? AND campaign_id=?', args: [award.id, cid] },
    {
      sql: 'DELETE FROM requests WHERE campaign_id=? AND member_id=? AND cycle_date=?',
      args: [cid, award.member_id, award.cycle_date],
    },
  );
}

function earlyAudit(x: ElectionCommandContext) {
  const entry = x.state?.earlyChoices?.find((e) => e.awardId === x.choices[0]?.id);
  return entry ? { early: true, memberId: entry.memberId, selectionCursor: entry.cursor, round: entry.round } : {};
}

const manager = (message: string, state?: string) => ({ manager: message, ...(state ? { state } : {}) });
const pauseOrResume = (status: 'paused' | 'active'): ElectionCommand => ({
  preconditions: manager('Solo el responsable puede pausar o reanudar la elección', 'No hay una elección configurada'),
  restartsClock: status === 'active',
  execute: (x) => {
    x.state = { ...x.state!, status };
  },
});

export const ELECTION_COMMANDS: Record<string, ElectionCommand> = {
  preferences: { execute: executePreferences },
  start: {
    preconditions: manager('Solo el responsable puede activar esta elección'),
    restartsClock: true,
    execute: executeStart,
  },
  resolve_tie: {
    preconditions: manager('Solo el responsable puede registrar el sorteo', 'No hay una elección configurada'),
    execute: executeResolveTie,
    audited: (x) => ({ resolution: x.state?.tieResolutions?.at(-1) }),
  },
  register_joint: {
    preconditions: manager(
      'Solo el responsable puede gestionar acuerdos de elección conjunta',
      'No hay una elección activa',
    ),
    execute: executeJoint('register_joint'),
    audited: jointAudit,
  },
  cancel_joint: {
    preconditions: manager(
      'Solo el responsable puede gestionar acuerdos de elección conjunta',
      'No hay una elección activa',
    ),
    execute: executeJoint('cancel_joint'),
    audited: jointAudit,
  },
  choose: { execute: executeChoose },
  choose_joint: {
    preconditions: manager('El turno conjunto requiere la confirmación del responsable'),
    execute: executeChooseJoint,
  },
  defer: { execute: executeDefer },
  pause: pauseOrResume('paused'),
  resume: pauseOrResume('active'),
  resume_automatic: {
    preconditions: manager('Solo el responsable del equipo puede reanudar los automatismos'),
    restartsClock: true,
    execute: (x) => {
      if (!x.state || x.state.status !== 'active' || !x.state.automaticPaused)
        throw new ApiError('No hay automatismos detenidos para reanudar');
      x.state = { ...x.state, automaticPaused: false };
    },
  },
  advance: {
    preconditions: { state: 'No hay una elección configurada' },
    execute: executeAdvance,
    audited: earlyAudit,
  },
  link_account: {
    preconditions: {
      liveOnly: 'Vincula las cuentas desde una campaña real',
      manager: 'Solo el responsable puede vincular cuentas',
    },
    execute: executeLinkAccount,
  },
  early_choose: { execute: executeEarlyChoose, audited: earlyAudit },
  early_cancel: {
    execute: executeEarlyCancel,
    audited: (x) => ({
      cancelled: x.body.awardId,
      memberId: x.d.awards.find((a: { id: string }) => a.id === x.body.awardId)?.member_id ?? null,
    }),
  },
  election_undo: {
    preconditions: manager('Solo el responsable del equipo puede deshacer o rehacer elecciones'),
    restoresSnapshot: true,
    execute: executeHistory('election_undo'),
    audited: (x) => ({ undoTargetId: x.body.historyId }),
  },
  election_redo: {
    preconditions: manager('Solo el responsable del equipo puede deshacer o rehacer elecciones'),
    restoresSnapshot: true,
    execute: executeHistory('election_redo'),
    audited: (x) => ({ redoTargetId: x.body.historyId }),
  },
};
