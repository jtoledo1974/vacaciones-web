/** Describe the actual ability to receive turn alerts, not raw browser API states. */
export type NotificationViewInput={
 loading:boolean;
 failed?:boolean;
 supported:boolean;
 hasPublicKey:boolean;
 permission:NotificationPermission|'unsupported';
 enabled:boolean;
};

export type NotificationView={
 kind:'loading'|'error'|'unsupported'|'blocked'|'unavailable'|'inactive'|'active';
 heading:string;
 description:string;
 action:string|null;
};

/** Derive mutually exclusive, user-facing states from local and server conditions. */
export function notificationView(input:NotificationViewInput):NotificationView{
 if(input.loading)return {kind:'loading',heading:'Comprobando tus avisos…',description:'Estamos consultando la configuración de este dispositivo.',action:null};
 if(input.failed)return {kind:'error',heading:'No podemos comprobar tus avisos',description:'Comprueba la conexión y vuelve a intentarlo. No sabemos si están activos.',action:null};
 if(!input.supported||input.permission==='unsupported')return {kind:'unsupported',heading:'Avisos no compatibles con este navegador',description:'Abre la aplicación desde un navegador que admita notificaciones. En iPhone, instálala primero en la pantalla de inicio.',action:null};
 if(input.permission==='denied')return {kind:'blocked',heading:'Avisos bloqueados en el navegador',description:'Permite las notificaciones de este sitio en los ajustes del navegador y vuelve a comprobarlo.',action:null};
 if(input.enabled)return {kind:'active',heading:'Avisos activos en este dispositivo',description:'Este dispositivo está registrado para recibir avisos cuando llegue tu turno. Su aparición y sonido dependen del sistema.',action:'Desactivar avisos'};
 if(!input.hasPublicKey)return {kind:'unavailable',heading:'Avisos temporalmente no disponibles',description:'El administrador aún tiene que completar la configuración del servicio de notificaciones.',action:null};
 return {
  kind:'inactive',
  heading:'Avisos pendientes de activar',
  description:input.permission==='granted'
   ?'El navegador ya permite los avisos. Actívalos aquí para recibir una notificación cuando llegue tu turno.'
   :'Activa los avisos para que este dispositivo te avise cuando llegue tu turno, aunque no tengas abierta la aplicación.',
  action:'Activar avisos',
 };
}
