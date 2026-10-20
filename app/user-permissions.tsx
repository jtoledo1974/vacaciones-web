'use client';
import {useState} from 'react';
import {useConfirmation} from './confirmation';
export default function UserForm({admin,busy,save}:any){
 const confirm=useConfirmation();
 const [selected,setSelected]=useState<any>(null),[subject,setSubject]=useState(''),[provider,setProvider]=useState('chatgpt');
 const [role,setRole]=useState('team_admin'),[teams,setTeams]=useState<string[]>([]),[expires,setExpires]=useState('');
 const reset=()=>{setSelected(null);setSubject('');setProvider('chatgpt');setRole('team_admin');setTeams([]);setExpires('');};
 const edit=(u:any)=>{const grants=admin.grants.filter((g:any)=>g.user_id===u.id);setSelected(u);setProvider(u.provider);setSubject(u.subject.replace(/^email:/,''));setRole(u.role);setTeams(grants.map((g:any)=>g.team_id));setExpires(grants[0]?.expires_at?.slice(0,10)??'');};
 return <>
 <div className="table-wrap"><table><caption>Usuarios con permisos</caption><thead><tr><th>Cuenta</th><th>Rol</th><th>Equipos y caducidad</th><th>Acciones</th></tr></thead><tbody>{admin?.users.map((u:any)=><tr key={u.id}>
 <td>{u.subject.replace(/^email:/,'')}<br/><small>{u.provider}</small></td><td>{u.role==='team_admin'?'Responsable de equipo':'Solo lectura'}</td><td>{admin.grants.filter((g:any)=>g.user_id===u.id).map((g:any)=>g.team_id+(g.expires_at?' · hasta '+g.expires_at.slice(0,10):'')).join(', ')||'Sin equipos'}</td>
 <td><button className="secondary" disabled={busy} onClick={()=>edit(u)} aria-label={'Editar '+u.subject}>Editar</button> <button className="secondary" disabled={busy} aria-label={'Eliminar '+u.subject} onClick={async()=>{if(await confirm('Eliminar los permisos de '+u.subject+' en todos sus equipos. Su plantilla y vacaciones se conservan.')){if((await save({action:'delete',id:u.id,version:u.version}))?.ok)reset();}}}>Eliminar permisos</button></td></tr>)}</tbody></table></div>
 <form onSubmit={async e=>{e.preventDefault();const normalized=provider==='chatgpt'?'email:'+subject.trim().toLowerCase():subject.trim();const existing=selected??admin?.users.find((u:any)=>u.provider===provider&&u.subject===normalized);if((await save({id:existing?.id,provider,subject,role,teams:role==='team_admin'?teams:[],version:existing?.version??0,expiresAt:expires?new Date(expires).toISOString():null}))?.ok)reset();}}>
 <h3>{selected?'Editar permisos':'Asignar permisos'}</h3><div className="entry-form">
 <label>Proveedor<select aria-label="Proveedor de identidad" value={provider} disabled={!!selected||busy} onChange={e=>setProvider(e.target.value)}><option value="chatgpt">ChatGPT Sites</option><option value="firebase">Firebase Auth</option></select></label>
 <label>{provider==='chatgpt'?'Correo electrónico de ChatGPT':'UID de Firebase'}<input required type={provider==='chatgpt'?'email':'text'} value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy}/></label>
 <label>Rol<select value={role} disabled={busy} onChange={e=>setRole(e.target.value)}><option value="team_admin">Responsable de equipo</option><option value="viewer">Solo lectura</option></select></label>
 <label>Caducidad opcional<input type="date" value={expires} disabled={busy} onChange={e=>setExpires(e.target.value)}/></label>
 <button className="primary" disabled={busy||(role==='team_admin'&&!teams.length)}>Guardar permisos</button>{selected&&<button type="button" className="secondary" disabled={busy} onClick={reset}>Cancelar edición</button>}</div>
 <div className="team-checkboxes">{'ABCDEFGH'.split('').map(t=><label key={t}><input type="checkbox" disabled={busy||role!=='team_admin'} checked={teams.includes(t)} onChange={e=>setTeams(e.target.checked?[...teams,t]:teams.filter(x=>x!==t))}/>Equipo {t}</label>)}</div>
 <p className="muted">Selecciona al menos un equipo para un responsable. Solo lectura revoca la administración de todos los equipos. Revisa el correo antes de guardar.</p>
 </form></>;
}
