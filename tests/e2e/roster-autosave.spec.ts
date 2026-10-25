import {test,expect} from '@playwright/test';

const origin='http://127.0.0.1:5199';

/** Wait for client-side hydration before opening the mobile navigation.
 * A bare isVisible() immediately after reload can race with first render.
 */
async function openAdministration(page:import('@playwright/test').Page):Promise<void> {
  await expect(page.getByLabel('Equipo',{exact:true})).toHaveValue('C');
  const nav=page.getByRole('button',{name:'Administración',exact:true});
  await expect(nav).toBeAttached();
  const mobileMenu=page.getByRole('button',{name:'Abrir menú',exact:true});
  if(await mobileMenu.isVisible()) {
    await mobileMenu.click({timeout:8_000});
    await expect(nav).toBeVisible();
  }
  await nav.click({timeout:8_000});
  await expect(page.getByRole('heading',{name:'Plantilla del equipo C'})).toBeVisible();
}

test('la plantilla guarda automáticamente y conserva las ediciones tras recargar',{tag:'@both'},async({page,request})=>{
  await request.get('/signin-with-chatgpt?return_to=/');
  await page.context().addCookies((await request.storageState()).cookies);
  let index=await (await request.get('/api/index')).json();
  if(!index.campaigns.length){
    const initialized=await request.post('/api/initialize',{data:{},headers:{Origin:origin}});
    expect(initialized.ok(),await initialized.text()).toBeTruthy();
    index=await (await request.get('/api/index')).json();
  }
  const campaign=index.campaigns.find((c:any)=>c.team_id==='C'&&c.year===2026&&c.scope_key==='live');
  expect(campaign).toBeDefined();
  const before=await (await request.get('/api/campaign/'+campaign.id)).json();
  expect(before.members.length).toBeGreaterThan(0);
  const member=before.members[0],firstLabel=member.label;
  const modified='Autosave '+member.code;
  try {
    await page.goto('/?equipo=C&year=2026');
    await openAdministration(page);
    await expect(page.getByRole('button',{name:/Guardar cambios/})).toHaveCount(0);
    const field=page.getByLabel('Nombre fila 1',{exact:true});
    await field.fill(modified);
    await field.press('Tab');
    await expect.poll(async()=>{
      const state=await (await request.get('/api/campaign/'+campaign.id)).json();
      return state.members.find((m:any)=>m.id===member.id)?.label;
    }).toBe(modified);
    await expect(page.locator('#roster-panel').getByRole('status').filter({hasText:'Todos los cambios guardados'})).toBeVisible();
    await page.reload();
    await openAdministration(page);
    await expect(page.getByLabel('Nombre fila 1',{exact:true})).toHaveValue(modified);
  } finally {
    const state=await (await request.get('/api/campaign/'+campaign.id)).json();
    const res=await request.post('/api/campaign/'+campaign.id,{
      headers:{Origin:origin},
      data:{
        action:'bulk_members',version:state.campaign.version,
        rows:state.members.map((m:any)=>({memberId:m.id,code:m.code,label:m.id===member.id?firstLabel:m.label,seniority:m.seniority??''})),
      },
    });
    expect(res.ok(),await res.text()).toBeTruthy();
  }
});
