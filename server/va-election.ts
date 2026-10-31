import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';
import { canAdminVa, requireVaAdmin, type Principal } from './permissions.ts';
import { type Repository, type Statement } from './repository.ts';
import { calendar, iso, serial, type Config } from '../domain/calendar.ts';
import { vaDays, vaYears } from '../domain/va-entitlement.ts';
import {
  vaHistoryOps,
  vaControlsView,
  readVaReconstruction,
  vaControlMutation,
  validateVaRestoration,
} from './va-controls.ts';
import {
  vaAutomatic,
  vaAvailable,
  vaBalance,
  vaChoose,
  vaNext,
  vaStartRound,
  vaTurn,
  type VaElection,
  type VaParticipant,
  type VaPreference,
} from '../domain/va-election.ts';

type Stored = { year: number; version: number; json: string };
type Ordinary = { id: string; year: number; team_id: string; version: number; status: string; json: string };
type Body = {
  action?: string;
  version?: number;
  personId?: string;
  dates?: unknown;
  mode?: unknown;
  waitMinutes?: unknown;
  reason?: string;
  targetId?: string;
  people?: unknown;
  source?: { title?: unknown; sha256?: unknown };
  reviewToken?: string;
};
const validYear = (year: number) => {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError('Indica un ejercicio válido');
};
export function vaDates(value: unknown, year: number): string[] {
  if (!Array.isArray(value) || value.length > 366) throw new ApiError('Indica una lista de días');
  for (const d of value) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !d.startsWith(year + '-'))
      throw new ApiError('Fecha fuera del ejercicio');
    try {
      serial(d);
    } catch {
      throw new ApiError('Fecha no válida');
    }
  }
  if (new Set(value).size !== value.length) throw new ApiError('Hay días duplicados');
  return value;
}
async function stored(repo: Repository, year: number) {
  validYear(year);
  return (await repo.all<Stored>('SELECT * FROM va_campaigns WHERE year=?', [year]))[0] ?? null;
}
async function ordinary(repo: Repository, year: number) {
  return repo.all<Ordinary>(
    `SELECT c.id,c.year,c.team_id,c.version,c.status,p.json FROM campaigns c
     JOIN parameters p ON p.campaign_id=c.id WHERE c.year=? AND c.scope_key='live' ORDER BY c.team_id`,
    [year],
  );
}
async function context(repo: Repository, year: number) {
  const campaigns = await ordinary(repo, year);
  // The last ordinary cycle of December can continue into the VA year.
  const related = [...(await ordinary(repo, year - 1)), ...campaigns];
  const blocked: Record<string, Set<string>> = {};
  for (const c of related) {
    const cycles = new Map(calendar(c.year, c.team_id, JSON.parse(c.json) as Config).map((d) => [d.date, d.end]));
    const awards = await repo.all<{ person_id: string; cycle_date: string }>(
      'SELECT m.person_id,a.cycle_date FROM awards a JOIN campaign_members m ON m.id=a.member_id WHERE a.campaign_id=?',
      [c.id],
    );
    for (const a of awards) {
      const end = cycles.get(a.cycle_date);
      if (!end) throw new ApiError('Una adjudicación ordinaria no pertenece al calendario; revisa ' + c.team_id);
      const dates = (blocked[a.person_id] ??= new Set());
      for (let d = serial(a.cycle_date); d <= serial(end); d++) dates.add(iso(d));
    }
  }
  const quotas = Object.fromEntries(
    (await repo.all<{ date: string; places: number }>('SELECT date,places FROM va_quotas WHERE year=?', [year])).map(
      (r) => [r.date, r.places],
    ),
  );
  const [source] = await repo.all<{ version: number }>('SELECT version FROM va_quota_sources WHERE year=?', [year]);
  return { campaigns, related, blocked, quotas, quotaVersion: source?.version ?? 0 };
}
function assertion(sql: string, args: unknown[], ordinaryConflict = false): Statement[] {
  const id = crypto.randomUUID();
  if (ordinaryConflict)
    return [
      {
        sql: `INSERT INTO va_integrity_assertions(id,valid) VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,
        args: [id, ...args],
      },
      { sql: 'DELETE FROM va_integrity_assertions WHERE id=?', args: [id] },
    ];
  return [
    {
      sql: `INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (${sql}) THEN ? ELSE NULL END)`,
      args: [...args, id],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [id] },
  ];
}
async function save(
  repo: Repository,
  actor: Principal,
  before: Stored | null,
  state: VaElection,
  guards: Statement[],
  action: string,
  detail: unknown,
  at: string,
  extraOps: Statement[] = [],
) {
  const version = before?.version ?? 0;
  const ops: Statement[] = [
    ...guards,
    before
      ? {
          sql: 'UPDATE va_campaigns SET json=?,version=version+1 WHERE year=? AND version=?',
          args: [JSON.stringify(state), state.year, version],
        }
      : {
          sql: 'INSERT INTO va_campaigns(year,version,json) VALUES(?,1,?) ON CONFLICT(year) DO NOTHING',
          args: [state.year, JSON.stringify(state)],
        },
    ...assertion('changes()=1', []),
    ...vaHistoryOps(
      before?.json ?? null,
      state,
      action === 'preferences' &&
        before &&
        (JSON.parse(before.json) as VaElection).choices.length !== state.choices.length
        ? 'advance'
        : action,
      actor.id,
      at,
    ),
    ...extraOps,
    append({
      id: crypto.randomUUID(),
      actor: actor.id,
      action: 'va_election',
      before: { year: state.year, version },
      after: { year: state.year, action, detail, version: version + 1 },
      createdAt: at,
    }),
    { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
  ];
  try {
    await repo.batch(ops);
  } catch (error) {
    if (String(error).includes('transaction_assertions'))
      throw new ApiError('Los datos cambiaron; recarga y revisa tu selección', 409);
    throw error;
  }
}
async function owner(repo: Repository, actor: Principal, state: VaElection) {
  if (!actor.id) return null;
  const keys = [actor.id, actor.emailKey].filter((k): k is string => !!k);
  const rows = await repo.all<{ person_id: string }>(
    `SELECT person_id FROM controller_accounts WHERE principal_key IN (${keys.map(() => '?').join(',')})
     UNION SELECT person_id FROM va_external_accounts WHERE principal_key IN (${keys.map(() => '?').join(',')})`,
    [...keys, ...keys],
  );
  return state.people.find((p) => rows.some((r) => r.person_id === p.id))?.id ?? null;
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function masterRows(repo: Repository, year: number) {
  const people = await repo.all<{
    id: string;
    code: string;
    label: string;
    team_id: string;
    controller_number: number | null;
    seniority: string;
  }>('SELECT id,code,label,team_id,controller_number,seniority FROM people WHERE active=1 ORDER BY id');
  const members = await repo.all<{ person_id: string; code: string; label: string; team_id: string }>(
    `SELECT m.person_id,m.code,m.label,c.team_id FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id
     WHERE c.year=? AND c.scope_key='live' ORDER BY c.team_id,m.position,m.code`,
    [year],
  );
  const external = await repo.all<(typeof people)[number]>(
    "SELECT id,code,label,'' AS team_id,controller_number,seniority FROM va_external_people WHERE active=1 ORDER BY id",
  );
  return [
    ...people.map((p) => {
      const m = members.find((r) => r.person_id === p.id);
      return m ? { ...p, code: m.code, label: m.label, team_id: m.team_id } : p;
    }),
    ...external,
  ];
}
/** Censo explicitly ordered by RRHH. The preview never creates or opens a campaign. */
export async function importVaElection(repo: Repository, actor: Principal, year: number, body: Body) {
  requireVaAdmin(actor);
  validYear(year);
  const before = await stored(repo, year);
  if (before && (JSON.parse(before.json) as VaElection).status !== 'preparation')
    throw new ApiError('El censo está congelado desde la apertura');
  if (!['preview', 'apply'].includes(body.action ?? '')) throw new ApiError('Usa preview o apply');
  if (
    !Array.isArray(body.people) ||
    !body.people.length ||
    body.people.length > 500 ||
    body.people.some((p) => typeof p !== 'string') ||
    new Set(body.people).size !== body.people.length
  )
    throw new ApiError('Indica los identificadores de personas en el orden de RRHH, sin duplicados');
  const source = body.source;
  if (
    typeof source?.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 160 ||
    typeof source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw new ApiError('Indica el título y SHA-256 de la fuente del censo');
  const master = await masterRows(repo, year);
  const people: VaParticipant[] = (body.people as string[]).map((id) => {
    const p = master.find((r) => r.id === id);
    if (!p || !p.controller_number || !vaDays(vaYears(p.seniority, year)))
      throw new ApiError('Persona sin datos validados o sin derecho: ' + id);
    return {
      id,
      code: p.code,
      label: p.label,
      team: p.team_id,
      controllerNumber: p.controller_number,
      seniority: p.seniority,
      days: vaDays(vaYears(p.seniority, year)),
    };
  });
  if (new Set(people.map((p) => p.controllerNumber)).size !== people.length)
    throw new ApiError('Números de empleado duplicados');
  const omitted = master.filter((p) => vaDays(vaYears(p.seniority, year)) > 0 && !people.some((r) => r.id === p.id));
  const warnings = people.flatMap((p, i) =>
    i && p.controllerNumber < people[i - 1].controllerNumber
      ? [p.code + ' no sigue el número de empleado ascendente']
      : [],
  );
  const state: VaElection = {
    format: 'va-election-v1',
    year,
    status: 'preparation',
    round: 1,
    people,
    queue: [],
    cursor: 0,
    choices: [],
    preferences: before ? (JSON.parse(before.json) as VaElection).preferences : {},
    turnStartedAt: null,
    pausedAt: null,
    deferrals: {},
    deferredTargets: {},
    source: { title: source.title.trim(), sha256: source.sha256 },
  };
  // The review binds the whole master census too: omissions cannot change unnoticed.
  const reviewToken = await digest({ state, master, version: before?.version ?? 0 });
  const report = { year, people, warnings, omitted: omitted.map((p) => ({ id: p.id, code: p.code })), reviewToken };
  if (body.action === 'preview') return report;
  if (body.reviewToken !== reviewToken) throw new ApiError('Revisa de nuevo el censo antes de aplicarlo', 409);
  // Concurrent master updates invalidate this import in the same transaction.
  const revision = (await repo.all<{ revision: number }>("SELECT revision FROM app_state WHERE id='main'"))[0]
    ?.revision;
  if (
    (await digest({
      state,
      master: await masterRows(repo, year),
      version: before?.version ?? 0,
    })) !== reviewToken
  )
    throw new ApiError('Las fichas cambiaron; revisa de nuevo', 409);
  await save(
    repo,
    actor,
    before,
    state,
    assertion("(SELECT revision FROM app_state WHERE id='main')=?", [revision]),
    'import',
    { source: state.source, order: people.map((p) => p.id), warnings },
    new Date().toISOString(),
  );
  return { ...report, applied: true };
}
export async function vaElectionView(repo: Repository, actor: Principal, year: number) {
  const row = await stored(repo, year);
  const admin = canAdminVa(actor);
  if (!row) return { year, version: 0, state: null, admin, me: null };
  let state = JSON.parse(row.json) as VaElection;
  const control = admin ? await vaControlsView(repo, year) : null;
  const reconstruction = await readVaReconstruction(repo, year);
  if (reconstruction && admin)
    state = { ...JSON.parse(reconstruction.working_json), preferences: state.preferences } as VaElection;
  const me = await owner(repo, actor, state);
  const ctx = await context(repo, year);
  return {
    year,
    version: row.version,
    admin,
    me,
    control,
    reconstructing: !!reconstruction,
    census: admin ? state.people : undefined,
    state: {
      status: state.status,
      round: state.round,
      turn: vaTurn(state),
      turnStartedAt: state.turnStartedAt,
      automaticPaused: state.automaticPaused ?? false,
      queue: state.queue.slice(state.cursor),
      people: state.people.map((p) => ({
        id: p.id,
        code: p.code,
        label: admin || p.id === me ? p.label : '',
        days: admin || p.id === me ? p.days : null,
        balance: admin || p.id === me ? vaBalance(state, p.id) : null,
      })),
      choices: state.choices,
      deferrals: admin ? state.deferrals : {},
      source: admin ? state.source : undefined,
    },
    quotas: ctx.quotas,
    available: Object.fromEntries(Object.keys(ctx.quotas).map((d) => [d, vaAvailable(state, ctx.quotas, d)])),
    preference: me ? (state.preferences[me] ?? { dates: [], mode: 'manual', waitMinutes: 0 }) : null,
    ordinaryDays: me ? [...(ctx.blocked[me] ?? [])] : [],
    turnOrdinaryDays: admin && vaTurn(state) ? [...(ctx.blocked[vaTurn(state)!] ?? [])] : [],
    ordinaryClosed: ctx.campaigns.length > 0 && ctx.campaigns.every((c) => c.status === 'closed'),
  };
}
export async function mutateVaElection(
  repo: Repository,
  actor: Principal,
  year: number,
  body: Body,
  time = new Date(),
) {
  const row = await stored(repo, year);
  if (!row) throw new ApiError('Carga primero el censo ordenado de RRHH', 409);
  if (body.version !== row.version) throw new ApiError('La campaña cambió; recarga antes de confirmar', 409);
  const state = JSON.parse(row.json) as VaElection;
  const me = await owner(repo, actor, state),
    admin = canAdminVa(actor),
    action = body.action;
  if (!actor.id || (!admin && !me)) throw new ApiError('No tienes permiso para esta campaña', 403);
  if (!['choose', 'preferences', 'advance'].includes(action ?? '')) requireVaAdmin(actor);
  if (action === 'advance' && !admin && !me) throw new ApiError('No autorizado', 403);
  const ctx = await context(repo, year),
    at = time.toISOString();
  const reason = typeof body.reason === 'string' && body.reason.length <= 500 ? body.reason.trim() : '';
  const guards = assertion('COALESCE((SELECT version FROM va_quota_sources WHERE year=?),0)=?', [
    year,
    ctx.quotaVersion,
  ]);
  guards.push(
    ...assertion("(SELECT COUNT(*) FROM campaigns WHERE year BETWEEN ? AND ? AND scope_key='live')=?", [
      year - 1,
      year,
      ctx.related.length,
    ]),
  );
  for (const c of ctx.related)
    guards.push(...assertion('(SELECT version FROM campaigns WHERE id=?)=?', [c.id, c.version]));
  let detail: unknown = null;
  try {
    const controlled = admin
      ? await vaControlMutation(repo, state, body, actor.id!, ctx.quotas, ctx.blocked, (v) => vaDates(v, year), at)
      : null;
    if (controlled) {
      validateVaRestoration(controlled.state, ctx.quotas, ctx.blocked);
      await save(repo, actor, row, controlled.state, guards, action!, controlled.detail, at, controlled.ops);
      return vaElectionView(repo, actor, year);
    }
    if (await readVaReconstruction(repo, year)) {
      if (action === 'advance') return vaElectionView(repo, actor, year);
      if (action !== 'preferences') throw new ApiError('La elección está bloqueada mientras se reconstruye', 409);
    }
    if (action === 'preferences') {
      if (!me || state.status === 'completed')
        throw new ApiError('Las preferencias solo las edita su titular durante la campaña', 403);
      const dates = vaDates(body.dates, year);
      if (typeof body.mode !== 'string' || !['manual', 'immediate', 'after_wait'].includes(body.mode))
        throw new ApiError('Modo de preferencias no válido');
      const waitMinutes = body.waitMinutes ?? 0;
      if (
        typeof waitMinutes !== 'number' ||
        !Number.isInteger(waitMinutes) ||
        waitMinutes < 0 ||
        waitMinutes > 1440 ||
        (body.mode === 'after_wait' && waitMinutes < 1)
      )
        throw new ApiError('Indica una espera entre 1 y 1440 minutos');
      state.preferences[me] = { dates, mode: body.mode as VaPreference['mode'], waitMinutes };
      detail = { personId: me, mode: body.mode, waitMinutes, dates };
    } else if (action === 'start' || action === 'round2') {
      if (!ctx.campaigns.length || ctx.campaigns.some((c) => c.status !== 'closed'))
        throw new ApiError('Cierra las campañas ordinarias del ejercicio antes de abrir VA');
      if (!ctx.quotaVersion || !Object.values(ctx.quotas).some((n) => n > 0))
        throw new ApiError('Carga los cupos de RRHH antes de abrir');
      vaStartRound(state, action === 'start' ? 1 : 2, at);
    } else if (action === 'choose') {
      const personId = admin ? (body.personId ?? me) : me;
      if (!personId || (!admin && body.personId && body.personId !== me))
        throw new ApiError('Solo puedes elegir para ti', 403);
      const dates = vaDates(body.dates, year);
      vaChoose(state, personId, dates, ctx.quotas, ctx.blocked[personId] ?? new Set(), at);
      detail = { personId, dates, delegated: personId !== me };
    } else if (action === 'pause') {
      if (state.status !== 'running') throw new ApiError('La elección no está en curso');
      state.status = 'paused';
      state.pausedAt = at;
    } else if (action === 'resume') {
      if (state.status !== 'paused') throw new ApiError('La elección no está pausada');
      if (state.turnStartedAt && state.pausedAt)
        state.turnStartedAt = new Date(
          Date.parse(state.turnStartedAt) + time.getTime() - Date.parse(state.pausedAt),
        ).toISOString();
      state.pausedAt = null;
      state.status = 'running';
    } else if (action === 'skip') {
      if (state.status !== 'running' || !reason) throw new ApiError('Indica el motivo para saltar el turno en curso');
      detail = { personId: vaTurn(state), reason };
      vaNext(state, at);
    } else if (action === 'defer') {
      if (state.status !== 'running' || !reason) throw new ApiError('Indica el motivo del aplazamiento');
      const from = state.queue.indexOf(body.personId ?? ''),
        target = state.queue.indexOf(body.targetId ?? '');
      if (from < state.cursor || target <= from) throw new ApiError('El destino debe ser un turno posterior pendiente');
      if (state.deferredTargets[body.targetId!] || Object.values(state.deferredTargets).includes(body.personId!))
        throw new ApiError('No se pueden encadenar grupos aplazados; revisa el grupo con la administración');
      if (
        Object.entries(state.deferredTargets).filter(
          ([id, targetId]) => id !== body.personId && targetId === body.targetId,
        ).length >= 2
      )
        throw new ApiError('La elección conjunta admite como máximo tres personas');
      const [id] = state.queue.splice(from, 1);
      state.queue.splice(target, 0, id);
      state.deferrals[id] = reason;
      state.deferredTargets[id] = body.targetId!;
      if (from === state.cursor) state.turnStartedAt = at;
      detail = { personId: id, targetId: body.targetId, reason };
    } else if (action !== 'advance') throw new ApiError('Acción de VA no válida');
    if (state.status === 'round_complete') vaStartRound(state, 2, at);
    const automatic =
      action === 'preferences' && (await readVaReconstruction(repo, year))
        ? []
        : vaAutomatic(state, ctx.quotas, ctx.blocked, at);
    if (action === 'advance' && !automatic.length) return vaElectionView(repo, actor, year);
    detail = { input: detail, automatic };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error instanceof Error ? error.message : 'Elección no válida');
  }
  await save(repo, actor, row, state, guards, action!, detail, at);
  return vaElectionView(repo, actor, year);
}
/** Called by the existing dispatcher, so personal wait timers also work with no page open. */
export async function advanceVaElections(repo: Repository, time = new Date()) {
  let applied = 0;
  const rows = await repo.all<Stored>('SELECT * FROM va_campaigns');
  for (const row of rows) {
    if ((JSON.parse(row.json) as VaElection).status !== 'running') continue;
    const view = await mutateVaElection(
      repo,
      { id: 'system:va', role: 'superadmin', teams: [] },
      row.year,
      { action: 'advance', version: row.version },
      time,
    );
    if (view.version !== row.version) applied++;
  }
  return { applied };
}

/** Assertions run after ordinary writes, inside their transaction. Reopened ordinary
 * campaigns may change only if their resulting awards do not overlap a VA day.
 */
export async function vaOrdinaryGuards(repo: Repository, statements: Statement[]): Promise<Statement[]> {
  if (
    !statements.some((s) =>
      /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:awards|parameters|campaign_members|campaigns)\b/i.test(s.sql),
    )
  )
    return [];
  const campaigns = await repo.all<Ordinary>(
    `SELECT c.id,c.year,c.team_id,c.version,c.status,p.json FROM campaigns c JOIN parameters p ON p.campaign_id=c.id WHERE c.scope_key='live'
       AND EXISTS (SELECT 1 FROM va_campaigns v
         WHERE v.year IN (c.year,c.year+1) AND json_array_length(v.json,'$.choices')>0)`,
  );
  return campaigns.flatMap((c) => {
    // Config edits and roster imports can change cycle boundaries in this same
    // batch. Validate the resulting calendar, rather than its previous version.
    let config = c.json;
    for (const statement of statements) {
      if (
        statement.sql === 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?' &&
        statement.args?.[1] === c.id
      )
        config = String(statement.args[0]);
    }
    const cycles = calendar(c.year, c.team_id, JSON.parse(config) as Config);
    // Every calendar fits under D1's 100-bound-parameter limit.
    return assertion(
      `NOT EXISTS(SELECT 1 FROM awards a JOIN campaign_members m ON m.id=a.member_id
      JOIN va_campaigns v ON v.year IN (?,?) JOIN json_each(v.json,'$.choices') j
      WHERE a.campaign_id=? AND json_extract(j.value,'$.personId')=m.person_id
      AND json_extract(j.value,'$.date') BETWEEN a.cycle_date AND
      CASE a.cycle_date ${cycles.map(() => 'WHEN ? THEN ?').join(' ')} END)`,
      [c.year, c.year + 1, c.id, ...cycles.flatMap((d) => [d.date, d.end])],
      true,
    );
  });
}
