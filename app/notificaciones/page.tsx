'use client';
import {useEffect,useState} from 'react';
import {firebaseBearerToken} from '../firebase-client';

type NotificationSettings={canTest:boolean;publicKey:string|null;subscriptions:{endpoint:string;createdAt:string}[];notifications:{id:string;campaign_id:string;round:number;created_at:string;team_id:string;year:number}[]};
const decode=(value:string):Uint8Array=>{
 const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
};
async function api(method:'GET'|'POST',body?:unknown):Promise<any>{
 const token=await firebaseBearerToken();
 const r=await fetch('/api/notifications',{method,cache:'no-store',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const response=await r.json() as {error?:string};if(!r.ok)throw Error(response.error||'Error de notificaciones');return response;
}
export default function NotificationPreferences(){
 const [settings,setSettings]=useState<NotificationSettings|null>(null);
 const [enabled,setEnabled]=useState(false);
 const [permission,setPermission]=useState('desconocido');
 const [message,setMessage]=useState('');
 const [busy,setBusy]=useState(false);
 async function refresh(){
  const data:NotificationSettings=await api('GET');setSettings(data);
  if('Notification' in window)setPermission(Notification.permission);
  if('serviceWorker' in navigator){
   const registration=await navigator.serviceWorker.getRegistration('/notificaciones/');
   const active=await registration?.pushManager.getSubscription();
   setEnabled(!!active&&data.subscriptions.some(s=>s.endpoint===active.endpoint));
  }
 }
 useEffect(()=>{void refresh().catch(e=>setMessage(String(e)));},[]);
 async function toggle(){
  setBusy(true);setMessage('');
  try{
   if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw Error('Web Push no disponible en este navegador');
   if(!settings?.publicKey)throw Error('Falta configurar las claves VAPID en el servidor');
   if(!enabled){
    // Permissions must be requested directly within the user's click gesture.
    const granted=await Notification.requestPermission();setPermission(granted);
    if(granted!=='granted')throw Error('El navegador no ha autorizado las notificaciones');
   }
   const registration=await navigator.serviceWorker.register('/push-probe-sw.js',{scope:'/notificaciones/'});
   await navigator.serviceWorker.ready;
   let subscription=await registration.pushManager.getSubscription();
   if(enabled){
    if(subscription){await api('POST',{action:'unsubscribe',endpoint:subscription.endpoint});await subscription.unsubscribe();}
    setMessage('Notificaciones desactivadas en este dispositivo');
   }else{
    if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode(settings.publicKey) as BufferSource});
    await api('POST',{action:'subscribe',subscription:subscription.toJSON()});
    setMessage('Dispositivo registrado para recibir avisos de tu turno');
   }
   await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 async function testPush(){
  setBusy(true);setMessage('');
  try{
   if(!settings?.canTest)throw Error('Esta prueba requiere permisos de superadministrador');
   const registration=await navigator.serviceWorker.getRegistration('/notificaciones/');
   const subscription=await registration?.pushManager.getSubscription();
   if(!subscription||!settings.subscriptions.some(s=>s.endpoint===subscription.endpoint))
    throw Error('Activa antes las notificaciones en este dispositivo con tu cuenta de superadministrador');
   await api('POST',{action:'test',endpoint:subscription.endpoint});
   setMessage('El servicio Push ha aceptado el aviso de prueba. Comprueba si aparece en el sistema; la aceptación no garantiza su visualización.');
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 return <main style={{maxWidth:750,margin:'2.5rem auto',padding:'0 1rem',fontFamily:'system-ui'}}>
  <a href="/">← Volver a vacaciones</a>
  <h1>Notificaciones de vacaciones</h1>
  <p>Recibe un aviso cuando llegue tu turno de elección, aunque no tengas abierta la aplicación. Requiere iniciar sesión con la cuenta vinculada a tu controlador y autorizar notificaciones en cada dispositivo.</p>
  <p>Permiso del navegador: <strong>{permission}</strong>. En este dispositivo: <strong>{enabled?'Activadas':'Desactivadas'}</strong>.</p>
  <button disabled={busy||!settings?.publicKey} onClick={toggle} style={{padding:12}}>{busy?'Procesando…':enabled?'Desactivar en este dispositivo':'Activar notificaciones en este dispositivo'}</button>
  {!settings?.publicKey&&<p>Notificaciones remotas pendientes de configuración VAPID por parte del administrador.</p>}
  {settings?.canTest&&<section aria-label="Prueba Push de superadministrador"><h2>Prueba de notificación Push</h2><p>Envía un aviso Push real únicamente a este dispositivo, registrado con tu cuenta de superadministrador. No modifica turnos, preferencias ni campañas y no utiliza simulaciones.</p><button type="button" disabled={busy||!enabled||!settings.publicKey} onClick={testPush} style={{padding:12}}>Enviar Push de prueba a este dispositivo</button>{!enabled&&<p><small>Activa primero las notificaciones en este dispositivo para habilitar la prueba.</small></p>}</section>}
  {message&&<p role="status">{message}</p>}
  <h2>Últimos avisos de turno</h2>
  {!settings?.notifications.length?<p>No hay avisos registrados.</p>:<ul>{settings.notifications.map(n=><li key={n.id}>Ronda {n.round} · {new Date(n.created_at).toLocaleString('es-ES')} · <a href={'/?equipo='+encodeURIComponent(n.team_id)+'&year='+encodeURIComponent(String(n.year))}>Abrir elección</a></li>)}</ul>}
  <p><small>El sonido depende de los ajustes del navegador y del sistema operativo. En Windows, comprueba las notificaciones y sonidos de Chrome, el volumen y «No molestar». La web no puede forzar un sonido de alerta.</small></p>
 </main>;
}
