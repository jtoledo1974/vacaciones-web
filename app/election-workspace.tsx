'use client';
import {useEffect,useRef,useState} from 'react';
import CycleCalendar,{formatDate} from './cycle-calendar';
import {useConfirmation} from './confirmation';
import {newcomerScore} from '../domain/historical-order';
import {orderForRound} from '../domain/election';

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
 const [order,setOrder]=useState(''),[ties,setTies]=useState(''),[joints,setJoints]=useState(''),[source,setSource]=useState(''),[confirmed,setConfirmed]=useState(false),[deferral,setDeferral]=useState(true),[error,setError]=useState('');
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
 return <details className="panel"><summary>Preparar el orden de elección</summary><p>Conforme a Criterios Vacaciones 1.1 (2025): orden de menor a mayor puntuación anterior, sorteo inicial de los empatados y rotación de estos en cada ronda. Los turnos conjuntos se realizan cuando llega el último integrante del grupo.</p>
 <form onSubmit={save}>
 {error&&<p role="alert">{error}</p>}
 <label>Identificadores en orden confirmado (uno por línea)<textarea required aria-label="Orden confirmado" value={order} onChange={e=>setOrder(e.target.value)} rows={6}/></label>
 <label>Empates sorteados (opcional; un grupo consecutivo por línea)<textarea aria-label="Grupos empatados" value={ties} onChange={e=>setTies(e.target.value)} rows={3} placeholder="AA, BB, CC"/></label>
 <label>Turnos conjuntos acordados (opcional; dos o tres CTA por línea)<textarea aria-label="Turnos conjuntos" value={joints} onChange={e=>setJoints(e.target.value)} rows={3} placeholder="DD, EE"/></label>
 <NewcomerCalculator/><label>Origen del orden y sorteo<input required minLength={10} maxLength={500} value={source} onChange={e=>setSource(e.target.value)} placeholder="Ejercicio anterior, puntuaciones y acta del sorteo"/></label>
 <div className="team-checkboxes">
 <label><input type="checkbox" checked={deferral} onChange={e=>setDeferral(e.target.checked)}/> Permitir uno o dos aplazamientos (dos o tres ciclos en el siguiente turno)</label>
 <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Confirmo la aplicación de Criterios Vacaciones 1.1 (2025)</label>
 </div><button className="primary" disabled={busy||!confirmed}>Activar elección</button></form></details>;
}
function Preferences({data,memberId,dates,setDates,busy,act}:any){
 const existing=data.election.preferences.find((p:any)=>p.member_id===memberId),[automatic,setAutomatic]=useState(existing?.automatic??false);
 useEffect(()=>setAutomatic(existing?.automatic??false),[existing?.automatic]);
 const member=data.members.find((m:any)=>m.id===memberId);
 return <section className="panel preferences-panel"><h2>Preferencias de {member?.code}</h2><p>Pulsa ciclos en el calendario para añadir alternativas. Se probarán de arriba abajo cuando llegue tu turno; un ciclo ocupado se omite. La lista puede contener más alternativas que vacaciones.</p>{!dates.length?<p className="muted">Todavía no hay preferencias.</p>:<ol className="preference-list">{dates.map((date:string,i:number)=>{const cycle=data.result.cycles.find((c:any)=>c.date===date);return <li key={date}><span>{formatDate(date)} · {cycle?.score} puntos</span><div><button className="icon-button" aria-label={`Subir preferencia ${i+1}`} disabled={i===0||busy} onClick={()=>{const next=[...dates];[next[i-1],next[i]]=[next[i],next[i-1]];setDates(next);}}>↑</button><button className="icon-button" aria-label={`Bajar preferencia ${i+1}`} disabled={i===dates.length-1||busy} onClick={()=>{const next=[...dates];[next[i+1],next[i]]=[next[i],next[i+1]];setDates(next);}}>↓</button><button className="icon-button" aria-label={`Quitar preferencia ${i+1}`} disabled={busy} onClick={()=>setDates(dates.filter((d:string)=>d!==date))}>×</button></div></li>;})}</ol>}<label className="preference-consent"><input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)}/> Asignar automáticamente desde esta lista cuando llegue mi turno</label><p className="muted">Al guardar, las elecciones automáticas que ya correspondan pueden confirmarse de inmediato. Si no hay opciones válidas suficientes, el turno queda esperando.</p><button className="primary" disabled={busy} onClick={()=>act({action:'preferences',memberId,dates,automatic},'Preferencias guardadas')}>Guardar preferencias</button></section>;
}
export default function ElectionWorkspace({data,busy,act,legacy,identity,superuser,signinUrl}:any){
 const confirm=useConfirmation();
 const election=data.election,turn=election.turn,state=election.state,manage=election.canManage,mine=election.myMemberId,open=data.campaign.status==='open',current=data.members.find((m:any)=>m.id===turn?.memberId);
 const [mode,setMode]=useState<'choose'|'preferences'>('choose'),[memberId,setMemberId]=useState(mine??turn?.memberId??data.members[0]?.id??''),[selected,setSelected]=useState<string[]>([]),[jointSelected,setJointSelected]=useState<Record<string,string[]>>({}),[jointTarget,setJointTarget]=useState(''),[detail,setDetail]=useState<any>(null),[dates,setDates]=useState<string[]>([]),[message,setMessage]=useState(''),[pairOptions,setPairOptions]=useState<string[]|null>(null),[loadingOptions,setLoadingOptions]=useState(false),[filterMember,setFilterMember]=useState(mine??'');
 useEffect(()=>{setSelected([]);setJointSelected({});setJointTarget('');},[turn?.memberId,turn?.needed,state?.status]);
 useEffect(()=>{if(mine)setMemberId(mine);},[mine]);
 useEffect(()=>{setDetail((current:any)=>current?data.result.cycles.find((c:any)=>c.date===current.date)??null:null);},[data.campaign.version]);
 const lastSavedPreferences=useRef<{memberId:string;dates:string}>({memberId:'',dates:'[]'});
 const serverPreferences=JSON.stringify(election.preferences.find((p:any)=>p.member_id===memberId)?.dates??[]);
 useEffect(()=>{
  const incoming=JSON.parse(serverPreferences) as string[];
  setDates(current=>{
   const untouched=lastSavedPreferences.current.memberId!==memberId
    ||JSON.stringify(current)===lastSavedPreferences.current.dates;
   return untouched?incoming:current;
  });
  lastSavedPreferences.current={memberId,dates:serverPreferences};
 },[memberId,serverPreferences]);
 useEffect(()=>{
  setPairOptions(null);if(turn?.participants?.length!==1||turn?.needed<2||!selected.length||selected.length>=turn.needed)return;
  let active=true;setLoadingOptions(true);
  const query=new URLSearchParams();selected.forEach(date=>query.append('selected',date));
  fetch('/api/election/'+data.campaign.id+'/options?'+query,{cache:'no-store'}).then(async response=>{const body:any=await response.json();if(!response.ok)throw new Error(body.error);if(active)setPairOptions(body.available);}).catch(e=>{if(active){setPairOptions([]);setMessage(e.message);}}).finally(()=>{if(active)setLoadingOptions(false);});
  return ()=>{active=false;setLoadingOptions(false);};
 },[selected.join(','),turn?.needed,data.campaign.version]);
 const canChoose=open&&state?.status==='active'&&(manage||(turn?.participants?.length===1&&mine===turn?.memberId)),canPreferences=open&&(manage||!!mine);
 const roundOrder=state?orderForRound(state,Math.max(0,(turn?.round??1)-1)):data.members.map((m:any)=>m.id);
 function clickCycle(c:any){setDetail(c);setMessage('');
 if(mode==='choose'&&canChoose&&turn?.participants?.length>1){
  const target=jointTarget||turn.participants[0],previous=jointSelected[target]??[],max=turn.requiredByMember[target]??1;
  setJointSelected({...jointSelected,[target]:previous.includes(c.date)?previous.filter(d=>d!==c.date):previous.length>=max?[c.date]:[...previous,c.date]});return;
 }
 if(mode==='preferences'&&canPreferences){if(!dates.includes(c.date))setDates([...dates,c.date]);return;}if(canChoose){if(loadingOptions){setMessage("Comprobando qué segundo ciclo es compatible…");return;}if(!(pairOptions??election.available).includes(c.date)&&!selected.includes(c.date)){setMessage('Este ciclo no es válido para quien elige ahora: ya está elegido, no hay cupo o se excede un límite.');return;}if(selected.includes(c.date))setSelected(selected.filter(d=>d!==c.date));else setSelected(turn.needed===1||selected.length>=turn.needed?[c.date]:[...selected,c.date]);}}
 return <>
  <section className="panel election-turn election-workflow-head"><div><div className="eyebrow">{state?.status==='active'?`RONDA ${turn?.round} · ELECCIÓN EN CURSO`:state?.status==='complete'?'ELECCIÓN COMPLETADA':state?.status==='paused'?'ELECCIÓN EN PAUSA':'VACACIONES DEL EQUIPO'}</div><h2>{state?.status==='active'&&current?`${turn?.participants?.length>1?turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code).join(" + "):current.code} elige ahora`:'Consulta ciclos, ocupación y baremos'}</h2><p>{state?.status==='active'&&current?`Corresponde elegir ${turn.needed} ciclo(s). ${canChoose?'Selecciona en el calendario y confirma.':'El turno espera una elección válida de esta persona.'}`:'Las vacaciones registradas se muestran públicamente. El orden de elección necesita confirmación del administrador.'}</p></div><div className="button-row">{canPreferences&&<><button className={mode==='choose'?'primary':'secondary'} onClick={()=>setMode('choose')}>Elegir / consultar</button><button className={mode==='preferences'?'primary':'secondary'} onClick={()=>setMode('preferences')}>Preparar preferencias</button></>}{superuser&&state&&state.status!=='complete'&&<button className="secondary" disabled={busy||!open} onClick={()=>act({action:state.status==='active'?'pause':'resume'},state.status==='active'?'Elección pausada':'Elección reanudada')}>{state.status==='active'?'Pausar elección':'Reanudar elección'}</button>}</div></section>
  {election.pendingAutomatic&&canPreferences&&<div className="alert warning">Hay elecciones automáticas pendientes. <button className="secondary" disabled={busy||!open} onClick={()=>act({action:"advance"},"Elecciones automáticas procesadas")}>Continuar automatismos</button></div>}
<div className="election-filter"><label>Ver vacaciones de<select aria-label="Ver vacaciones de controlador" value={filterMember} onChange={e=>setFilterMember(e.target.value)}><option value="">Todo el equipo</option>{data.members.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>{filterMember&&<span>{election.points.find((p:any)=>p.member_id===filterMember)?.cycles??0} ciclos · {election.points.find((p:any)=>p.member_id===filterMember)?.points??0} de baremo sin ponderar</span>}<a href="#puntos-equipo">Ver puntos y ciclos del equipo</a></div>
  {canPreferences&&mode==='preferences'&&manage&&<label className="preference-member">Introducir preferencias para<select aria-label="Preferencias de controlador" value={memberId} onChange={e=>setMemberId(e.target.value)}>{data.members.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>}
  <div className="election-layout">
   <div className="election-calendar-wrap">
    <CycleCalendar year={data.campaign.year} cycles={data.result.cycles}
     selected={mode==='preferences'?dates:turn?.participants?.length>1?Object.values(jointSelected).flat():selected} onSelect={clickCycle}
     busy={busy||loadingOptions} highlighted={data.awards.filter((a:any)=>a.member_id===filterMember).map((a:any)=>a.cycle_date)}
     awards={data.awards} members={data.members} order={roundOrder} points={election.points}/>
   </div>
   <aside className="election-side">
    <section className="panel vac2-choice-card">
     <div className="eyebrow">{mode==='preferences'?'PREPARANDO PREFERENCIAS':state?.status==='active'?'TURNO ACTUAL':'CONSULTAR CICLO'}</div>
     {mode==='choose'&&state?.status==='active'&&current&&<><h2>{turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code).join(' + ')} · Ronda {turn.round}</h2><p className="muted">Debe elegir {turn.needed} ciclo(s).</p></>}
     {mode==='preferences'&&<h2>Preferencias de {data.members.find((m:any)=>m.id===memberId)?.code}</h2>}
     {detail?<><h2>{formatDate(detail.date)} – {formatDate(detail.end)}{detail.period===1?' · Verano':''}</h2><p><strong>{detail.score} puntos</strong> · {detail.occupied}/{detail.max} plazas ocupadas · {Math.max(0,detail.max-detail.occupied)} libres</p>
      <div className="button-row">{data.awards.filter((a:any)=>a.cycle_date===detail.date).map((a:any)=><span className="person-chip" key={a.id}>{data.members.find((m:any)=>m.id===a.member_id)?.code}</span>)}</div></>:<p className="muted">Selecciona un ciclo en el calendario para ver ocupantes, disponibilidad y baremo.</p>}
     {message&&<p role="status" className="alert warning">{message}</p>}
     {mode==='choose'&&canChoose&&<>
             {turn?.participants?.length>1&&<div className="joint-picker"><p>Turno conjunto: selecciona el controlador y sus ciclos.</p>{turn.participants.map((id:string)=><button key={id} className={(jointTarget||turn.participants[0])===id?'primary':'secondary'} onClick={()=>setJointTarget(id)}>{data.members.find((m:any)=>m.id===id)?.code}: {(jointSelected[id]??[]).length}/{turn.requiredByMember[id]}</button>)}</div>}<p>Selección: {turn?.participants?.length>1?turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code+': '+(jointSelected[id]??[]).map(formatDate).join(' + ')).join(' | '):selected.length?selected.map(formatDate).join(' + '):'pulsa un ciclo en el calendario'}</p><div className="button-row"><button className="primary" disabled={busy||loadingOptions||(turn?.participants?.length>1?turn.participants.some((id:string)=>(jointSelected[id]??[]).length!==turn.requiredByMember[id]):selected.length!==turn.needed)} onClick={async()=>{
 if(turn?.participants?.length>1){
  const entries=turn.participants.map((id:string)=>({member_id:id,dates:jointSelected[id]??[]}));
  if(await confirm('¿Confirmar las elecciones del turno conjunto?'))act({action:'choose_joint',entries},'Turno conjunto confirmado');
 }else if(await confirm('¿Confirmar '+selected.map(formatDate).join(' y ')+' para '+current.code+'?'))act({action:'choose',memberId:current.id,dates:selected},'Elección confirmada');
 }}>Confirmar {turn?.participants?.length>1?'turno conjunto':turn.needed===3?'tres ciclos':turn.needed===2?'ambos ciclos':'ciclo'}</button>{state.allowDeferral&&turn?.participants?.length===1&&<button className="secondary" disabled={busy||!turn.canDefer} onClick={async()=>{if(await confirm(`¿Aplazar el turno de ${current.code} para elegir dos ciclos en su próxima ocasión?`))act({action:'defer',memberId:current.id},'Turno aplazado');}}>{state.credits[current.id]===1?'Aplazar para elegir tres':'Aplazar para elegir dos'}</button>}</div></>}
      {manage&&<div className="election-workflow-actions">
      <button className="secondary" disabled={busy||(!election.undo&&!data.undo)||!open} onClick={async()=>{
       if(await confirm('¿Deshacer el último cambio de elección, incluyendo cola y ocupación?'))
        data.undo?legacy({action:'undo_vacations',undoId:data.undo.id},'Cambio deshecho'):act({action:'election_undo',historyId:election.undo},'Cambio de elección deshecho');
      }}>↶ Deshacer</button>
      <button className="secondary" disabled={busy||(!election.redo&&!data.redo)||!open} onClick={async()=>{
       if(await confirm('¿Rehacer el cambio de elección?'))
        data.redo?legacy({action:'redo_vacations',undoId:data.redo.id},'Cambio rehecho'):act({action:'election_redo',historyId:election.redo},'Cambio de elección rehecho');
      }}>↷ Rehacer</button>
     </div>}
    </section>
    {manage&&<section className="panel election-history-panel"><h2>Últimas adjudicaciones</h2>
     <p className="muted">Más recientes primero. Las elecciones deshechas desaparecen de esta lista.</p>
     {(election.timeline??[]).length?
      <ol className="election-log">{(election.timeline??[]).slice(0,40).map((a:any,i:number)=>{
       const code=data.members.find((m:any)=>m.id===a.member_id)?.code??'?';
       const cycle=data.result.cycles.find((c:any)=>c.date===a.cycle_date);
       return <li key={a.member_id+'|'+a.cycle_date}><div><b>{i+1}. {code}</b><br/><span>{formatDate(a.cycle_date)} · {cycle?.score??'—'} puntos{a.legacy?' · importado':''}</span></div></li>;
      })}</ol>:<p className="muted">Todavía no hay ciclos adjudicados.</p>}
    </section>}
    {mode==='preferences'&&canPreferences&&memberId&&<Preferences key={memberId} data={data} memberId={memberId} dates={dates} setDates={setDates} busy={busy} act={act}/>}
    <section id="puntos-equipo" className="panel election-order-panel">
     <h2>{state?'Orden de elección':'Controladores del equipo'}</h2>
     {state&&manage&&<p className="muted">{state.source}</p>}
     <ol className="turn-list">{roundOrder.map((id:string)=>{
      const m=data.members.find((m:any)=>m.id===id),p=election.points.find((p:any)=>p.member_id===id);
      return <li key={id} className={id===turn?.memberId?'current-turn':''}><strong>{m?.code}</strong>
       <span>{p?.cycles??0} ciclos · {p?.points??0} puntos{state?.credits[id]?' · '+state.credits[id]+' turno(s) aplazado(s)':''}</span></li>;
     })}</ol>
     <p className="muted">Puntuación de los ciclos elegidos del año actual; no cambia el orden inicial de elección.</p>
    </section>
   </aside>
  </div>

  {superuser&&open&&(!state||state.status==='paused')&&<OrderSetup data={data} busy={busy} act={act}/>}
  {!manage&&!mine&&<section className="panel"><h2>Preparar tus preferencias</h2><p>Inicia sesión y pide al administrador que vincule tu cuenta a tu identificador. Podrá introducir tu lista por ti si no usas la web.</p>{identity?<p>Tu identificador de cuenta: <code className="subject">{identity}</code></p>:<a className="secondary" href={signinUrl}>Iniciar sesión</a>}</section>}
  <details className="panel"><summary>Vacaciones confirmadas · {data.awards.length} ciclos</summary><div className="table-wrap"><table><thead><tr><th>Controlador</th><th>Ciclo</th><th>Baremo</th>{manage&&<th>Corrección</th>}</tr></thead><tbody>{data.awards.map((a:any)=>{const c=data.result.cycles.find((c:any)=>c.date===a.cycle_date);return <tr key={a.id}><td>{data.members.find((m:any)=>m.id===a.member_id)?.code}</td><td>{formatDate(a.cycle_date)}</td><td>{c?.score}</td>{manage&&<td><button className="secondary" disabled={busy||state?.status==='active'||!open} onClick={async()=>{if(await confirm('¿Eliminar este ciclo confirmado?'))legacy({action:'delete_award',id:a.id},'Ciclo eliminado');}}>Eliminar ciclo</button></td>}</tr>;})}</tbody></table></div></details>
  {manage&&data.requests.some((r:any)=>!data.awards.some((a:any)=>a.member_id===r.member_id&&a.cycle_date===r.cycle_date))&&<details className="panel"><summary>Peticiones anteriores sin ciclo confirmado</summary><p className="muted">Registros creados antes del flujo de elección. Puedes eliminarlos para corregir datos anteriores; no son las nuevas listas de preferencias.</p>{data.requests.filter((r:any)=>!data.awards.some((a:any)=>a.member_id===r.member_id&&a.cycle_date===r.cycle_date)).map((r:any)=><p key={r.id}>{data.members.find((m:any)=>m.id===r.member_id)?.code} · {formatDate(r.cycle_date)} <button className="secondary" disabled={busy||!open||state?.status==="active"} onClick={async()=>{if(await confirm("¿Eliminar esta petición anterior sin elección confirmada?"))legacy({action:"delete_request",id:r.id},"Petición anterior eliminada");}}>Eliminar petición anterior</button></p>)}</details>}
  {manage&&<details className="panel"><summary>Revisiones y cierre del ejercicio</summary>{data.result.issues.length>0&&<p className="alert error">{data.result.issues.join(' · ')}</p>}{data.result.warnings.length>0&&<p className="alert warning">{data.result.warnings.join(' · ')}</p>}<button className="secondary" disabled={busy||!open||state?.status==='active'} onClick={()=>legacy({action:'calculate'},'Revisión calculada')}>Calcular revisión</button>{data.runs.map((run:any)=><p key={run.id}>{new Date(run.created_at).toLocaleDateString('es-ES')} · {run.id.slice(0,8)} {superuser&&run.source_version===data.campaign.version&&<button className="secondary" disabled={busy||state?.status==='active'} onClick={async()=>{if(await confirm('¿Guardar esta revisión como resultado final y cerrar el ejercicio?'))legacy({action:'publish',runId:run.id},'Revisión final publicada');}}>Guardar resultado final</button>}</p>)}</details>}
 </>;
}











