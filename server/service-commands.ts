import { calendar, validateConfig, serial, ENGINE_VERSION, type Config } from '../domain/calendar.ts';
import { calculate } from '../domain/vacations.ts';
import { occupancyFor, campaignOf } from '../domain/policy.ts';
import { VACATIONS_UNDO_FORMAT } from '../domain/events.ts';
import { PREFERENCE_COLUMNS, preferenceRow } from '../domain/election.ts';
import { grantsIndividualEntitlements } from '../domain/hr-calendars.ts';
import { ApiError } from './errors.ts';
import { cas, insertRows, type Repository, type Statement } from './repository.ts';
import { validateRoster, rowStatements } from './roster.ts';
import { electionStateStatement } from './election-service.ts';
import { requireWrite, type Principal } from './permissions.ts';
import type { Service } from './service.ts';
const id = () => crypto.randomUUID(),
  now = () => new Date().toISOString();

export function checkedConfig(config: Config, year: number) {
  try {
    return validateConfig(config, year);
  } catch (e: any) {
    throw new ApiError(e.message ?? 'Parámetros no válidos');
  }
}
export function checkedDate(value: string) {
  try {
    return serial(value);
  } catch {
    throw new ApiError('Fecha no válida');
  }
}
// Previous scores and RRHH exceptions are keyed by nick: a rename carries them along.
// Renames apply simultaneously, so swapping two nicks keeps each entry with its person.
export function renameConfigCodes(config: Config, renames: [string, string][]): Config | null {
  const to = new Map(renames);
  if (
    ![config.previousScores, config.individualEntitlements].some(
      (map) => map && Object.keys(map).some((k) => to.has(k)),
    )
  )
    return null;
  const rename = <T>(map: Record<string, T> | undefined) =>
    map && Object.fromEntries(Object.entries(map).map(([k, v]) => [to.get(k) ?? k, v]));
  return {
    ...config,
    ...(config.previousScores ? { previousScores: rename(config.previousScores) } : {}),
    ...(config.individualEntitlements ? { individualEntitlements: rename(config.individualEntitlements) } : {}),
  };
}

/** Everything a command may read while it builds the transaction. `ops` already holds the campaign CAS. */
export type CommandContext = {
  service: Service;
  repo: Repository;
  actor: Principal;
  cid: string;
  body: any;
  d: Awaited<ReturnType<Service['load']>>;
  c: any;
  rules: ReturnType<typeof occupancyFor>;
  election: Awaited<ReturnType<ReturnType<Service['election']>['read']>>;
  renameOnly: boolean;
  ops: Statement[];
};
export type CommandResult = { before: any; after: any };
/**
 * One administrative action of `Service.mutate`. The pipeline loads the campaign,
 * checks permission, the reconstruction freeze and the CAS version, then applies
 * the declared preconditions before `execute`; validation lives in `execute` because
 * most checks need the same reads that build the statements.
 */
export type Command = {
  preconditions: {
    /** While the election is active: 'allowed', only in simulations, or 'blocked' (pause first). */
    activeElection: 'allowed' | 'simulation' | 'blocked';
    /** May run on a closed or published campaign. */
    closedCampaign: boolean;
    /** Only on the real campaign, never on a simulation. */
    liveOnly?: string;
    /** Edits that only relabel stable ids: they neither need a pause nor reset the election. */
    renameOnly?: (body: any, d: CommandContext['d']) => boolean;
  };
  /** Stores the vacations snapshot that undo/redo restores. */
  vacationsUndo?: boolean;
  /** What happens to the election afterwards: kept, reset, or a command-specific effect. */
  election: 'keep' | 'reset' | ((ctx: CommandContext) => Promise<void> | void);
  execute: (ctx: CommandContext) => Promise<CommandResult>;
  /** Final touch on the audit payload, once the election effect is in place. */
  audited?: (ctx: CommandContext, after: any) => any;
};
type Conditions = { electionActive: boolean; closed: boolean; live: boolean; renameOnly: boolean };
/** The common preconditions, in the order the pipeline applies them. Null when the action may run. */
export function preconditionError(command: Command | undefined, s: Conditions): string | null {
  const guard = command?.preconditions.activeElection ?? 'blocked';
  if (s.electionActive && !s.renameOnly && guard !== 'allowed' && !(guard === 'simulation' && !s.live))
    return 'Pausa la elección antes de corregir datos o cambiar la plantilla';
  if (s.closed && !command?.preconditions.closedCampaign)
    return 'La campaña está cerrada. Un superadministrador puede reabrirla.';
  if (command?.preconditions.liveOnly && !s.live) return command.preconditions.liveOnly;
  return null;
}
export function commandFor(action: unknown): Command | undefined {
  return typeof action === 'string' && Object.hasOwn(COMMANDS, action) ? COMMANDS[action] : undefined;
}

async function executeResetVacations(ctx: CommandContext): Promise<CommandResult> {
  const { cid, body, c, ops } = ctx;
  const before: any = null;
  let after: any = body;
  if (body.confirmation !== `${c.team_id}-${c.year}`)
    throw new ApiError('Confirma el equipo y ejercicio antes de empezar de cero');
  ops.push(
    { sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] },
    { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
  );
  after = { requests: 0, awards: 0 };
  return { before, after };
}

const executeUndoVacations =
  (action: string) =>
  async (ctx: CommandContext): Promise<CommandResult> => {
    const { service, repo, actor, cid, body, d, c, election, ops } = ctx;
    const before: any = null;
    let after: any = body;
    const entry = await service.vacationUndo(cid, c.version);
    if (!entry || entry.id !== body.undoId || (action === 'redo_vacations') !== (entry.action === 'undo_vacations'))
      throw new ApiError('El cambio ya no se puede deshacer. Recarga la campaña.', 409);
    const snapshot = JSON.parse(entry.before_json!);
    if (!Array.isArray(snapshot.awards))
      throw new ApiError('La copia para deshacer carece de adjudicaciones verificables', 409);
    // The target is a prior committed snapshot protected by the campaign
    // version CAS. Rechecking global completion here is unnecessary and
    // can make undo unusably slow; new awards are still validated normally.
    // Undo/redo may restore a full preference snapshot. Do not let a delegated
    // administrator overwrite linked controllers' preferences through this route.
    if (c.scope_key === 'live' && actor.role !== 'superadmin' && snapshot.election) {
      const mine = await service.election().memberForAccount(d);
      const linked = await repo.all(
        'SELECT m.id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE m.campaign_id=?',
        [cid],
      );
      const previous = snapshot.election.preferences ?? [],
        current = election.preferences;
      if (
        linked.some(
          (m: any) =>
            m.id !== mine &&
            JSON.stringify(previous.find((p: any) => p.member_id === m.id) ?? null) !==
              JSON.stringify(current.find((p: any) => p.member_id === m.id) ?? null),
        )
      )
        throw new ApiError(
          'Solo el titular o un superadministrador pueden restaurar preferencias de cuentas vinculadas',
          403,
        );
    }
    ops.push(
      { sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
    );
    for (const r of snapshot.requests)
      ops.push({
        sql: 'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,?)',
        args: [r.id, cid, r.member_id, r.slot, r.cycle_date, r.version],
      });
    for (const a of snapshot.awards)
      ops.push({
        sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,?)',
        args: [a.id, cid, a.member_id, a.cycle_date, a.version],
      });
    after = { undone: entry.id };
    return { before, after };
  };

async function executeConfig(ctx: CommandContext): Promise<CommandResult> {
  const { cid, body, d, c, rules, election, ops } = ctx;
  let before: any = null;
  let after: any = body;
  const cfg = checkedConfig(body.config, c.year);
  if (rules) {
    const known = new Set(d.members.map((m: any) => m.code));
    for (const code of Object.keys(cfg.individualEntitlements ?? {}))
      if (!known.has(code))
        throw new ApiError(
          'La excepción de RRHH hace referencia a un controlador inexistente en esta plantilla: ' + code,
        );
    if (election.state) {
      const normalize = (items: Record<string, unknown> | undefined) =>
        JSON.stringify(Object.entries(items ?? {}).sort(([a], [b]) => a.localeCompare(b)));
      if (
        normalize(d.config.individualEntitlements) !== normalize(cfg.individualEntitlements) ||
        normalize(d.config.specialQuotas) !== normalize(cfg.specialQuotas) ||
        d.config.cyclesPerPerson !== cfg.cyclesPerPerson
      )
        throw new ApiError(
          'Los derechos individuales y cupos de RRHH se congelan al activar la elección. Reinicia la elección antes de cambiarlos.',
        );
    }
    if (d.awards.length) {
      const candidate = rules.canComplete(rules.state(campaignOf(c, cfg), d.members, d.awards), {
        maxChecks: rules.budgets.commit,
      });
      if (candidate.status !== 'possible')
        throw new ApiError(
          'Estos parámetros dejarían las adjudicaciones sin una terminación validada: ' +
            (candidate.reason ?? candidate.status),
          409,
        );
    }
  }
  if (election.state) {
    const previous = d.config.previousScores ?? {},
      updated = cfg.previousScores ?? {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(updated)]);
    if (
      [...keys].some((key) => previous[key] !== updated[key]) ||
      (d.config.previousScoresSource ?? '') !== (cfg.previousScoresSource ?? '')
    )
      throw new ApiError(
        'Las puntuaciones anteriores quedan congeladas al activar la elección. Reinicia la elección para modificarlas.',
      );
  }
  const dates = new Set(calendar(c.year, c.team_id, cfg).map((s) => s.date));
  if ([...d.requests, ...d.awards].some((r) => !dates.has(r.cycle_date)))
    throw new ApiError('El cambio eliminaría ciclos con solicitudes o adjudicaciones');
  ops.push({
    sql: 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?',
    args: [JSON.stringify(cfg), cid],
  });
  before = d.config;
  after = cfg;
  return { before, after };
}

async function executeRequest(ctx: CommandContext): Promise<CommandResult> {
  const { cid, body, d, c, ops } = ctx;
  let before: any = null;
  const after: any = body;
  const m = d.members.find((m) => m.id === body.memberId);
  if (!m) throw new ApiError('Identificador ajeno al equipo');
  if (!Number.isInteger(body.slot) || body.slot < 1 || body.slot > 6) throw new ApiError('Posición entre 1 y 6');
  if (!calendar(c.year, c.team_id, d.config).some((s) => s.date === body.date)) throw new ApiError('Ciclo no válido');
  if (d.requests.some((r) => r.member_id === m.id && r.slot !== body.slot && r.cycle_date === body.date))
    throw new ApiError('Ese ciclo ya está solicitado por el trabajador');
  before = d.requests.find((r) => r.member_id === m.id && r.slot === body.slot) ?? null;
  ops.push({
    sql: 'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,1) ON CONFLICT(campaign_id,member_id,slot) DO UPDATE SET cycle_date=excluded.cycle_date,version=requests.version+1',
    args: [id(), cid, m.id, body.slot, body.date],
  });
  return { before, after };
}

const executeDeleteRequest =
  (action: string) =>
  async (ctx: CommandContext): Promise<CommandResult> => {
    const { cid, body, d, election, ops } = ctx;
    let before: any = null;
    let after: any = body;
    const table = action === 'delete_request' ? 'requests' : 'awards';
    before = (action === 'delete_request' ? d.requests : d.awards).find((r) => r.id === body.id);
    if (!before) throw new ApiError('Registro no encontrado', 404);
    ops.push({ sql: `DELETE FROM ${table} WHERE id=? AND campaign_id=?`, args: [body.id, cid] });
    // Original imported selections populated both relations. Keep their correction unified.
    // Criterios 1.1 p.2: correcting a later award must not erase the original selection.
    // Legacy imported grids without an election still behave as before.
    if (action === 'delete_award' && !election.state)
      ops.push({
        sql: 'DELETE FROM requests WHERE campaign_id=? AND member_id=? AND cycle_date=?',
        args: [cid, before.member_id, before.cycle_date],
      });
    after = { deleted: body.id };
    return { before, after };
  };

async function executeAward(ctx: CommandContext): Promise<CommandResult> {
  const { cid, body, d, c, rules, ops } = ctx;
  const before: any = null;
  let after: any = body;
  const m = d.members.find((m) => m.id === body.memberId);
  if (!m) throw new ApiError('Identificador ajeno al equipo');
  if (d.awards.some((a) => a.member_id === m.id && a.cycle_date === body.date))
    throw new ApiError('Adjudicación duplicada');
  const candidate = { id: id(), member_id: m.id, cycle_date: body.date };
  if (rules) {
    const check = rules.evaluateCandidate(rules.state(campaignOf(c, d.config), d.members, d.awards), [
      { member_id: m.id, cycle_date: body.date },
    ]);
    if (!check.allowed) throw new ApiError(check.issues.map((issue) => issue.message).join('; '));
  } else {
    const check = calculate(c.year, c.team_id, d.config, d.members, d.requests, [...d.awards, candidate]);
    if (check.issues.length) throw new ApiError(check.issues.join('; '));
  }
  ops.push({
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
    args: [candidate.id, cid, m.id, body.date],
  });
  after = candidate;
  return { before, after };
}

async function executeCalculate(ctx: CommandContext): Promise<CommandResult> {
  const { actor, cid, d, c, election, ops, body } = ctx;
  const before: any = null;
  let after: any = body;
  const result = calculate(c.year, c.team_id, d.config, d.members, d.requests, d.awards);
  const runId = id();
  ops.push({
    sql: 'INSERT INTO runs(id,campaign_id,source_version,engine_version,result_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    args: [
      runId,
      cid,
      c.version + 1,
      ENGINE_VERSION,
      JSON.stringify({
        result,
        config: d.config,
        members: d.members,
        requests: d.requests,
        awards: d.awards,
        election,
      }),
      actor.id,
      now(),
    ],
  });
  after = { runId, issues: result.issues };
  return { before, after };
}

async function executePublish(ctx: CommandContext): Promise<CommandResult> {
  const { actor, cid, body, d, c, rules, ops } = ctx;
  let before: any = null;
  let after: any = body;
  const run = d.runs.find((r) => r.id === body.runId);
  if (!run || run.source_version !== c.version)
    throw new ApiError('Calcula una revisión con los datos actuales antes de publicar', 409);
  const savedResult = JSON.parse(run.result_json).result;
  // A review created with the withdrawn occupancy policy cannot
  // be acknowledged and published as if it had been calculated
  // under the current rules. Historical snapshots stay untouched.
  if (rules && savedResult.occupancyPolicyVersion !== rules.version)
    throw new ApiError(
      'La revisión utiliza otra versión de ' + rules.name + '. Calcula una nueva revisión antes de publicar.',
      409,
    );
  if (savedResult.issues.length) throw new ApiError('Resuelve las incidencias antes de publicar');
  if (rules) {
    const reviewed = rules.evaluateFinal(rules.state(campaignOf(c, d.config), d.members, d.awards));
    if (!reviewed.valid)
      throw new ApiError('No se puede publicar: ' + reviewed.issues.map((i) => i.message).join('; '));
    const expected = reviewed.warnings.map((w) => w.code).sort();
    const acknowledged = Array.isArray(body.reviewedWarnings) ? [...new Set(body.reviewedWarnings)].sort() : [];
    if (JSON.stringify(expected) !== JSON.stringify(acknowledged))
      throw new ApiError(
        'Confirma expresamente los avisos de RRHH para publicar: ' + reviewed.warnings.map((w) => w.message).join('; '),
        409,
      );
    after = {
      status: 'published',
      runId: run.id,
      review: {
        policyVersion: rules.version,
        campaignVersion: c.version,
        actor: actor.id,
        at: now(),
        warnings: reviewed.warnings,
      },
    };
  }
  ops.push({ sql: "UPDATE campaigns SET status='published',published_run_id=? WHERE id=?", args: [run.id, cid] });
  before = { status: c.status, publishedRunId: c.published_run_id };
  if (!rules) after = { status: 'published', runId: run.id };
  return { before, after };
}

const executeCloseClose =
  (action: string) =>
  async (ctx: CommandContext): Promise<CommandResult> => {
    const { cid, c, ops, body } = ctx;
    let before: any = null;
    let after: any = body;
    ops.push({
      sql: 'UPDATE campaigns SET status=? WHERE id=?',
      args: [action === 'close' ? 'closed' : 'open', cid],
    });
    before = { status: c.status };
    after = { status: action === 'close' ? 'closed' : 'open' };
    return { before, after };
  };

async function executeImportRoster(ctx: CommandContext): Promise<CommandResult> {
  const { service, repo, actor, cid, body, d, c, ops } = ctx;
  let before: any = null;
  let after: any = body;
  if (
    c.scope_key === 'live' &&
    actor.role !== 'superadmin' &&
    (
      await repo.all(
        'SELECT 1 FROM preferences p JOIN campaign_members m ON m.id=p.member_id JOIN controller_accounts a ON a.person_id=m.person_id WHERE p.campaign_id=? LIMIT 1',
        [cid],
      )
    ).length
  )
    throw new ApiError(
      'No se puede sustituir la plantilla mientras existan preferencias privadas de controladores vinculados',
      403,
    );
  const source = body.source;
  if (!source || source.format !== 'vacaciones-roster-v1' || source.team !== c.team_id || source.year !== c.year)
    throw new ApiError('La plantilla no corresponde a este equipo y ejercicio');
  const importedConfig = source.config ? checkedConfig(source.config, c.year) : d.config;
  let rows;
  try {
    rows = validateRoster(source.rows, c.year, c.team_id, importedConfig);
  } catch (e: any) {
    throw new ApiError(e.message);
  }
  if (grantsIndividualEntitlements(c.year)) {
    const rosterCodes = new Set(rows.map((r) => r.code));
    for (const code of Object.keys(importedConfig.individualEntitlements ?? {}))
      if (!rosterCodes.has(code))
        throw new ApiError('La importación dejaría sin controlador la autorización individual de RRHH: ' + code);
  }
  const imported = rows.map((r, i) => ({ ...r, id: id(), personId: id(), position: i }));
  const selections = imported.flatMap((m) =>
    (m.dates ?? [])
      .map((date, i) => ({ id: id(), member_id: m.id, slot: i + 1, cycle_date: date }))
      .filter((r) => r.cycle_date),
  );
  // The original selection grid drives both the request and the vacation relation.
  const importedAwards = source.copySelections
    ? selections.map((r) => ({ id: id(), member_id: r.member_id, cycle_date: r.cycle_date }))
    : [];
  const check = calculate(c.year, c.team_id, importedConfig, imported, selections, importedAwards);
  if (check.issues.length) throw new ApiError('Revisa la plantilla: ' + check.issues.join('; '));
  service.assertCompletable(c, importedConfig, imported, importedAwards, 'Importar plantilla');

  ops.push(
    { sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] },
    electionStateStatement(cid, null),
    { sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] },
    { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
    { sql: 'DELETE FROM campaign_members WHERE campaign_id=?', args: [cid] },
  );

  for (const m of imported) {
    const annual = d.members.find((p) => p.code === m.code);
    const existing = annual ? { id: annual.person_id } : null;
    if (existing) {
      m.personId = existing.id;
      ops.push({
        sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',
        args: [m.id, cid, existing.id, m.code, m.label, m.seniority, m.position],
      });
    } else ops.push(...rowStatements(cid, c.team_id, m, m.position, m.personId, m.id));
  }
  for (const r of selections)
    ops.push({
      sql: 'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,1)',
      args: [r.id, cid, r.member_id, r.slot, r.cycle_date],
    });
  for (const a of importedAwards)
    ops.push({
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
      args: [a.id, cid, a.member_id, a.cycle_date],
    });
  ops.push({ sql: "UPDATE campaigns SET data_kind='imported' WHERE id=?", args: [cid] });
  if (source.config)
    ops.push({
      sql: 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?',
      args: [JSON.stringify(importedConfig), cid],
    });
  before = { members: d.members, requests: d.requests, awards: d.awards, config: d.config };
  after = {
    source: source.source ?? 'Plantilla importada',
    members: rows.length,
    selections: selections.length,
    awards: importedAwards.length,
    configurationImported: !!source.config,
  };
  return { before, after };
}

async function executeBulkMembers(ctx: CommandContext): Promise<CommandResult> {
  const { service, cid, body, d, c, rules, ops } = ctx;
  let before: any = null;
  let after: any = body;
  let rows;
  try {
    rows = validateRoster(body.rows, c.year, c.team_id, d.config);
  } catch (e: any) {
    throw new ApiError(e.message);
  }
  const resolved = rows.map((r, i) => {
    const member = r.memberId ? d.members.find((m) => m.id === r.memberId) : d.members.find((m) => m.code === r.code);
    if (r.memberId && !member) throw new ApiError('Controlador ajeno a este equipo');
    return { row: r, member, position: member?.position ?? d.members.length + i };
  });
  const memberIds = resolved.map((r) => r.member?.id).filter(Boolean);
  if (new Set(memberIds).size !== memberIds.length) throw new ApiError('El mismo controlador aparece en dos filas');
  const touched = new Set(resolved.map((r) => r.member?.id).filter(Boolean));
  if (resolved.some((r) => d.members.some((m) => m.code === r.row.code && !touched.has(m.id))))
    throw new ApiError('Hay un identificador duplicado en la plantilla');

  const renamed = renameConfigCodes(
    d.config,
    resolved.flatMap(({ row: r, member }) =>
      member && member.code !== r.code ? [[member.code, r.code] as [string, string]] : [],
    ),
  );
  if (renamed)
    ops.push({
      sql: 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?',
      args: [JSON.stringify(renamed), cid],
    });
  if (rules && d.awards.length) {
    const revised = d.members.map((m) => {
      const updated = resolved.find((item) => item.member?.id === m.id);
      return updated ? { ...m, code: updated.row.code } : m;
    });
    const additions = resolved
      .filter((item) => !item.member)
      .map((item, i) => ({ id: 'new-roster-' + i, code: item.row.code, seniority: item.row.seniority }));
    service.assertCompletable(c, renamed ?? d.config, [...revised, ...additions], d.awards, 'Actualizar plantilla');
  }
  for (const { row: r, member, position } of resolved) {
    if (member)
      ops.push({
        sql: 'UPDATE campaign_members SET code=?,label=?,seniority=?,version=version+1 WHERE id=? AND campaign_id=?',
        args: [r.code, r.label, r.seniority, member.id, cid],
      });
    else ops.push(...rowStatements(cid, c.team_id, r, position, id(), id()));
  }
  ops.push({ sql: "UPDATE campaigns SET data_kind='configured' WHERE id=?", args: [cid] });
  before = d.members;
  after = rows;
  return { before, after };
}

async function executeTransferMember(ctx: CommandContext): Promise<CommandResult> {
  const { service, repo, actor, cid, body, d, c, election, ops } = ctx;
  let before: any = null;
  let after: any = body;
  const member = d.members.find((m) => m.id === body.memberId);
  if (!member) throw new ApiError('Controlador no encontrado', 404);
  if (grantsIndividualEntitlements(c.year) && d.config.individualEntitlements?.[member.code])
    throw new ApiError('Retira primero la excepción individual de RRHH antes de trasladar al controlador');
  if (election.preferences.some((p) => p.member_id === member.id && p.dates.length))
    throw new ApiError('Vacía sus preferencias antes de cambiar de turno');
  if ([...d.requests, ...d.awards].some((r) => r.member_id === member.id))
    throw new ApiError(
      'El controlador tiene vacaciones en este ejercicio. Corrige sus registros o realiza el cambio en un ejercicio nuevo sin vacaciones.',
    );
  const target = (
    await repo.all("SELECT * FROM campaigns WHERE team_id=? AND year=? AND scope_key='live'", [body.targetTeam, c.year])
  )[0];
  if (!target || target.id === cid || target.status !== 'open')
    throw new ApiError('Elige otro equipo con campaña abierta en el mismo ejercicio');
  requireWrite(actor, target.team_id);
  if (target.version !== body.targetVersion)
    throw new ApiError('El equipo de destino cambió. Recarga antes de trasladar.', 409);
  const destination = await service.load(target.id);
  const targetElection = await service.election().read(target.id);
  if (targetElection.state?.status === 'active')
    throw new ApiError('Pausa también la elección del equipo de destino antes del traslado');
  if (destination.members.some((m) => m.person_id === member.person_id || m.code === member.code))
    throw new ApiError('La persona o su identificador ya existe en el equipo de destino');
  if (destination.members.length >= 100)
    throw new ApiError('El equipo de destino ha alcanzado el máximo de 100 controladores');
  service.assertCompletable(
    target,
    destination.config,
    [...destination.members, { ...member, id: 'transfer-prospective' }],
    destination.awards,
    'Trasladar controlador',
  );
  ops.push(
    ...cas(target.id, target.version),
    electionStateStatement(target.id, null),
    { sql: 'DELETE FROM preferences WHERE member_id=? AND campaign_id=?', args: [member.id, cid] },
    { sql: 'DELETE FROM campaign_members WHERE id=? AND campaign_id=?', args: [member.id, cid] },
    {
      sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',
      args: [
        id(),
        target.id,
        member.person_id,
        member.code,
        member.label,
        member.seniority,
        Math.max(-1, ...destination.members.map((m) => m.position)) + 1,
      ],
    },
    { sql: "UPDATE campaigns SET data_kind='configured' WHERE id IN (?,?)", args: [cid, target.id] },
  );
  before = member;
  after = { code: member.code, from: c.team_id, to: target.team_id, year: c.year };
  ops.push(service.audit('transfer_received', target, null, after));
  return { before, after };
}

async function executeRetireMember(ctx: CommandContext): Promise<CommandResult> {
  const { service, cid, body, d, c, election, ops } = ctx;
  let before: any = null;
  let after: any = body;
  const member = d.members.find((m) => m.id === body.memberId);
  if (!member) throw new ApiError('Identificador no encontrado', 404);
  if (grantsIndividualEntitlements(c.year) && d.config.individualEntitlements?.[member.code])
    throw new ApiError('Retira primero la excepción individual de RRHH antes de dar de baja al controlador');
  service.assertCompletable(
    c,
    d.config,
    d.members.filter((m) => m.id !== member.id),
    d.awards,
    'Dar de baja controlador',
  );
  if (election.preferences.some((p) => p.member_id === member.id && p.dates.length))
    throw new ApiError('Vacía sus preferencias antes de dar la baja');
  if ([...d.requests, ...d.awards].some((r) => r.member_id === member.id))
    throw new ApiError('Retira sus solicitudes y adjudicaciones del borrador antes de retirar el identificador');
  ops.push(
    { sql: 'DELETE FROM preferences WHERE member_id=? AND campaign_id=?', args: [member.id, cid] },
    { sql: 'DELETE FROM campaign_members WHERE id=? AND campaign_id=?', args: [member.id, cid] },
  );
  before = member;
  after = { retired: member.code };
  return { before, after };
}

async function executeMember(ctx: CommandContext): Promise<CommandResult> {
  const { service, cid, body, d, c, ops } = ctx;
  let before: any = null;
  const after: any = body;
  const code = String(body.code ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9_-]{2,12}$/.test(code)) throw new ApiError('Usa un código de 2 a 12 letras, números o guiones');
  checkedDate(body.seniority);
  const m = d.members.find((m) => m.id === body.memberId);
  if (d.members.some((other) => other.code === code && other.id !== m?.id))
    throw new ApiError('Ese código ya existe en esta campaña');
  if (m) {
    const renamed = renameConfigCodes(d.config, [[m.code, code]]);
    if (renamed)
      ops.push({
        sql: 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?',
        args: [JSON.stringify(renamed), cid],
      });
    before = m;
    ops.push({
      sql: 'UPDATE campaign_members SET code=?,seniority=?,version=version+1 WHERE id=? AND campaign_id=?',
      args: [code, body.seniority, m.id, cid],
    });
  } else {
    service.assertCompletable(
      c,
      d.config,
      [...d.members, { id: 'new-member-prospective', code, seniority: body.seniority }],
      d.awards,
      'Añadir controlador',
    );
    const pid = id();
    ops.push(
      ...rowStatements(cid, c.team_id, { code, label: '', seniority: body.seniority }, d.members.length, pid, id()),
    );
  }
  return { before, after };
}

// Nicks and names label stable ids, so they may change mid-election; seniority,
// additions and every other correction still require a pause.
const sameSeniority = (d: CommandContext['d'], r: any) => {
  const m = d.members.find((x) => x.id === r?.memberId);
  return !!m && String(r.seniority ?? '').trim() === m.seniority;
};
const editing = { activeElection: 'blocked', closedCampaign: false } as const;
const vacations = { preconditions: editing, vacationsUndo: true, election: 'reset' } as const;
function resetVacationsElection({ c, cid, actor, ops }: CommandContext) {
  const delegated = c.scope_key === 'live' && actor.role !== 'superadmin';
  ops.push(
    {
      sql: delegated
        ? 'DELETE FROM preferences WHERE campaign_id=? AND member_id NOT IN (SELECT m.id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE m.campaign_id=?)'
        : 'DELETE FROM preferences WHERE campaign_id=?',
      args: delegated ? [cid, cid] : [cid],
    },
    electionStateStatement(cid, null),
  );
}
async function restoreElection({ service, c, cid, ops }: CommandContext) {
  const entry = await service.vacationUndo(cid, c.version);
  const old = entry ? JSON.parse(entry.before_json!) : null;
  if (old?.election) {
    ops.push(
      { sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] },
      electionStateStatement(cid, old.election.state),
    );
    ops.push(
      ...insertRows(
        'preferences',
        PREFERENCE_COLUMNS,
        old.election.preferences.map((p: any) => preferenceRow(p, cid)),
      ),
    );
  }
}
const availabilityImpact =
  (action: 'award' | 'delete_award') =>
  ({ rules, c, d, body }: CommandContext, after: any) => {
    if (!rules) return after;
    const updated = action === 'award' ? [...d.awards, after] : d.awards.filter((a: any) => a.id !== body.id);
    const impact = rules.impact(
      rules.state(campaignOf(c, d.config), d.members, d.awards),
      rules.state(campaignOf(c, d.config), d.members, updated),
    );
    return {
      ...after,
      availabilityHistory: { before: rules.compact(impact.before), after: rules.compact(impact.after) },
    };
  };

export const COMMANDS: Record<string, Command> = {
  reset_vacations: {
    preconditions: { activeElection: 'simulation', closedCampaign: false },
    vacationsUndo: true,
    election: resetVacationsElection,
    execute: executeResetVacations,
  },
  undo_vacations: { ...vacations, election: restoreElection, execute: executeUndoVacations('undo_vacations') },
  redo_vacations: { ...vacations, election: restoreElection, execute: executeUndoVacations('redo_vacations') },
  config: { preconditions: editing, election: 'reset', execute: executeConfig },
  request: { ...vacations, execute: executeRequest },
  delete_request: { ...vacations, execute: executeDeleteRequest('delete_request') },
  award: { ...vacations, execute: executeAward, audited: availabilityImpact('award') },
  delete_award: {
    ...vacations,
    execute: executeDeleteRequest('delete_award'),
    audited: availabilityImpact('delete_award'),
  },
  calculate: {
    preconditions: { activeElection: 'allowed', closedCampaign: false },
    election: 'keep',
    execute: executeCalculate,
  },
  publish: {
    preconditions: { activeElection: 'blocked', closedCampaign: true },
    election: 'keep',
    execute: executePublish,
  },
  close: {
    preconditions: { activeElection: 'allowed', closedCampaign: true },
    election: ({ election, cid, ops }) => {
      if (election.state) ops.push(electionStateStatement(cid, { ...election.state, status: 'paused' }));
    },
    execute: executeCloseClose('close'),
  },
  reopen: {
    preconditions: { activeElection: 'blocked', closedCampaign: true },
    election: 'keep',
    execute: executeCloseClose('reopen'),
  },
  import_roster: { preconditions: editing, election: 'reset', execute: executeImportRoster },
  bulk_members: {
    preconditions: {
      ...editing,
      renameOnly: (body, d) =>
        Array.isArray(body.rows) &&
        body.rows.length === d.members.length &&
        body.rows.every((r: any) => sameSeniority(d, r)),
    },
    election: 'reset',
    execute: executeBulkMembers,
  },
  transfer_member: {
    preconditions: {
      ...editing,
      liveOnly: 'El traslado entre grupos se gestiona en la campaña real, no desde una simulación aislada',
    },
    election: 'reset',
    execute: executeTransferMember,
  },
  retire_member: { preconditions: editing, election: 'reset', execute: executeRetireMember },
  member: {
    preconditions: { ...editing, renameOnly: (body, d) => sameSeniority(d, body) },
    election: 'reset',
    execute: executeMember,
  },
};

/** Load, CAS, preconditions, execute, election effect, audit and commit: one transaction as before. */
export async function runCommand(service: Service, repo: Repository, cid: string, body: any) {
  const d = await service.load(cid),
    c = d.campaign,
    rules = occupancyFor(c.year);
  requireWrite(service.actor, c.team_id);
  const rebuilding = await service.election().reconstruction().read(cid);
  if (rebuilding && rebuilding.status !== 'completed')
    throw new ApiError('La elección está congelada mientras se reconstruyen los turnos', 409);
  if (!Number.isInteger(body.version) || body.version !== c.version)
    throw new ApiError('La campaña cambió. Recarga antes de guardar.', 409);
  const action = body.action,
    command = commandFor(action);
  const election = await service.election().read(cid);
  const renameOnly = !!command?.preconditions.renameOnly?.(body, d);
  const error = preconditionError(command, {
    electionActive: election.state?.status === 'active',
    closed: c.status !== 'open',
    live: c.scope_key === 'live',
    renameOnly,
  });
  if (error) throw new ApiError(error);
  if (!command) throw new ApiError('Operación no válida');
  const ctx: CommandContext = {
    service,
    repo,
    actor: service.actor,
    cid,
    body,
    d,
    c,
    rules,
    election,
    renameOnly,
    ops: cas(cid, body.version),
  };
  let { before, after } = await command.execute(ctx);
  if (command.vacationsUndo) {
    before = { format: VACATIONS_UNDO_FORMAT, requests: d.requests, awards: d.awards, election };
    after = { ...after, version: c.version + 1 };
  }
  if (typeof command.election === 'function') await command.election(ctx);
  // A rename keeps order, queue and turn: they reference ids, not nicks.
  else if (command.election === 'reset' && election.state && !renameOnly)
    ctx.ops.push(electionStateStatement(cid, null));
  if (command.audited) after = command.audited(ctx, after);
  ctx.ops.push(service.audit(action, c, before, after));
  await service.commit(ctx.ops);
}
