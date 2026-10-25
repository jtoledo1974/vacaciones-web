import {test,expect} from '@playwright/test';

const settings={
 canTest:false,publicKey:'test-vapid-key',subscriptions:[],notifications:[],
};

test('Chrome muestra el estado real de Push y respeta el permiso concedido',async({page})=>{
 await page.context().grantPermissions(['notifications']);
 await page.route('**/api/notifications',route=>route.fulfill({json:settings}));
 await page.goto('/notificaciones');
 // Playwright headless can disable the Push API even when Notifications.permission
 // is granted. The app must not offer activation without PushManager.
 const support=await page.evaluate(()=>({
  api:'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window&&window.isSecureContext,
  permission:'Notification' in window?Notification.permission:null,
 }));
 const active=page.getByRole('heading',{name:'Avisos pendientes de activar'});
 const unsupported=page.getByRole('heading',{name:'Avisos no compatibles con este navegador'});
 if(support.api){
  await expect(active).toBeVisible();
  await expect(page.getByRole('button',{name:'Activar avisos'})).toBeEnabled();
  await expect(page.getByText(/El navegador ya permite los avisos/)).toBeVisible();
  expect(support.permission).toBe('granted');
 }else{
  await expect(unsupported).toBeVisible();
  await expect(page.getByRole('button',{name:'Activar avisos'})).toHaveCount(0);
 }
 await expect(page.getByText('granted',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Enviar aviso de prueba'})).toHaveCount(0);
 for(const width of [320,375,430]){
  await page.setViewportSize({width,height:700});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  if(support.api){
   const box=await page.getByRole('button',{name:'Activar avisos'}).boundingBox();
   expect(box).not.toBeNull();
   expect(box!.height).toBeGreaterThanOrEqual(44);
  }
 }
});

test('UI con permiso concedido y API disponible distingue permiso de suscripción',async({page})=>{
 await page.context().grantPermissions(['notifications']);
 // This test fixes the Web Push capability explicitly; it tests UI state,
 // not browser delivery (which has a separate integration checklist).
 await page.addInitScript(()=>{
  if(!('PushManager' in window))Object.defineProperty(window,'PushManager',{configurable:true,value:class PushManager{}});
  if(!('Notification' in window))Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'granted'}});
  if(!('serviceWorker' in navigator))Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:async()=>undefined}});
 });
 await page.route('**/api/notifications',route=>route.fulfill({json:settings}));
 await page.goto('/notificaciones');
 await expect(page.getByRole('heading',{name:'Avisos pendientes de activar'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Activar avisos'})).toBeEnabled();
 await expect(page.getByText(/El navegador ya permite los avisos/)).toBeVisible();
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
