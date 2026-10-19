'use client';
import {useState,type FormEvent} from 'react';
import {firebaseSignOut,firebaseUser} from './firebase-client';

export default function LocalAdminLogin({enabled,loggedIn}:{enabled:boolean;loggedIn:boolean}){
 const [username,setUsername]=useState('');
 const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 if(!enabled&&!loggedIn)return null;

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();setError('');setBusy(true);
  try{
   // Firebase bearer tokens have priority over the local session.
   if(firebaseUser())await firebaseSignOut();
   const response=await fetch('/api/local-admin/login',{
    method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username,password})
   });
   const result=await response.json() as {error?:string};
   if(!response.ok)throw new Error(result.error??'No se pudo iniciar sesión');
   setPassword('');
   window.location.reload();
  }catch(e){setPassword('');setError(e instanceof Error?e.message:'No se pudo iniciar sesión');}
  finally{setBusy(false);}
 }
 async function logout(){
  setError('');setBusy(true);
  try{
   const response=await fetch('/api/local-admin/logout',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'
   });
   if(!response.ok)throw new Error('No se pudo cerrar la sesión');
   window.location.reload();
  }catch(e){setError(e instanceof Error?e.message:'Error de sesión');setBusy(false);}
 }
 return <div className="local-admin-login">
  {loggedIn
   ?<button type="button" className="firebase-login" disabled={busy} onClick={logout}>Cerrar sesión de administrador local</button>
   :<details>
      <summary>Acceso administrador con contraseña</summary>
      <form onSubmit={submit}>
       <label>Usuario<input name="username" autoComplete="username" maxLength={100} required value={username} onChange={e=>setUsername(e.target.value)}/></label>
       <label>Contraseña<input name="password" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
       <button type="submit" className="firebase-login" disabled={busy}>{busy?'Accediendo…':'Entrar como administrador'}</button>
      </form>
     </details>}
  {error&&<p role="alert" className="local-admin-error">{error}</p>}
 </div>;
}
