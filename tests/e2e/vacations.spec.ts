import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
// No configurable remote URL: destructive QA is restricted to the dedicated local DB.
const origin='http://127.0.0.1:5199';
async function post(api:APIRequestContext,path:string,body:unknown){
  const r=await api.post('/api/'+path,{data:body,headers:{Origin:origin}});
  expect(r.ok(),await r.text()).toBeTruthy();return r.json();
}
async function read(api:APIRequestContext,id:string){const r=await api.get('/api/campaign/'+id);expect(r.ok()).toBeTruthy();return r.json();}
async function election(api:APIRequestContext,id:string,body:object){const d=await read(api,id);return post(api,'election/'+id,{...body,version:d.campaign.version});}
async function setup(api:APIRequestContext,page:Page){
  await api.get('/signin-with-chatgpt?return_to=/');
  await page.context().addCookies((await api.storageState()).cookies);
  let index=await (await api.get('/api/index')).json();
  if(!index.campaigns.length)index=await post(api,'initialize',{});
  const live=index.campaigns.find((c:any)=>c.team_id==='C'&&c.year===2026&&c.scope_key==='live');
  const baseline=await read(api,live.id);
  const clone=await post(api,'simulations/'+live.id,{name:'Playwright '+crypto.randomUUID().slice(0,8),version:baseline.campaign.version});
  let d=await read(api,clone.id);
  d=await post(api,'campaign/'+clone.id,{action:'import_roster',version:d.campaign.version,source:{format:'vacaciones-roster-v1',team:'C',year:2026,copySelections:false,rows:['QA_A','QA_B','QA_C','QA_D'].map(code=>({code,label:'Ficticio '+code,seniority:''}))}});
  return {id:clone.id,live,baseline,data:d};
}
async function open(page:Page,id:string){await page.goto('/?equipo=C&year=2026');await page.getByLabel('Escenario',{exact:true}).selectOption(id);await expect(page.getByText(/SIMULACIÓN PRIVADA/i)).toBeVisible();}
async function activate(page:Page,ties=''){
  await page.getByText('Preparar el orden de elección',{exact:true}).click();
  await page.getByLabel('Orden confirmado',{exact:true}).fill('QA_A\nQA_B\nQA_C\nQA_D');
  if(ties)await page.getByLabel('Grupos empatados',{exact:true}).fill(ties);
  await page.getByLabel('Origen del orden').fill('Orden ficticio de Playwright, sin uso operativo');
  await page.getByLabel('Permitir uno o dos aplazamientos', {exact:false}).check();
  await page.getByLabel('Confirmo la aplicación de Criterios Vacaciones 1.1', {exact:false}).check();
  await page.getByRole('button',{name:'Activar elección',exact:true}).click();
  await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible();
}
async function cycle(page:Page,date:string){await page.locator('.vac2-cycle[data-cycle-date="'+date+'"]').click();}
async function confirm(page:Page,button:string){await page.getByRole('button',{name:button,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();}

test('integración: dos aplazamientos permiten elegir tres ciclos desde el calendario',async({page,request},info)=>{
 const s=await setup(request,page);await open(page,s.id);await activate(page);
 const dates=s.data.result.cycles.map((c:any)=>c.date);
 await confirm(page,'Aplazar para elegir dos');
 for(let round=0;round<2;round++){
  for(let person=1;person<4;person++)await election(request,s.id,{action:'choose',memberId:s.data.members[person].id,dates:[dates[round*3+person-1]]});
  await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible({timeout:18000});
  if(round===0)await confirm(page,'Aplazar para elegir tres');
 }
 await cycle(page,dates[6]);await cycle(page,dates[7]);
 await expect(page.getByRole('button',{name:'Confirmar tres ciclos',exact:true})).toBeDisabled();
 await expect(page.locator('.vac2-cycle[data-cycle-date="'+dates[8]+'"]').first()).toBeEnabled();
 await cycle(page,dates[8]);await confirm(page,'Confirmar tres ciclos');
 await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
 const result=await read(request,s.id);
 expect(result.awards.filter((a:any)=>a.member_id===s.data.members[0].id)).toHaveLength(3);
 expect(result.requests.filter((a:any)=>a.member_id===s.data.members[0].id)).toHaveLength(3);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 await page.screenshot({path:info.outputPath('eleccion-integrada.png'),fullPage:true});
});

test('integración: administración agrupada y navegación pública en escritorio y móvil',async({page,request,browser},info)=>{
 const s=await setup(request,page);await open(page,s.id);
 await expect(page.getByRole('button',{name:'Exportar adjudicaciones CSV'})).toBeVisible();
 if(await page.getByRole('button',{name:'Abrir menú',exact:true}).isVisible())await page.getByRole('button',{name:'Abrir menú',exact:true}).click();
 await expect(page.getByRole('button',{name:'Configuración',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Administración',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Campañas anuales'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Descargar copia completa'})).toBeHidden();
 await page.getByText('Parámetros del ejercicio',{exact:true}).click();
 await expect(page.getByRole('button',{name:'Guardar parámetros'})).toBeVisible();
 await page.getByText('Parámetros del ejercicio',{exact:true}).click();
 await page.getByText('Herramientas avanzadas',{exact:true}).click();
 await expect(page.getByRole('link',{name:'Descargar copia completa'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 await page.screenshot({path:info.outputPath('administracion-integrada.png'),fullPage:true});
 const anonymous=await browser.newContext({baseURL:origin});const p=await anonymous.newPage();
 await p.goto('/?equipo=C&year=2026');await expect(p.getByRole('heading',{name:'Disponibilidad y baremo'})).toBeVisible();
 await expect(p.getByRole('button',{name:'Administración',exact:true})).toHaveCount(0);
 await anonymous.close();
});

test('calendario público, permisos y aislamiento',async({page,request,browser})=>{
  const s=await setup(request,page);await open(page,s.id);await activate(page);
  const anonymous=await browser.newContext({baseURL:origin});const p=await anonymous.newPage();
  await p.goto('/?equipo=C&year=2026');await expect(p.getByRole('heading',{name:'Disponibilidad y baremo'})).toBeVisible();
  await expect(p.getByLabel('Escenario',{exact:true})).toHaveCount(0);
  await expect(p.getByRole('button',{name:'Confirmar ciclo',exact:true})).toHaveCount(0);
  expect((await anonymous.request.get('/api/campaign/'+s.id)).status()).toBe(403);
  expect((await anonymous.request.post('/api/election/'+s.id,{data:{action:'pause'},headers:{Origin:origin}})).status()).toBe(401);
  const after=await read(request,s.live.id);expect(after.awards).toEqual(s.baseline.awards);expect(after.campaign).toEqual(s.baseline.campaign);
  await anonymous.close();
});

test('aplazar, elegir dos en calendario y deshacer/rehacer',async({page,request})=>{
  const s=await setup(request,page);await open(page,s.id);await activate(page);
  const dates=s.data.result.cycles.map((c:any)=>c.date);await cycle(page,dates[0]);await confirm(page,'Aplazar para elegir dos');
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  for(let i=1;i<4;i++){
    await cycle(page,dates[i-1]);await confirm(page,'Confirmar ciclo');
    await expect(page.getByRole('heading',{name:(i===3?'QA_A':['QA_A','QA_B','QA_C','QA_D'][i+1])+' elige ahora',exact:true})).toBeVisible();
  }
  await cycle(page,dates[0]);await expect(page.getByRole('button',{name:'Confirmar ambos ciclos',exact:true})).toBeDisabled();
  const options=await (await request.get('/api/election/'+s.id+'/options?selected='+dates[0])).json();
  await expect(page.locator('.vac2-cycle[data-cycle-date="'+options.available[0]+'"]').first()).toBeEnabled();
  await cycle(page,options.available[0]);await confirm(page,'Confirmar ambos ciclos');
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  expect((await read(request,s.id)).awards).toHaveLength(5);
  await confirm(page,'↶ Deshacer');await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible();
  expect((await read(request,s.id)).awards).toHaveLength(3);
  await confirm(page,'↷ Rehacer');await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  expect((await read(request,s.id)).awards).toHaveLength(5);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});

test('preferencias delegadas y elección automática al llegar el turno',async({page,request})=>{
  const s=await setup(request,page),date=s.data.result.cycles[0].date;
  await open(page,s.id);await page.getByRole('button',{name:'Preparar preferencias',exact:true}).click();
  await page.getByLabel('Preferencias de controlador',{exact:true}).selectOption(s.data.members[1].id);
  await cycle(page,date);await page.getByLabel('Asignar automáticamente desde esta lista cuando llegue mi turno',{exact:true}).check();
  await page.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Preferencias guardadas'})).toBeVisible();
  await page.getByRole('button',{name:'Elegir / consultar',exact:true}).click();await activate(page);
  await cycle(page,date);await confirm(page,'Confirmar ciclo');
  await expect(page.getByRole('heading',{name:'QA_C elige ahora',exact:true})).toBeVisible();
  const d=await read(request,s.id);expect(d.awards).toHaveLength(2);expect(d.awards.some((a:any)=>a.member_id===s.data.members[1].id)).toBeTruthy();
});

test('bloqueo, descarga y restauración de backup completo',async({page,request},info)=>{
  const s=await setup(request,page);await open(page,s.id);await activate(page);
  if(await page.getByRole('button',{name:'Abrir menú',exact:true}).isVisible())await page.getByRole('button',{name:'Abrir menú',exact:true}).click();
  await page.getByRole('button',{name:'Administración',exact:true}).click();
  await page.getByText('Herramientas avanzadas',{exact:true}).click();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Descargar copia completa'}).click();
  const download=await downloadPromise;await download.saveAs(info.outputPath('backup.json'));
  const backup=await (await request.get('/api/backup')).json();
  await confirm(page,'Cerrar equipo C');await expect(page.getByText('Campaña cerrada',{exact:true})).toBeVisible();
  let d=await read(request,s.id);expect(d.campaign.status).toBe('closed');
  const blocked=await request.post('/api/election/'+s.id,{data:{action:'preferences',version:d.campaign.version,memberId:d.members[0].id,dates:[],automatic:false},headers:{Origin:origin}});expect(blocked.status()).toBe(400);
  const current=await (await request.get('/api/backup')).json();
  await post(request,'restore',{backup,revision:current.payload.revision});
  d=await read(request,s.id);expect(d.campaign.status).toBe('open');expect(d.election.state.status).toBe('active');
});

test('Criterios 1.1: dos CTA eligen juntos al llegar el último, en una sola transacción',async({page,request})=>{
 const fixture=await setup(request,page),dates=fixture.data.result.cycles.map((c:any)=>c.date);
 await open(page,fixture.id);
 await page.getByText('Preparar el orden de elección',{exact:true}).click();
 await page.getByLabel('Orden confirmado',{exact:true}).fill('QA_A\nQA_B\nQA_C\nQA_D');
 await page.getByLabel('Turnos conjuntos').fill('QA_A, QA_C');
 await page.getByLabel('Origen del orden').fill('Sorteo y elección conjunta ficticios; Criterios 1.1 de 2025');
 await page.getByLabel('Confirmo la aplicación de Criterios Vacaciones 1.1').check();
 await page.getByRole('button',{name:'Activar elección'}).click();
 await expect(page.getByRole('heading',{name:'QA_B elige ahora'})).toBeVisible();
 await cycle(page,dates[0]);await confirm(page,'Confirmar ciclo');
 await expect(page.getByRole('heading',{name:'QA_A + QA_C elige ahora'})).toBeVisible();
 await cycle(page,dates[1]);
 await expect(page.getByRole('button',{name:'Confirmar turno conjunto'})).toBeDisabled();
 await page.getByRole('button',{name:/QA_C: 0\/1/}).click();
 await cycle(page,dates[2]);
 await confirm(page,'Confirmar turno conjunto');
 const after=await read(request,fixture.id);
 expect(after.awards).toHaveLength(3);
 expect(after.requests).toHaveLength(3);
 await expect(page.getByRole('heading',{name:'QA_D elige ahora'})).toBeVisible();
});

test('responsive: mapa, calendario mensual, tabla de CTA y selección móvil',async({page,request})=>{
  await page.setViewportSize({width:390,height:844});
  const s=await setup(request,page);await open(page,s.id);await activate(page);
  await expect(page.getByRole('button',{name:'Mapa',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Por CTA',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Calendario',exact:true}).click();
  await expect(page.getByRole('button',{name:'Siguiente →'})).toBeVisible();
  await page.getByRole('button',{name:'Siguiente →'}).click();
  await expect(page.getByRole('button',{name:'← Anterior'})).toBeEnabled();
  await page.getByRole('button',{name:'Por CTA',exact:true}).click();
  await expect(page.locator('.vac2-member-card').first()).toBeVisible();
  await page.getByRole('button',{name:'Mapa',exact:true}).click();
  await cycle(page,s.data.result.cycles[0].date);
  await confirm(page,'Confirmar ciclo');
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  await expect(page.getByText('Últimas adjudicaciones')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});


test('dos clientes abiertos reciben una adjudicación sin recargar manualmente',async({page,request})=>{
 const s=await setup(request,page);
 await open(page,s.id);
 await activate(page);
 const second=await page.context().newPage();
 await second.goto('/?equipo=C&year=2026');
 await second.getByLabel('Escenario',{exact:true}).selectOption(s.id);
 await expect(second.getByRole('heading',{name:'QA_A elige ahora'})).toBeVisible();
 const date=s.data.result.cycles[0].date;
 await cycle(page,date);
 await confirm(page,'Confirmar ciclo');
 await expect(second.getByRole('heading',{name:'QA_B elige ahora'})).toBeVisible({timeout:18000});
 await expect(second.locator('.vac2-cycle[data-cycle-date="'+date+'"]')).toContainText('QA_A');
 if(await second.getByRole('button',{name:'Abrir menú',exact:true}).isVisible())await second.getByRole('button',{name:'Abrir menú',exact:true}).click();
 await second.getByRole('button',{name:'Administración',exact:true}).click();
 const updated=await election(request,s.id,{action:'choose',memberId:s.data.members[1].id,dates:[s.data.result.cycles[1].date]});
 expect(updated.awards).toHaveLength(2);
 await expect(second.getByText('Actualización automática · hasta 5 s')).toBeVisible();
 if(await second.getByRole('button',{name:'Abrir menú',exact:true}).isVisible())await second.getByRole('button',{name:'Abrir menú',exact:true}).click();
 await second.getByRole('button',{name:'Vacaciones',exact:true}).click();
 await expect(second.getByRole('heading',{name:'QA_C elige ahora'})).toBeVisible({timeout:18000});
 await second.close();
});

test('empate de tres: registrar orden externo pulsando nombres, persistir y rotar',async({page,request})=>{
 const s=await setup(request,page);await open(page,s.id);await activate(page,'QA_B, QA_C, QA_D');
 await cycle(page,s.data.result.cycles[0].date);await confirm(page,'Confirmar ciclo');
 const panel=page.getByRole('region',{name:'Resolver empate'});
 await expect(page.getByRole('heading',{name:'Empate pendiente de sorteo'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Confirmar ciclo',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Guardar orden externo',exact:true})).toBeDisabled();
 for(const code of ['QA_D','QA_B','QA_C'])await page.getByRole('button',{name:'Añadir al sorteo '+code,exact:true}).click();
 await expect(page.getByRole('list',{name:'Orden del sorteo externo'})).toHaveText('QA_DQA_BQA_C');
 await confirm(page,'Guardar orden externo');await expect(page.getByRole('heading',{name:'QA_D elige ahora',exact:true})).toBeVisible();
 await page.reload();await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);await expect(page.getByRole('heading',{name:'QA_D elige ahora',exact:true})).toBeVisible();
 const saved=await read(request,s.id);expect(saved.election.state.tieResolutions[0].order).toEqual([3,1,2].map(i=>s.data.members[i].id));
 expect(saved.election.state.tieResolutions[0].method).toBe('external');
 for(const [i,idx] of [3,1,2].entries())await election(request,s.id,{action:'choose',memberId:s.data.members[idx].id,dates:[s.data.result.cycles[i+1].date]});
 await election(request,s.id,{action:'choose',memberId:s.data.members[0].id,dates:[s.data.result.cycles[4].date]});
 expect((await read(request,s.id)).election.turn.memberId).toBe(s.data.members[1].id);
 expect((await read(request,s.live.id)).campaign).toEqual(s.baseline.campaign);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('sorteo en la app guarda una permutación y no permite repetir',async({page,request})=>{
 const s=await setup(request,page);
 await election(request,s.id,{action:'start',order:s.data.members.map((m:any)=>m.id),tieGroups:[s.data.members.slice(0,3).map((m:any)=>m.id)],source:'Sorteo ficticio para Playwright',rulesConfirmed:true,allowDeferral:true});
 await open(page,s.id);await expect(page.getByRole('heading',{name:'Empate pendiente de sorteo'})).toBeVisible();
 await confirm(page,'Sortear y guardar orden');
 await expect(page.getByRole('heading',{name:'Empate pendiente de sorteo'})).toHaveCount(0);
 const saved=await read(request,s.id),resolution=saved.election.state.tieResolutions[0];expect(resolution.method).toBe('random');expect([...resolution.order].sort()).toEqual(s.data.members.slice(0,3).map((m:any)=>m.id).sort());
 await page.reload();await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);await expect(page.getByRole('heading',{name:saved.members.find((m:any)=>m.id===saved.election.turn.memberId).code+' elige ahora',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Sortear y guardar orden'})).toHaveCount(0);
 expect((await read(request,s.id)).election.state.tieResolutions).toEqual(saved.election.state.tieResolutions);
});
