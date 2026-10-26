import test from 'node:test';
import assert from 'node:assert/strict';
import {AuditContext,auditBefore,auditAfter,appliedAudit} from '../server/audit-context.ts';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';

test('audit read context shares replay and parsed snapshots within one view only',async()=>{
 const persisted={id:'choice',action:'choose',created_at:'2026-10-24T10:00:00Z',
  before_json:JSON.stringify({format:'election-undo-v1',awards:[]}),
  after_json:JSON.stringify({choices:[{member_id:'A',cycle_date:'2027-01-01'}]})};
 let reads=0;
 const repo={async all<T=any>():Promise<T[]>{reads++;return [{...persisted}] as T[];},async batch(){return [];}};
 const context=new AuditContext(repo,'campaign',1);
 const [rows,replay,again]=await Promise.all([context.rows(),context.replay(),context.replay()]);
 assert.equal(reads,1);
 assert.equal(replay,again);
 assert.equal(replay.done[0],rows[0]);
 assert.equal(auditBefore(rows[0]),auditBefore(rows[0]));
 assert.equal(auditAfter(rows[0]),auditAfter(rows[0]));
 assert.deepEqual(JSON.parse(JSON.stringify(rows[0])),persisted,'Parsed snapshots never leak through serialization');
 assert.deepEqual(replay,appliedAudit([persisted]));
 const next=new AuditContext(repo,'campaign',2);
 const newer=(await next.rows())[0];
 assert.equal(reads,2,'A later view always has a fresh read context');
 assert.notEqual(auditBefore(newer),auditBefore(rows[0]));
});

test('administrator campaign view reads full election history once and vacation undo once',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,{id:'test:owner',role:'superadmin',teams:[]});
 await service.init();
 const cid=(await service.list()).campaigns[0].id;
 const original=repo.all.bind(repo),queries:string[]=[];
 repo.all=async<T=any>(sql:string,args:any[]=[])=>{queries.push(sql);return original<T>(sql,args);};
 await service.view(cid);
 assert.equal(queries.filter(sql=>sql==='SELECT id,action,before_json,after_json,created_at FROM audit WHERE campaign_id=? ORDER BY rowid ASC').length,1);
 assert.equal(queries.filter(sql=>sql==='SELECT * FROM audit WHERE campaign_id=? ORDER BY created_at DESC LIMIT 30').length,1);
 queries.length=0;
 await service.view(cid);
 assert.equal(queries.filter(sql=>sql==='SELECT id,action,before_json,after_json,created_at FROM audit WHERE campaign_id=? ORDER BY rowid ASC').length,1,'A subsequent request reloads history');
 repo.db.close();
});

test('audit campaign index supports ordered replay in a newly migrated database',()=>{
 const repo=new SQLiteRepo();
 const plans=repo.db.prepare('EXPLAIN QUERY PLAN SELECT id,action,before_json,after_json,created_at FROM audit WHERE campaign_id=? ORDER BY rowid ASC').all('campaign');
 assert.ok(plans.some(row=>String(row.detail).includes('USING INDEX audit_campaign')));
 assert.ok(!plans.some(row=>String(row.detail).includes('USE TEMP B-TREE')));
 repo.db.close();
});
test('deshacer una entrada concreta la retira de su sitio y rehacer la devuelve al mismo',()=>{
 const row=(id:string,action:string,after:any={})=>({id,action,before_json:JSON.stringify({format:'election-undo-v1'}),after_json:JSON.stringify(after)});
 const choose=row('choose','choose'),list=row('list','preferences',{memberId:'A'});
 const undo={id:'undo',action:'election_undo',before_json:null,after_json:JSON.stringify({undoTargetId:'choose'})};
 const undone=appliedAudit([choose,list,undo]);
 assert.deepEqual(undone.done.map(e=>e.id),['list']);
 assert.equal(undone.redo,undo);
 assert.equal(undone.redoOriginal,choose);
 // A later list edit keeps redo available; redo puts the decision back in order.
 const relist=row('relist','preferences',{memberId:'A'});
 const redone=appliedAudit([choose,list,undo,relist,{id:'redo',action:'election_redo',before_json:null,after_json:'{}'}]);
 assert.deepEqual(redone.done.map(e=>e.id),['choose','list','relist']);
 // Rows without a recorded target keep undoing the newest entry.
 assert.deepEqual(appliedAudit([choose,list,{...undo,after_json:'{}'}]).done.map(e=>e.id),['choose']);
});
