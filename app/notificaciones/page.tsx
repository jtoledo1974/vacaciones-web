'use client';

import {useCallback,useEffect,useState} from 'react';
import {Bell,BellOff,CheckCircle2,HelpCircle,RefreshCw,ShieldAlert,Smartphone} from 'lucide-react';
import {firebaseBearerToken} from '../firebase-client';
import {isAppleMobile,notificationView} from './notification-view';

type NotificationSettings={
 canTest:boolean;
 publicKey:string|null;
 subscriptions:{endpoint:string;createdAt:string}[];
 notifications:{id:string;campaign_id:string;round:number;created_at:string;team_id:string;year:number}[];
};
type Device={supported:boolean;appleMobile:boolean;standalone:boolean;permission:NotificationPermission|'unsupported'};

const decode=(value:string):Uint8Array<ArrayBuffer>=>{
 const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
};
async function api(method:'GET'|'POST',body?:unknown):Promise<NotificationSettings>{
 const token=await firebaseBearerToken();
 const response=await fetch('/api/notifications',{
  method,cache:'no-store',
  headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined
 });
 const json=await response.json() as {error?:string};
 if(!response.ok){
  if(response.status===401)throw Error('Inicia sesión con la cuenta vinculada a tu controlador para configurar los avisos.');
  throw Error(json.error||'No se ha podido consultar el servicio de notificaciones');
 }
 return json as NotificationSettings;
}
function getDevice():Device{
 const appleMobile=isAppleMobile(navigator.userAgent,navigator.maxTouchPoints);
 const standalone=window.matchMedia('(display-mode: standalone)').matches||
  Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
 const supported='Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window&&window.isSecureContext;
 return {appleMobile,standalone,supported,permission:'Notification' in window?Notification.permission:'unsupported'};
}

export default function NotificationPreferences(){
 const [settings,setSettings]=useState<NotificationSettings|null>(null);
 const [enabled,setEnabled]=useState(false);
 const [device,setDevice]=useState<Device>({supported:false,appleMobile:false,standalone:false,permission:'unsupported'});
 const [loading,setLoading]=useState(true);
 const [failed,setFailed]=useState(false);
 const [message,setMessage]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');

 const refresh=useCallback(async()=>{
  setLoading(true);
  setFailed(false);
  setError('');
  try{
   const local=getDevice();
   setDevice(local);
   const data=await api('GET');
   setSettings(data);
   let active=false;
   if(local.supported&&(!local.appleMobile||local.standalone)){
    const registration=await navigator.serviceWorker.getRegistration('/notificaciones/');
    const subscription=await registration?.pushManager.getSubscription();
    active=!!subscription&&data.subscriptions.some(s=>s.endpoint===subscription.endpoint);
   }
   setEnabled(active);
  }catch(e){
   setFailed(true);
   setError(e instanceof Error?e.message:String(e));
  }finally{setLoading(false);}
 },[]);

 useEffect(()=>{void refresh();},[refresh]);

 const view=notificationView({
  loading,failed,supported:device.supported,hasPublicKey:!!settings?.publicKey,
  permission:device.permission,enabled,appleMobile:device.appleMobile,standalone:device.standalone,
 });

 async function toggle(){
  if(!view.action||busy)return;
  setBusy(true);setMessage('');
  try{
   if(!enabled){
    // Browser permission prompts require a direct user gesture.
    const permission=await Notification.requestPermission();
    setDevice(d=>({...d,permission}));
    if(permission!=='granted')throw Error('No se han autorizado los avisos. Comprueba los permisos del navegador.');
   }
   const registration=await navigator.serviceWorker.register('/push-probe-sw.js',{scope:'/notificaciones/'});
   // The registration is scoped to /notificaciones, so do not await
   // navigator.serviceWorker.ready on any other URL.
   let subscription=await registration.pushManager.getSubscription();
   if(enabled){
    if(subscription){
     await api('POST',{action:'unsubscribe',endpoint:subscription.endpoint});
     await subscription.unsubscribe();
    }
    setMessage('Has desactivado los avisos en este dispositivo.');
   }else{
    if(!settings?.publicKey)throw Error('El servicio de notificaciones todavía no está configurado.');
    if(!subscription){
     subscription=await registration.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:decode(settings.publicKey),
     });
    }
    await api('POST',{action:'subscribe',subscription:subscription.toJSON()});
    setMessage('Avisos activados en este dispositivo. Recibirás avisos para tus turnos de elección.');
   }
   await refresh();
  }catch(e){
   setError(e instanceof Error?e.message:String(e));
   setDevice(getDevice());
  }finally{setBusy(false);}
 }

 async function testPush(){
  if(!settings?.canTest||!enabled||busy)return;
  setBusy(true);setMessage('');setError('');
  try{
   const registration=await navigator.serviceWorker.getRegistration('/notificaciones/');
   const subscription=await registration?.pushManager.getSubscription();
   if(!subscription||!settings.subscriptions.some(s=>s.endpoint===subscription.endpoint))
    throw Error('Activa primero los avisos con tu cuenta de superadministrador.');
   await api('POST',{action:'test',endpoint:subscription.endpoint});
   setMessage('El servicio Push ha aceptado la prueba. Comprueba si aparece la notificación en tu dispositivo.');
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }

 const Icon=view.kind==='active'?CheckCircle2:view.kind==='inactive'?Bell:view.kind==='install'?Smartphone:view.kind==='blocked'?ShieldAlert:BellOff;

 return <main className="notifications-page">
  <div className="notifications-wrap">
   <a className="notifications-back" href="/">← Volver a vacaciones</a>
   <header className="notifications-header">
    <h1>Notificaciones de vacaciones</h1>
    <p>Te avisaremos cuando llegue tu turno de elección. Configura los avisos en cada dispositivo que quieras utilizar.</p>
   </header>
   <section className="panel notifications-card" aria-label="Estado de las notificaciones">
    <div className={'notifications-state is-'+view.kind} role="status">
     <span className="notifications-state-icon"><Icon size={22} aria-hidden="true"/></span>
     <div><h2>{view.heading}</h2><p>{view.description}</p></div>
    </div>
    {view.kind==='install'&&<div className="notifications-instructions">
     <h3>Cómo activarlos en iPhone o iPad</h3>
     <ol><li>Abre esta web en Safari y toca <strong>Compartir</strong>.</li>
      <li>Selecciona <strong>Añadir a pantalla de inicio</strong>.</li>
      <li>Abre <strong>Vacaciones LECS</strong> desde el icono creado y pulsa <strong>Activar avisos</strong>.</li></ol>
     <p>Necesitas iOS o iPadOS 16.4 o posterior. Desde una pestaña normal del navegador no se pueden activar.</p>
    </div>}
    {view.kind==='blocked'&&<div className="notifications-instructions">
     <p>{device.appleMobile?'En Ajustes de iOS, busca Notificaciones y permite los avisos de Vacaciones LECS.':'Abre la configuración del sitio (icono junto a la dirección web), permite las notificaciones y vuelve aquí.'}</p>
    </div>}
    {view.action&&<button type="button" className={enabled?'secondary notifications-action':'primary notifications-action'} disabled={busy} onClick={()=>void toggle()}>
     {busy?'Guardando…':view.action}
    </button>}
    {view.kind==='unavailable'&&<p className="notifications-hint">La activación estará disponible cuando el administrador complete la configuración Push.</p>}
    <button type="button" className="notifications-refresh" disabled={busy||loading} onClick={()=>void refresh()}>
     <RefreshCw size={16} aria-hidden="true"/> Volver a comprobar
    </button>
    {error&&<p className="notifications-feedback is-error" role="alert">{error}</p>}
    {message&&<p className="notifications-feedback is-success" role="status">{message}</p>}
   </section>

   {settings?.canTest&&<section className="panel notifications-card" aria-label="Prueba Push de superadministrador">
    <h2>Probar los avisos</h2>
    <p>Envía una notificación de prueba solo a este dispositivo, sin modificar elecciones ni simulaciones.</p>
    <button type="button" className="secondary notifications-action" disabled={busy||!enabled||!settings.publicKey||view.kind!=='active'} onClick={()=>void testPush()}>
     Enviar aviso de prueba
    </button>
    {!enabled&&<p className="notifications-hint">Activa primero los avisos para habilitar la prueba.</p>}
   </section>}

   <section className="panel notifications-card" aria-label="Últimos avisos de turno">
    <h2>Últimos avisos</h2>
    {loading?<p className="notifications-hint">Cargando avisos…</p>:!settings?.notifications.length?
     <p className="notifications-hint">Todavía no hay avisos registrados.</p>:
     <ul className="notifications-history">{settings.notifications.map(n=><li key={n.id}>
      <span>Ronda {n.round} · {new Date(n.created_at).toLocaleString('es-ES')}</span>
      <a href={'/?equipo='+encodeURIComponent(n.team_id)+'&year='+encodeURIComponent(String(n.year))}>Ver elección</a>
     </li>)}</ul>}
   </section>
   <details className="notifications-help">
    <summary><HelpCircle size={17} aria-hidden="true"/> Ayuda y diagnóstico</summary>
    <p>Necesitas iniciar sesión con la cuenta vinculada a tu controlador, aceptar los permisos de notificación y mantenerlos habilitados en el sistema. El dispositivo decide cómo y cuándo muestra y reproduce los avisos.</p>
    <p>Los avisos no se envían durante simulaciones. El servicio puede aceptar una notificación aunque el sistema operativo no la muestre.</p>
    <p><a href="/notificaciones/diagnostico">Abrir diagnóstico técnico</a></p>
    <dl><dt>Permiso del navegador</dt><dd>{device.permission==='granted'?'Permitido':device.permission==='denied'?'Bloqueado':device.permission==='default'?'Sin solicitar':'No disponible'}</dd>
     <dt>Suscripción registrada</dt><dd>{loading?'Comprobando…':failed?'No comprobada':enabled?'Sí':'No'}</dd>
    </dl>
   </details>
  </div>
 </main>;
}
