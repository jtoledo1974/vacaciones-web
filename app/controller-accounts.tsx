'use client';
import {useState} from 'react';
export default function ControllerAccounts({data,busy,save}:any){
 const [memberId,setMemberId]=useState(data.members[0]?.id??'');
 const account=data.election.accounts.find((a:any)=>a.member_id===memberId);
 const initialProvider=account?.principal_key?.startsWith('firebase:')?'firebase':'chatgpt';
 const [provider,setProvider]=useState(initialProvider);
 return <section className="panel"><h2>Acceso personal de controladores</h2>
  <p>Una cuenta vinculada puede guardar sus preferencias y elegir en su turno. El identificador Firebase es el UID del proyecto de autenticación compartido, no el correo electrónico.</p>
  <form className="entry-form" onSubmit={e=>{
   e.preventDefault();const form=new FormData(e.currentTarget);
   save({action:'link_account',memberId,provider,subject:String(form.get('subject')??''),accountVersion:account?.version??0});
  }}>
   <label>Controlador<select aria-label="Vincular controlador" value={memberId} onChange={e=>{
    setMemberId(e.target.value);const next=data.election.accounts.find((a:any)=>a.member_id===e.target.value);
    setProvider(next?.principal_key?.startsWith('firebase:')?'firebase':'chatgpt');
   }}>{data.members.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>
   <label>Proveedor<select aria-label="Proveedor de cuenta de controlador" value={provider} onChange={e=>setProvider(e.target.value)}><option value="chatgpt">ChatGPT Sites</option><option value="firebase">Firebase Authentication</option></select></label>
   <label>UID / identificador<input key={memberId+'-'+account?.version} name="subject" defaultValue={account?.principal_key?.replace(/^(chatgpt|firebase):/,'')??''} maxLength={250} placeholder="Identificador que ve el usuario al iniciar sesión"/></label>
   <button className="primary" disabled={busy||!memberId||data.campaign.status!=='open'}>Guardar vinculación</button>
  </form>
  <p className="muted">Vacía el identificador para desvincular. Ni el email ni el nombre se utilizan para asociar una identidad automáticamente.</p>
 </section>;
}
