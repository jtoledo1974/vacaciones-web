import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
// No configurable remote URL: destructive QA is restricted to the dedicated local DB.
const origin='http://127.0.0.1:5199';

test('historial heredado: adjudicaciones tras sorteo y cuadro con destinatario sin fecha duplicada',async({page,request},info)=>{
 const source=await setup(request,page);
 const ids=source.data.members.map((m:any)=>m.id);
 await election(request,source.id,{action:'start',order:ids,tieGroups:[ids.slice(0,2)],jointGroups:[],source:'Orden ficticio para regresión de simulación heredada',rulesConfirmed:true,allowDeferral:true});
 const base=await read(request,source.id);
 const clone=await post(request,'simulations/'+source.id,{name:'Historial heredado QA',version:base.campaign.version});
 await election(request,clone.id,{action:'resume'});
 const before=await read(request,clone.id),members=before.members;
 await election(request,clone.id,{action:'resolve_tie',method:'external',order:members.slice(0,2).map((m:any)=>m.id)});
 const dates=before.result.cycles.map((c:any)=>c.date);
 await election(request,clone.id,{action:'choose',memberId:members[0].id,dates:[dates[0]]});
 await election(request,clone.id,{action:'choose',memberId:members[1].id,dates:[dates[1]]});
 await open(page,clone.id);
 const log=page.locator('.election-log');
 await expect(log.locator('li')).toHaveCount(3);
 await expect(log.locator('li').first()).toContainText('R1 · 2');
 await expect(log.locator('li').nth(1)).toContainText('R1 · 1');
 await expect(log.locator('li').last()).toContainText('Sorteo de empate');
 await expect(log.locator('li').last().locator('.election-cycle-number')).toHaveCount(0);
 await expect(page.getByText('Inicio del historial · No hay eventos anteriores.')).toBeVisible();
 // Choose a cycle already occupied, preserving its occupant and capacity details.
 await cycle(page,dates[0]);
 const card=page.getByRole('region',{name:'Detalle del ciclo seleccionado'});
 await expect(card.locator('.election-selected-summary')).toHaveText('Elige QA_C');
 await expect(card.locator('.person-chip')).toContainText('QA_A');
 await expect(card).toContainText('plazas ocupadas');
 await expect(card).toContainText('puntos');
 await expect(card.getByRole('button',{name:'Confirmar ciclo',exact:true})).toBeEnabled();
 await expect(card.getByRole('button',{name:'Cancelar selección',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('historial-y-destinatario.png'),fullPage:true});
 await card.screenshot({path:info.outputPath('cuadro-destinatario.png')});
 await card.getByRole('button',{name:'Cancelar selección',exact:true}).click();
 await expect(card).toHaveCount(0);
 expect((await read(request,clone.id)).awards).toHaveLength(2);
});
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
  await expect(page.getByRole('heading',{name:'Elección sin iniciar',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirmar ciclo',exact:true})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Detalle del ciclo seleccionado'})).toHaveCount(0);
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
async function confirm(page:Page,button:string){
 const target=page.getByRole('button',{name:button,exact:true});
 if(button.startsWith('Aplazar')&&!await target.isVisible())await page.locator('.election-more-actions > summary').click();
 await target.click();
 if(/^Confirmar (ciclo|ambos ciclos|tres ciclos|turno conjunto)$/.test(button)){
  await expect(page.getByRole('dialog')).toHaveCount(0);
 }else await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
}

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
 await expect(page.getByText(/Turno triple: recupera 2 aplazamiento/)).toBeVisible();
 await expect(page.getByText('Turno aplazado, sin adjudicación. Acumula un ciclo para la siguiente ronda.')).toHaveCount(2);
 const result=await read(request,s.id);
 expect(result.awards.filter((a:any)=>a.member_id===s.data.members[0].id)).toHaveLength(3);
 expect(result.requests.filter((a:any)=>a.member_id===s.data.members[0].id)).toHaveLength(3);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 await page.screenshot({path:info.outputPath('eleccion-integrada.png'),fullPage:true});
});

test('navegación compacta entre Calendario y Preferencias',async({page,request})=>{
 const s=await setup(request,page);await open(page,s.id);
 const switcher=page.getByRole('group',{name:'Vista de vacaciones'});
 const calendar=switcher.getByRole('button',{name:'Calendario',exact:true});
 const preferences=switcher.getByRole('button',{name:'Preferencias',exact:true});
 await expect(calendar).toHaveAttribute('aria-pressed','true');
 await expect(preferences).toHaveAttribute('aria-pressed','false');
 await preferences.click();
 await expect(preferences).toHaveAttribute('aria-pressed','true');
 await calendar.click();
 await expect(calendar).toHaveAttribute('aria-pressed','true');
 for(const width of [320,375,430]){
  await page.setViewportSize({width,height:640});
  const bounds=await switcher.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeLessThan(44);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 }
});

test('móvil: el menú Más acciones permanece dentro de la pantalla',async({page,request})=>{
 const s=await setup(request,page);await open(page,s.id);await activate(page);
 const actions=page.locator('.election-turn-controls > .election-more-actions');
 const summary=actions.locator('summary');
 for(const width of [320,375,430]){
  await page.setViewportSize({width,height:640});
  await summary.click();
  const menu=actions.locator('.election-more-menu');
  const defer=menu.getByRole('button',{name:'Aplazar para elegir dos'});
  await expect(defer).toBeVisible();
  await defer.scrollIntoViewIfNeeded();
  const bounds=await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await summary.click();
 }
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
  await open(page,s.id);await page.getByRole('group',{name:'Vista de vacaciones'}).getByRole('button',{name:'Preferencias',exact:true}).click();
  await page.getByLabel('Preferencias de controlador',{exact:true}).selectOption(s.data.members[1].id);
  await cycle(page,date);await expect(page.getByLabel('Asignar automáticamente desde esta lista cuando llegue mi turno')).toHaveCount(0);
  if(!await page.locator('.preference-sheet').isVisible()&&await page.getByRole('button',{name:'Revisar y guardar',exact:true}).isVisible())await page.getByRole('button',{name:'Revisar y guardar',exact:true}).click();
  await page.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Preferencias guardadas'}).first()).toBeVisible();
  if(await page.getByRole('button',{name:'Cerrar revisión de preferencias',exact:true}).isVisible())await page.getByRole('button',{name:'Cerrar revisión de preferencias',exact:true}).click();
  await page.getByRole('group',{name:'Vista de vacaciones'}).getByRole('button',{name:'Calendario',exact:true}).click();await activate(page);
  await cycle(page,date);await confirm(page,'Confirmar ciclo');
  await expect(page.getByRole('heading',{name:'QA_C elige ahora',exact:true})).toBeVisible();
  const d=await read(request,s.id);expect(d.awards).toHaveLength(2);expect(d.awards.some((a:any)=>a.member_id===s.data.members[1].id)).toBeTruthy();
});

test('undo en navegador deshace solo el último turno automático y permite corregirlo',async({page,request})=>{
 const s=await setup(request,page),dates=s.data.result.cycles.map((x:any)=>x.date),[a,b,c,d]=s.data.members;
 await election(request,s.id,{action:'preferences',memberId:b.id,dates:[dates[1]]});
 await election(request,s.id,{action:'preferences',memberId:c.id,dates:[dates[2]]});
 await open(page,s.id);await activate(page);
 await cycle(page,dates[0]);await confirm(page,'Confirmar ciclo');
 await expect(page.getByRole('heading',{name:'QA_D elige ahora',exact:true})).toBeVisible();
 let current=await read(request,s.id);
 expect(current.awards.map((x:any)=>x.member_id).sort()).toEqual([a.id,b.id,c.id].sort());
 await confirm(page,'↶ Deshacer');
 await expect(page.getByRole('heading',{name:'QA_C elige ahora',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Reanudar automatismos',exact:true})).toBeVisible();
 current=await read(request,s.id);
 expect(current.awards.map((x:any)=>x.member_id).sort()).toEqual([a.id,b.id].sort());
 expect(current.election.state.automaticPaused).toBe(true);
 expect(current.election.preferences.find((p:any)=>p.member_id===c.id).active).toBe(true);
 await cycle(page,dates[3]);await confirm(page,'Confirmar ciclo');
 await expect(page.getByRole('heading',{name:'QA_D elige ahora',exact:true})).toBeVisible();
 current=await read(request,s.id);
 expect(current.awards.find((x:any)=>x.member_id===c.id)?.cycle_date).toBe(dates[3]);
 expect(current.election.state.automaticPaused).toBe(true);
 await page.getByRole('button',{name:'Reanudar automatismos',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await expect(page.getByRole('button',{name:'Reanudar automatismos',exact:true})).toHaveCount(0);
 expect((await read(request,s.id)).election.state.automaticPaused).toBe(false);
});

test('guardar preferencias durante el turno avisa antes de adjudicar automáticamente',async({page,request})=>{
 const s=await setup(request,page),member=s.data.members[0],date=s.data.result.cycles[0].date;
 await open(page,s.id);await activate(page);
 await page.getByRole('group',{name:'Vista de vacaciones'}).getByRole('button',{name:'Preferencias',exact:true}).click();
 await page.getByLabel('Preferencias de controlador',{exact:true}).selectOption(member.id);
 await cycle(page,date);
 if(!await page.locator('.preference-sheet').isVisible()&&await page.getByRole('button',{name:'Revisar y guardar',exact:true}).isVisible())await page.getByRole('button',{name:'Revisar y guardar',exact:true}).click();
 await page.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Confirmar cambio'});
 await expect(dialog).toContainText('adjudicar inmediatamente');
 await expect(dialog).toContainText('sin otra confirmación');
 expect((await read(request,s.id)).awards).toHaveLength(0);
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect((await read(request,s.id)).awards).toHaveLength(0);
 if(!await page.locator('.preference-sheet').isVisible()&&await page.getByRole('button',{name:'Revisar y guardar',exact:true}).isVisible())await page.getByRole('button',{name:'Revisar y guardar',exact:true}).click();
 await page.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();
 if(await page.getByRole('button',{name:'Cerrar revisión de preferencias',exact:true}).isVisible())await page.getByRole('button',{name:'Cerrar revisión de preferencias',exact:true}).click();
 await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
 const after=await read(request,s.id);
 expect(after.awards.filter((a:any)=>a.member_id===member.id).map((a:any)=>a.cycle_date)).toEqual([date]);
 expect(after.election.preferences.find((p:any)=>p.member_id===member.id)).toMatchObject({dates:[date],automatic:true});
});

test('reconstrucción guiada: tercera elección distinta y cuarta por preferencias anteriores',async({page,request},info)=>{
 if(info.project.name==='chromium')await page.setViewportSize({width:1440,height:900});
 const s=await setup(request,page),dates=s.data.result.cycles.map((c:any)=>c.date),ids=s.data.members.map((m:any)=>m.id);
 await election(request,s.id,{action:'preferences',memberId:ids[3],dates:[dates[4]]});
 await election(request,s.id,{action:'start',order:ids,source:'Orden ficticio para reconstrucción UI Playwright',rulesConfirmed:true,allowDeferral:true});
 for(let i=0;i<3;i++)await election(request,s.id,{action:'choose',memberId:ids[i],dates:[dates[i]]});
 await election(request,s.id,{action:'advance'});
 await open(page,s.id);
 const historyPanel=page.getByRole('region',{name:'Historial de elección'});
 await expect(page.getByRole('heading',{name:'Reconstruir elecciones anteriores'})).toHaveCount(0);
 await expect(historyPanel.getByRole('button',{name:'Desde aquí'})).toHaveCount(0);
 await historyPanel.locator('summary[aria-label="Más acciones del historial"]').click();
 await historyPanel.getByRole('button',{name:'Reconstruir desde un turno…'}).click();
 await expect(historyPanel.getByRole('region',{name:'Elegir inicio de reconstrucción'})).toBeVisible();
 const history=(await read(request,s.id)).election.reconstruction.candidates;
 const point=history.find((e:any)=>e.action==='choose'&&e.memberIds.includes(ids[2]));
 expect(point).toBeTruthy();
 await historyPanel.getByRole('button',{name:'Reconstruir desde QA_C (ronda 1)'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await expect(page.locator('.reconstruction-status')).toContainText('Elección congelada');
 await expect(page.getByText('Decisión del administrador',{exact:true})).toBeVisible();
 const editor=page.getByRole('region',{name:'Reconstrucción guiada'}),calendar=page.locator('.election-calendar-wrap');
 await expect(editor.locator('.reconstruction-decisions label').first()).toHaveCSS('flex-direction','row');
 await expect(page.locator('.reconstruction-status')).toContainText('Reconstrucción en curso');
 await expect(page.getByRole('region',{name:'Turno de elección'})).toHaveCount(0);
 const checkLayout=async(side:boolean)=>{
  const panelBox=await editor.boundingBox(),calendarBox=await calendar.boundingBox();
  expect(panelBox).toBeTruthy();expect(calendarBox).toBeTruthy();
  if(side){expect(panelBox!.x).toBeGreaterThanOrEqual(calendarBox!.x+calendarBox!.width);expect(panelBox!.width).toBeLessThanOrEqual(361);}
  else expect(panelBox!.y+panelBox!.height).toBeLessThanOrEqual(calendarBox!.y);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 };
 await checkLayout(info.project.name==='chromium');
 await page.screenshot({path:info.outputPath('reconstruction-initial.png'),fullPage:true});
 await editor.screenshot({path:info.outputPath('reconstruction-panel.png')});
 await editor.getByLabel('Registrar otra decisión').check();
 const alternative=editor.getByLabel('Ciclo alternativo');
 await alternative.selectOption(dates[5]);
 await expect(alternative).toHaveCount(0);
 await expect(editor.getByText('Pendiente de registrar')).toBeVisible();
 await expect(editor.getByRole('button',{name:'Cambiar ciclo 1'})).toBeVisible();
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeEnabled();
 await editor.getByRole('button',{name:'Cambiar ciclo 1'}).click();
 await expect(alternative).toBeVisible();
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeDisabled();
 await alternative.selectOption(dates[3]);
 await expect(alternative).toHaveCount(0);
 if(info.project.name==='chromium'){
  for(const viewport of [{width:1280,height:720},{width:1440,height:650},{width:768,height:1024}]){
   await page.setViewportSize(viewport);await checkLayout(viewport.width>900);
   await editor.scrollIntoViewIfNeeded();
   await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeInViewport();
   await page.screenshot({path:info.outputPath('reconstruction-'+viewport.width+'x'+viewport.height+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>window.scrollTo(0,650));
  await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeInViewport();
  expect((await editor.boundingBox())!.y).toBeGreaterThanOrEqual(15);
  await page.screenshot({path:info.outputPath('reconstruction-sticky.png')});
 }
 await page.getByRole('button',{name:'Registrar decisión y continuar'}).click();
 await expect(page.getByText('Mejor preferencia histórica:')).toBeVisible();
 await page.getByRole('button',{name:'Registrar decisión y continuar'}).click();
 await expect(page.getByRole('heading',{name:'Turnos reconstruidos'})).toBeVisible();
 await page.getByRole('button',{name:'Finalizar reconstrucción'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 const result=await read(request,s.id);
 expect(result.awards.find((a:any)=>a.member_id===ids[2]).cycle_date).toBe(dates[3]);
 expect(result.awards.find((a:any)=>a.member_id===ids[3]).cycle_date).toBe(dates[4]);
 expect(result.election.state.automaticPaused).toBe(true);
 await expect(page.getByRole('heading',{name:'Reconstruir elecciones anteriores'})).toHaveCount(0);
 await expect(editor).toHaveCount(0);
 await expect(page.locator('.reconstruction-status')).toHaveCount(0);
 await expect(historyPanel.getByText(/Última reconstrucción/)).toBeVisible();
});

test('reconstrucción: un turno doble oculta el selector completo y permite cambiar cualquier ciclo',async({page,request})=>{
 const s=await setup(request,page),ids=s.data.members.map((m:any)=>m.id),dates=s.data.result.cycles.map((c:any)=>c.date);
 await open(page,s.id);await activate(page);
 await confirm(page,'Aplazar para elegir dos');
 for(let i=1;i<4;i++)await election(request,s.id,{action:'choose',memberId:ids[i],dates:[dates[i]]});
 await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible();
 await cycle(page,dates[0]);
 const options=await (await request.get('/api/election/'+s.id+'/options?selected='+dates[0])).json();
 await cycle(page,options.available[0]);
 await confirm(page,'Confirmar ambos ciclos');
 const before=await read(request,s.id);
 const point=before.election.reconstruction.candidates.find((c:any)=>c.action==='choose'&&c.memberIds.includes(ids[0]));
 expect(point).toBeTruthy();
 await election(request,s.id,{action:'reconstruction_start',historyId:point.id});
 await open(page,s.id);
 const editor=page.getByRole('region',{name:'Reconstrucción guiada'});
 await expect(editor.getByRole('heading',{name:/QA_A.*Elegir 2 ciclo/})).toBeVisible();
 await editor.getByLabel('Registrar otra decisión').check();
 const alternative=editor.getByLabel('Ciclo alternativo');
 const available=(await read(request,s.id)).election.reconstruction.current.available as string[];
 expect(available.length).toBeGreaterThanOrEqual(2);
 await alternative.selectOption(available[0]);
 await expect(alternative).toBeVisible();
 await expect(alternative.locator('option[value="'+available[0]+'"]')).toHaveCount(0);
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeDisabled();
 await alternative.selectOption(available[1]);
 await expect(alternative).toHaveCount(0);
 await expect(editor.getByRole('button',{name:'Cambiar ciclo 1'})).toBeVisible();
 await expect(editor.getByRole('button',{name:'Cambiar ciclo 2'})).toBeVisible();
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeEnabled();
 await editor.getByRole('button',{name:'Cambiar ciclo 1'}).click();
 await expect(alternative).toBeVisible();
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeDisabled();
 await alternative.selectOption(available[0]);
 await expect(alternative).toHaveCount(0);
 await expect(editor.getByRole('button',{name:'Registrar decisión y continuar'})).toBeEnabled();
 await editor.getByRole('button',{name:'Cancelar y restaurar estado original'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 expect((await read(request,s.id)).awards.map((a:any)=>[a.member_id,a.cycle_date]).sort()).toEqual(before.awards.map((a:any)=>[a.member_id,a.cycle_date]).sort());
});

test('reconstrucción lateral: deshacer, rehacer y cancelar restaura las adjudicaciones',async({page,request})=>{
 const s=await setup(request,page),ids=s.data.members.map((m:any)=>m.id),dates=s.data.result.cycles.map((c:any)=>c.date);
 await election(request,s.id,{action:'start',order:ids,source:'Orden ficticio para restauración de reconstrucción lateral',rulesConfirmed:true,allowDeferral:true});
 for(let i=0;i<3;i++)await election(request,s.id,{action:'choose',memberId:ids[i],dates:[dates[i]]});
 const before=await read(request,s.id),point=before.election.reconstruction.candidates.find((c:any)=>c.memberIds.includes(ids[1]));
 await election(request,s.id,{action:'reconstruction_start',historyId:point.id});
 await open(page,s.id);
 const editor=page.getByRole('region',{name:'Reconstrucción guiada'});
 await editor.getByLabel('Recuperar elección anterior').check();
 await editor.getByRole('button',{name:'Registrar decisión y continuar'}).click();
 await expect(editor.getByRole('heading',{name:/QA_C/})).toBeVisible();
 await editor.getByRole('button',{name:'Deshacer paso'}).click();
 await expect(editor.getByRole('heading',{name:/QA_B/})).toBeVisible();
 await editor.getByRole('button',{name:'Rehacer paso'}).click();
 await expect(editor.getByRole('heading',{name:/QA_C/})).toBeVisible();
 await editor.getByRole('button',{name:'Cancelar y restaurar estado original'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
 await expect(editor).toBeVisible();
 await editor.getByRole('button',{name:'Cancelar y restaurar estado original'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await expect(editor).toHaveCount(0);
 const after=await read(request,s.id);
 expect(after.awards.map((a:any)=>[a.member_id,a.cycle_date]).sort()).toEqual(before.awards.map((a:any)=>[a.member_id,a.cycle_date]).sort());
 expect(after.election.state).toEqual(before.election.state);
});
test('un administrador puede iniciar reconstrucción desde una rama abandonada del historial',async({page,request})=>{
 const s=await setup(request,page),dates=s.data.result.cycles.map((c:any)=>c.date),ids=s.data.members.map((m:any)=>m.id);
 await election(request,s.id,{action:'start',order:ids,source:'Orden ficticio para probar el historial de ramas',rulesConfirmed:true,allowDeferral:false});
 for(let i=0;i<4;i++)await election(request,s.id,{action:'choose',memberId:ids[i],dates:[dates[i]]});
 let state=await read(request,s.id);
 state=await election(request,s.id,{action:'election_undo',historyId:state.election.undo});
 state=await election(request,s.id,{action:'election_undo',historyId:state.election.undo});
 await election(request,s.id,{action:'choose',memberId:ids[2],dates:[dates[6]]});
 state=await read(request,s.id);
 expect(state.election.redo).toBeNull();
 const archived=state.election.reconstruction.candidates.find((candidate:any)=>candidate.archived&&candidate.memberIds.includes(ids[2]));
 expect(archived).toBeTruthy();
 await open(page,s.id);
 const historyPanel=page.getByRole('region',{name:'Historial de elección'});
 await expect(historyPanel.getByText(/Decisiones de ramas anteriores/)).toHaveCount(0);
 await historyPanel.locator('summary[aria-label="Más acciones del historial"]').click();
 await historyPanel.getByRole('button',{name:'Reconstruir desde un turno…'}).click();
 await historyPanel.locator('.history-archived-choices summary').click();
 await historyPanel.getByLabel('Elegir decisión de rama anterior').selectOption(archived.id);
 await historyPanel.getByRole('button',{name:'Reconstruir desde la decisión anterior'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 state=await read(request,s.id);
 expect(state.election.reconstruction.active).toBe(true);
 expect(state.election.reconstruction.current.memberId).toBe(ids[2]);
 expect(state.awards).toHaveLength(2);
 await expect(page.locator('.reconstruction-status')).toContainText('Elección congelada');
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
  const blocked=await request.post('/api/election/'+s.id,{data:{action:'preferences',version:d.campaign.version,memberId:d.members[0].id,dates:[]},headers:{Origin:origin}});expect(blocked.status()).toBe(400);
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
  await page.getByRole('group',{name:'Vista del calendario'}).getByRole('button',{name:'Meses',exact:true}).click();
  await expect(page.getByRole('button',{name:'Siguiente →'})).toBeVisible();
  await page.getByRole('button',{name:'Siguiente →'}).click();
  await expect(page.getByRole('button',{name:'← Anterior'})).toBeEnabled();
  await page.getByRole('button',{name:'Por CTA',exact:true}).click();
  await expect(page.locator('.vac2-member-card').first()).toBeVisible();
  await page.getByRole('button',{name:'Mapa',exact:true}).click();
  await cycle(page,s.data.result.cycles[0].date);
  await expect(page.getByRole('region',{name:'Detalle del ciclo seleccionado'})).toBeVisible();
  await expect(page.locator('.vac2-choice-card')).toHaveCSS('position','fixed');
  await confirm(page,'Confirmar ciclo');
  await expect(page.getByRole('region',{name:'Detalle del ciclo seleccionado'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Últimos turnos y adjudicaciones',exact:true})).toBeVisible();
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
 await expect(page.getByText('Sorteo externo registrado · Orden inicial: QA_D → QA_B → QA_C')).toBeVisible();
 await page.reload();await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);await expect(page.getByRole('heading',{name:'QA_D elige ahora',exact:true})).toBeVisible();
 const saved=await read(request,s.id);expect(saved.election.state.tieResolutions[0].order).toEqual([3,1,2].map(i=>s.data.members[i].id));
 expect(saved.election.state.tieResolutions[0].method).toBe('external');
 for(const [i,idx] of [3,1,2].entries())await election(request,s.id,{action:'choose',memberId:s.data.members[idx].id,dates:[s.data.result.cycles[i+1].date]});
 await election(request,s.id,{action:'choose',memberId:s.data.members[0].id,dates:[s.data.result.cycles[4].date]});
 expect((await read(request,s.id)).election.turn.memberId).toBe(s.data.members[1].id);
 await page.reload();await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);
 await expect(page.getByText('Empate · QA_D: 1.º de 3 · Orden de esta ronda: QA_D → QA_B → QA_C')).toBeVisible();
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

test('sin equipo en URL no se impone C y el administrador puede borrar una simulación',async({page,request,browser})=>{
 const s=await setup(request,page);
 const visitor=await browser.newContext({baseURL:origin});
 try{
  const anonymous=await visitor.newPage();
  await anonymous.goto('/');
  await expect(anonymous.getByLabel('Equipo',{exact:true})).toHaveValue('');
  await expect(anonymous.getByRole('heading',{name:'Selecciona un equipo'})).toBeVisible();
  await anonymous.getByLabel('Equipo',{exact:true}).selectOption('B');
  await expect(anonymous.getByLabel('Equipo',{exact:true})).toHaveValue('B');
  await expect(anonymous).toHaveURL(/equipo=B/);
 }finally{await visitor.close();}
 await page.goto('/?equipo=C&year=2026');
 await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);
 // Wait for the selected scenario to load; do not race its asynchronous campaign fetch.
 await expect(page.getByText('Simulación privada: '+s.data.campaign.simulation_name,{exact:true})).toBeVisible();
 // Simulation actions are available directly in the header, independent of navigation.
 await expect(page.locator('.scenario-actions summary')).toBeVisible();
 await page.locator('.scenario-actions summary').click();
 await page.getByRole('button',{name:'Eliminar simulación'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar'}).click();
 await expect(page.getByLabel('Escenario',{exact:true})).toHaveValue(s.live.id);
 await expect(page.getByRole('status').filter({hasText:'Simulación eliminada'})).toBeVisible();
 expect((await request.get('/api/campaign/'+s.id)).status()).toBe(404);
});
