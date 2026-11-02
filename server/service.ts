import { ORDINARY_TEAMS, VA_TEAM, ensureVaTeam, ordinaryCampaign } from './teams.ts';
import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { type Config } from '../domain/calendar.ts';
import { calculate } from '../domain/vacations.ts';
import { campaignOf, occupancyOf, ordinaryScope, scopeOf, unitsOf, type PolicyCampaign } from '../domain/policy.ts';
import { historicalAvailability } from './availability-history.ts';
import {
  AuditContext,
  append,
  deleteEventsFor,
  eventsFor,
  lastUndoableVacation,
  logicalRow,
  type AuditRow,
  recentAudit,
} from './audit-context.ts';
import { discretion, redactDiscreet, snapshotRequests } from './early-discretion.ts';
import { type AuditAction } from '../domain/events.ts';
import { canWrite, requireSuper, requireWrite, type Identity, type Principal } from './permissions.ts';
import { cas, tableColumns, type Repository, type Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { ElectionService } from './election-service.ts';
import { requestsForAwards } from './election-requests.ts';
import { PersonalSimulationService } from './personal-simulation.ts';
import { cloneSimulation } from './simulations.ts';
import { projectAdminCampaignView, projectPublicCampaignView, projectPublishedCampaignView } from './projections.ts';
import { validateElectionState, upgradeElectionState } from '../domain/election.ts';
import { checkedConfig, runCommand } from './service-commands.ts';
import { HrExportError, hrTeamCells, suggestHrNames, type HrCell } from '../domain/hr-export.ts';
import { orderAwardsBySelection } from '../domain/award-display-order.ts';
import { readHrWorkbook, writeHrWorkbook, type HrWorkbook } from './hr-xlsx.ts';
import { vaVisibility } from './va-census.ts';
import { crossCampaignGuards, policyExternal } from './va-integrity.ts';
export { ApiError } from './errors.ts';
const id = () => crypto.randomUUID(),
  now = () => new Date().toISOString();
/** SQL assertion: the affected team retains a permanent administrator after this transaction. */
function keepTeamAdmin(team: string): Statement[] {
  // VA may have no administrator of its own: superadmins administer it (ADR 0002).
  if (team === VA_TEAM) return [];
  const token = id();
  return [
    {
      sql: "INSERT INTO transaction_assertions(id) VALUES(CASE WHEN EXISTS(SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.team_id=? AND u.role='team_admin' AND g.expires_at IS NULL) THEN ? ELSE NULL END)",
      args: [team, token],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
  ];
}
export async function principal(repo: Repository, identity: Identity, superEmails: string): Promise<Principal> {
  if (!identity) return { id: null, role: 'viewer', teams: [] };
  const key = identity.provider + ':' + identity.subject;
  const verifiedEmail =
    identity.emailVerified === true && identity.email?.trim() ? identity.email.trim().toLowerCase() : null;
  const emailKey = verifiedEmail && identity.provider === 'chatgpt' ? 'chatgpt-email:' + verifiedEmail : undefined;
  if (identity.provider === 'local_admin') return { id: key, role: 'superadmin', teams: [] };
  if (
    verifiedEmail &&
    superEmails
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(verifiedEmail)
  )
    return { id: key, role: 'superadmin', teams: [], emailKey };
  const subjects = [identity.subject, ...(emailKey ? ['email:' + verifiedEmail] : [])];
  const users = await repo.all(
    `SELECT * FROM users WHERE provider=? AND subject IN (${subjects.map(() => '?').join(',')})`,
    [identity.provider, ...subjects],
  );
  const user = users.find((u) => u.subject === identity.subject) ?? users[0];
  if (!user) return { id: key, role: 'viewer', teams: [], emailKey };
  return {
    id: key,
    role: user.role === 'team_admin' ? 'team_admin' : 'viewer',
    teams: (
      await repo.all('SELECT team_id FROM grants WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)', [
        user.id,
        now(),
      ])
    ).map((g) => g.team_id),
    emailKey,
  };
}
export class Service {
  constructor(
    private repo: Repository,
    public actor: Principal,
  ) {}
  election() {
    return new ElectionService(this.repo, this.actor, {
      load: (cid) => this.load(cid),
      commit: (ops) => this.commit(ops),
      audit: (a, c, b, n) => this.audit(a, c, b, n),
      assertVaReader: (loaded) => this.assertVaReader(loaded),
    });
  }
  personalSimulation() {
    return new PersonalSimulationService(this.repo, this.actor, {
      load: (cid) => this.load(cid),
      election: () => this.election(),
    });
  }
  async list() {
    const r = await this.repo.batch([
      { sql: "SELECT * FROM teams WHERE kind='ordinary' ORDER BY id" },
      { sql: `SELECT * FROM campaigns WHERE ${ordinaryCampaign()} ORDER BY year DESC,team_id,created_at` },
    ]);
    const campaigns = r[1].results.filter((c) => c.scope_key === 'live' || canWrite(this.actor, c.team_id));
    const accountKeys = [this.actor.id, ...(this.actor.emailKey ? [this.actor.emailKey] : [])].filter(
      (key): key is string => !!key,
    );
    const mine = accountKeys.length
      ? await this.repo.all(
          `SELECT DISTINCT m.campaign_id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE a.principal_key IN (${accountKeys.map(() => '?').join(',')})`,
          accountKeys,
        )
      : [];
    return {
      teams: r[0].results.filter((t) => /^[A-H]$/.test(t.id)).map((t) => ({ ...t, name: 'Equipo ' + t.id })),
      campaigns,
      principal: this.actor,
      myCampaignIds: mine.map((m) => m.campaign_id).filter((id) => campaigns.some((c) => c.id === id)),
      va: await vaVisibility(this.repo, this.actor),
      vaCampaign: await this.vaCampaign(),
    };
  }
  /** The latest live VA campaign, for whoever may open it (see view). */
  private async vaCampaign() {
    if (!this.actor.id) return null;
    const [c] = await this.repo.all(
      "SELECT id,year,status,version FROM campaigns WHERE team_id=? AND scope_key='live' ORDER BY year DESC LIMIT 1",
      [VA_TEAM],
    );
    if (!c) return null;
    if (canWrite(this.actor, VA_TEAM)) return c;
    return (await this.election().memberForAccount({ campaign: c, members: [] })) ? c : null;
  }
  /** Every team's live campaign of the latest year, as anyone may follow it. */
  async stats() {
    if (!this.actor.id) throw new ApiError('Inicia sesión para consultar el estado de las campañas', 401);
    const live = (await this.repo.all(
      `SELECT id,year FROM campaigns WHERE scope_key='live' AND ${ordinaryCampaign()} ORDER BY team_id`,
    )) as {
      id: string;
      year: number;
    }[];
    const year = Math.max(0, ...live.map((c) => c.year));
    const election = this.election();
    return {
      year: year || null,
      campaigns: await Promise.all(live.filter((c) => c.year === year).map((c) => election.summary(c.id))),
    };
  }
  async createSimulation(cid: string, body: any) {
    const d = await this.load(cid);
    requireWrite(this.actor, d.campaign.team_id);
    if (body.version !== d.campaign.version)
      throw new ApiError('La campaña cambió. Recarga antes de crear la simulación.', 409);
    const result = await cloneSimulation(this.repo, d, body.name);
    await this.commit([
      ...result.statements,
      this.audit('simulation_created', { id: result.id, team_id: d.campaign.team_id }, null, {
        source: cid,
        name: body.name,
      }),
    ]);
    return { id: result.id };
  }
  async deleteSimulation(cid: string, body: any) {
    const d = await this.load(cid);
    requireWrite(this.actor, d.campaign.team_id);
    if (d.campaign.scope_key === 'live') throw new ApiError('La campaña real no se puede eliminar', 403);
    if (body.version !== d.campaign.version)
      throw new ApiError('La simulación cambió. Recarga antes de eliminarla.', 409);
    const personIds = [...new Set(d.members.map((m: any) => m.person_id))] as string[];
    const ops: Statement[] = [
      ...cas(cid, d.campaign.version),
      deleteEventsFor(cid),
      { sql: 'DELETE FROM reconstruction_sessions WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM election_states WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM runs WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM parameters WHERE campaign_id=?', args: [cid] },
      { sql: 'DELETE FROM campaign_members WHERE campaign_id=?', args: [cid] },
      ...personIds.map((personId) => ({
        sql: 'DELETE FROM people WHERE id=? AND NOT EXISTS(SELECT 1 FROM campaign_members WHERE person_id=?) AND NOT EXISTS(SELECT 1 FROM controller_accounts WHERE person_id=?)',
        args: [personId, personId, personId],
      })),
      { sql: "DELETE FROM campaigns WHERE id=? AND scope_key<>'live'", args: [cid] },
      this.audit('simulation_deleted', { team_id: d.campaign.team_id }, null, {
        name: d.campaign.simulation_name,
        year: d.campaign.year,
      }),
    ];
    await this.commit(ops);
    return { ok: true };
  }
  /** Validate prospective roster/award edits before writing them. A local
   * capacity check is not enough for an occupancy engine: every controller must still be
   * able to finish, and final summer minimums must be reachable. */
  assertCompletable(
    c: any,
    config: Config,
    members: any[],
    awards: any[],
    action: string,
    external?: PolicyCampaign['external'],
  ) {
    const rules = occupancyOf(scopeOf(c));
    if (!rules || awards.length === 0) return;
    const state = rules.state(campaignOf(c, config, external), members, awards);
    const violations = rules.immediateIssues(state, []);
    if (violations.length) throw new ApiError(action + ': ' + violations.map((x) => x.message).join('; '), 409);
    const proof = rules.canComplete(state, { maxChecks: rules.budgets.commit });
    if (proof.status !== 'possible')
      throw new ApiError(
        action +
          ': la adjudicación resultante no tiene una completación validada según ' +
          rules.authority +
          '. ' +
          (proof.reason ?? proof.status),
        409,
      );
  }
  async load(cid: string) {
    const rows = await this.repo.batch([
      { sql: 'SELECT * FROM campaigns WHERE id=?', args: [cid] },
      { sql: 'SELECT * FROM parameters WHERE campaign_id=?', args: [cid] },
      { sql: 'SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position,code', args: [cid] },
      { sql: 'SELECT * FROM requests WHERE campaign_id=? ORDER BY slot', args: [cid] },
      // Explicit imports carry their global sequence. Legacy grids fall back to
      // request column then roster position (earlier round wins within a cycle).
      // MIN(slot) prevents corrupt/legacy duplicate requests multiplying awards.
      {
        sql: `SELECT a.* FROM awards a
          LEFT JOIN (
            SELECT campaign_id, member_id, cycle_date, MIN(slot) AS slot
            FROM requests WHERE campaign_id=? GROUP BY campaign_id, member_id, cycle_date
          ) r ON r.campaign_id=a.campaign_id
            AND r.member_id=a.member_id AND r.cycle_date=a.cycle_date
          LEFT JOIN campaign_members m ON m.campaign_id=a.campaign_id AND m.id=a.member_id
          WHERE a.campaign_id=?
          ORDER BY a.selection_index IS NULL, a.selection_index,
            r.slot IS NULL, r.slot, m.position, m.code, a.cycle_date, a.id`,
        args: [cid, cid],
      },
      { sql: 'SELECT * FROM runs WHERE campaign_id=? ORDER BY created_at DESC LIMIT 20', args: [cid] },
    ]);
    const campaign = rows[0].results[0];
    if (!campaign) throw new ApiError('Campaña no encontrada', 404);
    const config = JSON.parse(rows[1].results[0].json),
      external = await policyExternal(this.repo, campaign);
    return {
      campaign,
      config,
      // Only VA campaigns need data from outside (ADR 0002).
      ...(external && { external }),
      members: rows[2].results,
      requests: rows[3].results,
      awards: rows[4].results,
      runs: rows[5].results,
    };
  }
  async view(cid: string, options: { skipAvailabilityForPendingAutomatic?: boolean } = {}) {
    const loaded = await this.load(cid);
    if (
      loaded.campaign.scope_key !== 'live' &&
      !canWrite(this.actor, loaded.campaign.team_id) &&
      this.actor.preview?.campaignId !== cid
    )
      throw new ApiError('Simulación reservada a administradores', 403);
    await this.assertVaReader(loaded);
    const auditContext = new AuditContext(this.repo, cid, loaded.campaign.version);
    const { d, state, hidden, consumed } = await this.election().concealedFor(loaded, undefined, auditContext);
    const concealing = d !== loaded;
    // A recorded availability counts the hidden awards: recompute it from the masked view.
    const recovery = occupancyOf(scopeOf(d.campaign))
      ? await historicalAvailability(this.repo, cid, d.campaign.version)
      : { restored: false };
    const restored = recovery.restored;
    const scoringRequests = d.campaign.status === 'open' ? requestsForAwards(cid, d.awards, d.requests) : d.requests;
    const result = calculate(d.campaign.year, d.campaign.team_id, d.config, d.members, scoringRequests, d.awards, {
      skipProof: restored,
      external: d.external,
    });
    const election = await this.election().view(d, {
      restored,
      result,
      recordedAvailability: concealing ? null : recovery.recordedAvailability,
      ...options,
      ...(state !== undefined ? { state, hidden, consumed } : {}),
      ...(concealing ? { unconcealed: loaded } : {}),
      auditContext,
    });
    if (canWrite(this.actor, d.campaign.team_id)) {
      const entry = await this.vacationUndo(cid, d.campaign.version);
      // Master dates (ENAIRE) are shown beside the roster; the campaign snapshot stays as it is.
      const people = await this.repo.all(
        'SELECT m.id,p.seniority FROM campaign_members m JOIN people p ON p.id=m.person_id WHERE m.campaign_id=?',
        [cid],
      );
      const masterSeniority = Object.fromEntries(people.filter((p) => p.seniority).map((p) => [p.id, p.seniority]));
      return { ...projectAdminCampaignView(d, election, result, entry), masterSeniority };
    }
    return projectPublicCampaignView(d, cid, election, result, this.actor.preview);
  }
  /** VA is not a public consultation: its administrators and its participants only, on every read. */
  async assertVaReader(loaded: Awaited<ReturnType<Service['load']>>) {
    if (
      loaded.campaign.team_id === VA_TEAM &&
      !canWrite(this.actor, VA_TEAM) &&
      this.actor.preview?.campaignId !== loaded.campaign.id &&
      !(await this.election().memberForAccount(loaded))
    )
      throw new ApiError('Las vacaciones de antigüedad se consultan solo con una cuenta participante', 403);
  }
  async publishedView(cid: string) {
    const d = await this.load(cid);
    if (d.campaign.scope_key !== 'live' && !canWrite(this.actor, d.campaign.team_id))
      throw new ApiError('Simulación reservada a administradores', 403);
    await this.assertVaReader(d);
    const run = d.campaign.published_run_id
      ? (await this.repo.all('SELECT * FROM runs WHERE id=? AND campaign_id=?', [d.campaign.published_run_id, cid]))[0]
      : null;
    if (!run) return null;
    const snapshot = JSON.parse(run.result_json);
    return projectPublishedCampaignView(d, cid, snapshot);
  }
  async vacationUndo(cid: string, version: number) {
    return lastUndoableVacation(this.repo, cid, version);
  }
  audit(action: AuditAction, c: any, before: any, after: any): Statement {
    return append({
      id: id(),
      actor: this.actor.id,
      action,
      teamId: c?.team_id,
      campaignId: c?.id,
      before,
      after,
      createdAt: now(),
    });
  }
  async commit(statements: Statement[]) {
    const vaGuards = await crossCampaignGuards(this.repo, statements);
    try {
      return await this.repo.batch([
        ...statements,
        ...vaGuards,
        { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
      ]);
    } catch (e) {
      if (String(e).includes('va_ordinary_overlap'))
        throw new ApiError(
          'El cambio deja a una persona con el mismo día en vacaciones ordinarias y de VA, o un día de VA por encima de sus plazas. La administración debe resolver el conflicto antes de aplicarlo.',
          409,
        );
      if (/va_duplicate_account|va_duplicate_controller_number/.test(String(e)))
        throw new ApiError('La cuenta o el número CTA ya pertenece a una persona del censo VA', 409);
      if (String(e).includes('transaction_assertions'))
        throw new ApiError('Otra persona ha actualizado la campaña. Recarga antes de guardar.', 409);
      if (String(e).includes('UNIQUE constraint'))
        throw new ApiError('Este registro ya existe. Recarga para comprobarlo.', 409);
      throw e;
    }
  }
  async init() {
    requireSuper(this.actor);
    if ((await this.repo.all(ORDINARY_TEAMS)).length) throw new ApiError('El proyecto ya está inicializado', 409);
    const ops: Statement[] = [{ sql: "INSERT INTO app_state(id,revision) VALUES('main',0)" }];
    for (const t of 'ABCDEFGH') {
      const campaignId = id();
      ops.push(
        { sql: 'INSERT INTO teams(id,name,version) VALUES(?,?,1)', args: [t, 'Equipo ' + t] },
        {
          sql: "INSERT INTO campaigns(id,team_id,year,status,version,created_at) VALUES(?,?,2026,'open',1,?)",
          args: [campaignId, t, now()],
        },
        {
          sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)',
          args: [campaignId, JSON.stringify(defaultConfig(2026))],
        },
      );
      for (let i = 1; i <= 16; i++) {
        const personId = t + '-' + i,
          code = t + String(i).padStart(2, '0'),
          seniority = `${2000 + i}-01-01`;
        ops.push(
          {
            sql: 'INSERT INTO people(id,team_id,code,seniority,version) VALUES(?,?,?,?,1)',
            args: [personId, t, code, seniority],
          },
          {
            sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority,version) VALUES(?,?,?,?,?,1)',
            args: [id(), campaignId, personId, code, seniority],
          },
        );
      }
    }
    ops.push(this.audit('initialize_demo', null, null, { teams: 8, year: 2026, fictional: true }));
    await this.commit(ops);
    return this.list();
  }
  async createCampaigns(year: number, copyYear: number | null, rosterYear: number | null | 'latest' = 'latest') {
    requireSuper(this.actor);
    checkedConfig(defaultConfig(year), ordinaryScope(year));
    if (rosterYear !== 'latest' && rosterYear !== null && (!Number.isInteger(rosterYear) || rosterYear >= year))
      throw new ApiError('La plantilla de origen debe ser de un ejercicio anterior');
    const ts = await this.repo.all("SELECT * FROM teams WHERE kind='ordinary' ORDER BY id");
    if (ts.length !== 8) throw new ApiError('Inicializa los ocho equipos primero');
    const prior = copyYear
      ? await this.repo.all(
          `SELECT c.*,p.json FROM campaigns c JOIN parameters p ON p.campaign_id=c.id WHERE c.year=? AND c.scope_key='live' AND ${ordinaryCampaign('c')}`,
          [copyYear],
        )
      : [];
    const ops: Statement[] = [];
    for (const t of ts) {
      const cid = id(),
        previous = prior.find((p) => p.team_id === t.id);
      const rosterSource =
        rosterYear === null
          ? null
          : (
              await this.repo.all(
                rosterYear === 'latest'
                  ? "SELECT * FROM campaigns WHERE team_id=? AND year<? AND scope_key='live' ORDER BY year DESC LIMIT 1"
                  : "SELECT * FROM campaigns WHERE team_id=? AND year=? AND scope_key='live'",
                [t.id, rosterYear === 'latest' ? year : rosterYear],
              )
            )[0];
      if (rosterYear !== null && !rosterSource)
        throw new ApiError('No hay plantilla de origen para el equipo ' + t.id + '. Elige empezar sin controladores.');
      const annualPeople = rosterSource
        ? await this.repo.all('SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position,code', [
            rosterSource.id,
          ])
        : [];
      if (annualPeople.some((p) => p.seniority && p.seniority > `${year}-12-31`))
        throw new ApiError('La plantilla contiene una antigüedad posterior al ejercicio');
      // Lock each selected source while copying, so a concurrent edit rolls back creation.
      if (rosterSource) {
        const token = id();
        ops.push(
          {
            sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (SELECT version FROM campaigns WHERE id=?)=? THEN ? ELSE NULL END)',
            args: [rosterSource.id, rosterSource.version, token],
          },
          { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
        );
      }
      if (copyYear && !previous) throw new ApiError('El ejercicio de origen no contiene los ocho equipos');
      if (previous && previous.id !== rosterSource?.id) {
        const token = id();
        ops.push(
          {
            sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (SELECT version FROM campaigns WHERE id=?)=? THEN ? ELSE NULL END)',
            args: [previous.id, previous.version, token],
          },
          { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
        );
      }
      const config = previous ? copyConfig(JSON.parse(previous.json), copyYear!, year) : defaultConfig(year);
      checkedConfig(config, ordinaryScope(year));
      ops.push(
        {
          sql: "INSERT INTO campaigns(id,team_id,year,status,version,data_kind,created_at) VALUES(?,?,?,'open',1,?,?)",
          args: [cid, t.id, year, rosterSource?.data_kind ?? 'configured', now()],
        },
        { sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)', args: [cid, JSON.stringify(config)] },
      );
      for (const p of annualPeople)
        ops.push({
          sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',
          args: [id(), cid, p.person_id, p.code, p.label ?? '', p.seniority, p.position ?? 0],
        });
      ops.push(
        this.audit('create_campaign', { id: cid, team_id: t.id }, null, {
          year,
          copyYear,
          rosterYear: rosterSource?.year ?? null,
        }),
      );
    }
    await this.commit(ops);
    return this.list();
  }
  async mutate(cid: string, body: any) {
    const review = await runCommand(this, this.repo, cid, body);
    if (body.action === 'preview_import_roster') return review;
    return this.view(cid);
  }
  async configureUser(body: any) {
    if (this.actor.role === 'team_admin') return this.configureTeamUser(body);
    requireSuper(this.actor);
    const provider = body.provider ?? 'chatgpt';
    const input = typeof body.subject === 'string' ? body.subject.trim() : '';
    const subject = provider === 'chatgpt' ? 'email:' + input.toLowerCase() : input;
    const validEmail =
      provider === 'chatgpt' &&
      /^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(input) &&
      input.length <= 194;
    const validUid = provider === 'firebase' && input.length > 0 && input.length <= 200 && !/[\s:]/.test(input);
    if (
      !['chatgpt', 'firebase'].includes(provider) ||
      (!validEmail && !validUid) ||
      !['viewer', 'team_admin'].includes(body.role) ||
      !Array.isArray(body.teams) ||
      body.teams.some((t: string) => !(('ABCDEFGH'.includes(t) && t.length === 1) || t === VA_TEAM))
    )
      throw new ApiError('Usuario o permisos no válidos');
    if (body.role === 'team_admin' && !body.teams.length)
      throw new ApiError('Selecciona al menos un equipo para el responsable');
    if (body.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))
      throw new ApiError('Caducidad no válida');
    const uid = provider + ':' + subject;
    const sourceId = body.id ?? uid;
    const old = (await this.repo.all('SELECT * FROM users WHERE id=?', [sourceId]))[0] ?? null;
    if (body.id && !old) throw new ApiError('El usuario ya no existe. Recarga.', 409);
    if (old && old.provider !== provider) throw new ApiError('No se puede cambiar el proveedor');
    if (sourceId !== uid && (await this.repo.all('SELECT id FROM users WHERE id=?', [uid])).length)
      throw new ApiError('Ese correo ya tiene permisos. Edita su entrada.', 409);
    const oldGrants = await this.repo.all('SELECT * FROM grants WHERE user_id=?', [sourceId]);
    const expected = Number(body.version ?? 0);
    if ((old?.version ?? 0) !== expected) throw new ApiError('Los permisos cambiaron. Recarga.', 409);
    const token = id(),
      ops: Statement[] = old
        ? [
            {
              sql: 'UPDATE users SET role=?,version=version+1 WHERE id=? AND version=?',
              args: [body.role, sourceId, expected],
            },
          ]
        : [
            {
              sql: 'INSERT INTO users(id,provider,subject,role,version) VALUES(?,?,?,?,1)',
              args: [uid, provider, subject, body.role],
            },
          ];
    ops.push(
      {
        sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
        args: [token],
      },
      { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
      { sql: 'DELETE FROM grants WHERE user_id=?', args: [sourceId] },
    );
    if (old) ops.push({ sql: 'UPDATE users SET id=?,subject=? WHERE id=?', args: [uid, subject, sourceId] });
    if (body.role === 'team_admin' && body.teams.includes(VA_TEAM)) ops.push(ensureVaTeam);
    for (const t of new Set(body.role === 'team_admin' ? body.teams : []))
      ops.push({
        sql: 'INSERT INTO grants(id,user_id,team_id,expires_at) VALUES(?,?,?,?)',
        args: [id(), uid, t, body.expiresAt ?? null],
      });
    for (const team of new Set<string>([...oldGrants.map((g: any) => g.team_id), ...body.teams]))
      ops.push(...keepTeamAdmin(team));
    ops.push(
      this.audit(
        'permissions',
        null,
        { user: old, grants: oldGrants },
        { provider, subject, role: body.role, teams: body.role === 'team_admin' ? body.teams : [] },
      ),
    );
    await this.commit(ops);
    return { ok: true };
  }
  async deleteUser(body: any) {
    if (this.actor.role === 'team_admin') return this.deleteTeamUser(body);
    requireSuper(this.actor);
    const user = (await this.repo.all('SELECT * FROM users WHERE id=?', [body.id]))[0];
    if (!user || user.version !== body.version) throw new ApiError('Los permisos cambiaron. Recarga.', 409);
    const grants = await this.repo.all('SELECT * FROM grants WHERE user_id=?', [user.id]),
      token = id();
    await this.commit([
      { sql: 'UPDATE users SET version=version+1 WHERE id=? AND version=?', args: [user.id, body.version] },
      {
        sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
        args: [token],
      },
      { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
      { sql: 'DELETE FROM grants WHERE user_id=?', args: [user.id] },
      { sql: 'DELETE FROM users WHERE id=?', args: [user.id] },
      ...[...new Set<string>(grants.map((g: any) => g.team_id))].flatMap((team) => keepTeamAdmin(team)),
      this.audit('delete_permissions', null, { user, grants }, null),
    ]);
    return { ok: true };
  }
  /** Edit only a grant in the administrator's own team, never grants in other teams. */
  async configureTeamUser(body: any) {
    const team = body.teamId;
    if (typeof team !== 'string' || !this.actor.teams.includes(team))
      throw new ApiError('Equipo fuera de tus permisos', 403);
    const provider = body.provider ?? 'chatgpt',
      input = typeof body.subject === 'string' ? body.subject.trim() : '';
    const valid =
      provider === 'chatgpt'
        ? /^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(input) && input.length <= 194
        : provider === 'firebase' && input.length > 0 && input.length <= 200 && !/[\s:]/.test(input);
    if (
      !valid ||
      !['viewer', 'team_admin'].includes(body.role) ||
      !Array.isArray(body.teams) ||
      body.teams.some((t: any) => t !== team) ||
      body.teams.length > 1
    )
      throw new ApiError('Cuenta o permisos no válidos');
    if (body.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))
      throw new ApiError('Caducidad no válida');
    const subject = provider === 'chatgpt' ? 'email:' + input.toLowerCase() : input,
      uid = provider + ':' + subject,
      sourceId = body.id ?? uid;
    const old = (await this.repo.all('SELECT * FROM users WHERE id=?', [sourceId]))[0] ?? null;
    if (body.id && !old) throw new ApiError('Los permisos cambiaron. Recarga.', 409);
    if (old && (old.provider !== provider || old.subject !== subject))
      throw new ApiError('No puedes cambiar una identidad desde un equipo', 403);
    const expected = Number(body.id ? (body.version ?? 0) : (old?.version ?? 0));
    if ((old?.version ?? 0) !== expected) throw new ApiError('Los permisos cambiaron. Recarga.', 409);
    const enable = body.role === 'team_admin' && body.teams.includes(team);
    if (!old && !enable) throw new ApiError('No hay un permiso que retirar');
    if (old) {
      const assigned = await this.repo.all('SELECT 1 FROM grants WHERE user_id=? AND team_id=?', [uid, team]);
      if (!enable && !assigned.length) throw new ApiError('La cuenta no administra este equipo', 403);
      // Same exemption as keepTeamAdmin: VA may be left without an administrator of its own.
      if (assigned.length && (!enable || body.expiresAt) && team !== VA_TEAM) {
        const others = await this.repo.all(
          "SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.team_id=? AND g.user_id<>? AND g.expires_at IS NULL AND u.role='team_admin' LIMIT 1",
          [team, uid],
        );
        if (!others.length)
          throw new ApiError(
            'No se puede retirar o poner caducidad al último administrador permanente del equipo',
            409,
          );
      }
    }
    const ops: Statement[] = [],
      token = id();
    if (old) {
      ops.push(
        { sql: 'UPDATE users SET version=version+1 WHERE id=? AND version=?', args: [uid, expected] },
        {
          sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
          args: [token],
        },
        { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
      );
    } else
      ops.push({
        sql: "INSERT INTO users(id,provider,subject,role,version) VALUES(?,?,?,'team_admin',1)",
        args: [uid, provider, subject],
      });
    ops.push({ sql: 'DELETE FROM grants WHERE user_id=? AND team_id=?', args: [uid, team] });
    if (enable)
      ops.push({
        sql: 'INSERT INTO grants(id,user_id,team_id,expires_at) VALUES(?,?,?,?)',
        args: [id(), uid, team, body.expiresAt ?? null],
      });
    ops.push({
      sql: "UPDATE users SET role=CASE WHEN EXISTS(SELECT 1 FROM grants WHERE user_id=?) THEN 'team_admin' ELSE 'viewer' END WHERE id=?",
      args: [uid, uid],
    });
    ops.push(
      ...keepTeamAdmin(team),
      this.audit('permissions', { team_id: team }, { user: old }, { subject, role: enable ? 'team_admin' : 'viewer' }),
    );
    await this.commit(ops);
    return { ok: true };
  }
  async deleteTeamUser(body: any) {
    const team = body.teamId;
    if (typeof team !== 'string' || !this.actor.teams.includes(team))
      throw new ApiError('Equipo fuera de tus permisos', 403);
    const user = (await this.repo.all('SELECT * FROM users WHERE id=?', [body.id]))[0];
    if (!user || user.version !== body.version) throw new ApiError('Los permisos cambiaron. Recarga.', 409);
    const grants = await this.repo.all('SELECT * FROM grants WHERE user_id=? AND team_id=?', [user.id, team]);
    if (!grants.length) throw new ApiError('Esta cuenta no tiene permisos en tu equipo', 403);
    const others = await this.repo.all(
      "SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.team_id=? AND g.user_id<>? AND g.expires_at IS NULL AND u.role='team_admin' LIMIT 1",
      [team, user.id],
    );
    if (!others.length && team !== VA_TEAM)
      throw new ApiError('No se puede retirar al último administrador permanente del equipo', 409);
    const token = id(),
      ops: Statement[] = [
        { sql: 'UPDATE users SET version=version+1 WHERE id=? AND version=?', args: [user.id, user.version] },
        {
          sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
          args: [token],
        },
        { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
        { sql: 'DELETE FROM grants WHERE user_id=? AND team_id=?', args: [user.id, team] },
        {
          sql: "UPDATE users SET role=CASE WHEN EXISTS(SELECT 1 FROM grants WHERE user_id=?) THEN 'team_admin' ELSE 'viewer' END WHERE id=?",
          args: [user.id, user.id],
        },
        ...keepTeamAdmin(team),
        this.audit('delete_permissions', { team_id: team }, { user, grants }, null),
      ];
    await this.commit(ops);
    return { ok: true };
  }
  async admin() {
    if (this.actor.role === 'team_admin') {
      if (!this.actor.teams.length) throw new ApiError('No administras ningún equipo', 403);
      const grants = await this.repo.all(
        `SELECT g.* FROM grants g JOIN users u ON u.id=g.user_id WHERE u.role='team_admin' AND g.team_id IN (${this.actor.teams.map(() => '?').join(',')})`,
        this.actor.teams,
      );
      const ids = [...new Set<string>(grants.map((g: any) => g.user_id))];
      const users = ids.length
        ? await this.repo.all(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        : [];
      return { users, grants, revision: 0, audit: [] };
    }
    requireSuper(this.actor);
    const r = await this.repo.batch([
      { sql: 'SELECT * FROM users' },
      { sql: 'SELECT * FROM grants' },
      recentAudit(100),
      { sql: "SELECT revision FROM app_state WHERE id='main'" },
    ]);
    return {
      users: r[0].results,
      grants: r[1].results,
      audit: await this.withoutDiscreetEarly(r[2].results),
      revision: r[3].results[0]?.revision ?? 0,
    };
  }
  /**
   * The global log keeps discreet early choices out too (server/early-discretion.ts):
   * their rows go, and every other row's snapshots lose what names them.
   */
  private async withoutDiscreetEarly<R extends AuditRow & { campaign_id?: string | null }>(rows: R[]) {
    const campaigns = new Set(rows.flatMap((row) => (row.campaign_id ? [row.campaign_id] : [])));
    const byCampaign = new Map<
      string,
      { test: (row: AuditRow) => boolean; ids: Set<string>; consumed: Map<string, string> }
    >();
    for (const cid of campaigns) {
      const d = await this.load(cid).catch(() => null);
      if (!d) continue;
      const events = await eventsFor(this.repo, cid);
      if (
        !events.some(
          (row) => row.action === 'early_cancel' || row.action === 'early_choose' || row.action === 'advance',
        )
      )
        continue;
      const { hidden } = await this.election().concealedFor(d);
      const mine = await this.election().memberForAccount(d);
      const {
        row: test,
        ids,
        consumed,
      } = discretion(events, hidden, mine, new Set(d.awards.map((a: { id: string }) => a.id)), [
        ...d.requests,
        ...snapshotRequests(events),
      ]);
      if (ids.size || consumed.size) byCampaign.set(cid, { test, ids, consumed });
    }
    if (!byCampaign.size) return rows.map(logicalRow);
    const redact = (json: string | null, { ids, consumed }: { ids: Set<string>; consumed: Map<string, string> }) =>
      json && ([...ids].some((id) => json.includes(id)) || (consumed.size && json.includes('"preferences"')))
        ? JSON.stringify(redactDiscreet(JSON.parse(json), ids, consumed))
        : json;
    return rows.flatMap((stored) => {
      const row = logicalRow(stored);
      const discreet = row.campaign_id ? byCampaign.get(row.campaign_id) : undefined;
      if (!discreet) return [row];
      if (discreet.test(row)) return [];
      return [
        {
          ...row,
          before_json: redact(row.before_json, discreet),
          after_json: redact(row.after_json, discreet),
        },
      ];
    });
  }
  /** RRHH's workbook for the year, uploaded once by a superadministrator. */
  private async hrWorkbook(year: number) {
    const row = (await this.repo.all("SELECT * FROM hr_templates WHERE year=? AND kind='ordinary'", [year]))[0];
    if (!row) throw new ApiError(`Falta la plantilla de RRHH de ${year}`, 404);
    const zip = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
    return { row, zip, book: await readHrWorkbook(zip) };
  }
  private async hrCampaign(cid: string) {
    const d = await this.load(cid);
    requireWrite(this.actor, d.campaign.team_id);
    if (d.campaign.scope_key !== 'live') throw new ApiError('Solo se exporta la campaña real, no una simulación');
    return d;
  }
  async uploadHrTemplate(year: number, base64: string) {
    requireSuper(this.actor);
    if (!Number.isInteger(year) || typeof base64 !== 'string' || !base64) throw new ApiError('Plantilla no válida');
    let zip: Uint8Array;
    try {
      zip = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } catch {
      throw new ApiError('Plantilla no válida');
    }
    const book = await readHrWorkbook(zip).catch((e) => {
      throw new ApiError(e instanceof HrExportError ? e.message : 'El fichero no es la plantilla de RRHH');
    });
    if (book.year !== null && book.year !== year) throw new ApiError(`La plantilla es de ${book.year}, no de ${year}`);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', zip as BufferSource)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const at = now();
    await this.commit([
      {
        sql: "INSERT INTO hr_templates(year,kind,data,sha256,uploaded_by,uploaded_at) VALUES(?,'ordinary',?,?,?,?) ON CONFLICT(year,kind) DO UPDATE SET data=excluded.data,sha256=excluded.sha256,uploaded_by=excluded.uploaded_by,uploaded_at=excluded.uploaded_at",
        args: [year, base64, sha256, this.actor.id, at],
      },
      this.audit('hr_template', null, null, { year, sha256 }),
    ]);
    return { year, sha256, uploadedAt: at };
  }
  /** The team's RRHH roster and who is matched to which name. */
  async hrStatus(cid: string) {
    const d = await this.hrCampaign(cid);
    const year = d.campaign.year;
    const template = (
      await this.repo.all("SELECT year,sha256,uploaded_at FROM hr_templates WHERE year=? AND kind='ordinary'", [year])
    )[0];
    if (!template) return { year, template: null, roster: [], members: [], closed: d.campaign.status !== 'open' };
    const { book } = await this.hrWorkbook(year);
    const roster = book.sheets.find((s) => s.team === d.campaign.team_id)!.roster;
    const saved = new Map(
      (await this.repo.all('SELECT person_id,hr_name FROM hr_names WHERE year=?', [year])).map((r) => [
        r.person_id,
        r.hr_name,
      ]),
    );
    const suggested = suggestHrNames(d.members, roster);
    return {
      year,
      template: { sha256: template.sha256, uploadedAt: template.uploaded_at },
      roster,
      closed: d.campaign.status !== 'open',
      members: d.members.map((m) => ({
        id: m.id,
        code: m.code,
        label: m.label,
        // '' is an explicit "no name" (a rejected proposal); null means never reviewed.
        hrName: saved.get(m.person_id) ?? null,
        suggested: suggested[m.id] ?? null,
      })),
    };
  }
  /** name: an entry of column J; '' to reject any proposal; null to forget the decision. */
  async saveHrNames(cid: string, names: Record<string, string | null>) {
    const d = await this.hrCampaign(cid);
    const year = d.campaign.year;
    const { book } = await this.hrWorkbook(year);
    const roster = new Set(book.sheets.find((s) => s.team === d.campaign.team_id)!.roster);
    if (!names || typeof names !== 'object') throw new ApiError('Correspondencia no válida');
    const byId = new Map(d.members.map((m) => [m.id, m]));
    const ops: Statement[] = [];
    for (const [memberId, name] of Object.entries(names)) {
      const m = byId.get(memberId);
      if (!m) throw new ApiError('Persona desconocida en este equipo');
      if (name !== null && name !== '' && !roster.has(name))
        throw new ApiError(`«${name}» no está en la hoja ${d.campaign.team_id}`);
      ops.push(
        name === null
          ? { sql: 'DELETE FROM hr_names WHERE year=? AND person_id=?', args: [year, m.person_id] }
          : {
              sql: 'INSERT INTO hr_names(year,person_id,hr_name) VALUES(?,?,?) ON CONFLICT(year,person_id) DO UPDATE SET hr_name=excluded.hr_name',
              args: [year, m.person_id, name],
            },
      );
    }
    await this.commit([...ops, this.audit('hr_names', d.campaign, null, { year, names })]);
    return this.hrStatus(cid);
  }
  private async hrNames(year: number) {
    return new Map<string, string>(
      (await this.repo.all('SELECT person_id,hr_name FROM hr_names WHERE year=?', [year])).map((r) => [
        r.person_id,
        r.hr_name,
      ]),
    );
  }
  /** Cells of one team's sheet; throws HrExportError when the data cannot be written. */
  private async hrCells(cid: string, book: HrWorkbook, saved: Map<string, string>) {
    const d = await this.load(cid);
    const view = await this.view(cid);
    // Saved decisions first ('' = rejected); otherwise only exact proposals, never approximate ones.
    const names: Record<string, string> = {};
    const suggested = suggestHrNames(d.members, book.sheets.find((s) => s.team === d.campaign.team_id)!.roster);
    for (const m of d.members) {
      const name = saved.has(m.person_id)
        ? saved.get(m.person_id)!
        : suggested[m.id]?.exact
          ? suggested[m.id].name
          : '';
      if (name) names[m.id] = name;
    }
    return hrTeamCells({
      sheet: book.sheets.find((s) => s.team === d.campaign.team_id)!,
      cycles: view.result.cycles,
      members: d.members,
      awards: orderAwardsBySelection(view.awards, view.election?.timeline),
      names,
    });
  }
  /** RRHH's workbook with only this team's sheet filled in; the team must be closed. */
  async exportHrTeam(cid: string) {
    const d = await this.hrCampaign(cid);
    if (d.campaign.status === 'open') throw new ApiError('Cierra el equipo antes de exportarlo a RRHH');
    const { year, team_id: team } = d.campaign;
    const { row, zip, book } = await this.hrWorkbook(year);
    let cells;
    try {
      cells = await this.hrCells(cid, book, await this.hrNames(year));
    } catch (e) {
      if (e instanceof HrExportError) throw new ApiError(e.message, 409);
      throw e;
    }
    const bytes = await writeHrWorkbook(zip, book, { [team]: cells });
    await this.commit([
      this.audit('hr_export', d.campaign, null, { year, version: d.campaign.version, template: row.sha256 }),
    ]);
    return { name: `${year}_LECS_Vac_${team}.xlsm`, bytes };
  }
  /**
   * RRHH's workbook with the sheet of every closed or published team filled in (superadministrator).
   * Open teams are left as in the template and reported, so their sheet is never half-written.
   */
  async exportHrGlobal(year: number) {
    requireSuper(this.actor);
    const { row, zip, book } = await this.hrWorkbook(year);
    const campaigns = await this.repo.all(
      `SELECT id,team_id,status,version FROM campaigns WHERE year=? AND scope_key='live' AND ${ordinaryCampaign()} ORDER BY team_id`,
      [year],
    );
    const saved = await this.hrNames(year);
    const cellsByTeam: Record<string, HrCell[]> = {};
    const open: string[] = [];
    const problems: string[] = [];
    for (const c of campaigns) {
      if (c.status === 'open') {
        open.push(c.team_id);
        continue;
      }
      try {
        cellsByTeam[c.team_id] = await this.hrCells(c.id, book, saved);
      } catch (e) {
        if (!(e instanceof HrExportError)) throw e;
        problems.push(`Equipo ${c.team_id}: ${e.message}`);
      }
    }
    if (problems.length) throw new ApiError(problems.join(' · '), 409);
    if (!Object.keys(cellsByTeam).length) throw new ApiError('No hay ningún equipo cerrado o publicado que exportar');
    const bytes = await writeHrWorkbook(zip, book, cellsByTeam);
    await this.commit([
      this.audit('hr_export', null, null, {
        year,
        teams: campaigns.filter((c) => cellsByTeam[c.team_id]).map((c) => ({ team: c.team_id, version: c.version })),
        open,
        template: row.sha256,
      }),
    ]);
    return { name: `${year}_LECS_Vac_global.xlsm`, bytes, open };
  }
  async backup() {
    requireSuper(this.actor);
    const names = Object.keys(tableColumns),
      r = await this.repo.batch([
        ...names.map((n) => ({ sql: `SELECT * FROM ${n} ORDER BY ${n === 'audit' ? 'rowid' : tableColumns[n][0]}` })),
        { sql: "SELECT revision FROM app_state WHERE id='main'" },
      ]);
    const payload = {
      format: 'vacaciones-backup-v1',
      auditOrder: 'insertion',
      createdAt: now(),
      revision: r.at(-1)!.results[0]?.revision ?? 0,
      tables: Object.fromEntries(names.map((n, i) => [n, r[i].results])),
    };
    return { payload, sha256: await digest(JSON.stringify(payload)) };
  }
  async restore(b: any, expectedRevision: number) {
    requireSuper(this.actor);
    if (
      !b?.payload ||
      b.payload.format !== 'vacaciones-backup-v1' ||
      b.sha256 !== (await digest(JSON.stringify(b.payload)))
    )
      throw new ApiError('Copia inválida o integridad incorrecta');
    const tables = { ...b.payload.tables };
    for (const key of [
      'preferences',
      'election_states',
      'controller_accounts',
      'reconstruction_sessions',
      'hr_names',
      'va_quotas',
      'va_quota_sources',
    ])
      if (tables[key] === undefined) tables[key] = [];
    // The old VA election (ADR 0002, phase 5) is gone: its tables in older backups are dropped.
    for (const key of ['va_campaigns', 'va_election_history', 'va_reconstructions']) delete tables[key];
    // Local admin sessions are not backed up. Older backups kept them (and login
    // attempts) in audit: drop those rows so a restore never resurrects a session.
    if (Array.isArray(tables.audit))
      tables.audit = tables.audit.filter(
        (r: any) =>
          !['local_admin_session', 'local_admin_session_revoked', 'local_admin_login_attempt'].includes(r?.action),
      );
    // Undo history replays audit in insertion order. Older backups listed it by id:
    // recover chronological order from created_at (stable for equal times).
    if (b.payload.auditOrder !== 'insertion' && Array.isArray(tables.audit))
      tables.audit = [...tables.audit].sort((x: any, y: any) =>
        String(x.created_at).localeCompare(String(y.created_at)),
      );
    const names = Object.keys(tableColumns);
    if (names.some((n) => !Array.isArray(tables[n])) || Object.keys(tables).some((n) => !names.includes(n)))
      throw new ApiError('Tablas no válidas');
    if (names.reduce((n, t) => n + tables[t].length, 0) > 25000) throw new ApiError('Copia demasiado grande');
    for (const c of tables.campaigns) {
      const p = tables.parameters.find((p: any) => p.campaign_id === c.id);
      if (!p) throw new ApiError('Faltan parámetros');
      checkedConfig(JSON.parse(p.json), scopeOf(c));
    }
    try {
      for (const row of tables.election_states)
        validateElectionState(
          upgradeElectionState(JSON.parse(row.json))!,
          tables.campaign_members.filter((m: any) => m.campaign_id === row.campaign_id),
        );
      for (const pref of tables.preferences) {
        const member = tables.campaign_members.find(
            (m: any) => m.id === pref.member_id && m.campaign_id === pref.campaign_id,
          ),
          campaign = tables.campaigns.find((c: any) => c.id === pref.campaign_id),
          config = tables.parameters.find((p: any) => p.campaign_id === pref.campaign_id);
        if (!member || !campaign || !config) throw new Error('Preferencias ajenas a la campaña');
        const dates = JSON.parse(pref.dates_json),
          // VA days come from the HR quotas in the same file.
          quotas = Object.fromEntries(
            ((tables.va_quotas ?? []) as { year: number; date: string; places: number }[])
              .filter((q) => q.year === campaign.year)
              .map((q) => [q.date, q.places]),
          ),
          validDates = new Set(unitsOf(campaignOf(campaign, JSON.parse(config.json), { quotas })).map((c) => c.date));
        if (
          !Array.isArray(dates) ||
          dates.length > 100 ||
          new Set(dates).size !== dates.length ||
          dates.some((d) => !validDates.has(d)) ||
          ![0, 1].includes(pref.automatic) ||
          (pref.persistent !== undefined && ![0, 1].includes(pref.persistent)) ||
          (pref.active !== undefined && ![0, 1].includes(pref.active))
        )
          throw new Error('Preferencias no válidas');
      }
    } catch (e: any) {
      throw new ApiError('Copia no válida: ' + e.message);
    }
    const token = id(),
      ops: Statement[] = [
        { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main' AND revision=?", args: [expectedRevision] },
        {
          sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
          args: [token],
        },
        { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
      ];
    for (const n of [...names].reverse()) ops.push({ sql: `DELETE FROM ${n}` });
    // A restore invalidates every local admin session.
    ops.push({ sql: 'DELETE FROM local_admin_sessions' });
    ops.push({ sql: 'DELETE FROM cli_sessions' });
    for (const n of names) {
      const cols = tableColumns[n];
      for (const row of tables[n]) {
        if (Object.keys(row).some((k) => !cols.includes(k))) throw new ApiError('Columna desconocida');
        ops.push({
          sql: `INSERT INTO ${n}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
          args: cols.map(
            (k) =>
              row[k] ??
              (k === 'label'
                ? ''
                : k === 'position'
                  ? 0
                  : k === 'data_kind'
                    ? 'demo'
                    : n === 'people' && k === 'active'
                      ? 1
                      : k === 'kind'
                        ? 'ordinary'
                        : k === 'scope_key'
                          ? 'live'
                          : k === 'simulation_name'
                            ? ''
                            : n === 'preferences' && k === 'persistent'
                              ? 0
                              : n === 'preferences' && k === 'active'
                                ? 1
                                : n === 'preferences' && k === 'mode'
                                  ? 'immediate'
                                  : n === 'preferences' && k === 'wait_minutes'
                                    ? 0
                                    : n === 'preferences' && k === 'labels_json'
                                      ? '{}'
                                      : null),
          ),
        });
      }
    }
    ops.push(this.audit('restore', null, { revision: expectedRevision }, { sha256: b.sha256 }));
    await this.commit(ops);
    return { ok: true };
  }
}
async function digest(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The scheduler's identity when it applies a list whose wait ran out. Never a signed-in user. */
export const WAIT_EXPIRY_ACTOR: Principal = { id: 'sistema:plazo', role: 'superadmin', teams: [] };
/** Called by the minute dispatcher: each failure is isolated so one campaign cannot block the rest. */
export async function advanceExpiredTurns(repo: Repository, now = Date.now()) {
  const rows = await repo.all(
    "SELECT c.id FROM campaigns c JOIN election_states e ON e.campaign_id=c.id WHERE c.scope_key='live' AND c.status='open' AND json_extract(e.json,'$.status')='active' LIMIT 100",
  );
  const election = new Service(repo, WAIT_EXPIRY_ACTOR).election();
  let applied = 0,
    errors = 0;
  for (const row of rows) {
    try {
      applied += await election.expire(row.id, now);
    } catch {
      errors++;
    }
  }
  return { applied, errors };
}
