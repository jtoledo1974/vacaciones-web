/** Resolve once the registration has an active worker. pushManager.subscribe()
 * rejects without one, and navigator.serviceWorker.ready never resolves here
 * because /notificaciones is outside the /notificaciones/ scope. */
export function activeRegistration(registration:ServiceWorkerRegistration):Promise<ServiceWorkerRegistration>{
 if(registration.active)return Promise.resolve(registration);
 const worker=registration.installing??registration.waiting;
 if(!worker)return Promise.reject(Error('No se ha podido preparar el servicio de avisos en este dispositivo.'));
 return new Promise((resolve,reject)=>{
  const onChange=()=>{
   if(worker.state==='activated'){worker.removeEventListener('statechange',onChange);resolve(registration);}
   else if(worker.state==='redundant'){worker.removeEventListener('statechange',onChange);reject(Error('No se ha podido preparar el servicio de avisos en este dispositivo.'));}
  };
  worker.addEventListener('statechange',onChange);
 });
}
