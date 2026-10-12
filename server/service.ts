import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { calendar, validateConfig, serial, ENGINE_VERSION, type Config } from '../domain/calendar.ts';
import { calculate } from '../domain/vacations.ts';
import { requireSuper, requireWrite, type Identity, type Principal } from './permissions.ts';
import { cas, tableColumns, type Repository, type Statement } from './repository.ts';
const id = () => crypto.randomUUID(), now = () => new Date().toISOString();
export class ApiError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
function checkedConfig(config:Config,year:number){try{return validateConfig(config,year);}catch(e:any){throw new ApiError(e.message??'Parámetros no válidos');}}
function checkedDate(value:string){try{return serial(value);}catch{throw new ApiError('Fecha no válida');}}
export async function principal(repo: Repository, identity: Identity, superEmails: string): Promise<Principal> { if (!identity)
    return { id: null, role: 'viewer', teams: [] }; const key = identity.provider + ':' + identity.subject; if (superEmails.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(identity.email.toLowerCase()))
    return { id: key, role: 'superadmin', teams: [] }; const user = (await repo.all('SELECT * FROM users WHERE provider=? AND subject=?', [identity.provider, identity.subject]))[0]; if (!user)
    return { id: key, role: 'viewer', teams: [] }; return { id: key, role: user.role === 'team_admin' ? 'team_admin' : 'viewer', teams: (await repo.all('SELECT team_id FROM grants WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)', [user.id, now()])).map(g => g.team_id) }; }
export class Service {
    constructor(private repo: Repository, public actor: Principal) { }
    async list() { const r = await this.repo.batch([{ sql: 'SELECT * FROM teams ORDER BY id' }, { sql: 'SELECT * FROM campaigns ORDER BY year DESC,team_id' }]); return { teams: r[0].results, campaigns: r[1].results, principal: this.actor }; }
    async load(cid: string) { const rows = await this.repo.batch([{ sql: 'SELECT * FROM campaigns WHERE id=?', args: [cid] }, { sql: 'SELECT * FROM parameters WHERE campaign_id=?', args: [cid] }, { sql: 'SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY code', args: [cid] }, { sql: 'SELECT * FROM requests WHERE campaign_id=? ORDER BY slot', args: [cid] }, { sql: 'SELECT * FROM awards WHERE campaign_id=?', args: [cid] }, { sql: 'SELECT * FROM runs WHERE campaign_id=? ORDER BY created_at DESC LIMIT 20', args: [cid] }]); const campaign = rows[0].results[0]; if (!campaign)
        throw new ApiError('Campaña no encontrada', 404); const config = JSON.parse(rows[1].results[0].json); return { campaign, config, members: rows[2].results, requests: rows[3].results, awards: rows[4].results, runs: rows[5].results }; }
    async view(cid: string) { const d = await this.load(cid); const editable = this.actor.role === 'superadmin' || this.actor.role === 'team_admin' && this.actor.teams.includes(d.campaign.team_id); if (editable)
        return { ...d, result: calculate(d.campaign.year, d.campaign.team_id, d.config, d.members, d.requests, d.awards), runs: d.runs.map((r: any) => ({ ...r, result_json: undefined })), editable: true }; const pub = d.campaign.published_run_id ? d.runs.find((r: any) => r.id === d.campaign.published_run_id) || (await this.repo.all('SELECT * FROM runs WHERE id=? AND campaign_id=?', [d.campaign.published_run_id, cid]))[0] : null; if (!pub)
        return { campaign: { id: cid, year: d.campaign.year, team_id: d.campaign.team_id, status: d.campaign.status }, members: [], requests: [], awards: [], config: null, result: null, runs: [], editable: false }; const s = JSON.parse(pub.result_json); return { campaign: { id: cid, year: d.campaign.year, team_id: d.campaign.team_id, status: 'published' }, members: s.members.map((m: any) => ({ id: m.id, code: m.code })), requests: s.requests, awards: s.awards, result: { ...s.result, ordering: s.result.ordering.map((m: any) => ({ id: m.id, code: m.code, score: m.score })) }, config: null, runs: [], editable: false }; }
    audit(action: string, c: any, before: any, after: any): Statement { return { sql: 'INSERT INTO audit(id,actor,action,team_id,campaign_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)', args: [id(), this.actor.id, action, c?.team_id ?? null, c?.id ?? null, before === null ? null : JSON.stringify(before), JSON.stringify(after), now()] }; }
    async commit(statements: Statement[]) { try {
        return await this.repo.batch([...statements, { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" }]);
    }
    catch (e) {
        if (String(e).includes('transaction_assertions'))
            throw new ApiError('Otra persona ha actualizado la campaña. Recarga antes de guardar.', 409);
        if (String(e).includes('UNIQUE constraint'))
            throw new ApiError('Este registro ya existe. Recarga para comprobarlo.', 409);
        throw e;
    } }
    async init() {
        requireSuper(this.actor);
        if ((await this.repo.all('SELECT id FROM teams')).length)
            throw new ApiError('El proyecto ya está inicializado', 409);
        const ops: Statement[] = [{ sql: "INSERT INTO app_state(id,revision) VALUES('main',0)" }];
        for (const t of 'ABCDEFGH') {
            const campaignId=id();
            ops.push(
                {sql:'INSERT INTO teams(id,name,version) VALUES(?,?,1)',args:[t,'Equipo '+t]},
                {sql:"INSERT INTO campaigns(id,team_id,year,status,version,created_at) VALUES(?,?,2026,'open',1,?)",args:[campaignId,t,now()]},
                {sql:'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)',args:[campaignId,JSON.stringify(defaultConfig(2026))]}
            );
            for(let i=1;i<=16;i++){
                const personId=t+'-'+i,code=t+String(i).padStart(2,'0'),seniority=`${2000+i}-01-01`;
                ops.push(
                    {sql:'INSERT INTO people(id,team_id,code,seniority,version) VALUES(?,?,?,?,1)',args:[personId,t,code,seniority]},
                    {sql:'INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority,version) VALUES(?,?,?,?,?,1)',args:[id(),campaignId,personId,code,seniority]}
                );
            }
        }
        ops.push(this.audit('initialize_demo',null,null,{teams:8,year:2026,fictional:true}));
        await this.commit(ops);
        return this.list();
    }
    async createCampaigns(year: number, copyYear: number | null) { requireSuper(this.actor); checkedConfig(defaultConfig(year), year); const ts = await this.repo.all('SELECT * FROM teams ORDER BY id'); if (ts.length !== 8)
        throw new ApiError('Inicializa los ocho equipos primero'); const people = await this.repo.all('SELECT * FROM people'); const prior = copyYear ? await this.repo.all('SELECT c.*,p.json FROM campaigns c JOIN parameters p ON p.campaign_id=c.id WHERE c.year=?', [copyYear]) : []; const ops: Statement[] = []; for (const t of ts) {
        const cid = id(), previous = prior.find(p => p.team_id === t.id);
        if (copyYear && !previous)
            throw new ApiError('El ejercicio de origen no contiene los ocho equipos');
        const config = previous ? copyConfig(JSON.parse(previous.json), copyYear!, year) : defaultConfig(year);
        checkedConfig(config, year);
        ops.push({ sql: 'INSERT INTO campaigns(id,team_id,year,status,version,created_at) VALUES(?,?,?,\'open\',1,?)', args: [cid, t.id, year, now()] }, { sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)', args: [cid, JSON.stringify(config)] });
        for (const p of people.filter(p => p.team_id === t.id))
            ops.push({ sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority,version) VALUES(?,?,?,?,?,1)', args: [id(), cid, p.id, p.code, p.seniority] });
        ops.push(this.audit('create_campaign', { id: cid, team_id: t.id }, null, { year, copyYear }));
    } await this.commit(ops); return this.list(); }
    async mutate(cid: string, body: any) {
        const d = await this.load(cid), c = d.campaign;
        requireWrite(this.actor, c.team_id);
        if (!Number.isInteger(body.version) || body.version !== c.version)
            throw new ApiError('La campaña cambió. Recarga antes de guardar.', 409);
        const action = body.action;
        if (c.status !== 'open' && !['reopen', 'publish', 'close'].includes(action))
            throw new ApiError('La campaña está cerrada. Un superadministrador puede reabrirla.');
        const ops = cas(cid, body.version);
        let before: any = null, after: any = body;
        if (action === 'config') {
            requireSuper(this.actor);
            const cfg = checkedConfig(body.config, c.year);
            const dates = new Set(calendar(c.year, c.team_id, cfg).map(s => s.date));
            if ([...d.requests, ...d.awards].some(r => !dates.has(r.cycle_date)))
                throw new ApiError('El cambio eliminaría ciclos con solicitudes o adjudicaciones');
            ops.push({ sql: 'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?', args: [JSON.stringify(cfg), cid] });
            before = d.config;
            after = cfg;
        }
        else if (action === 'request') {
            const m = d.members.find(m => m.id === body.memberId);
            if (!m)
                throw new ApiError('Identificador ajeno al equipo');
            if (!Number.isInteger(body.slot) || body.slot < 1 || body.slot > 6)
                throw new ApiError('Posición entre 1 y 6');
            if (!calendar(c.year, c.team_id, d.config).some(s => s.date === body.date))
                throw new ApiError('Ciclo no válido');
            if (d.requests.some(r => r.member_id === m.id && r.slot !== body.slot && r.cycle_date === body.date))
                throw new ApiError('Ese ciclo ya está solicitado por el trabajador');
            before = d.requests.find(r => r.member_id === m.id && r.slot === body.slot) ?? null;
            ops.push({ sql: 'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,1) ON CONFLICT(campaign_id,member_id,slot) DO UPDATE SET cycle_date=excluded.cycle_date,version=requests.version+1', args: [id(), cid, m.id, body.slot, body.date] });
        }
        else if (action === 'delete_request' || action === 'delete_award') {
            const table = action === 'delete_request' ? 'requests' : 'awards';
            before = (action === 'delete_request' ? d.requests : d.awards).find(r => r.id === body.id);
            if (!before)
                throw new ApiError('Registro no encontrado', 404);
            ops.push({ sql: `DELETE FROM ${table} WHERE id=? AND campaign_id=?`, args: [body.id, cid] });
            after = { deleted: body.id };
        }
        else if (action === 'award') {
            const m = d.members.find(m => m.id === body.memberId);
            if (!m)
                throw new ApiError('Identificador ajeno al equipo');
            if (d.awards.some(a => a.member_id === m.id && a.cycle_date === body.date))
                throw new ApiError('Adjudicación duplicada');
            const candidate = { id: id(), member_id: m.id, cycle_date: body.date };
            const check = calculate(c.year, c.team_id, d.config, d.members, d.requests, [...d.awards, candidate]);
            if (check.issues.length)
                throw new ApiError(check.issues.join('; '));
            ops.push({ sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)', args: [candidate.id, cid, m.id, body.date] });
            after = candidate;
        }
        else if (action === 'calculate') {
            const result = calculate(c.year, c.team_id, d.config, d.members, d.requests, d.awards);
            const runId = id();
            ops.push({ sql: 'INSERT INTO runs(id,campaign_id,source_version,engine_version,result_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)', args: [runId, cid, c.version + 1, ENGINE_VERSION, JSON.stringify({ result, config: d.config, members: d.members, requests: d.requests, awards: d.awards }), this.actor.id, now()] });
            after = { runId, issues: result.issues };
        }
        else if (action === 'publish') {
            requireSuper(this.actor);
            const run = d.runs.find(r => r.id === body.runId);
            if (!run || run.source_version !== c.version)
                throw new ApiError('Calcula una revisión con los datos actuales antes de publicar', 409);
            if (JSON.parse(run.result_json).result.issues.length)
                throw new ApiError('Resuelve las incidencias antes de publicar');
            ops.push({ sql: 'UPDATE campaigns SET status=\'published\',published_run_id=? WHERE id=?', args: [run.id, cid] });
            before = { status: c.status, publishedRunId: c.published_run_id };
            after = { status: 'published', runId: run.id };
        }
        else if (action === 'close' || action === 'reopen') {
            requireSuper(this.actor);
            ops.push({ sql: 'UPDATE campaigns SET status=? WHERE id=?', args: [action === 'close' ? 'closed' : 'open', cid] });
            before = { status: c.status };
            after = { status: action === 'close' ? 'closed' : 'open' };
        }
        else if (action === 'member') {
            requireSuper(this.actor);
            const code = String(body.code ?? '').trim().toUpperCase();
            if (!/^[A-Z0-9_-]{2,12}$/.test(code))
                throw new ApiError('Usa un código de 2 a 12 letras, números o guiones');
            checkedDate(body.seniority);
            const m = d.members.find(m => m.id === body.memberId);
            if(d.members.some(other=>other.code===code&&other.id!==m?.id))
                throw new ApiError('Ese código ya existe en esta campaña');
            if (m) {
                before = m;
                ops.push({ sql: 'UPDATE campaign_members SET code=?,seniority=?,version=version+1 WHERE id=? AND campaign_id=?', args: [code, body.seniority, m.id, cid] }, { sql: 'UPDATE people SET code=?,seniority=?,version=version+1 WHERE id=? AND team_id=?', args: [code, body.seniority, m.person_id, c.team_id] });
            }
            else {
                const pid = id();
                ops.push({ sql: 'INSERT INTO people(id,team_id,code,seniority,version) VALUES(?,?,?,?,1)', args: [pid, c.team_id, code, body.seniority] }, { sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority,version) VALUES(?,?,?,?,?,1)', args: [id(), cid, pid, code, body.seniority] });
            }
        }
        else
            throw new ApiError('Operación no válida');
        ops.push(this.audit(action, c, before, after));
        await this.commit(ops);
        return this.view(cid);
    }
    async configureUser(body: any) { requireSuper(this.actor); if (!['viewer', 'team_admin'].includes(body.role) || !Array.isArray(body.teams) || body.teams.some((t: string) => !('ABCDEFGH'.includes(t) && t.length === 1)) || typeof body.subject !== 'string' || body.subject.length < 1 || body.subject.length > 200)
        throw new ApiError('Usuario o permisos no válidos'); if (body.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))
        throw new ApiError('Caducidad no válida'); const uid = 'chatgpt:' + body.subject; const old = (await this.repo.all('SELECT * FROM users WHERE id=?', [uid]))[0] ?? null; const oldGrants = await this.repo.all('SELECT * FROM grants WHERE user_id=?', [uid]); const expected = Number(body.version ?? 0); if ((old?.version ?? 0) !== expected)
        throw new ApiError('Los permisos cambiaron. Recarga.', 409); const token = id(), ops: Statement[] = old ? [{ sql: 'UPDATE users SET role=?,version=version+1 WHERE id=? AND version=?', args: [body.role, uid, expected] }] : [{ sql: 'INSERT INTO users(id,provider,subject,role,version) VALUES(?,?,?,?,1)', args: [uid, 'chatgpt', body.subject, body.role] }]; ops.push({ sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] }, { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] }, { sql: 'DELETE FROM grants WHERE user_id=?', args: [uid] }); for (const t of new Set(body.teams))
        ops.push({ sql: 'INSERT INTO grants(id,user_id,team_id,expires_at) VALUES(?,?,?,?)', args: [id(), uid, t, body.expiresAt ?? null] }); ops.push(this.audit('permissions', null, { user: old, grants: oldGrants }, { subject: body.subject, role: body.role, teams: body.teams })); await this.commit(ops); return { ok: true }; }
    async admin() { requireSuper(this.actor); const r = await this.repo.batch([{ sql: 'SELECT * FROM users' }, { sql: 'SELECT * FROM grants' }, { sql: 'SELECT * FROM audit ORDER BY created_at DESC LIMIT 100' }, { sql: "SELECT revision FROM app_state WHERE id='main'" }]); return { users: r[0].results, grants: r[1].results, audit: r[2].results, revision: r[3].results[0]?.revision ?? 0 }; }
    async backup() { requireSuper(this.actor); const names = Object.keys(tableColumns), r = await this.repo.batch([...names.map(n => ({ sql: `SELECT * FROM ${n} ORDER BY ${tableColumns[n][0]}` })), { sql: "SELECT revision FROM app_state WHERE id='main'" }]); const payload = { format: 'vacaciones-backup-v1', createdAt: now(), revision: r.at(-1)!.results[0]?.revision ?? 0, tables: Object.fromEntries(names.map((n, i) => [n, r[i].results])) }; return { payload, sha256: await digest(JSON.stringify(payload)) }; }
    async restore(b: any, expectedRevision: number) {
        requireSuper(this.actor);
        if (!b?.payload || b.payload.format !== 'vacaciones-backup-v1' || b.sha256 !== await digest(JSON.stringify(b.payload)))
            throw new ApiError('Copia inválida o integridad incorrecta');
        const names = Object.keys(tableColumns);
        if (names.some(n => !Array.isArray(b.payload.tables[n])) || Object.keys(b.payload.tables).some(n => !names.includes(n)))
            throw new ApiError('Tablas no válidas');
        if (names.reduce((n, t) => n + b.payload.tables[t].length, 0) > 25000)
            throw new ApiError('Copia demasiado grande');
        for (const c of b.payload.tables.campaigns) {
            const p = b.payload.tables.parameters.find((p: any) => p.campaign_id === c.id);
            if (!p)
                throw new ApiError('Faltan parámetros');
            checkedConfig(JSON.parse(p.json), c.year);
        }
        const token = id(), ops: Statement[] = [{ sql: "UPDATE app_state SET revision=revision+1 WHERE id='main' AND revision=?", args: [expectedRevision] }, { sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] }, { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] }];
        for (const n of [...names].reverse())
            ops.push({ sql: `DELETE FROM ${n}` });
        for (const n of names) {
            const cols = tableColumns[n];
            for (const row of b.payload.tables[n]) {
                if (Object.keys(row).some(k => !cols.includes(k)))
                    throw new ApiError('Columna desconocida');
                ops.push({ sql: `INSERT INTO ${n}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, args: cols.map(k => row[k] ?? null) });
            }
        }
        ops.push(this.audit('restore', null, { revision: expectedRevision }, { sha256: b.sha256 }));
        await this.commit(ops);
        return { ok: true };
    }
}
async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join(''); }

