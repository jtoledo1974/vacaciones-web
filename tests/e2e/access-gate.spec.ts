import {test,expect,type Page,type APIRequestContext} from '@playwright/test';

async function mockVisitor(page:Page,request:APIRequestContext,linked:boolean,authenticated=true) {
  await request.get('/signin-with-chatgpt?return_to=/');
  await page.context().addCookies((await request.storageState()).cookies);
  let index=await (await request.get('/api/index')).json();
  if(!index.campaigns.length){
    const response=await request.post('/api/initialize',{data:{},headers:{Origin:'http://127.0.0.1:5199'}});
    expect(response.ok(),await response.text()).toBeTruthy();
    index=await response.json();
  }
  const campaign=index.campaigns.find((c:any)=>c.team_id==='A'&&c.year===2026&&c.scope_key==='live');
  expect(campaign).toBeTruthy();
  const data=await (await request.get('/api/campaign/'+campaign.id)).json();
  const memberId=linked?data.members[0].id:null;
  const publicCampaign={...data,editable:false,participating:linked,
    election:{...data.election,myMemberId:memberId,canManage:false,
      preferenceMemberIds:memberId?[memberId]:[],accounts:[],preferences:[]}};
  const principal={id:authenticated?'chatgpt:visitor':null,role:'viewer',teams:[]};
  await page.route('**/api/session',route=>route.fulfill({json:{
    principal,identity:authenticated?{provider:'chatgpt',subject:'visitor',email:'visitor@example.test'}:null,
  }}));
  await page.route('**/api/index',route=>route.fulfill({json:{
    ...index,principal,myCampaignIds:linked?[campaign.id]:[],
  }}));
  await page.route('**/api/campaign/'+campaign.id,route=>route.fulfill({json:publicCampaign}));
  await page.goto('/?equipo=A&year=2026');
}

test('el usuario autenticado sin vinculación recibe un aviso y elige explícitamente consulta pública',async({page,request})=>{
  await mockVisitor(page,request,false);
  await expect(page.getByRole('heading',{name:/Tu cuenta no está vinculada a un controlador/})).toBeVisible();
  await expect(page.getByRole('region',{name:/Tu cuenta no está vinculada a un controlador/}).getByText('visitor@example.test')).toBeVisible();
  await expect(page.getByRole('button',{name:'Mis preferencias',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Continuar en consulta pública'}).click();
  await expect(page.getByRole('region',{name:'Calendario de ciclos'})).toBeVisible();
  await expect(page.getByText(/Estás consultando la campaña públicamente/)).toBeVisible();
  await page.getByRole('button',{name:'Volver al aviso de acceso'}).click();
  await expect(page.getByRole('heading',{name:/Tu cuenta no está vinculada a un controlador/})).toBeVisible();
});

test('el controlador vinculado accede a preferencias sin aviso de acceso',async({page,request})=>{
  await mockVisitor(page,request,true);
  await expect(page.getByRole('heading',{name:/Tu cuenta no está vinculada a un controlador/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Mis preferencias',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Preferencias',exact:true})).toHaveCount(0);
  await expect(page.locator('.campaign-strip')).toContainText('Controlador · preferencias propias');
});

test('el visitante anónimo continúa viendo el calendario sin bloqueo',async({page,request})=>{
  await mockVisitor(page,request,false,false);
  await expect(page.getByRole('heading',{name:/Tu cuenta no está vinculada a un controlador/})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Calendario de ciclos'})).toBeVisible();
});
