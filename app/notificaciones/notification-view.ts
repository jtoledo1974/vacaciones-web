/** User-facing device state based on the permission, subscription and installation. */
export type NotificationViewInput={
 loading:boolean;
 failed?:boolean;
 supported:boolean;
 hasPublicKey:boolean;
 permission:NotificationPermission|'unsupported';
 enabled:boolean;
 appleMobile?:boolean;
 standalone?:boolean;
};

export type NotificationView={
 kind:'loading'|'error'|'install'|'unsupported'|'blocked'|'unavailable'|'inactive'|'active';
 heading:string;
 description:string;
 action:string|null;
};

/** Identify iOS/iPadOS, including iPadOS desktop user agents. */
export function isAppleMobile(userAgent:string,maxTouchPoints:number):boolean{
 return /iPhone|iPad|iPod/i.test(userAgent)||(/Macintosh/i.test(userAgent)&&maxTouchPoints>1);
}

/** Derive a single non-contradictory message; never expose raw browser values. */
export function notificationView(input:NotificationViewInput):NotificationView{
 if(input.loading)return {kind:'loading',heading:'Comprobando tus avisos…',description:'Estamos consultando la configuración de este dispositivo.',action:null};
 if(input.failed)return {kind:'error',heading:'No podemos comprobar tus avisos',description:'Comprueba la conexión y vuelve a intentarlo. No sabemos si están activos.',action:null};
 if(input.appleMobile&&!input.standalone)return {kind:'install',heading:'Instala la aplicación para recibir avisos',description:'En iPhone y iPad, los avisos solo funcionan desde la aplicación añadida a la pantalla de inicio.',action:null};
 if(!input.supported||input.permission==='unsupported')return {kind:'unsupported',heading:'Avisos no compatibles con este navegador',description:'Abre esta página desde un navegador que admita notificaciones Push.',action:null};
 if(input.permission==='denied')return {kind:'blocked',heading:'Avisos bloqueados en el navegador',description:'Permite las notificaciones de este sitio en los ajustes del navegador o del dispositivo y vuelve a comprobarlo.',action:null};
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
