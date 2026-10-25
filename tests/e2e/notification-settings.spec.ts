import {test,expect} from '@playwright/test';

const settings={
 canTest:false,publicKey:'test-vapid-key',subscriptions:[],notifications:[],
};

test('el navegador permite avisos pero aún falta activar la suscripción',async({page})=>{
 await page.context().grantPermissions(['notifications']);
 await page.route('**/api/notifications',route=>route.fulfill({json:settings}));
 await page.goto('/notificaciones');
 await expect(page.getByRole('heading',{name:'Avisos pendientes de activar'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Activar avisos'})).toBeEnabled();
 await expect(page.getByText(/El navegador ya permite los avisos/)).toBeVisible();
 await expect(page.getByText('granted')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Enviar aviso de prueba'})).toHaveCount(0);
 for(const width of [320,375,430]){
  await page.setViewportSize({width,height:700});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  const button=page.getByRole('button',{name:'Activar avisos'});
  const box=await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
 }
});

test('error del servicio no se presenta como avisos desactivados',async({page})=>{
 await page.route('**/api/notifications',route=>route.fulfill({status:503,json:{error:'Servicio temporalmente no disponible'}}));
 await page.goto('/notificaciones');
 await expect(page.getByRole('heading',{name:'No podemos comprobar tus avisos'})).toBeVisible();
 await expect(page.getByRole('alert')).toContainText('Servicio temporalmente no disponible');
 await expect(page.getByRole('button',{name:'Activar avisos'})).toHaveCount(0);
});

test('el panel de prueba es exclusivo del superadministrador',async({page})=>{
 await page.route('**/api/notifications',route=>route.fulfill({json:{...settings,canTest:true}}));
 await page.goto('/notificaciones');
 await expect(page.getByRole('region',{name:'Prueba Push de superadministrador'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Enviar aviso de prueba'})).toBeDisabled();
});

test('iPhone muestra instalación antes de activar permisos',{tag:'@mobile-only'},async({page})=>{
 await page.route('**/api/notifications',route=>route.fulfill({json:settings}));
 await page.goto('/notificaciones');
 await expect(page.getByRole('heading',{name:'Instala la aplicación para recibir avisos'})).toBeVisible();
 await expect(page.getByText('Añadir a pantalla de inicio')).toBeVisible();
 await expect(page.getByRole('button',{name:'Activar avisos'})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});
