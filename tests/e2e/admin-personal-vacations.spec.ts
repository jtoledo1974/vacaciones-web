import {expect,test,type APIRequestContext,type Page} from '@playwright/test';

// Only the isolated local Playwright database is used. Never target a deployed Site.
const origin='http://127.0.0.1:5199';

async function post(api:APIRequestContext,path:string,body:unknown){
 const response=await api.post('/api/'+path,{data:body,headers:{Origin:origin}});
 expect(response.ok(),await response.text()).toBeTruthy();
 return response.json();
}
async function read(api:APIRequestContext,id:string){
 const response=await api.get('/api/campaign/'+id);
 expect(response.ok(),await response.text()).toBeTruthy();
 return response.json();
}
async function election(api:APIRequestContext,id:string,body:object){
 const campaign=await read(api,id);
 return post(api,'election/'+id,{...body,version:campaign.campaign.version});
}
async function navigate(page:Page,name:'Administración'|'Vacaciones'){
 if(await page.getByRole('button',{name:'Abrir menú',exact:true}).isVisible())
  await page.getByRole('button',{name:'Abrir menú',exact:true}).click();
 await page.getByRole('button',{name,exact:true}).click();
}

test('la misma cuenta ChatGPT administra, guarda sus preferencias y elige vacaciones',async({page,request})=>{
 // Reuse the development-only simulated ChatGPT sign-in from the existing E2E suite.
 await request.get('/signin-with-chatgpt?return_to=/');
 await page.context().addCookies((await request.storageState()).cookies);
 const session=await (await request.get('/api/session')).json();
 expect(session.identity.provider).toBe('chatgpt');
 expect(session.principal.role).toBe('superadmin');

 let index=await (await request.get('/api/index')).json();
 if(!index.campaigns.length)index=await post(request,'initialize',{});
 const live=index.campaigns.find((c:any)=>c.team_id==='C'&&c.year===2026&&c.scope_key==='live');
 expect(live).toBeDefined();

 const before=await read(request,live.id);
 const controller=before.members[0];
 const original=before.election.accounts.find((a:any)=>a.member_id===controller.id);
 const originalKey:string=original?.principal_key??'';
 const originalProvider=originalKey.startsWith('firebase:')?'firebase':'chatgpt';
 const originalSubject=originalKey?originalKey.slice(originalProvider.length+1):'';

 // Account links may only be registered on a live campaign. The link is
 // temporary and restored in finally; actual choices occur in a simulation.
 await election(request,live.id,{
  action:'link_account',memberId:controller.id,provider:'chatgpt',
  subject:session.identity.email,accountVersion:original?.version??0,
 });
 try{
  const linked=await read(request,live.id);
  expect(linked.election.myMemberId).toBe(controller.id);
  expect(linked.election.canManage).toBe(true);

  const cloned=await post(request,'simulations/'+live.id,{
   name:'Doble rol '+crypto.randomUUID().slice(0,8),version:linked.campaign.version,
  });
  const simulation=await read(request,cloned.id);
  const own=simulation.members.find((m:any)=>m.person_id===controller.person_id);
  expect(own).toBeDefined();
  expect(simulation.election.myMemberId).toBe(own.id);
  expect(simulation.election.canManage).toBe(true);

  await page.goto('/?equipo=C&year=2026');
  await page.getByLabel('Escenario',{exact:true}).selectOption(cloned.id);
  await expect(page.getByText(/SIMULACIÓN PRIVADA/i)).toBeVisible();
  await navigate(page,'Administración');
  await expect(page.getByRole('heading',{name:'Plantilla del equipo C'})).toBeVisible();
  await navigate(page,'Vacaciones');

  await page.getByRole('button',{name:'Preparar preferencias',exact:true}).click();
  await expect(page.getByLabel('Preferencias de controlador',{exact:true})).toHaveValue(own.id);
  const date=simulation.result.cycles[0].date;
  await page.locator('.vac2-cycle[data-cycle-date="'+date+'"]').click();
  if(await page.getByRole('button',{name:'Revisar y guardar',exact:true}).isVisible())await page.getByRole('button',{name:'Revisar y guardar',exact:true}).click();
  await page.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Preferencias guardadas'}).first()).toBeVisible();
  const saved=await read(request,cloned.id);
  expect(saved.election.preferences.find((p:any)=>p.member_id===own.id)).toMatchObject({
   dates:[date],automatic:true,
  });

  await election(request,cloned.id,{
   action:'start',order:[own.id,...simulation.members.filter((m:any)=>m.id!==own.id).map((m:any)=>m.id)],
   source:'Orden ficticio para probar la doble función',rulesConfirmed:true,allowDeferral:false,
  });
  await page.reload();
  await page.getByLabel('Escenario',{exact:true}).selectOption(cloned.id);
  // Starting the election applies this previously saved list immediately.
  const next=simulation.members.find((m:any)=>m.id!==own.id);
  await expect(page.getByRole('heading',{name:next.code+' elige ahora',exact:true})).toBeVisible();

  const after=await read(request,cloned.id);
  expect(after.election.myMemberId).toBe(own.id);
  expect(after.awards.filter((a:any)=>a.member_id===own.id).map((a:any)=>a.cycle_date)).toEqual([date]);
  expect(after.election.canManage).toBe(true);
 }finally{
  // Restore the original personal link in the isolated local fixture.
  const current=await read(request,live.id);
  const account=current.election.accounts.find((a:any)=>a.member_id===controller.id);
  await election(request,live.id,{
   action:'link_account',memberId:controller.id,provider:originalProvider,
   subject:originalSubject,accountVersion:account?.version??0,
  });
 }
});
