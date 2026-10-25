import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeRegistration} from '../app/notificaciones/service-worker.ts';

type Listener=()=>void;
function worker(state:string){
 const listeners:Listener[]=[];
 return {state,addEventListener:(_:string,l:Listener)=>listeners.push(l),removeEventListener:()=>{},fire(next:string){this.state=next;listeners.forEach(l=>l());}};
}

test('una instalación nueva espera a que el service worker esté activo antes de suscribir',async()=>{
 const installing=worker('installing');
 const registration:any={active:null,installing,waiting:null};
 let done=false;
 const ready=activeRegistration(registration).then(r=>{done=true;return r;});
 await Promise.resolve();
 assert.equal(done,false);
 installing.fire('installed');
 await Promise.resolve();
 assert.equal(done,false);
 registration.active=installing;
 installing.fire('activated');
 assert.equal(await ready,registration);
});

test('si ya hay un service worker activo no espera',async()=>{
 const registration:any={active:worker('activated'),installing:null,waiting:null};
 assert.equal(await activeRegistration(registration),registration);
});

test('un service worker descartado es un error explícito',async()=>{
 const installing=worker('installing');
 const ready=activeRegistration({active:null,installing,waiting:null} as any);
 installing.fire('redundant');
 await assert.rejects(ready,/No se ha podido preparar/);
});

test('la aplicación instalada abre la elección, no la página de avisos',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
 assert.equal(manifest.start_url,'/');
 for(const icon of manifest.icons)assert.notEqual(icon.purpose,'any maskable');
});
