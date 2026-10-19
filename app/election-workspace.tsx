'use client';
import {useEffect,useRef,useState} from 'react';
import CycleCalendar,{formatDate} from './cycle-calendar';
import {useConfirmation} from './confirmation';
import {newcomerScore} from '../domain/historical-order';
import {orderForRound} from '../domain/election';
import PreferencesEditor from './preferences-editor';

function NewcomerCalculator(){
 const [completed,setCompleted]=useState(''),[roundAverages,setRoundAverages]=useState(''),[message,setMessage]=useState('');
 const calculateScore=()=>{
  try{
   const values=(raw:string)=>raw.trim()?raw.split(/[;,\n]/).map(s=>Number(s.trim())):[];
   const points=values(completed),means=values(roundAverages);
   if(points.length>6||means.length!==6||[...points,...means].some(n=>!Number.isFinite(n)))throw new Error('Introduce de 0 a 6 ciclos disfrutados y seis medias del equipo por ronda');
   const source=newcomerScore(points.map((points,idx)=>({round:idx+1,points})),means.map(n=>[n]));
   setMessage('Puntuación según criterios 1.1: '+source.score.toLocaleString('es-ES')+' puntos. Confirmar datos originales antes de situarlo en el orden.');
  }catch(e:any){setMessage(e.message);}
 };
 return <details className="panel"><summary>Calculadora para nuevas incorporaciones</summary>
 <p>Normas, página 3. Introduce los puntos de los ciclos completos disfrutados por el nuevo CTA y la media de puntos de cada una de las seis rondas del equipo. Calcula la puntuación para introducirlo en el orden; no altera automáticamente la clasificación.</p>
 <label>Puntos de ciclos disfrutados (entre 0 y 6, separados por comas)<textarea aria-label="Ciclos disfrutados por nuevo CTA" rows={2} placeholder="40, 56, 80, 32" value={completed} onChange={e=>setCompleted(e.target.value)}/></label>
 <label>Media de puntos del equipo, rondas 1 a 6<textarea aria-label="Medias por ronda del equipo" rows={2} placeholder="40, 50, 60, 65, 38, 35" value={roundAverages} onChange={e=>setRoundAverages(e.target.value)}/></label>
 <button type="button" className="secondary" onClick={calculateScore}>Calcular puntuación del nuevo CTA</button>
 {message&&<p role="status">{message}</p>}
 </details>;
}
function OrderSetup({data,busy,act}:any){
 const scores=data.config?.previousScores;
 const initial=scores?[...data.members].sort((a:any,b:any)=>(scores[a.code]??Infinity)-(scores[b.code]??Infinity)):[];
 const initialGroups=new Map<number,string[]>();for(const m of initial){if(Number.isFinite(scores[m.code]))initialGroups.set(scores[m.code],[...(initialGroups.get(scores[m.code])??[]),m.code]);}
 const [order,setOrder]=useState(initial.map((m:any)=>m.code).join('\n')),[ties,setTies]=useState([...initialGroups.values()].filter(g=>g.length>1).map(g=>g.join(', ')).join('\n')),[joints,setJoints]=useState(''),[source,setSource]=useState(data.config?.previousScoresSource??''),[confirmed,setConfirmed]=useState(false),[deferral,setDeferral]=useState(true),[error,setError]=useState('');
 const parseGroups=(raw:string)=>raw.split(/\n/).map(line=>line.split(/[,;]/).map(code=>code.trim().toUpperCase()).filter(Boolean)).filter(group=>group.length>0);
 const save=(e:any)=>{
  e.preventDefault();
  const codes=order.split(/[\n,;]/).map(code=>code.trim().toUpperCase()).filter(Boolean);
  const lookup=(code:string)=>data.members.find((m:any)=>m.code===code)?.id;
  const ids=codes.map(lookup),tieGroups=parseGroups(ties).map(g=>g.map(lookup)),jointGroups=parseGroups(joints).map(g=>g.map(lookup));
  if(ids.some(id=>!id)||[...tieGroups,...jointGroups].some(g=>g.some(id=>!id))){setError('Hay identificadores que no pertenecen al equipo');return;}
  setError('');
  act({action:'start',order:ids,tieGroups,jointGroups,source,rulesConfirmed:confirmed,allowDeferral:deferral},'Orden confirmado y elección activada');
 };
 return <details className="panel"><summary>Preparar el orden de elección</summary><p>Conforme a Criterios Vacaciones 1.1 (2025): orden de menor a mayor puntuación anterior, resolución del sorteo antes del primer turno de cada grupo empatado y rotación de estos en cada ronda. Los turnos conjuntos se realizan cuando llega el último integrante del grupo.</p>
 {scores&&<p>Orden preparado a partir de las puntuaciones anteriores guardadas. Los empates se resolverán cuando llegue su primer turno.</p>}
 <form onSubmit={save}>
 {error&&<p role="alert">{error}</p>}
 <label>Identificadores por puntuación anterior (uno por línea; orden provisional dentro de los empates)<textarea required aria-label="Orden confirmado" value={order} onChange={e=>setOrder(e.target.value)} rows={6}/></label>
 <label>Grupos empatados pendientes de sorteo (un grupo consecutivo por línea)<textarea aria-label="Grupos empatados" value={ties} onChange={e=>setTies(e.target.value)} rows={3} placeholder="AA, BB, CC"/></label>
 <label>Turnos conjuntos acordados (opcional; dos o tres CTA por línea)<textarea aria-label="Turnos conjuntos" value={joints} onChange={e=>setJoints(e.target.value)} rows={3} placeholder="DD, EE"/></label>
 <NewcomerCalculator/><label>Origen del orden y sorteo<input required minLength={10} maxLength={500} value={source} onChange={e=>setSource(e.target.value)} placeholder="Ejercicio anterior, puntuaciones y acta del sorteo"/></label>
 <div className="team-checkboxes">
 <label><input type="checkbox" checked={deferral} onChange={e=>setDeferral(e.target.checked)}/> Permitir uno o dos aplazamientos (dos o tres ciclos en el siguiente turno)</label>
 <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Confirmo la aplicación de Criterios Vacaciones 1.1 (2025)</label>
 </div><button className="primary" disabled={busy||!confirmed}>Activar elección</button></form></details>;
}
function TieResolver({group,data,busy,act,manage,open}:any){
 const confirm=useConfirmation(),[order,setOrder]=useState<string[]>([]);
 const code=(id:string)=>data.members.find((m:any)=>m.id===id)?.code??id;
 return <section className="panel" aria-label="Resolver empate"><h2>Empate pendiente de sorteo</h2>
 <p>{group.map(code).join(', ')}. La elección y los automatismos esperan hasta que se guarde el orden del sorteo. En las siguientes rondas se rotará este orden.</p>
 {manage&&open?<><button className="primary" disabled={busy} onClick={async()=>{if(await confirm('¿Sortear y guardar el orden de este grupo? El resultado quedará registrado y no se podrá repetir.'))act({action:'resolve_tie',method:'random'},'Sorteo guardado');}}>Sortear y guardar orden</button>
 <h3>Registrar un sorteo realizado fuera de la app</h3><p>Pulsa los nombres en el orden obtenido: primero quien elige antes, después el siguiente, hasta completar el grupo.</p>
 <div className="button-row">{group.map((id:string)=><button type="button" className="secondary" key={id} aria-label={'Añadir al sorteo '+code(id)} disabled={busy||order.includes(id)} onClick={()=>setOrder([...order,id])}>{code(id)}</button>)}</div>
 <ol aria-label="Orden del sorteo externo">{order.map(id=><li key={id}>{code(id)}</li>)}</ol>
 <div className="button-row"><button className="secondary" disabled={busy||!order.length} onClick={()=>setOrder(order.slice(0,-1))}>Quitar último</button><button className="primary" disabled={busy||order.length!==group.length} onClick={async()=>{if(await confirm('¿Guardar este orden del sorteo externo: '+order.map(code).join(' → ')+'?'))act({action:'resolve_tie',method:'external',order},'Orden del sorteo externo guardado');}}>Guardar orden externo</button></div></>:<p>El responsable del equipo debe registrar el resultado antes de continuar.</p>}
 </section>;
}
export default function ElectionWorkspace({data,busy,act,legacy,identity,superuser,signinUrl,navigationGuard,onPreferenceEdit}:any){
 const confirm=useConfirmation();
 const election=data.election,turn=election.turn,state=election.state,manage=election.canManage,mine=election.myMemberId,open=data.campaign.status==='open',current=data.members.find((m:any)=>m.id===turn?.memberId);
  const preferenceMemberIds:string[]=election.preferenceMemberIds??[];
  const preferenceMembers=data.members.filter((m:any)=>preferenceMemberIds.includes(m.id));
 const [mode,setMode]=useState<'choose'|'preferences'>('choose'),[memberId,setMemberId]=useState(mine&&preferenceMemberIds.includes(mine)?mine:preferenceMembers[0]?.id??''),[selected,setSelected]=useState<string[]>([]),[jointSelected,setJointSelected]=useState<Record<string,string[]>>({}),[jointTarget,setJointTarget]=useState(''),[detail,setDetail]=useState<any>(null),[dates,setDates]=useState<string[]>([]),[message,setMessage]=useState(''),[pairOptions,setPairOptions]=useState<string[]|null>(null),[loadingOptions,setLoadingOptions]=useState(false),[filterMember,setFilterMember]=useState(mine??'');
 useEffect(()=>{setSelected([]);setJointSelected({});setJointTarget('');setDetail(null);setMessage('');},[turn?.memberId,turn?.round,turn?.needed,state?.status]);
 useEffect(()=>{if(!preferenceMemberIds.includes(memberId))setMemberId(mine&&preferenceMemberIds.includes(mine)?mine:preferenceMembers[0]?.id??'');},[memberId,mine,preferenceMemberIds.join('|')]);
 useEffect(()=>{setDetail((current:any)=>current?data.result.cycles.find((c:any)=>c.date===current.date)??null:null);},[data.campaign.version]);
 const existing=election.preferences.find((p:any)=>p.member_id===memberId);
 const serverPreferences=JSON.stringify({dates:existing?.dates??[],persistent:existing?.persistent??false});
 const [persistent,setPersistent]=useState(false),[preferenceMessage,setPreferenceMessage]=useState('');
 const lastSavedPreferences=useRef({memberId:'',value:serverPreferences});
 const draftValue=JSON.stringify({dates,persistent});
 const dirty=draftValue!==serverPreferences;
 useEffect(()=>{
  const previous=lastSavedPreferences.current;
  if(previous.memberId!==memberId||draftValue===previous.value){
   const incoming=JSON.parse(serverPreferences);setDates(incoming.dates);setPersistent(incoming.persistent);
  }
  lastSavedPreferences.current={memberId,value:serverPreferences};
 },[memberId,serverPreferences]);
 useEffect(()=>{
  if(!dirty)return;
  const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',warn);
  return ()=>window.removeEventListener('beforeunload',warn);
 },[dirty]);
 async function leavePreferences(){
  if(busy)return false;
  if(!dirty)return true;
  if(!await confirm('Tienes cambios de preferencias sin guardar. Si continúas, se descartarán. Cancela para volver a revisar y guardar tu lista. ¿Descartar los cambios y continuar?'))return false;
  const saved=JSON.parse(serverPreferences);setDates(saved.dates);setPersistent(saved.persistent);setPreferenceMessage('');
  return true;
 }
 useEffect(()=>{if(navigationGuard)navigationGuard.current=leavePreferences;return ()=>{if(navigationGuard)navigationGuard.current=null;};});
 function editDates(next:string[]){setDates(next);setPreferenceMessage('Lista modificada. Cambios sin guardar.');onPreferenceEdit?.();}
 function editPersistence(next:boolean){setPersistent(next);setPreferenceMessage('Uso de la lista modificado. Cambios sin guardar.');onPreferenceEdit?.();}
 async function savePreferences(){
  if(state?.status==='active'&&!state.automaticPaused&&turn?.memberId===memberId&&turn.participants?.length===1&&dates.length>0){
   const quantity=turn.needed===1?'un ciclo':turn.needed+' ciclos';
   const code=data.members.find((m:any)=>m.id===memberId)?.code;
   if(!await confirm('Es el turno de '+code+'. Al guardar estas preferencias, el sistema intentará adjudicar inmediatamente '+quantity+' según el orden de la lista y los cupos disponibles. Si hay opciones válidas suficientes, la adjudicación se registrará automáticamente y se avanzará al siguiente turno, sin otra confirmación. ¿Guardar y continuar?'))return;
  }
  const result=await act({action:'preferences',memberId,dates,persistent},'Preferencias guardadas');
  setPreferenceMessage(result?.campaign?'Preferencias guardadas. Tu lista está confirmada.':'No se ha confirmado el guardado. Revisa el error y vuelve a intentarlo.');
 }
 useEffect(()=>{
  setPairOptions(null);if(turn?.participants?.length!==1||turn?.needed<2||!selected.length||selected.length>=turn.needed)return;
  let active=true;setLoadingOptions(true);
  const query=new URLSearchParams();selected.forEach(date=>query.append('selected',date));
  fetch('/api/election/'+data.campaign.id+'/options?'+query,{cache:'no-store'}).then(async response=>{const body:any=await response.json();if(!response.ok)throw new Error(body.error);if(active)setPairOptions(body.available);}).catch(e=>{if(active){setPairOptions([]);setMessage(e.message);}}).finally(()=>{if(active)setLoadingOptions(false);});
  return ()=>{active=false;setLoadingOptions(false);};
 },[selected.join(','),turn?.needed,data.campaign.version]);
 const canChoose=open&&state?.status==='active'&&!!turn?.memberId&&(manage||(turn?.participants?.length===1&&mine===turn?.memberId)),canPreferences=open&&preferenceMemberIds.length>0;
 const roundOrder=state?orderForRound(state,Math.max(0,(turn?.round??1)-1)):data.members.map((m:any)=>m.id);
 function clickCycle(c:any){if(mode==='choose')setDetail(c);setMessage('');
 if(mode==='choose'&&canChoose&&turn?.participants?.length>1){
  const target=jointTarget||turn.participants[0],previous=jointSelected[target]??[],max=turn.requiredByMember[target]??1;
  setJointSelected({...jointSelected,[target]:previous.includes(c.date)?previous.filter(d=>d!==c.date):previous.length>=max?[c.date]:[...previous,c.date]});return;
 }
 if(mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)){if(c.occupied>=c.max){setPreferenceMessage('Este ciclo no tiene plazas disponibles y no puede añadirse como nueva preferencia.');return;}if(!dates.includes(c.date)){editDates([...dates,c.date]);setPreferenceMessage('Añadido a tus preferencias · posición '+(dates.length+1)+'. Sin guardar.');}else setPreferenceMessage('Ya está en tu lista · posición '+(dates.indexOf(c.date)+1)+(dirty?'. Sin guardar.':'. Guardada.'));return;}if(canChoose){if(loadingOptions){setMessage("Comprobando qué segundo ciclo es compatible…");return;}if(!(pairOptions??election.available).includes(c.date)&&!selected.includes(c.date)){setMessage('Este ciclo no es válido para quien elige ahora: ya está elegido, no hay cupo o se excede un límite.');return;}if(selected.includes(c.date))setSelected(selected.filter(d=>d!==c.date));else setSelected(turn.needed===1||selected.length>=turn.needed?[c.date]:[...selected,c.date]);}}
 return <>
  <section className="panel election-turn election-workflow-head" aria-label="Turno de elección">
   <div className="election-turn-status">
    <span className="eyebrow">{state?.status==='active'?`RONDA ${turn?.round} · EN CURSO`:state?.status==='complete'?'ELECCIÓN COMPLETADA':state?.status==='paused'?'ELECCIÓN EN PAUSA':'ELECCIÓN SIN INICIAR'}</span>
    <h2>{turn?.pendingTie?'Empate pendiente antes del siguiente turno':state?.status==='active'&&current?`${turn?.participants?.length>1?turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code).join(" + "):current.code} elige ahora`:!state?'Elección sin iniciar':'Consulta de ciclos'}</h2>
    {state?.status==='active'&&current&&!turn?.pendingTie&&<span className="muted">{turn.needed} ciclo(s) por elegir</span>}
   </div>
   <div className="election-turn-controls">
    {canPreferences&&<><button className={mode==='choose'?'primary':'secondary'} aria-pressed={mode==='choose'} onClick={async()=>{if(mode==='choose'||await leavePreferences()){setMode('choose');setDetail(null);}}}>Elegir / consultar</button><button className={mode==='preferences'?'primary':'secondary'} aria-pressed={mode==='preferences'} onClick={()=>{setMode('preferences');setDetail(null);onPreferenceEdit?.();}}>Preparar preferencias</button></>}
    {((mode==='choose'&&canChoose&&state?.allowDeferral&&turn?.participants?.length===1&&turn.canDefer)||(superuser&&state&&state.status!=='complete'))&&<details className="election-more-actions"><summary>Más acciones</summary><div className="election-more-menu">
     {mode==='choose'&&canChoose&&state?.allowDeferral&&turn?.participants?.length===1&&turn.canDefer&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{if(await confirm(`¿Aplazar el turno de ${current.code}? No podrá elegir hasta la próxima ronda.`))act({action:'defer',memberId:current.id},'Turno aplazado');}}>{state.credits[current.id]===1?'Aplazar para elegir tres':'Aplazar para elegir dos'}</button>}
     {superuser&&state&&state.status!=='complete'&&<button type="button" className="secondary" disabled={busy||!open} onClick={()=>act({action:state.status==='active'?'pause':'resume'},state.status==='active'?'Elección pausada':'Elección reanudada')}>{state.status==='active'?'Pausar elección':'Reanudar elección'}</button>}
    </div></details>}
   </div>
  </section>
  {mode==='choose'&&superuser&&open&&(!state||state.status==='paused')&&<div id="preparar-eleccion"><OrderSetup key={data.campaign.id+JSON.stringify(data.config?.previousScores)} data={data} busy={busy} act={act}/></div>}
  {turn?.pendingTie&&<TieResolver key={turn.pendingTie.join('|')} group={turn.pendingTie} data={data} busy={busy} act={act} manage={manage} open={open}/> }
  {manage&&state?.status==='active'&&state.automaticPaused&&<div className="alert warning" role="status">Los automatismos están detenidos tras deshacer una elección. Puedes corregir el turno manualmente; no se adjudicará de nuevo por sorpresa. <button type="button" className="secondary" disabled={busy||!open} onClick={async()=>{if(await confirm('¿Reanudar los automatismos? Las preferencias vigentes podrían adjudicar inmediatamente los siguientes turnos.'))act({action:'resume_automatic'},'Automatismos reanudados');}}>Reanudar automatismos</button></div>}
  {election.pendingAutomatic&&canPreferences&&<div className="alert warning">Hay elecciones automáticas pendientes. <button className="secondary" disabled={busy||!open} onClick={()=>act({action:"advance"},"Elecciones automáticas procesadas")}>Continuar automatismos</button></div>}
{mode==='choose'&&<div className="election-filter"><label>Ver vacaciones de<select aria-label="Ver vacaciones de controlador" value={filterMember} onChange={e=>setFilterMember(e.target.value)}><option value="">Todo el equipo</option>{preferenceMembers.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>{filterMember&&<span>{election.points.find((p:any)=>p.member_id===filterMember)?.cycles??0} ciclos · {election.points.find((p:any)=>p.member_id===filterMember)?.points??0} de baremo sin ponderar</span>}<a href="#puntos-equipo">Ver puntos y ciclos del equipo</a></div>}
  {canPreferences&&mode==='preferences'&&manage&&<label className="preference-member">Introducir preferencias para<select aria-label="Preferencias de controlador" value={memberId} disabled={busy} onChange={async e=>{const next=e.target.value;if(await leavePreferences()){setMemberId(next);setPreferenceMessage('');onPreferenceEdit?.();}}}>{preferenceMembers.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>}
  <div className={"election-layout"+(detail?" has-active-detail":"")+(mode==='preferences'&&canPreferences?" is-preparing-preferences":"")}>
   <div className="election-calendar-wrap">
    <CycleCalendar preferenceMode={mode==='preferences'} year={data.campaign.year} cycles={data.result.cycles}
     selected={mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)?dates:turn?.participants?.length>1?Object.values(jointSelected).flat():selected} onSelect={clickCycle}
     busy={busy||loadingOptions} highlighted={data.awards.filter((a:any)=>a.member_id===filterMember).map((a:any)=>a.cycle_date)}
     awards={data.awards} members={data.members} order={roundOrder} points={election.points}/>
   </div>
   <aside className="election-side">
    {mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)&&<PreferencesEditor data={data} memberId={memberId} dates={dates} setDates={editDates} persistent={persistent} setPersistent={editPersistence} dirty={dirty} busy={busy} save={savePreferences} message={!dirty&&/sin guardar/i.test(preferenceMessage)?(existing?'La lista coincide con la versión guardada.':'No hay cambios pendientes ni preferencias guardadas.'):preferenceMessage}/>}

    {mode==='choose'&&detail&&<section className="panel vac2-choice-card" aria-label="Detalle del ciclo seleccionado">
     <div className="election-choice-heading"><span className="eyebrow">CICLO SELECCIONADO</span><button type="button" className="icon-button" aria-label="Cerrar detalle del ciclo" onClick={()=>{setDetail(null);setSelected([]);setJointSelected({});setMessage('');}}>×</button></div>
     <h2>{formatDate(detail.date)} – {formatDate(detail.end)}{detail.period===1?' · Verano':''}</h2>
     <p><strong>{detail.score} puntos</strong> · {detail.occupied}/{detail.max} plazas ocupadas · {Math.max(0,detail.max-detail.occupied)} libres</p>
     <div className="button-row">{data.awards.filter((a:any)=>a.cycle_date===detail.date).map((a:any)=><span className="person-chip" key={a.id}>{data.members.find((m:any)=>m.id===a.member_id)?.code}</span>)}</div>
     {message&&<p role="status" className="alert warning">{message}</p>}
     {mode==='choose'&&canChoose&&<>
      {turn?.participants?.length>1&&<div className="joint-picker"><p>Turno conjunto: selecciona el controlador y sus ciclos.</p>{turn.participants.map((id:string)=><button key={id} className={(jointTarget||turn.participants[0])===id?'primary':'secondary'} onClick={()=>setJointTarget(id)}>{data.members.find((m:any)=>m.id===id)?.code}: {(jointSelected[id]??[]).length}/{turn.requiredByMember[id]}</button>)}</div>}
      <p className="election-selected-summary"><strong>Elección:</strong> {turn?.participants?.length>1?turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code+': '+((jointSelected[id]??[]).map(formatDate).join(' + ')||'pendiente')).join(' | '):selected.length?selected.map(formatDate).join(' + '):'ningún ciclo elegido'}</p>
      <div className="button-row">
       <button type="button" className="primary" disabled={busy||loadingOptions||(turn?.participants?.length>1?turn.participants.some((id:string)=>(jointSelected[id]??[]).length!==turn.requiredByMember[id]):selected.length!==turn.needed)} onClick={()=>{
        if(turn?.participants?.length>1){const entries=turn.participants.map((id:string)=>({member_id:id,dates:jointSelected[id]??[]}));act({action:'choose_joint',entries},'Turno conjunto confirmado');}
        else act({action:'choose',memberId:current.id,dates:selected},'Elección confirmada');
       }}>Confirmar {turn?.participants?.length>1?'turno conjunto':turn.needed===3?'tres ciclos':turn.needed===2?'ambos ciclos':'ciclo'}</button>
       <button type="button" className="secondary" onClick={()=>{setDetail(null);setSelected([]);setJointSelected({});setMessage('');}}>Cancelar selección</button>
      </div>
     </>}
    </section>}
    {manage&&<section className="panel election-history-panel">
     <div className="election-history-head"><h2>Últimas adjudicaciones</h2>
      <div className="election-workflow-actions">
       {(election.undo||data.undo)&&open&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{if(await confirm('¿Deshacer el último cambio de elección, incluyendo cola y ocupación?'))data.undo?legacy({action:'undo_vacations',undoId:data.undo.id},'Cambio deshecho'):act({action:'election_undo',historyId:election.undo},'Cambio de elección deshecho');}}>↶ Deshacer</button>}
       {(election.redo||data.redo)&&open&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{if(await confirm('¿Rehacer el cambio de elección?'))data.redo?legacy({action:'redo_vacations',undoId:data.redo.id},'Cambio rehecho'):act({action:'election_redo',historyId:election.redo},'Cambio de elección rehecho');}}>↷ Rehacer</button>}
      </div>
     </div>
     <p className="muted">Más recientes primero. Las elecciones deshechas desaparecen de esta lista.</p>
     {(election.timeline??[]).length?
      <ol className="election-log">{(election.timeline??[]).slice(0,40).map((a:any,i:number)=>{
       const code=data.members.find((m:any)=>m.id===a.member_id)?.code??'?';
       const cycle=data.result.cycles.find((c:any)=>c.date===a.cycle_date);
       return <li key={a.member_id+'|'+a.cycle_date}><div><b>{i+1}. {code}</b><br/><span>{formatDate(a.cycle_date)} · {cycle?.score??'—'} puntos{a.legacy?' · importado':''}</span></div></li>;
      })}</ol>:<p className="muted">Todavía no hay ciclos adjudicados.</p>}
    </section>}
    <section id="puntos-equipo" className="panel election-order-panel">
     <h2>{state?'Orden de elección':'Controladores del equipo'}</h2>
     {state&&manage&&<p className="muted">{state.source}</p>}
     {(state?.tieResolutions??[]).map((r:any,i:number)=><p key={i} className="muted">Sorteo {r.method==='random'?'en la app':'externo'} · {new Date(r.at).toLocaleString('es-ES')}: {r.order.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code).join(' → ')}</p>)}
     <ol className="turn-list">{roundOrder.map((id:string)=>{
      const m=data.members.find((m:any)=>m.id===id),p=election.points.find((p:any)=>p.member_id===id);
      return <li key={id} className={id===turn?.memberId?'current-turn':''}><strong>{m?.code}</strong>
       <span>{data.config?.previousScores?.[m?.code]!==undefined?'Anterior: '+data.config.previousScores[m.code]+' puntos · ':''}{p?.cycles??0} ciclos · {p?.points??0} puntos{state?.credits[id]?' · '+state.credits[id]+' turno(s) aplazado(s)':''}</span></li>;
     })}</ol>
     <p className="muted">Puntuación de los ciclos elegidos del año actual; no cambia el orden inicial de elección.</p>
    </section>
   </aside>
  </div>


  {!manage&&!mine&&<section className="panel"><h2>Preparar tus preferencias</h2><p>Inicia sesión con la cuenta de ChatGPT cuyo correo electrónico figura en la plantilla del equipo. Si no tienes acceso, pide al administrador que compruebe el correo registrado. Podrá introducir tu lista por ti si no usas la web.</p>{!identity&&<a className="secondary" href={signinUrl}>Iniciar sesión</a>}</section>}
  <details className="panel"><summary>Vacaciones confirmadas · {data.awards.length} ciclos</summary><div className="table-wrap"><table><thead><tr><th>Controlador</th><th>Ciclo</th><th>Baremo</th>{manage&&<th>Corrección</th>}</tr></thead><tbody>{data.awards.map((a:any)=>{const c=data.result.cycles.find((c:any)=>c.date===a.cycle_date);return <tr key={a.id}><td>{data.members.find((m:any)=>m.id===a.member_id)?.code}</td><td>{formatDate(a.cycle_date)}</td><td>{c?.score}</td>{manage&&<td><button className="secondary" disabled={busy||state?.status==='active'||!open} onClick={async()=>{if(await confirm('¿Eliminar este ciclo confirmado?'))legacy({action:'delete_award',id:a.id},'Ciclo eliminado');}}>Eliminar ciclo</button></td>}</tr>;})}</tbody></table></div></details>
  {manage&&data.requests.some((r:any)=>!data.awards.some((a:any)=>a.member_id===r.member_id&&a.cycle_date===r.cycle_date))&&<details className="panel"><summary>Peticiones anteriores sin ciclo confirmado</summary><p className="muted">Registros creados antes del flujo de elección. Puedes eliminarlos para corregir datos anteriores; no son las nuevas listas de preferencias.</p>{data.requests.filter((r:any)=>!data.awards.some((a:any)=>a.member_id===r.member_id&&a.cycle_date===r.cycle_date)).map((r:any)=><p key={r.id}>{data.members.find((m:any)=>m.id===r.member_id)?.code} · {formatDate(r.cycle_date)} <button className="secondary" disabled={busy||!open||state?.status==="active"} onClick={async()=>{if(await confirm("¿Eliminar esta petición anterior sin elección confirmada?"))legacy({action:"delete_request",id:r.id},"Petición anterior eliminada");}}>Eliminar petición anterior</button></p>)}</details>}
  {manage&&<details className="panel"><summary>Revisiones y cierre del ejercicio</summary>{data.result.issues.length>0&&<p className="alert error">{data.result.issues.join(' · ')}</p>}{data.result.warnings.length>0&&<p className="alert warning">{data.result.warnings.join(' · ')}</p>}<button className="secondary" disabled={busy||!open||state?.status==='active'} onClick={()=>legacy({action:'calculate'},'Revisión calculada')}>Calcular revisión</button>{data.runs.map((run:any)=><p key={run.id}>{new Date(run.created_at).toLocaleDateString('es-ES')} · {run.id.slice(0,8)} {superuser&&run.source_version===data.campaign.version&&<button className="secondary" disabled={busy||state?.status==='active'} onClick={async()=>{if(await confirm('¿Guardar esta revisión como resultado final y cerrar el ejercicio?'))legacy({action:'publish',runId:run.id},'Revisión final publicada');}}>Guardar resultado final</button>}</p>)}</details>}
 </>;
}











