'use client';
import {useEffect,useState} from 'react';
import {useConfirmation} from './confirmation';

function label(action:string){
 return ({choose:'Elección individual',choose_joint:'Elección conjunta',advance:'Adjudicación automática',defer:'Aplazamiento',resolve_tie:'Resolución de empate',reconstruction_step:'Elección reconstruida'} as Record<string,string>)[action]??action;
}
const dateText=(date:string)=>date?new Date(date+'T12:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'}):'—';
export default function ReconstructionPanel({data,busy,act}:any){
 const confirm=useConfirmation(),r=data.election.reconstruction;
 const code=(id:string)=>data.members.find((m:any)=>m.id===id)?.code??'?';
 const [target,setTarget]=useState('');
 const [mode,setMode]=useState('preference'),[manualKind,setManualKind]=useState('choose');
 const [selected,setSelected]=useState<string[]>([]),[entries,setEntries]=useState<Record<string,string[]>>({}),[order,setOrder]=useState<string[]>([]);
 const [manualDate,setManualDate]=useState(''),[jointDate,setJointDate]=useState<Record<string,string>>({});
 const choice=r?.current,active=r?.active,stepKey=(r?.progress??0)+'|'+(choice?.round??'')+'|'+(choice?.memberId??'');
 const candidates=r?.candidates??[];
 useEffect(()=>{if(!target||!candidates.some((c:any)=>c.id===target))setTarget(candidates[0]?.id??'');},[target,candidates.map((c:any)=>c.id).join('|')]);
 useEffect(()=>{
  setMode(choice?.historicalPreference?'preference':choice?.originalPossible?'original':'manual');
  setManualKind(choice?.pendingTie?'resolve_tie':(choice?.participants?.length??0)>1?'choose_joint':'choose');
  setSelected([]);setEntries({});setOrder([]);setManualDate('');setJointDate({});
 },[stepKey]);
 // Do not push the election calendar and the preferences save button below the fold
 // when the campaign does not have a single decision that can be reconstructed.
 if(!r||(!active&&r.status!=='completed'&&!candidates.length))return null;
 const available=choice?.available??[];
 const originalKind=choice?.originalAction==='defer'?'defer':choice?.originalAction==='resolve_tie'?'resolve_tie':(choice?.participants?.length??0)>1?'choose_joint':'choose';
 const canSend=mode==='preference'?!!choice?.historicalPreference:
  mode==='original'?!!choice?.originalPossible:
  manualKind==='defer'?!!choice?.memberId&&choice?.participants?.length===1:
  manualKind==='resolve_tie'?!!choice?.pendingTie&&order.length===choice.pendingTie.length:
  manualKind==='choose_joint'?choice?.participants?.length>1&&choice.participants.every((id:string)=>(entries[id]??[]).length===choice.requiredByMember[id]):
  selected.length===choice?.needed;
 async function commit(){
  const kind=mode==='original'?originalKind:mode==='preference'?'choose':manualKind;
  await act({action:'reconstruction_step',kind,mode,...(mode==='manual'?{dates:selected,entries:(choice?.participants??[]).map((id:string)=>({member_id:id,dates:entries[id]??[]})),order}: {})},'Decisión reconstruida');
 }
 const impact=(r?.impact??[]) as any[];
 return <section className="panel reconstruction-panel" aria-label="Reconstrucción guiada">
  {!active&&<>
   <h2>Reconstruir elecciones anteriores</h2>
   <p>Elige el turno donde se produjo el error. Se conservarán las decisiones posteriores para revisarlas, sin adjudicar vacaciones automáticamente durante la reconstrucción. Si ya hiciste undo y elegiste otra cosa, busca las decisiones marcadas como «Rama anterior».</p>
   {!candidates.length?<p className="muted">Todavía no hay decisiones recuperables.</p>:<>
    <label>Retroceder hasta
     <select aria-label="Punto de reconstrucción" value={target} onChange={e=>setTarget(e.target.value)}>
      {candidates.map((c:any)=><option key={c.id} value={c.id}>Ronda {c.round} · {c.memberIds.map(code).join(' + ')} · {c.archived?'Rama anterior · ':''}{label(c.action)} {c.choices?.length?' · '+c.choices.map((p:any)=>dateText(p.cycle_date)).join(', '):''}</option>)}
     </select>
    </label>
    <button className="secondary" disabled={busy||!target} onClick={async()=>{if(await confirm('¿Iniciar reconstrucción desde este turno? La elección quedará congelada para los controladores y se recuperarán las decisiones posteriores una a una.'))await act({action:'reconstruction_start',historyId:target},'Reconstrucción iniciada');}}>Iniciar reconstrucción guiada</button>
   </>}
  </>}
  {active&&<>
   <div className="reconstruction-heading"><div><span className="eyebrow">RECONSTRUCCIÓN EN CURSO</span><h2>Equipo {data.campaign.team_id} · {choice?.round?'Ronda '+choice.round:'Revisión final'}</h2></div><span className="tag">Elección congelada</span></div>
   <p><strong>{r.progress} decisiones reconstruidas</strong> · {r.total} decisiones anteriores como referencia</p>
   <progress max={Math.max(1,r.total)} value={Math.min(r.progress,r.total)} style={{width:'100%'}}/>
   <p className="muted">El responsable puede elegir por cada CTA tras consultarle fuera de la aplicación. Las preferencias no pueden editarse y las adjudicaciones automáticas están suspendidas.</p>
   {choice&&r.status==='active'&&<div className="reconstruction-step">
    <h3>{choice.pendingTie?'Empate pendiente':choice.participants?.map(code).join(' + ')+' · Elegir '+choice.needed+' ciclo(s)'}</h3>
    <div className="reconstruction-options">
     <p><strong>Elección anterior:</strong> {choice.originalChoice?.flatMap((entry:any)=>entry.dates.map((date:string)=>code(entry.member_id)+' '+dateText(date))).join(' · ')||label(choice.originalAction??'Sin elección histórica')} {choice.originalPossible?'· Sigue siendo posible':'· No disponible o incompatible'}</p>
     <p><strong>Mejor preferencia histórica:</strong> {choice.historicalPreference?.length?choice.historicalPreference.map(dateText).join(' + '):'No hay combinación válida registrada'}</p>
     {choice.preferences?.length>0&&<details><summary>Consultar lista histórica completa</summary>{choice.preferences.map((p:any)=><p key={p.member_id}>{code(p.member_id)}: {p.dates.map(dateText).join(' → ')}</p>)}</details>}
    </div>
    <fieldset className="reconstruction-decisions"><legend>Decisión del administrador</legend>
     {!!choice.historicalPreference&&<label><input type="radio" name="reconstruction-decision" checked={mode==='preference'} onChange={()=>setMode('preference')}/> Aplicar preferencia histórica válida</label>}
     {choice.originalPossible&&<label><input type="radio" name="reconstruction-decision" checked={mode==='original'} onChange={()=>setMode('original')}/> Recuperar elección anterior</label>}
     <label><input type="radio" name="reconstruction-decision" checked={mode==='manual'} onChange={()=>setMode('manual')}/> Registrar otra decisión</label>
    </fieldset>
    {mode==='manual'&&<div className="reconstruction-manual">
     {choice.pendingTie?<><p>Registra el resultado del sorteo, en el orden de prioridad.</p>
      <div className="button-row">{choice.pendingTie.filter((id:string)=>!order.includes(id)).map((id:string)=><button className="secondary" key={id} disabled={busy} onClick={()=>setOrder([...order,id])}>{code(id)}</button>)}<button className="secondary" onClick={()=>setOrder(order.slice(0,-1))}>Quitar último</button></div><p>{order.map(code).join(' → ')||'Sin orden seleccionado'}</p>
     </>:<>
      {choice.participants?.length===1&&choice.originalAction==='defer'&&<label><input type="checkbox" checked={manualKind==='defer'} onChange={e=>setManualKind(e.target.checked?'defer':'choose')}/> Aplazar este turno</label>}
      {choice.participants?.length===1&&manualKind!=='defer'&&<div><label>Ciclo disponible <select aria-label="Ciclo alternativo" value={manualDate} onChange={e=>setManualDate(e.target.value)}><option value="">Selecciona un ciclo</option>{available.map((date:string)=><option key={date} value={date}>{dateText(date)}</option>)}</select></label>
       <button className="secondary" type="button" disabled={!manualDate||selected.includes(manualDate)||selected.length>=choice.needed} onClick={()=>{setSelected([...selected,manualDate]);setManualDate('');}}>Añadir ciclo</button>
       <p>{selected.map(dateText).join(' + ')||'Sin ciclos elegidos'} · {selected.length}/{choice.needed}</p>
       {selected.length>0&&<button className="secondary" onClick={()=>setSelected(selected.slice(0,-1))}>Quitar último</button>}
      </div>}
      {choice.participants?.length>1&&choice.participants.map((id:string)=><div key={id}><label>{code(id)} · {entries[id]?.length??0}/{choice.requiredByMember[id]} ciclos
       <select aria-label={'Ciclo de '+code(id)} value={jointDate[id]??''} onChange={e=>setJointDate({...jointDate,[id]:e.target.value})}><option value="">Selecciona ciclo</option>{data.result.cycles.map((c:any)=><option key={c.date} value={c.date}>{dateText(c.date)}</option>)}</select></label>
       <button className="secondary" disabled={!jointDate[id]||(entries[id]??[]).includes(jointDate[id])||(entries[id]??[]).length>=choice.requiredByMember[id]} onClick={()=>{setEntries({...entries,[id]:[...(entries[id]??[]),jointDate[id]]});setJointDate({...jointDate,[id]:''});}}>Añadir</button>
       <p>{(entries[id]??[]).map(dateText).join(' + ')}</p></div>)}
     </>}
    </div>}
    <button className="primary" disabled={busy||!canSend} onClick={commit}>Registrar decisión y continuar</button>
   </div>}
   {r.status==='review'&&<><h3>Turnos reconstruidos</h3><p>Se ha alcanzado el punto hasta el que había avanzado la elección. Revisa los cambios y finaliza; los automatismos permanecerán detenidos.</p>
    <p>CTA potencialmente afectados por cambios de disponibilidad: <strong>{impact.length}</strong></p>
    <button className="primary" disabled={busy} onClick={async()=>{if(await confirm('¿Finalizar la reconstrucción? Los automatismos NO se reanudarán hasta que el responsable lo autorice expresamente.'))await act({action:'reconstruction_finish'},'Reconstrucción finalizada, automatismos detenidos');}}>Finalizar reconstrucción</button>
   </>}
   {impact.length>0&&<details><summary>Examinar CTA afectados ({impact.length})</summary><ul>{impact.map((a:any)=><li key={a.memberId}><strong>{code(a.memberId)}</strong> · Primera preferencia válida: {dateText(a.previousFirst)} → {dateText(a.currentFirst)}</li>)}</ul></details>}
   <div className="button-row">
    <button className="secondary" disabled={busy||!r.canBack} onClick={()=>act({action:'reconstruction_back'},'Última decisión reconstruida deshecha')}>↶ Deshacer paso</button>
    <button className="secondary" disabled={busy||!r.canForward} onClick={()=>act({action:'reconstruction_forward'},'Paso reconstruido nuevamente')}>↷ Rehacer paso</button>
    <button className="secondary" disabled={busy} onClick={async()=>{if(await confirm('¿Cancelar toda la reconstrucción y restaurar el estado exactamente anterior a iniciarla?'))await act({action:'reconstruction_cancel'},'Reconstrucción cancelada y situación anterior recuperada');}}>Cancelar y restaurar estado original</button>
   </div>
  </>}
  {r.status==='completed'&&<div className="reconstruction-summary"><h2>Reconstrucción finalizada</h2><p>Se registraron {r.progress} decisiones. <strong>Los automatismos continúan detenidos</strong> hasta su reanudación por el responsable del equipo.</p>{impact.length>0&&<details><summary>CTA con cambios en disponibilidad ({impact.length})</summary>{impact.map((a:any)=><p key={a.memberId}>{code(a.memberId)}: {dateText(a.previousFirst)} → {dateText(a.currentFirst)}</p>)}</details>}</div>}
 </section>;
}
