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
async function activate(page:Page){
  await page.getByText('Preparar el orden de elección',{exact:true}).click();
  await page.getByLabel('Orden confirmado',{exact:true}).fill('QA_A\nQA_B\nQA_C\nQA_D');
  await page.getByLabel('Origen del orden').fill('Orden ficticio de Playwright, sin uso operativo');
  await page.getByLabel('Permitir uno o dos aplazamientos', {exact:false}).check();
  await page.getByLabel('Confirmo la aplicación de Criterios Vacaciones 1.1', {exact:false}).check();
  await page.getByRole('button',{name:'Activar elección',exact:true}).click();
  await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible();
}
async function cycle(page:Page,date:string){await page.getByRole('button',{name:new RegExp('^'+date+': ciclo')}).click();}
async function confirm(page:Page,button:string){await page.getByRole('button',{name:button,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();}

test('calendario público, permisos y aislamiento',async({page,request,browser})=>{
  const s=await setup(request,page);await open(page,s.id);await activate(page);
  const anonymous=await browser.newContext({baseURL:origin});const p=await anonymous.newPage();
  await p.goto('/?equipo=C&year=2026');await expect(p.getByRole('heading',{name:'Elige en el calendario'})).toBeVisible();
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
  await expect(page.getByRole('button',{name:new RegExp('^'+options.available[0]+': ciclo')})).toBeEnabled();
  await cycle(page,options.available[0]);await confirm(page,'Confirmar ambos ciclos');
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  expect((await read(request,s.id)).awards).toHaveLength(5);
  await confirm(page,'Deshacer último cambio');await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible();
  expect((await read(request,s.id)).awards).toHaveLength(3);
  await confirm(page,'Rehacer último cambio');await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
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
