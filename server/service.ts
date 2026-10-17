import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { calendar, validateConfig, serial, ENGINE_VERSION, type Config } from '../domain/calendar.ts';
import { calculate } from '../domain/vacations.ts';
import { canWrite, requireSuper, requireWrite, type Identity, type Principal } from './permissions.ts';
import { cas, tableColumns, type Repository, type Statement } from './repository.ts';
import {validateRoster,rowStatements} from './roster.ts';
import {ApiError} from './errors.ts';
import {ElectionService,electionStateStatement} from './election-service.ts';
import {cloneSimulation} from './simulations.ts';
import {validateElectionState} from '../domain/election.ts';
export {ApiError} from './errors.ts';
const id = () => crypto.randomUUID(), now = () => new Date().toISOString();
function checkedConfig(config:Config,year:number){try{return validateConfig(config,year);}catch(e:any){throw new ApiError(e.message??'Parámetros no válidos');}}
function checkedDate(value:string){try{return serial(value);}catch{throw new ApiError('Fecha no válida');}}
export async function principal(repo: Repository, identity: Identity, superEmails: string): Promise<Principal> { if (!identity)
    return { id: null, role: 'viewer', teams: [] }; const key = identity.provider + ':' + identity.subject; if(identity.provider==='local_admin')return {id:key,role:'superadmin',teams:[]}; if ((identity.provider==='chatgpt'||identity.emailVerified===true)&&superEmails.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(identity.email.toLowerCase()))
    return { id: key, role: 'superadmin', teams: [] }; const user = (await repo.all('SELECT * FROM users WHERE provider=? AND subject=?', [identity.provider, identity.subject]))[0]; if (!user)
    return { id: key, role: 'viewer', teams: [] }; return { id: key, role: user.role === 'team_admin' ? 'team_admin' : 'viewer', teams: (await repo.all('SELECT team_id FROM grants WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)', [user.id, now()])).map(g => g.team_id) }; }
export class Service {
    constructor(private repo: Repository, public actor: Principal) { }
    election(){return new ElectionService(this.repo,this.actor,{load:cid=>this.load(cid),commit:ops=>this.commit(ops),audit:(a,c,b,n)=>this.audit(a,c,b,n)});}
    async list(){
        const r=await this.repo.batch([{sql:'SELECT * FROM teams ORDER BY id'},{sql:'SELECT * FROM campaigns ORDER BY year DESC,team_id,created_at'}]);
        const campaigns=r[1].results.filter(c=>c.scope_key==='live'||canWrite(this.actor,c.team_id));
        const mine=this.actor.id?await this.repo.all('SELECT m.campaign_id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE a.principal_key=?',[this.actor.id]):[];
        return {teams:r[0].results.filter(t=>/^[A-H]$/.test(t.id)).map(t=>({...t,name:'Equipo '+t.id})),campaigns,principal:this.actor,myCampaignIds:mine.map(m=>m.campaign_id).filter(id=>campaigns.some(c=>c.id===id))};
    }
    async createSimulation(cid:string,body:any){
        requireSuper(this.actor);const d=await this.load(cid);if(body.version!==d.campaign.version)throw new ApiError('La campaña cambió. Recarga antes de crear la simulación.',409);
        const result=await cloneSimulation(this.repo,d,body.name,body.copyPreferences===true);await this.commit([...result.statements,this.audit('simulation_created',{id:result.id,team_id:d.campaign.team_id},null,{source:cid,name:body.name})]);return {id:result.id};
    }
    async load(cid: string) { const rows = await this.repo.batch([{ sql: 'SELECT * FROM campaigns WHERE id=?', args: [cid] }, { sql: 'SELECT * FROM parameters WHERE campaign_id=?', args: [cid] }, { sql: 'SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position,code', args: [cid] }, { sql: 'SELECT * FROM requests WHERE campaign_id=? ORDER BY slot', args: [cid] }, { sql: 'SELECT * FROM awards WHERE campaign_id=?', args: [cid] }, { sql: 'SELECT * FROM runs WHERE campaign_id=? ORDER BY created_at DESC LIMIT 20', args: [cid] }]); const campaign = rows[0].results[0]; if (!campaign)
        throw new ApiError('Campaña no encontrada', 404); const config = JSON.parse(rows[1].results[0].json); return { campaign, config, members: rows[2].results, requests: rows[3].results, awards: rows[4].results, runs: rows[5].results }; }
    async view(cid:string){
        const d=await this.load(cid);if(d.campaign.scope_key!=='live'&&!canWrite(this.actor,d.campaign.team_id))throw new ApiError('Simulación reservada a administradores',403);const election=await this.election().view(d),result=calculate(d.campaign.year,d.campaign.team_id,d.config,d.members,d.requests,d.awards);
        if(canWrite(this.actor,d.campaign.team_id))return {...d,election,undo:await this.vacationUndo(cid,d.campaign.version).then(e=>e&&e.action!=='undo_vacations'?{id:e.id,action:e.action}:null),redo:await this.vacationUndo(cid,d.campaign.version).then(e=>e?.action==='undo_vacations'?{id:e.id}:null),result,runs:d.runs.map((r:any)=>({...r,result_json:undefined})),editable:true};
        return {campaign:{id:cid,year:d.campaign.year,team_id:d.campaign.team_id,status:d.campaign.status,version:d.campaign.version,data_kind:d.campaign.data_kind,scope_key:d.campaign.scope_key,simulation_name:d.campaign.simulation_name},members:d.members.map(m=>({id:m.id,code:m.code})),requests:[],awards:d.awards,result:{...result,ordering:[]},config:null,runs:[],election,participating:!!election.myMemberId,editable:false};
    }
    async publishedView(cid:string){
        const d=await this.load(cid);if(d.campaign.scope_key!=='live'&&!canWrite(this.actor,d.campaign.team_id))throw new ApiError('Simulación reservada a administradores',403);const run=d.campaign.published_run_id?(await this.repo.all('SELECT * FROM runs WHERE id=? AND campaign_id=?',[d.campaign.published_run_id,cid]))[0]:null;
        if(!run)return null;const snapshot=JSON.parse(run.result_json);
        return {campaign:{id:cid,year:d.campaign.year,team_id:d.campaign.team_id,status:'published'},members:snapshot.members.map((m:any)=>({id:m.id,code:m.code})),awards:snapshot.awards,result:{...snapshot.result,ordering:[]}};
    }
    async vacationUndo(cid:string,version:number) {
        const entries=await this.repo.all('SELECT * FROM audit WHERE campaign_id=? ORDER BY created_at DESC LIMIT 30',[cid]);
        return entries.find(e=>{const before=e.before_json?JSON.parse(e.before_json):null,after=JSON.parse(e.after_json);return before?.format==='vacations-undo-v1'&&after.version===version;})??null;
    }
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
    async createCampaigns(year: number, copyYear: number | null, rosterYear:number|null|'latest'='latest') { requireSuper(this.actor); checkedConfig(defaultConfig(year), year);
        if(rosterYear!=='latest'&&rosterYear!==null&&(!Number.isInteger(rosterYear)||rosterYear>=year))throw new ApiError('La plantilla de origen debe ser de un ejercicio anterior');
        const ts = await this.repo.all('SELECT * FROM teams ORDER BY id'); if (ts.length !== 8)
        throw new ApiError('Inicializa los ocho equipos primero'); const prior = copyYear ? await this.repo.all('SELECT c.*,p.json FROM campaigns c JOIN parameters p ON p.campaign_id=c.id WHERE c.year=? AND c.scope_key=\'live\'', [copyYear]) : []; const ops: Statement[] = []; for (const t of ts) {
        const cid = id(), previous = prior.find(p => p.team_id === t.id);
        const rosterSource=rosterYear===null?null:(await this.repo.all(rosterYear==='latest'?'SELECT * FROM campaigns WHERE team_id=? AND year<? AND scope_key=\'live\' ORDER BY year DESC LIMIT 1':'SELECT * FROM campaigns WHERE team_id=? AND year=? AND scope_key=\'live\'',[t.id,rosterYear==='latest'?year:rosterYear]))[0];
        if(rosterYear!==null&&!rosterSource)throw new ApiError('No hay plantilla de origen para el equipo '+t.id+'. Elige empezar sin controladores.');
        const annualPeople=rosterSource?await this.repo.all('SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position,code',[rosterSource.id]):[];
        if(annualPeople.some(p=>p.seniority&&p.seniority>`${year}-12-31`))throw new ApiError('La plantilla contiene una antigüedad posterior al ejercicio');
        // Lock each selected source while copying, so a concurrent edit rolls back creation.
        if(rosterSource){const token=id();ops.push({sql:'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (SELECT version FROM campaigns WHERE id=?)=? THEN ? ELSE NULL END)',args:[rosterSource.id,rosterSource.version,token]},{sql:'DELETE FROM transaction_assertions WHERE id=?',args:[token]});}
        if (copyYear && !previous)
            throw new ApiError('El ejercicio de origen no contiene los ocho equipos');
        if(previous&&previous.id!==rosterSource?.id){const token=id();ops.push({sql:'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (SELECT version FROM campaigns WHERE id=?)=? THEN ? ELSE NULL END)',args:[previous.id,previous.version,token]},{sql:'DELETE FROM transaction_assertions WHERE id=?',args:[token]});}
        const config = previous ? copyConfig(JSON.parse(previous.json), copyYear!, year) : defaultConfig(year);
        checkedConfig(config, year);
        ops.push({ sql: 'INSERT INTO campaigns(id,team_id,year,status,version,data_kind,created_at) VALUES(?,?,?,\'open\',1,?,?)', args: [cid, t.id, year,rosterSource?.data_kind??'configured', now()] }, { sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)', args: [cid, JSON.stringify(config)] });
        for (const p of annualPeople)
            ops.push({ sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)', args: [id(), cid, p.person_id, p.code, p.label??'', p.seniority,p.position??0] });
        ops.push(this.audit('create_campaign', { id: cid, team_id: t.id }, null, { year, copyYear,rosterYear:rosterSource?.year??null }));
    } await this.commit(ops); return this.list(); }
    async mutate(cid: string, body: any) {
        const d = await this.load(cid), c = d.campaign;
        requireWrite(this.actor, c.team_id);
        if (!Number.isInteger(body.version) || body.version !== c.version)
            throw new ApiError('La campaña cambió. Recarga antes de guardar.', 409);
        const action = body.action;
        const election=await this.election().read(cid);
        if(election.state?.status==='active'&&!['calculate','close'].includes(action))throw new ApiError('Pausa la elección antes de corregir datos o cambiar la plantilla');
        if (c.status !== 'open' && !['reopen', 'publish', 'close'].includes(action))
            throw new ApiError('La campaña está cerrada. Un superadministrador puede reabrirla.');
        const ops = cas(cid, body.version);
        let before: any = null, after: any = body;
        if (action === 'reset_vacations') {
            requireSuper(this.actor);
            if(body.confirmation!==`${c.team_id}-${c.year}`)throw new ApiError('Confirma el equipo y ejercicio antes de empezar de cero');
            ops.push({sql:'DELETE FROM requests WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM awards WHERE campaign_id=?',args:[cid]});
            after={requests:0,awards:0};
        }
        else if(action==='undo_vacations'||action==='redo_vacations'){
            const entry=await this.vacationUndo(cid,c.version);
            if(!entry||entry.id!==body.undoId||(action==='redo_vacations')!==(entry.action==='undo_vacations'))throw new ApiError('El cambio ya no se puede deshacer. Recarga la campaña.',409);
            const snapshot=JSON.parse(entry.before_json);
            ops.push({sql:'DELETE FROM requests WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM awards WHERE campaign_id=?',args:[cid]});
            for(const r of snapshot.requests)ops.push({sql:'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,?)',args:[r.id,cid,r.member_id,r.slot,r.cycle_date,r.version]});
            for(const a of snapshot.awards)ops.push({sql:'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,?)',args:[a.id,cid,a.member_id,a.cycle_date,a.version]});
            after={undone:entry.id};
        }
        else if (action === 'config') {
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
            // Original imported selections populated both relations. Keep their correction unified.
            // Criterios 1.1 p.2: correcting a later award must not erase the original selection.
            // Legacy imported grids without an election still behave as before.
            if(action==='delete_award'&&!election.state)ops.push({sql:'DELETE FROM requests WHERE campaign_id=? AND member_id=? AND cycle_date=?',args:[cid,before.member_id,before.cycle_date]});
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
            ops.push({ sql: 'INSERT INTO runs(id,campaign_id,source_version,engine_version,result_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)', args: [runId, cid, c.version + 1, ENGINE_VERSION, JSON.stringify({ result, config: d.config, members: d.members, requests: d.requests, awards: d.awards,election }), this.actor.id, now()] });
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
        else if(action==='import_roster'){
            requireSuper(this.actor);
            const source=body.source;
            if(!source||source.format!=='vacaciones-roster-v1'||source.team!==c.team_id||source.year!==c.year)throw new ApiError('La plantilla no corresponde a este equipo y ejercicio');
            const importedConfig=source.config?checkedConfig(source.config,c.year):d.config;
            let rows;try{rows=validateRoster(source.rows,c.year,c.team_id,importedConfig);}catch(e:any){throw new ApiError(e.message);}
            const imported=rows.map((r,i)=>({...r,id:id(),personId:id(),position:i}));
            const selections=imported.flatMap(m=>(m.dates??[]).map((date,i)=>({id:id(),member_id:m.id,slot:i+1,cycle_date:date})).filter(r=>r.cycle_date));
            // The original selection grid drives both the request and the vacation relation.
            const importedAwards=source.copySelections?selections.map(r=>({id:id(),member_id:r.member_id,cycle_date:r.cycle_date})):[];
            const check=calculate(c.year,c.team_id,importedConfig,imported,selections,importedAwards);
            if(check.issues.length)throw new ApiError('Revisa la plantilla: '+check.issues.join('; '));

            ops.push({sql:'DELETE FROM preferences WHERE campaign_id=?',args:[cid]},electionStateStatement(cid,null),{sql:'DELETE FROM requests WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM awards WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM campaign_members WHERE campaign_id=?',args:[cid]});

            for(const m of imported){
                const annual=d.members.find(p=>p.code===m.code);
                const existing=annual?{id:annual.person_id}:null;
                if(existing){m.personId=existing.id;ops.push({sql:'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',args:[m.id,cid,existing.id,m.code,m.label,m.seniority,m.position]});}
                else ops.push(...rowStatements(cid,c.team_id,m,m.position,m.personId,m.id));
            }
            for(const r of selections)ops.push({sql:'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,1)',args:[r.id,cid,r.member_id,r.slot,r.cycle_date]});
            for(const a of importedAwards)ops.push({sql:'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',args:[a.id,cid,a.member_id,a.cycle_date]});
            ops.push({sql:"UPDATE campaigns SET data_kind='imported' WHERE id=?",args:[cid]});
            if(source.config)ops.push({sql:'UPDATE parameters SET json=?,version=version+1 WHERE campaign_id=?',args:[JSON.stringify(importedConfig),cid]});
            before={members:d.members,requests:d.requests,awards:d.awards,config:d.config};after={source:source.source??'Plantilla importada',members:rows.length,selections:selections.length,awards:importedAwards.length,configurationImported:!!source.config};
        }
        else if(action==='bulk_members'){
            requireSuper(this.actor);
            let rows;try{rows=validateRoster(body.rows,c.year,c.team_id,d.config);}catch(e:any){throw new ApiError(e.message);}
            const resolved=rows.map((r,i)=>{const member=r.memberId?d.members.find(m=>m.id===r.memberId):d.members.find(m=>m.code===r.code);if(r.memberId&&!member)throw new ApiError('Controlador ajeno a este equipo');return {row:r,member,position:member?.position??d.members.length+i};});
            const memberIds=resolved.map(r=>r.member?.id).filter(Boolean);
            if(new Set(memberIds).size!==memberIds.length)throw new ApiError('El mismo controlador aparece en dos filas');
            const touched=new Set(resolved.map(r=>r.member?.id).filter(Boolean));
            if(resolved.some(r=>d.members.some(m=>m.code===r.row.code&&!touched.has(m.id))))throw new ApiError('Hay un identificador duplicado en la plantilla');

            for(const {row:r,member,position} of resolved){
                if(member)ops.push({sql:'UPDATE campaign_members SET code=?,label=?,seniority=?,version=version+1 WHERE id=? AND campaign_id=?',args:[r.code,r.label,r.seniority,member.id,cid]});
                else ops.push(...rowStatements(cid,c.team_id,r,position,id(),id()));
            }
            ops.push({sql:"UPDATE campaigns SET data_kind='configured' WHERE id=?",args:[cid]});
            before=d.members;after=rows;
        }
        else if(action==='transfer_member'){
            if(c.scope_key!=='live')throw new ApiError('El traslado entre grupos se gestiona en la campaña real, no desde una simulación aislada');
            requireSuper(this.actor);
            const member=d.members.find(m=>m.id===body.memberId);
            if(!member)throw new ApiError('Controlador no encontrado',404);
            if(election.preferences.some(p=>p.member_id===member.id&&p.dates.length))throw new ApiError('Vacía sus preferencias antes de cambiar de turno');
            if([...d.requests,...d.awards].some(r=>r.member_id===member.id))throw new ApiError('El controlador tiene vacaciones en este ejercicio. Corrige sus registros o realiza el cambio en un ejercicio nuevo sin vacaciones.');
            const target=(await this.repo.all('SELECT * FROM campaigns WHERE team_id=? AND year=? AND scope_key=\'live\'',[body.targetTeam,c.year]))[0];
            if(!target||target.id===cid||target.status!=='open')throw new ApiError('Elige otro equipo con campaña abierta en el mismo ejercicio');
            if(target.version!==body.targetVersion)throw new ApiError('El equipo de destino cambió. Recarga antes de trasladar.',409);
            const destination=await this.load(target.id);
            const targetElection=await this.election().read(target.id);
            if(targetElection.state?.status==='active')throw new ApiError('Pausa también la elección del equipo de destino antes del traslado');
            if(destination.members.some(m=>m.person_id===member.person_id||m.code===member.code))throw new ApiError('La persona o su identificador ya existe en el equipo de destino');
            if(destination.members.length>=100)throw new ApiError('El equipo de destino ha alcanzado el máximo de 100 controladores');
            ops.push(...cas(target.id,target.version),electionStateStatement(target.id,null),{sql:'DELETE FROM preferences WHERE member_id=? AND campaign_id=?',args:[member.id,cid]},{sql:'DELETE FROM campaign_members WHERE id=? AND campaign_id=?',args:[member.id,cid]},{sql:'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',args:[id(),target.id,member.person_id,member.code,member.label,member.seniority,Math.max(-1,...destination.members.map(m=>m.position))+1]},{sql:"UPDATE campaigns SET data_kind='configured' WHERE id IN (?,?)",args:[cid,target.id]});
            before=member;after={code:member.code,from:c.team_id,to:target.team_id,year:c.year};
            ops.push(this.audit('transfer_received',target,null,after));
        }
        else if(action==='retire_member'){
            requireSuper(this.actor);
            const member=d.members.find(m=>m.id===body.memberId);
            if(!member)throw new ApiError('Identificador no encontrado',404);
            if(election.preferences.some(p=>p.member_id===member.id&&p.dates.length))throw new ApiError('Vacía sus preferencias antes de dar la baja');
            if([...d.requests,...d.awards].some(r=>r.member_id===member.id))throw new ApiError('Retira sus solicitudes y adjudicaciones del borrador antes de retirar el identificador');
            ops.push({sql:'DELETE FROM preferences WHERE member_id=? AND campaign_id=?',args:[member.id,cid]},{sql:'DELETE FROM campaign_members WHERE id=? AND campaign_id=?',args:[member.id,cid]});
            before=member;after={retired:member.code};
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
                ops.push({ sql: 'UPDATE campaign_members SET code=?,seniority=?,version=version+1 WHERE id=? AND campaign_id=?', args: [code, body.seniority, m.id, cid] });
            }
            else {
                const pid = id();
                ops.push(...rowStatements(cid,c.team_id,{code,label:'',seniority:body.seniority},d.members.length,pid,id()));
            }
        }
        else
            throw new ApiError('Operación no válida');
        if(['request','award','delete_request','delete_award','reset_vacations','undo_vacations','redo_vacations'].includes(action)){
            before={format:'vacations-undo-v1',requests:d.requests,awards:d.awards,election};
            after={...after,version:c.version+1};
        }
        if(action==='close'&&election.state)ops.push(electionStateStatement(cid,{...election.state,status:'paused'}));
        if(action==='reset_vacations'){ops.push({sql:'DELETE FROM preferences WHERE campaign_id=?',args:[cid]},electionStateStatement(cid,null));}
        else if(action==='undo_vacations'||action==='redo_vacations'){const entry=await this.vacationUndo(cid,c.version);const old=entry?JSON.parse(entry.before_json):null;if(old?.election){ops.push({sql:'DELETE FROM preferences WHERE campaign_id=?',args:[cid]},electionStateStatement(cid,old.election.state));for(const p of old.election.preferences)ops.push({sql:'INSERT INTO preferences(member_id,campaign_id,dates_json,automatic) VALUES(?,?,?,?)',args:[p.member_id,cid,JSON.stringify(p.dates),p.automatic?1:0]});}}
        else if(election.state&& !['calculate','publish','close','reopen'].includes(action))ops.push(electionStateStatement(cid,null));
        ops.push(this.audit(action, c, before, after));
        await this.commit(ops);
        return this.view(cid);
    }
    async configureUser(body: any) {
        requireSuper(this.actor);
        const provider=body.provider??'chatgpt';
        if(!['chatgpt','firebase'].includes(provider)||!['viewer','team_admin'].includes(body.role)
        ||!Array.isArray(body.teams)||body.teams.some((t:string)=>!('ABCDEFGH'.includes(t)&&t.length===1))
        ||typeof body.subject!=='string'||body.subject.length<1||body.subject.length>200||/[\s:]/.test(body.subject))
            throw new ApiError('Usuario o permisos no válidos');
        if(body.expiresAt&&(!Number.isFinite(Date.parse(body.expiresAt))||Date.parse(body.expiresAt)<=Date.now()))
            throw new ApiError('Caducidad no válida');
        const uid=provider+':'+body.subject;
        const old=(await this.repo.all('SELECT * FROM users WHERE id=?',[uid]))[0]??null;
        const oldGrants=await this.repo.all('SELECT * FROM grants WHERE user_id=?',[uid]);
        const expected=Number(body.version??0);
        if((old?.version??0)!==expected)throw new ApiError('Los permisos cambiaron. Recarga.',409);
        const token=id(),ops:Statement[]=old
            ?[{sql:'UPDATE users SET role=?,version=version+1 WHERE id=? AND version=?',args:[body.role,uid,expected]}]
            :[{sql:'INSERT INTO users(id,provider,subject,role,version) VALUES(?,?,?,?,1)',args:[uid,provider,body.subject,body.role]}];
        ops.push({sql:'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',args:[token]},
            {sql:'DELETE FROM transaction_assertions WHERE id=?',args:[token]},
            {sql:'DELETE FROM grants WHERE user_id=?',args:[uid]});
        for(const t of new Set(body.teams))ops.push({sql:'INSERT INTO grants(id,user_id,team_id,expires_at) VALUES(?,?,?,?)',args:[id(),uid,t,body.expiresAt??null]});
        ops.push(this.audit('permissions',null,{user:old,grants:oldGrants},{provider,subject:body.subject,role:body.role,teams:body.teams}));
        await this.commit(ops);return {ok:true};
    }
    async admin() { requireSuper(this.actor); const r = await this.repo.batch([{ sql: 'SELECT * FROM users' }, { sql: 'SELECT * FROM grants' }, { sql: 'SELECT * FROM audit ORDER BY created_at DESC LIMIT 100' }, { sql: "SELECT revision FROM app_state WHERE id='main'" }]); return { users: r[0].results, grants: r[1].results, audit: r[2].results, revision: r[3].results[0]?.revision ?? 0 }; }
    async backup() { requireSuper(this.actor); const names = Object.keys(tableColumns), r = await this.repo.batch([...names.map(n => ({ sql: `SELECT * FROM ${n} ORDER BY ${tableColumns[n][0]}` })), { sql: "SELECT revision FROM app_state WHERE id='main'" }]); const payload = { format: 'vacaciones-backup-v1', createdAt: now(), revision: r.at(-1)!.results[0]?.revision ?? 0, tables: Object.fromEntries(names.map((n, i) => [n, r[i].results])) }; return { payload, sha256: await digest(JSON.stringify(payload)) }; }
    async restore(b: any, expectedRevision: number) {
        requireSuper(this.actor);
        if (!b?.payload || b.payload.format !== 'vacaciones-backup-v1' || b.sha256 !== await digest(JSON.stringify(b.payload)))
            throw new ApiError('Copia inválida o integridad incorrecta');
        const tables={...b.payload.tables}; for(const key of ['preferences','election_states','controller_accounts'])if(tables[key]===undefined)tables[key]=[];
        const names = Object.keys(tableColumns);
        if (names.some(n => !Array.isArray(tables[n])) || Object.keys(tables).some(n => !names.includes(n)))
            throw new ApiError('Tablas no válidas');
        if (names.reduce((n, t) => n + tables[t].length, 0) > 25000)
            throw new ApiError('Copia demasiado grande');
        for (const c of tables.campaigns) {
            const p = tables.parameters.find((p: any) => p.campaign_id === c.id);
            if (!p)
                throw new ApiError('Faltan parámetros');
            checkedConfig(JSON.parse(p.json), c.year);
        }
        try{
            for(const row of tables.election_states)validateElectionState(JSON.parse(row.json),tables.campaign_members.filter((m:any)=>m.campaign_id===row.campaign_id));
            for(const pref of tables.preferences){const member=tables.campaign_members.find((m:any)=>m.id===pref.member_id&&m.campaign_id===pref.campaign_id),campaign=tables.campaigns.find((c:any)=>c.id===pref.campaign_id),config=tables.parameters.find((p:any)=>p.campaign_id===pref.campaign_id);if(!member||!campaign||!config)throw new Error('Preferencias ajenas a la campaña');const dates=JSON.parse(pref.dates_json),validDates=new Set(calendar(campaign.year,campaign.team_id,JSON.parse(config.json)).map(c=>c.date));if(!Array.isArray(dates)||dates.length>100||new Set(dates).size!==dates.length||dates.some(d=>!validDates.has(d))||![0,1].includes(pref.automatic))throw new Error('Preferencias no válidas');}
        }catch(e:any){throw new ApiError('Copia no válida: '+e.message);}
        const token = id(), ops: Statement[] = [{ sql: "UPDATE app_state SET revision=revision+1 WHERE id='main' AND revision=?", args: [expectedRevision] }, { sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] }, { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] }];
        for (const n of [...names].reverse())
            ops.push({ sql: `DELETE FROM ${n}` });
        for (const n of names) {
            const cols = tableColumns[n];
            for (const row of tables[n]) {
                if (Object.keys(row).some(k => !cols.includes(k)))
                    throw new ApiError('Columna desconocida');
                ops.push({ sql: `INSERT INTO ${n}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, args: cols.map(k => row[k] ?? (k==='label'?'':k==='position'?0:k==='data_kind'?'demo':n==='people'&&k==='active'?1:k==='scope_key'?'live':k==='simulation_name'?'':null)) });
            }
        }
        ops.push(this.audit('restore', null, { revision: expectedRevision }, { sha256: b.sha256 }));
        await this.commit(ops);
        return { ok: true };
    }
}
async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join(''); }












