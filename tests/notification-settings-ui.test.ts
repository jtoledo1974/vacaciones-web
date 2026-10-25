import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notificationView, type NotificationViewInput} from '../app/notificaciones/notification-view.ts';

const base:NotificationViewInput={
 loading:false,
 supported:true,
 hasPublicKey:true,
 permission:'default',
 enabled:false,
};

test('sin suscripción, el permiso concedido no se confunde con avisos activos',()=>{
 const state=notificationView({...base,permission:'granted'});
 assert.equal(state.kind,'inactive');
 assert.equal(state.heading,'Avisos pendientes de activar');
 assert.match(state.description,/ya permite/);
 assert.equal(state.action,'Activar avisos');
});

test('la suscripción realmente registrada es la única que anuncia avisos activos',()=>{
 const state=notificationView({...base,permission:'granted',enabled:true});
 assert.equal(state.kind,'active');
 assert.equal(state.heading,'Avisos activos en este dispositivo');
 assert.equal(state.action,'Desactivar avisos');
});

test('cubre permiso sin solicitar y permiso bloqueado con pasos claros',()=>{
 const pending=notificationView(base);
 assert.equal(pending.kind,'inactive');
 assert.doesNotMatch(pending.description,/concedido|granted|default/);
 const denied=notificationView({...base,permission:'denied'});
 assert.equal(denied.kind,'blocked');
 assert.match(denied.description,/ajustes del navegador/);
 assert.equal(denied.action,null);
});

test('distingue carga, error de consulta, falta de configuración e incompatibilidad',()=>{
 assert.equal(notificationView({...base,loading:true}).kind,'loading');
 assert.equal(notificationView({...base,failed:true}).kind,'error');
 assert.equal(notificationView({...base,hasPublicKey:false}).kind,'unavailable');
 assert.equal(notificationView({...base,supported:false}).kind,'unsupported');
 assert.equal(notificationView({...base,permission:'unsupported'}).kind,'unsupported');
});

test('si ya está activado, se puede desactivar aunque falte VAPID',()=>{
 const state=notificationView({...base,permission:'granted',enabled:true,hasPublicKey:false});
 assert.equal(state.kind,'active');
 assert.equal(state.action,'Desactivar avisos');
});
