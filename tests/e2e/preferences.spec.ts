import {test,expect,type APIRequestContext,type Page} from '@playwright/test';

const origin='http://127.0.0.1:5199';
async function post(api:APIRequestContext,path:string,body:object){
 const r=await api.post('/api/'+path,{data:body,headers:{Origin:origin}});expect(r.ok(),await r.text()).toBeTruthy();return r.json();
}
async function read(api:APIRequestContext,id:string){return (await api.get('/api/campaign/'+id)).json();}
async function command(api:APIRequestContext,id:string,body:object){const d=await read(api,id);return post(api,'election/'+id,{...body,version:d.campaign.version});}
async function fixture(api:APIRequestContext,page:Page){
 await api.get('/signin-with-chatgpt?return_to=/');await page.context().addCookies((await api.storageState()).cookies);
 let index=await (await api.get('/api/index')).json();if(!index.campaigns.length)index=await post(api,'initialize',{});
 const live=index.campaigns.find((c:any)=>c.team_id==='C'&&c.year===2026&&c.scope_key==='live'),baseline=await read(api,live.id);
 const clone=await post(api,'simulations/'+live.id,{name:'Preferencias QA '+crypto.randomUUID().slice(0,8),version:baseline.campaign.version});
 let data=await read(api,clone.id);
 data=await post(api,'campaign/'+clone.id,{action:'import_roster',version:data.campaign.version,source:{format:'vacaciones-roster-v1',team:'C',year:2026,copySelections:false,rows:['QA_A','QA_B','QA_C','QA_D'].map(code=>({code,label:'Ficticio '+code,seniority:''}))}});
 await page.goto('/?equipo=C&year=2026');await page.getByLabel('Escenario',{exact:true}).selectOption(clone.id);
 await expect(page.getByText(/SIMULACIÓN PRIVADA/i)).toBeVisible();
 await page.getByRole('button',{name:'Preparar preferencias',exact:true}).click();
 return {id:clone.id,data,live,baseline};
}
async function review(page:Page){
 const dock=page.getByRole('button',{name:'Revisar y guardar',exact:true});
 if(await dock.isVisible())await dock.click();
 return page.locator('.preferences-panel');
}
async function close(page:Page){const close=page.getByRole('button',{name:'Cerrar revisión de preferencias'});if(await close.isVisible())await close.click();}
async function add(page:Page,date:string){await page.locator('.vac2-cycle[data-cycle-date="'+date+'"]').click();}

// Run the four visual sizes once each; the existing suite also covers the two project devices.
for(const size of [{width:375,height:667},{width:390,height:844},{width:768,height:1024},{width:1440,height:900}]){
 test(`preferencias: seleccionar, ordenar, guardar y proteger borrador ${size.width}×${size.height}`,async({page,request},info)=>{
  test.setTimeout(90_000);
  test.skip(info.project.name!=='chromium','The four explicit viewport sizes are covered in the desktop project.');
  await page.setViewportSize(size);
  const s=await fixture(request,page),member=s.data.members[0],dates=s.data.result.cycles.slice(0,3).map((c:any)=>c.date);
  const shot=async(name:string)=>{if(!process.env.CI)await page.screenshot({path:info.outputPath(name+'.png')});};
  if(size.width>900){
   await expect.poll(async()=>{
    const rect=await page.getByRole('button',{name:'Guardar preferencias',exact:true}).boundingBox();
    return !!rect&&rect.y>=0&&rect.y+rect.height<=size.height;
   }).toBe(true);
  }else await page.getByRole('region',{name:'Calendario de ciclos'}).scrollIntoViewIfNeeded();
  await shot('01-vacia');
  if(size.width<=900){
   await expect(page.locator('.preference-dock')).toContainText('Sin preferencias guardadas');
   const bounds=await page.locator('.preference-dock').boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(size.height);
  }
  await add(page,dates[0]);
  await expect(page.getByRole('status').filter({hasText:'Añadido a tus preferencias'})).toContainText('posición 1');
  expect((await read(request,s.id)).election.preferences).toHaveLength(0);
  await expect(page.getByRole('region',{name:'Detalle del ciclo seleccionado'})).toHaveCount(0);
  await shot('02-primera-sin-guardar');
  await add(page,dates[1]);await add(page,dates[2]);
  const editor=await review(page);
  await expect(editor).toContainText('Cambios sin guardar');
  await shot('03-revision');
  await editor.getByRole('button',{name:'Subir preferencia 3',exact:true}).click();
  const list=editor.getByRole('list',{name:'Preferencias en orden de prioridad'});
  await expect(list.locator('li')).toHaveCount(3);
  await editor.getByLabel('Mantener estas preferencias en todas las rondas restantes').check();
  await shot('04-ordenadas');
  // Keyboard focus wraps inside the mobile review; Escape preserves the draft.
  if(size.width<=900){
   await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).focus();await page.keyboard.press('Tab');
   await expect(editor.getByRole('button',{name:'Cerrar revisión de preferencias'})).toBeFocused();
   await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
   await expect(page.getByRole('button',{name:'Revisar y guardar'})).toBeFocused();await review(page);
  }
  await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await expect(editor.getByRole('button',{name:'Guardar preferencias',exact:true})).toBeDisabled();
  let saved=(await read(request,s.id)).election.preferences.find((p:any)=>p.member_id===member.id);
  expect(saved).toMatchObject({dates:[dates[0],dates[2],dates[1]],persistent:true});
  await expect(editor).toContainText('Preferencias guardadas');await shot('05-guardadas');
  await editor.getByLabel('Mantener estas preferencias en todas las rondas restantes').uncheck();
  await expect(editor.locator('.preference-state').first()).toHaveText('Cambios sin guardar');
  await editor.getByLabel('Mantener estas preferencias en todas las rondas restantes').check();
  await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');
  await expect(editor.getByRole('status')).toHaveText('La lista coincide con la versión guardada.');
  await editor.getByRole('button',{name:'Quitar preferencia 2',exact:true}).click();
  await expect(editor).toContainText('Cambios sin guardar');await shot('06-modificar-guardadas');
  await close(page);
  await page.getByRole('button',{name:'Elegir / consultar',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Confirmar cambio'})).toContainText('sin guardar');await shot('07-proteger-cambio-modo');
  await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Preparar preferencias',exact:true})).toHaveAttribute('aria-pressed','true');
  // Changing controller and campaign both require a decision; cancellation retains the draft.
  await page.getByLabel('Preferencias de controlador',{exact:true}).selectOption(s.data.members[1].id);
  await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.getByLabel('Preferencias de controlador',{exact:true})).toHaveValue(member.id);
  await page.getByLabel('Escenario',{exact:true}).selectOption(s.live.id);
  await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.getByLabel('Escenario',{exact:true})).toHaveValue(s.id);
  await review(page);await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await expect(editor.getByRole('button',{name:'Guardar preferencias',exact:true})).toBeDisabled();await close(page);
  // Reload proves persistence, rather than only checking the React draft.
  await page.reload();await page.getByLabel('Escenario',{exact:true}).selectOption(s.id);
  await page.getByRole('button',{name:'Preparar preferencias',exact:true}).click();
  await review(page);await expect(list.locator('li')).toHaveCount(2);await close(page);
  // Presentation hides exhausted cycles, without changing their stored order.
  let data=await read(request,s.id);const config=structuredClone(data.config);
  await post(request,'campaign/'+s.id,{action:'config',version:data.campaign.version,config:{...config,relation:{minimum:0,base:0,maximum:0,graceJanuary:0,graceOctober:0},specialQuotas:{}}});
  await expect(page.locator('.vac2-cycle').first()).toContainText('0 libres',{timeout:18000});
  await review(page);await expect(editor).toContainText('sin cupo ocultos');await shot('08-sin-cupo-conservadas');await close(page);
  data=await read(request,s.id);await post(request,'campaign/'+s.id,{action:'config',version:data.campaign.version,config});
  await expect(page.locator('.vac2-cycle').first()).not.toContainText('0 libres',{timeout:18000});
  await review(page);await expect(list.locator('li')).toHaveCount(2);await close(page);
  // The saved list advances A; saving B's new draft must still ask explicitly.
  const started=await command(request,s.id,{action:'start',order:s.data.members.map((m:any)=>m.id),source:'Orden de prueba visual aislada',rulesConfirmed:true,allowDeferral:true});
  if(started.election.pendingAutomatic)await command(request,s.id,{action:'advance'});
  await expect(page.getByRole('heading',{name:'QA_B elige ahora',exact:true})).toBeVisible({timeout:18000});
  await page.getByLabel('Preferencias de controlador',{exact:true}).selectOption(s.data.members[1].id);
  await add(page,dates[2]);await review(page);await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'Confirmar cambio'});
  await expect(confirmation).toContainText('adjudicar inmediatamente');await shot('09-confirmar-adjudicacion');
  await confirmation.getByRole('button',{name:'Cancelar',exact:true}).click();
  expect((await read(request,s.id)).awards.filter((a:any)=>a.member_id===s.data.members[1].id)).toHaveLength(0);
  await close(page);
  expect((await read(request,s.live.id)).campaign).toEqual(s.baseline.campaign);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 });
}

test('preferencias: cuotas agotadas se ocultan, se conservan al guardar y reaparecen',async({page,request},info)=>{
 const s=await fixture(request,page),member=s.data.members[0],date=s.data.result.cycles[0].date;
 await add(page,date);let editor=await review(page);await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await expect(editor.getByRole('button',{name:'Guardar preferencias',exact:true})).toBeDisabled();await close(page);
 // Exhaust a quota using isolated campaign configuration, without altering the stored list.
 let data=await read(request,s.id);const original=structuredClone(data.config);
 const config={...original,relation:{minimum:0,base:0,maximum:0,graceJanuary:0,graceOctober:0},specialQuotas:{}};
 await post(request,'campaign/'+s.id,{action:'config',version:data.campaign.version,config});
 await expect(page.locator('.vac2-cycle[data-cycle-date="'+date+'"]').first()).toContainText('0 libres',{timeout:18000});
 editor=await review(page);await expect(editor).toContainText('sin cupo ocultos');
 if(!process.env.CI)await page.screenshot({path:info.outputPath('08-sin-cupo-conservadas.png')});
 await editor.getByLabel('Mantener estas preferencias en todas las rondas restantes').check();
 await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await expect(editor.getByRole('button',{name:'Guardar preferencias',exact:true})).toBeDisabled();
 expect((await read(request,s.id)).election.preferences.find((p:any)=>p.member_id===member.id).dates).toEqual([date]);
 await close(page);data=await read(request,s.id);await post(request,'campaign/'+s.id,{action:'config',version:data.campaign.version,config:original});
 await expect(page.locator('.vac2-cycle[data-cycle-date="'+date+'"]').first()).not.toContainText('0 libres',{timeout:18000});
 await review(page);await expect(editor.getByRole('listitem')).toHaveCount(1);
});

test('preferencias: fallo de guardado conserva borrador y cancelar salida no lo persiste',async({page,request})=>{
 const s=await fixture(request,page);await add(page,s.data.result.cycles[0].date);const editor=await review(page);
 await page.route('**/api/election/'+s.id,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Conflicto de prueba: vuelve a intentar'})}));
 await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 await expect(editor.getByRole('button',{name:'Guardar preferencias',exact:true})).toBeEnabled();
 await expect(editor).toContainText('Cambios sin guardar');expect((await read(request,s.id)).election.preferences).toHaveLength(0);
 await close(page);
 await page.getByLabel('Equipo',{exact:true}).selectOption('B');
 await page.getByRole('dialog',{name:'Confirmar cambio'}).getByRole('button',{name:'Cancelar',exact:true}).click();
 await expect(page.getByLabel('Equipo',{exact:true})).toHaveValue('C');
 await page.getByRole('button',{name:'Elegir / consultar',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await page.getByRole('button',{name:'Preparar preferencias',exact:true}).click();await review(page);
 await expect(editor.getByRole('listitem')).toHaveCount(0);
});

test('preferencias: lista larga mantiene accesibles cierre, orden y guardado',async({page,request},info)=>{
 const s=await fixture(request,page);
 for(const c of s.data.result.cycles.slice(0,14))await add(page,c.date);
 const editor=await review(page),save=editor.getByRole('button',{name:'Guardar preferencias',exact:true});
 await expect(editor.getByRole('listitem')).toHaveCount(14);
 const rect=await save.boundingBox(),viewport=page.viewportSize()!;
 expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.y+rect!.height).toBeLessThanOrEqual(viewport.height);
 await editor.getByRole('button',{name:'Subir preferencia 14',exact:true}).click();
 await save.click();await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await expect(save).toBeDisabled();
 const stored=(await read(request,s.id)).election.preferences.find((p:any)=>p.member_id===s.data.members[0].id);
 expect(stored.dates[12]).toBe(s.data.result.cycles[13].date);
 if(!process.env.CI)await page.screenshot({path:info.outputPath('lista-larga.png')});
});

test('preferencias: guardar tras undo conserva la pausa de automatismos de main',async({page,request},info)=>{
 const s=await fixture(request,page),dates=s.data.result.cycles.map((c:any)=>c.date);
 await command(request,s.id,{action:'start',order:s.data.members.map((m:any)=>m.id),source:'Prueba de pausa tras deshacer',rulesConfirmed:true,allowDeferral:true});
 await expect(page.getByRole('heading',{name:'QA_A elige ahora',exact:true})).toBeVisible({timeout:18000});
 await add(page,dates[0]);let editor=await review(page);
 await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 await page.getByRole('dialog',{name:'Confirmar cambio'}).getByRole('button',{name:'Confirmar',exact:true}).click();
 await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');await close(page);
 const saved=await read(request,s.id);expect(saved.awards).toHaveLength(1);
 await command(request,s.id,{action:'election_undo',historyId:saved.election.undo});
 await expect(page.getByRole('button',{name:'Reanudar automatismos',exact:true})).toBeVisible({timeout:18000});
 await add(page,dates[1]);editor=await review(page);
 await expect(editor).toContainText('Guardar conserva la lista sin adjudicar');
 await editor.getByRole('button',{name:'Guardar preferencias',exact:true}).click();
 await expect(editor.locator('.preference-state').first()).toHaveText('Preferencias guardadas');
 await expect(page.getByRole('dialog',{name:'Confirmar cambio'})).toHaveCount(0);
 const after=await read(request,s.id);expect(after.awards).toHaveLength(0);expect(after.election.state.automaticPaused).toBe(true);
 if(!process.env.CI)await page.screenshot({path:info.outputPath('preferencias-con-automatismos-pausados.png')});
});
