'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {formatDate} from './cycle-calendar';
import {visiblePreferenceDates} from '../domain/election';

// One editor moves into a modal on small screens; its draft belongs to the workspace.
export default function PreferencesEditor({data,memberId,dates,setDates,persistent,setPersistent,dirty,busy,save,cancel,message,readOnly=false}:any){
 const [mobile,setMobile]=useState(false),[expanded,setExpanded]=useState(false);
 const panel=useRef<HTMLElement>(null),review=useRef<HTMLButtonElement>(null);
 const member=data.members.find((m:any)=>m.id===memberId);
 const existing=data.election.preferences.find((p:any)=>p.member_id===memberId);
 const unavailableDates=new Set(dates.filter((date:string)=>!visiblePreferenceDates([date],data.result.cycles).length));
 useEffect(()=>{
  const query=window.matchMedia('(max-width: 900px)');
  const update=()=>{setMobile(query.matches);setExpanded(false);};
  update();query.addEventListener('change',update);
  return ()=>query.removeEventListener('change',update);
 },[]);
 useEffect(()=>{
  if(!mobile||!expanded)return;
  const app=document.querySelector<HTMLElement>('.app'),overflow=document.body.style.overflow;
  if(app)app.inert=true;
  document.body.style.overflow='hidden';
  panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  return ()=>{if(app)app.inert=false;document.body.style.overflow=overflow;review.current?.focus();};
 },[mobile,expanded]);
 useEffect(()=>{
  if(mobile)return;
  const fit=()=>{
   const element=panel.current;if(!element)return;
   const top=Math.max(16,element.getBoundingClientRect().top);
   element.style.maxHeight=Math.max(220,window.innerHeight-top-16)+'px';
  };
  fit();window.addEventListener('scroll',fit,{passive:true});window.addEventListener('resize',fit);
  return ()=>{window.removeEventListener('scroll',fit);window.removeEventListener('resize',fit);panel.current?.style.removeProperty('max-height');};
 },[mobile,message,data.campaign.version]);
 const status=dirty?'Cambios sin guardar':existing?'Preferencias guardadas':'Sin preferencias guardadas';
 function swap(index:number,direction:-1|1){
  const other=dates[index+direction];if(!other)return;
  const next=[...dates],first=next.indexOf(dates[index]),second=next.indexOf(other);
  [next[first],next[second]]=[next[second],next[first]];setDates(next);
 }
 const editor=<section ref={panel} className={'panel preferences-panel'+(mobile?' preference-sheet':'')} role={mobile?'dialog':undefined} aria-modal={mobile?true:undefined} aria-labelledby="preferences-title" onKeyDown={event=>{
  if(!mobile)return;
  if(event.key==='Escape'){event.preventDefault();setExpanded(false);}
  if(event.key==='Tab'){
   const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
   const first=controls[0],last=controls[controls.length-1];
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}>
  <header className="preference-editor-head"><div><span className="eyebrow">TU LISTA ORDENADA</span><h2 id="preferences-title">Preferencias de {member?.code}</h2></div>{mobile&&<button type="button" className="secondary" onClick={()=>setExpanded(false)} aria-label="Cerrar revisión de preferencias">Cerrar</button>}</header>
  <div className="preference-editor-body">
   <p className={'preference-state '+(dirty?'pending':'saved')}>{status}</p>
   {readOnly&&<p className="muted">Puedes añadir, quitar y reordenar ciclos para probar la interfaz. La campaña real no se modificará.</p>}
   <p>La posición 1 es tu primera opción. Se probarán en este orden al llegar tu turno.</p>
   {!dates.length&&<div className="preference-empty"><strong>Empieza por tu ciclo favorito</strong><p>Añade alternativas desde el calendario. Después revisa el orden y guarda tu lista.</p></div>}
   {existing?.active===false&&dates.length>0&&<p className="muted">Esta lista ya se utilizó. Vuelve a guardarla para autorizar su uso en tu próximo turno.</p>}
   {!!dates.length&&<ol className="preference-list" aria-label="Preferencias en orden de prioridad">{dates.map((date:string,i:number)=>{
    const cycle=data.result.cycles.find((c:any)=>c.date===date),position=dates.indexOf(date)+1;
    return <li key={date} value={position}><div className="preference-date"><strong>{formatDate(date)} – {formatDate(cycle?.end??date)}</strong><small>{cycle?.score} puntos{position===1?' · Primera opción':''}{unavailableDates.has(date)?' · Sin cupo actualmente':''}</small></div><div className="preference-row-actions"><button type="button" className="secondary" aria-label={`Subir preferencia ${position}`} disabled={i===0||busy} onClick={()=>swap(i,-1)}>↑</button><button type="button" className="secondary" aria-label={`Bajar preferencia ${position}`} disabled={i===dates.length-1||busy} onClick={()=>swap(i,1)}>↓</button><button type="button" className="secondary" aria-label={`Quitar preferencia ${position}`} disabled={busy} onClick={()=>setDates(dates.filter((d:string)=>d!==date))}>Quitar</button></div></li>;
   })}</ol>}
   {unavailableDates.size>0&&<p className="preference-hidden">{unavailableDates.size} ciclo(s) sin cupo actualmente. Permanecen visibles y en su posición; puedes quitarlos o reordenarlos. Se volverán a considerar si se libera una plaza.</p>}
   <label className="preference-consent"><input type="checkbox" disabled={busy} checked={persistent} onChange={e=>setPersistent(e.target.checked)}/> Mantener estas preferencias en todas las rondas restantes</label>
   <p className="muted">Sin marcar: solo el próximo turno efectivo, incluso si aplazas. {data.election.state?.automaticPaused?'Los automatismos están detenidos. Guardar conserva la lista sin adjudicar; el responsable debe reanudarlos.':'Guardar autoriza la asignación automática; si ya es tu turno, puede ser inmediata.'}</p>
  </div>
  <footer className="preference-editor-footer"><span className={'preference-state '+(dirty?'pending':'saved')}>{status}</span><div className="preference-feedback" role="status" aria-live="polite" aria-atomic="true">{message}</div><div className="preference-footer-actions"><button type="button" className="secondary" disabled={busy} onClick={cancel}>Cancelar</button><button type="button" className="primary" disabled={busy||readOnly||(!dirty&&existing?.active!==false)} onClick={save}>{readOnly?'Guardado desactivado':busy?'Guardando…':'Guardar preferencias'}</button></div></footer>
 </section>;
 return <>
  {mobile?<>
   <div className="preference-dock"><div className="preference-dock-status"><strong>{dates.length} {dates.length===1?'preferencia':'preferencias'}</strong><span className={dirty?'pending':'saved'}>{status}</span></div><div className="preference-dock-actions"><button type="button" className="secondary" disabled={busy} onClick={cancel}>Cancelar</button><button ref={review} type="button" className="primary" aria-haspopup="dialog" aria-expanded={expanded} onClick={()=>setExpanded(true)}>Revisar y guardar</button></div>{!expanded&&message&&<div className="preference-feedback" role="status" aria-live="polite" aria-atomic="true">{message}</div>}</div>
   {expanded&&createPortal(<div className="preference-sheet-backdrop" onClick={e=>{if(e.target===e.currentTarget)setExpanded(false);}}>{editor}</div>,document.body)}
  </>:editor}
 </>;
}
