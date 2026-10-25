import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
// No configurable remote URL: destructive QA is restricted to the dedicated local DB.
const origin='http://127.0.0.1:5199';
const codes=Array.from({length:20},(_,i)=>'QA'+String(i+1).padStart(2,'0'));

async function post(api:APIRequestContext,path:string,body:unknown){
 const r=await api.post('/api/'+path,{data:body,headers:{Origin:origin}});
 expect(r.ok(),await r.text()).toBeTruthy();return r.json();
}
async function read(api:APIRequestContext,id:string){const r=await api.get('/api/campaign/'+id);expect(r.ok()).toBeTruthy();return r.json();}
async function election(api:APIRequestContext,id:string,body:object){const d=await read(api,id);return post(api,'election/'+id,{...body,version:d.campaign.version});}

/** An isolated 2027 simulation of team C with a roster large enough to complete. */
async function setup2027(api:APIRequestContext,page:Page){
 await api.get('/signin-with-chatgpt?return_to=/');
 await page.context().addCookies((await api.storageState()).cookies);
 let index=await (await api.get('/api/index')).json();
 if(!index.campaigns.length)index=await post(api,'initialize',{});
 if(!index.campaigns.some((c:any)=>c.year===2027)){await post(api,'campaigns',{year:2027,copyYear:2026});index=await (await api.get('/api/index')).json();}
 const live=index.campaigns.find((c:any)=>c.team_id==='C'&&c.year===2027&&c.scope_key==='live');
 const baseline=await read(api,live.id);
 const clone=await post(api,'simulations/'+live.id,{name:'Playwright 2027 '+crypto.randomUUID().slice(0,8),version:baseline.campaign.version});
 let d=await read(api,clone.id);
 d=await post(api,'campaign/'+clone.id,{action:'import_roster',version:d.campaign.version,source:{format:'vacaciones-roster-v1',team:'C',year:2027,copySelections:false,rows:codes.map(code=>({code,label:'Ficticio '+code,seniority:''}))}});
 d=await post(api,'campaign/'+clone.id,{action:'config',version:d.campaign.version,config:{...d.config,
  previousScores:Object.fromEntries(codes.map((code,i)=>[code,100+i])),previousScoresSource:'Puntuaciones de Playwright verificadas'}});
 d=await election(api,clone.id,{action:'start',rulesConfirmed:true,allowDeferral:false});
 for(let step=0;step<100&&d.election.pendingAutomatic;step++)d=await election(api,clone.id,{action:'advance'});
 created.push(clone.id);
 return {id:clone.id,data:await read(api,clone.id)};
}
// 2027 audit rows carry full availability snapshots. Remove each simulation
// afterwards so later specs (e.g. the full backup restore) see a lean DB.
const created:string[]=[];
test.afterEach(async({request})=>{
 for(const id of created.splice(0)){
  const r=await request.get("/api/campaign/"+id);if(!r.ok())continue;
  const d=await r.json();
  await post(request,"simulations/"+id,{action:"delete",version:d.campaign.version});
 }
});
async function open(page:Page,id:string){
 await page.goto('/?equipo=C&year=2027');
 await page.getByLabel('Escenario',{exact:true}).selectOption(id);
 await expect(page.getByText(/SIMULACIÓN PRIVADA/i)).toBeVisible();
}
const turnCode=(d:any)=>d.members.find((m:any)=>m.id===d.election.turn.memberId).code;
const preCycles=(d:any)=>d.result.cycles.filter((c:any)=>c.period===0).map((c:any)=>c.date);

test('2027: el motivo de una plaza bloqueada se consulta con teclado o toque, no solo por color',{tag:'@both'},async({page,request})=>{
 const {id,data}=await setup2027(request,page);
 const red=Object.values(data.election.cycleAvailability.cycles).find((c:any)=>
  c.slots[3].reasons.some((r:any)=>r.code==='FOURTH_EXCLUDED_RED')) as any;
 expect(red,'team C has red cycles excluded from a fourth place').toBeTruthy();
 await open(page,id);
 const button=page.locator('button[data-cycle-date="'+red.cycle+'"]').first();
 if(test.info().project.name==='mobile')await button.tap();
 else{await button.focus();await page.keyboard.press('Enter');}
 await expect(page.getByText('4ª plaza:',{exact:false}).locator('..')).toContainText('RRHH excluye la cuarta plaza en este ciclo rojo');
});

test('2027: confirmar muestra el impacto, el historial lo registra y deshacer restaura la disponibilidad',async({page,request})=>{
 const {id,data}=await setup2027(request,page);
 const before=data.election.cycleAvailability;
 await open(page,id);
 await expect(page.getByRole('heading',{name:turnCode(data)+' elige ahora',exact:true})).toBeVisible();
 const date=preCycles(data)[0];
 await page.locator('button[data-cycle-date="'+date+'"]').first().click();
 await page.getByRole('button',{name:'Confirmar ciclo',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Confirmar adjudicación'});
 await expect(dialog).toContainText('¿Adjudicar a '+turnCode(data)+'?');
 await dialog.getByRole('button',{name:'Adjudicar',exact:true}).click();
 await expect.poll(async()=>(await read(request,id)).awards.length).toBe(1);
 await expect(page.getByRole('heading',{name:turnCode(await read(request,id))+' elige ahora',exact:true})).toBeVisible();
 // The plain award of an empty cycle has no consequence worth showing.
 await expect(page.locator('.election-log-highlight')).toHaveCount(0);
 await page.getByRole('button',{name:'↶ Deshacer',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await expect.poll(async()=>(await read(request,id)).awards.length).toBe(0);
 const restored=await read(request,id);
 expect(restored.election.cycleAvailability.cycles[date].occupied).toBe(0);
 expect(restored.election.cycleAvailability.cycles[date].possibleAdditionalUpperBound)
  .toBe(before.cycles[date].possibleAdditionalUpperBound);
});

test('2027: agotar la cuarta de preverano se destaca en el historial y explica el bloqueo de las demás',async({page,request})=>{
 const {id,data}=await setup2027(request,page);
 const [first,second]=preCycles(data);
 let d=data;
 for(let n=0;n<4;n++)d=await election(request,id,{action:'choose',memberId:d.election.turn.memberId,dates:[first]});
 d=await election(request,id,{action:'choose',memberId:d.election.turn.memberId,dates:[second]});
 d=await election(request,id,{action:'choose',memberId:d.election.turn.memberId,dates:[second]});
 d=await election(request,id,{action:'choose',memberId:d.election.turn.memberId,dates:[second]});
 expect(d.election.cycleAvailability.cycles[second].slots[3].reasons[0].code).toBe('FOURTH_PERIOD_LIMIT');
 await open(page,id);
 await expect(page.locator('.election-log-highlight')).toContainText('Agota el cupo de cuartas plazas del preverano');
 await page.locator('button[data-cycle-date="'+second+'"]').first().click();
 await expect(page.getByText('4ª plaza:',{exact:false}).locator('..')).toContainText('Alcanzado el límite de un ciclo con cuarta plaza en este periodo');
 // The server rejects the fourth with the concrete cause, not a generic error.
 const rejected=await request.post('/api/election/'+id,{headers:{Origin:origin},data:{action:'choose',version:d.campaign.version,memberId:d.election.turn.memberId,dates:[second]}});
 expect(rejected.ok()).toBeFalsy();
 expect(await rejected.text()).toContain('El preverano ya tiene su ciclo con cuatro');
});

test('2027: el origen territorial es obligatorio y no puede aceptarse como aviso',async({page,request})=>{
 const {id,data}=await setup2027(request,page);
 const pre=preCycles(data),last=pre[pre.length-1];
 const target=new Map(pre.map((date:string,i:number)=>[date,i===0?4:i===pre.length-1?2:3]));
 let d=data;
 for(let step=0;step<120;step++){
  const member=d.election.turn.memberId;
  const date=pre.find((x:string)=>d.awards.filter((a:any)=>a.cycle_date===x).length<target.get(x)!&&
   !d.awards.some((a:any)=>a.member_id===member&&a.cycle_date===x));
  if(!date)break;
  d=await election(request,id,{action:'choose',memberId:member,dates:[date]});
 }
 expect(pre.every((x:string)=>d.awards.filter((a:any)=>a.cycle_date===x).length===target.get(x))).toBe(true);
 const before=d.awards.length;
 const rejected=await request.post('/api/election/'+id,{headers:{Origin:origin},data:{
  action:'choose',version:d.campaign.version,memberId:d.election.turn.memberId,dates:[last]
 }});
 expect(rejected.ok()).toBeFalsy();
 expect((await read(request,id)).awards.length).toBe(before);
 expect((await read(request,id)).awards.filter((a:any)=>a.cycle_date===last).length).toBe(2);
 await open(page,id);
 await page.locator('button[data-cycle-date="'+last+'"]').first().click();
 await expect(page.getByRole('dialog',{name:'Confirmar adjudicación'})).toHaveCount(0);
});
