 type SelectedChoice={member_id:string;cycle_date:string};
 /**
  * The sole path for both explicit and automatic selections.
  * The synchronous ref prevents a second request while React updates state.
  * The server still performs version/CAS validation before committing.
  */
 async function submitChoice(choices:SelectedChoice[]):Promise<void>{
  if(choiceLock.current||busy||previewReadOnly||loadingOptions||!canChoose||!turn?.memberId)return;
  if(turn.participants?.length>1){
   if(turn.participants.some((id:string)=>choices.filter(choice=>choice.member_id===id).length!==turn.requiredByMember[id])||
      choices.some(choice=>!turn.participants.includes(choice.member_id)))return;
  }else if(choices.length!==turn.needed||choices.some(choice=>choice.member_id!==turn.memberId))return;
  choiceLock.current=true;
  setChoiceSubmitting(true);
  setMessage('');
  try{
   const names=turn.participants?.length>1?turn.participants.map(codeFor).join(' + '):current?.code??'';
   let impactLines:string[]=[];
   let warningLines:string[]=[];
   if(data.campaign.year===2027){
    setChoicePhase('checking');
    const query=new URLSearchParams({version:String(data.campaign.version),choices:JSON.stringify(choices)});
    const preview=new URLSearchParams(location.search).get('verComo');
    if(preview)query.set('verComo',preview);
    const response=await fetch('/api/election/'+data.campaign.id+'/impact?'+query,{cache:'no-store'});
    const report:any=await response.json();
    if(!response.ok)throw new Error(report.error??'No se pudo previsualizar la elección');
    if(report.version!==data.campaign.version||report.policyVersion!==election.occupancyPolicyVersion)
     throw new Error('El reparto o las normas han cambiado. Actualiza antes de elegir.');
    if(report.allowed===false){
     setMessage((report.issues??[]).map((issue:any)=>issue.message).join('; ')||'La elección impediría completar el reparto.');
     return;
    }
    impactLines=report.impact?describeImpact(report.impact):['El impacto no se pudo determinar exactamente; las cotas inciertas no se consideran bloqueos.'];
    warningLines=(report.warnings??[]).map((issue:any)=>issue.message);
   }
   // In real campaigns, and by default in simulations, confirmation is mandatory.
   // Fast simulation mode commits as soon as the complete choice is clicked.
   if(!simulation||!quickMode){
    setChoicePhase(null);
    const impactText=impactLines.length
     ?'\\n\\nConsecuencias sobre la disponibilidad:\\n'+impactLines.slice(0,14).join('\\n')+
       (impactLines.length>14?'\\n… y '+(impactLines.length-14)+' cambios más (consultables en el historial).':'')
     :'\\n\\nNo se han demostrado reducciones adicionales de disponibilidad.';
    const warningText=warningLines.length?'\\n\\nAvisos normativos:\\n'+warningLines.join('\\n'):'';
    const summary='¿Confirmar '+choices.length+' ciclo(s) para '+names+'?\\n'+choices.map(c=>formatDate(c.cycle_date)).join(' + ')+impactText+warningText;
    if(!await confirm(summary,undefined,{title:'Confirmar adjudicación e impacto',confirmLabel:'Adjudicar'}))return;
   }
   setChoicePhase('saving');
   const result=turn.participants?.length>1
    ?await act({action:'choose_joint',entries:turn.participants.map((id:string)=>({member_id:id,dates:choices.filter(choice=>choice.member_id===id).map(choice=>choice.cycle_date)}))},'Turno conjunto confirmado')
    :await act({action:'choose',memberId:turn.memberId,dates:choices.map(choice=>choice.cycle_date)},'Elección confirmada');
   if(!result?.campaign)setMessage('No se ha confirmado la adjudicación. Revisa el aviso de error antes de volver a intentarlo.');
  }catch(error:any){
   setMessage(error?.message??'No se pudo verificar la elección.');
  }finally{
   choiceLock.current=false;
   setChoiceSubmitting(false);
   setChoicePhase(null);
  }
 }
 function clickCycle(c:any){
  if(choiceSubmitting)return;
  if(mode==='choose')setDetail(c);
  setMessage('');
  if(mode==='choose'&&canChoose&&turn?.participants?.length>1){
   const target=jointTarget||turn.participants[0],previous=jointSelected[target]??[],max=turn.requiredByMember[target]??1;
   const nextDates=previous.includes(c.date)?previous.filter(d=>d!==c.date):previous.length>=max?[c.date]:[...previous,c.date];
   const next={...jointSelected,[target]:nextDates};
   setJointSelected(next);
   if(simulation&&quickMode&&!busy&&!previewReadOnly&&!loadingOptions&&
     turn.participants.every((id:string)=>(next[id]??[]).length===turn.requiredByMember[id]))
    void submitChoice(turn.participants.flatMap((id:string)=>(next[id]??[]).map((date:string)=>({member_id:id,cycle_date:date}))));
   return;
  }
  if(mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)){
   if(dates.includes(c.date)){editDates(togglePreferenceDate(dates,c.date,false));setPreferenceMessage('Ciclo retirado de tus preferencias. Sin guardar.');return;}
   editDates(togglePreferenceDate(dates,c.date,true));setPreferenceMessage('Añadido a tus preferencias · posición '+(dates.length+1)+'. Sin guardar.');return;
  }
  if(!canChoose||previewReadOnly)return;
  if(loadingOptions){setMessage('Comprobando qué segundo ciclo es compatible…');return;}
  if(!(pairOptions??election.available).includes(c.date)&&!selected.includes(c.date)){
   setMessage(election.availabilityReasons?.[c.date]??'Este ciclo no es viable en el reparto actual.');return;
  }
  const next=selected.includes(c.date)?selected.filter(d=>d!==c.date)
   :turn.needed===1||selected.length>=turn.needed?[c.date]:[...selected,c.date];
  setSelected(next);
  if(simulation&&quickMode&&!busy&&next.length===turn.needed&&turn?.participants?.length===1)
   void submitChoice(next.map(date=>({member_id:turn.memberId,cycle_date:date})));
 }
 return <>
  {thinking&&<div className="election-thinking-inline" role="status" aria-live="polite"><span className="election-thinking-spinner" aria-hidden="true"/>{thinkingMessage}</div>}
  {thinking&&slowChoice&&<div className="election-thinking-backdrop"><section className="election-thinking-dialog" role="dialog" aria-modal="true" aria-labelledby="election-thinking-title">
   <span className="election-thinking-spinner" aria-hidden="true"/>
   <h2 id="election-thinking-title">El motor está comprobando el reparto</h2>
   <p aria-live="polite">{thinkingMessage}</p>
   <p className="muted">Algunas elecciones, especialmente al ocupar una cuarta plaza, necesitan verificar que todos los controladores puedan completar sus vacaciones. No se ha confirmado ninguna adjudicación hasta que termine la comprobación.</p>
  </section></div>}
  {data.campaign.year===2027&&
   <details className="panel" aria-label="Interpretación normativa aplicada a vacaciones 2027">
    <summary>Cómo se aplican los cupos de 2027</summary>
    <p>En preverano hay dos ampliaciones a tres plazas en ciclos distintos y una ampliación a cuatro en un tercer ciclo. La cuarta no genera otro ciclo con una sola persona. Pueden terminar hasta tres ciclos individuales sin que ello suponga otro extracupo.</p>
    <p>En postverano pueden encadenarse la ampliación a tres y la cuarta plaza. En verano todos los ciclos deben terminar con al menos dos personas; están permitidos como máximo dos ciclos con cuatro.</p>
    <p>La flexibilidad de origen entre periodos está permitida provisionalmente por el responsable, con aviso cuando impida cumplir la interpretación territorial estricta de RR. HH. No es autorización definitiva de RR. HH. La referencia de dos ciclos estivales por persona es informativa.</p>
   </details>}
  {data.campaign.year===2027&&(data.result.policyWarnings??[]).length>0&&
   <section className="panel" aria-label="Avisos de las normas de vacaciones 2027">
    <h3>Avisos de reparto 2027</h3>
    <p>Estos avisos no bloquean la elección. Distinguen la flexibilidad provisional entre periodos de la referencia estival informativa; deben revisarse expresamente al cerrar el ejercicio.</p>
    {(data.result.policyWarnings??[]).map((w:any,i:number)=>
     <p key={w.code+'-'+i} role="status" className="alert warning">
      <strong>{w.period===0?'Preverano':w.period===1?'Verano':w.period===2?'Postverano':'Distribución general'}:</strong> {w.message}
     </p>)}
   </section>}
  {frozen&&<div className="reconstruction-status" role="status"><span aria-hidden="true">Ⅱ</span><strong>Reconstrucción en curso</strong><span>Elección congelada · Preferencias bloqueadas · Automatismos detenidos</span></div>}
  {!frozen&&<section className="panel election-turn election-workflow-head" aria-label="Turno de elección">
   <div className="election-turn-status">
    {simulation&&quickMode&&<span className="election-fast-indicator" role="status">Simulación · confirmación rápida</span>}
    <span className="eyebrow">{state?.status==='active'?`RONDA ${turn?.round} · EN CURSO`:state?.status==='complete'?'ELECCIÓN COMPLETADA':state?.status==='paused'?'ELECCIÓN EN PAUSA':'ELECCIÓN SIN INICIAR'}</span>
    <h2>{turn?.pendingTie?'Empate pendiente antes del siguiente turno':state?.status==='active'&&current?`${turn?.participants?.length>1?turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code).join(" + "):current.code} elige ahora`:'Consulta de ciclos'}</h2>
    {state?.status==='active'&&current&&!turn?.pendingTie&&<span className="muted">{turn.needed} ciclo(s) por elegir</span>}
   </div>
   <div className="election-turn-controls">
    {canPreferences&&<div className="election-view-switch" role="group" aria-label="Vista de vacaciones">
     <button type="button" className="election-view-option" aria-pressed={mode==='choose'} title="Consultar ciclos y elegir cuando corresponda" onClick={async()=>{if(mode!=='choose')await cancelPreferences();}}>Calendario</button>
     <button type="button" className="election-view-option" aria-pressed={mode==='preferences'} title="Preparar y guardar la lista de ciclos preferidos" onClick={()=>{setMode('preferences');setDetail(null);onPreferenceEdit?.();}}>Preferencias</button>
    </div>}
    {manage&&!state&&open&&<button type="button" className="primary election-quick-action" disabled={busy} onClick={onConfigureElection}>Configurar e iniciar elección</button>}
    {manage&&state?.status==='paused'&&open&&<button type="button" className="primary election-quick-action" disabled={busy} onClick={()=>act({action:'resume'},'Elección reanudada')}>Reanudar elección</button>}
    {!frozen&&((mode==='choose'&&canChoose&&state?.allowDeferral&&turn?.participants?.length===1&&turn.canDefer)||(manage&&state?.status==='active')||(manage&&open&&pendingGroups.length>0)||(superuser&&state?.status==='active')||(simulation&&manage&&state?.status==='active'))&&<details className="election-more-actions"><summary aria-label="Más acciones"><span className="election-more-label">Más acciones</span><span className="election-more-ellipsis" aria-hidden="true">⋯</span></summary><div className="election-more-menu">
     {simulation&&manage&&<label className="election-fast-mode"><input type="checkbox" checked={!quickMode} onChange={event=>changeQuickMode(!event.target.checked)} disabled={busy}/>Requerir confirmación antes de adjudicar</label>}
     {mode==='choose'&&canChoose&&state?.allowDeferral&&turn?.participants?.length===1&&turn.canDefer&&<button type="button" className="secondary" disabled={busy||previewReadOnly} onClick={async()=>{if(await confirm(`¿Aplazar el turno de ${current.code}? No podrá elegir hasta la próxima ronda.`))act({action:'defer',memberId:current.id},'Turno aplazado');}}>{state.credits[current.id]===1?'Aplazar para elegir tres':'Aplazar para elegir dos'}</button>}
     {manage&&open&&pendingGroups.length>0&&<button type="button" className="secondary election-pending-ties-action" disabled={busy||previewReadOnly} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');setTieDialogOpen(true);}}>Resolver empates pendientes <span className="election-pending-count">{pendingGroups.length}</span></button>}
     {manage&&state?.status==='active'&&<button type="button" className="secondary" onClick={()=>{setJointRound(turn?.round??1);setJointMembers([]);setJointOpen(true);}}>Gestionar turnos conjuntos…</button>}
     {superuser&&state?.status==='active'&&<button type="button" className="secondary" disabled={busy||!open} onClick={()=>act({action:'pause'},'Elección pausada')}>Pausar elección</button>}
    </div></details>}
   </div>
  </section>}
  {tieDialogOpen&&manage&&open&&!frozen&&pendingGroups.length>0&&<PendingTieDialog data={data} busy={busy} act={act} onClose={()=>setTieDialogOpen(false)}/>}
  {jointOpen&&!frozen&&manage&&state?.status==='active'&&<section className="panel" aria-label="Gestionar turnos conjuntos">
    <div className="section-head"><h2>Turnos conjuntos (excepcional)</h2><button type="button" className="secondary" onClick={()=>setJointOpen(false)}>Cerrar</button></div>
    <p>Selecciona de 2 a 3 controladores para una ronda. Elegirán simultáneamente cuando llegue el último según el orden efectivo de esa ronda. El acuerdo no se repetirá automáticamente.</p>
    <label>Ronda <select value={jointRound||turn?.round||1} onChange={e=>{setJointRound(Number(e.target.value));setJointMembers([]);}}>
     {Array.from({length:data.config.cyclesPerPerson-(turn?.round??1)+1},(_,i)=>(turn?.round??1)+i).map(n=><option value={n} key={n}>{n}</option>)}
    </select></label>
    <div className="joint-agreement-list">
    {orderForRound(state,(jointRound||turn?.round||1)-1).map((id:string,idx:number)=>{
      const chosenRound=jointRound||turn?.round||1;
      const alreadyPassed=chosenRound===turn?.round&&idx<state.cursor%state.order.length;
      const finished=data.awards.filter((a:any)=>a.member_id===id).length>=data.config.cyclesPerPerson;
      const tied=(state.pendingTieGroups??[]).some((g:string[])=>g.includes(id));
      const grouped=(state.jointGroups??[]).some((g:string[])=>g.includes(id))||(state.jointAgreements??[]).some((g:any)=>!g.cancelledAt&&g.round===chosenRound&&g.members.includes(id));
      const disabled=alreadyPassed||finished||tied||grouped||(jointMembers.length>=3&&!jointMembers.includes(id));
      return <label key={id}><input type="checkbox" checked={jointMembers.includes(id)} disabled={disabled} onChange={e=>setJointMembers(prev=>e.target.checked?[...prev,id]:prev.filter(person=>person!==id))}/><span title={codeFor(id)}>{codeFor(id)}</span></label>;
    })}
    </div>
    {jointMembers.length>=2&&<p><strong>Se elegiría al llegar a {codeFor(orderForRound(state,(jointRound||turn?.round||1)-1).filter((id:string)=>jointMembers.includes(id)).at(-1)??'')}.</strong> Participantes: {jointMembers.map(codeFor).join(' + ')}</p>}
    <button type="button" className="primary" disabled={busy||previewReadOnly||jointMembers.length<2||jointMembers.length>3} onClick={async()=>{const result=await act({action:'register_joint',round:jointRound||turn?.round||1,members:jointMembers},'Turno conjunto registrado');if(result?.campaign){setJointOpen(false);setJointMembers([]);}}}>Registrar acuerdo</button>
    {(state.jointAgreements??[]).filter((g:any)=>!g.cancelledAt&&g.round>=(turn?.round??1)).map((g:any,i:number)=><div key={i} className="button-row">
      <span>Ronda {g.round}: {g.members.map(codeFor).join(' + ')}</span>
      <button type="button" className="secondary" disabled={busy||g.round===(turn?.round??1)&&Math.min(...g.members.map((id:string)=>orderForRound(state,g.round-1).indexOf(id)))<state.cursor%state.order.length}
        onClick={async()=>{if(await confirm('¿Anular este acuerdo antes de que se consuma el primer turno?'))act({action:'cancel_joint',round:g.round,members:g.members},'Acuerdo conjunto anulado');}}>Anular</button>
    </div>)}
   </section>}
    {!frozen&&turn?.pendingTie&&<TieResolver key={turn.pendingTie.join('|')} group={turn.pendingTie} data={data} busy={busy} act={act} manage={manage} open={open}/> }
  {manage&&!frozen&&state?.status==='active'&&state.automaticPaused&&<div className="alert warning" role="status">Los automatismos están detenidos por una operación administrativa. Puedes corregir el turno manualmente; no se adjudicará de nuevo por sorpresa. <button type="button" className="secondary" disabled={busy||!open} onClick={async()=>{if(await confirm('¿Reanudar los automatismos? Las preferencias vigentes podrían adjudicar inmediatamente los siguientes turnos.'))act({action:'resume_automatic'},'Automatismos reanudados');}}>Reanudar automatismos</button></div>}
  {election.pendingAutomatic&&canPreferences&&<div className="alert warning">Hay elecciones automáticas pendientes. <button className="secondary" disabled={busy||!open||previewReadOnly} onClick={()=>act({action:"advance"},"Elecciones automáticas procesadas")}>Continuar automatismos</button></div>}
{mode==='choose'&&<div className="election-filter"><label>Ver vacaciones de<select aria-label="Ver vacaciones de controlador" value={filterMember} onChange={e=>setFilterMember(e.target.value)}><option value="">Todo el equipo</option>{preferenceMembers.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>{filterMember&&<span>{election.points.find((p:any)=>p.member_id===filterMember)?.cycles??0} ciclos · {election.points.find((p:any)=>p.member_id===filterMember)?.points??0} de baremo sin ponderar</span>}<a href="#puntos-equipo">Ver puntos y ciclos del equipo</a></div>}
  {canPreferences&&mode==='preferences'&&manage&&<label className="preference-member">Introducir preferencias para<select aria-label="Preferencias de controlador" value={memberId} disabled={busy} onChange={async e=>{const next=e.target.value;if(await leavePreferences()){setMemberId(next);setPreferenceMessage('');onPreferenceEdit?.();}}}>{preferenceMembers.map((m:any)=><option key={m.id} value={m.id}>{m.code}</option>)}</select></label>}
  <div className={"election-layout"+(detail&&!frozen?" has-active-detail":"")+(mode==='preferences'&&canPreferences?" is-preparing-preferences":"")+(frozen&&manage&&open?" is-reconstructing":"")}>
   {manage&&open&&frozen&&<ReconstructionPanel data={data} busy={busy} act={act}/>}
   <div className="election-calendar-wrap">
    <CycleCalendar preferenceMode={mode==='preferences'} year={data.campaign.year} cycles={data.result.cycles}
     selected={mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)?dates:turn?.participants?.length>1?Object.values(jointSelected).flat():selected} onSelect={clickCycle}
     busy={busy||loadingOptions||choiceSubmitting} highlighted={data.awards.filter((a:any)=>a.member_id===filterMember).map((a:any)=>a.cycle_date)}
     awards={data.awards} members={data.members} order={roundOrder} points={election.points} availability={election.cycleAvailability}/>
   </div>
   <aside className="election-side">
    {mode==='preferences'&&canPreferences&&preferenceMemberIds.includes(memberId)&&<PreferencesEditor data={data} readOnly={previewReadOnly} memberId={memberId} dates={dates} setDates={editDates} persistent={persistent} setPersistent={editPersistence} dirty={dirty} busy={busy} save={savePreferences} cancel={cancelPreferences} message={!dirty&&/sin guardar/i.test(preferenceMessage)?'La lista coincide con la versión guardada.':preferenceMessage}/>}

    {mode==='choose'&&detail&&<section className="panel vac2-choice-card" aria-label="Detalle del ciclo seleccionado">
     <div className="election-choice-heading"><span className="eyebrow">CICLO SELECCIONADO</span><button type="button" className="icon-button" aria-label="Cerrar detalle del ciclo" onClick={()=>{setDetail(null);setSelected([]);setJointSelected({});setMessage('');}}>×</button></div>
     <h2>{formatDate(detail.date)} – {formatDate(detail.end)}{detail.period===1?' · Verano':''}</h2>
     <p><strong>{detail.score} puntos</strong> · {detail.occupied}/{detail.max} plazas ocupadas · {data.campaign.year===2027
      ?'Plazas ocupadas; consulta debajo la disponibilidad global demostrada'
      :Math.max(0,detail.max-detail.occupied)+' libres'+(detail.available&&detail.occupied>=detail.max?' · Cupo adicional posible (pendiente de confirmar)':'')}</p>
     {data.campaign.year===2027&&<>
      <p><strong>Disponibilidad global:</strong> {cycleAvailability(detail,election.cycleAvailability,2027).description}</p>
      {election.cycleAvailability?.cycles?.[detail.date]&&<details className="election-cycle-rules"><summary>Detalle de las cuatro plazas y motivos de bloqueo</summary>
       <ul>{election.cycleAvailability.cycles[detail.date].slots.map((slot:any)=><li key={slot.position}><strong>{slot.position}ª plaza:</strong> {slotExplanation(slot)}</li>)}</ul>
      </details>}
     </>}
     {data.campaign.year===2027&&mode==='choose'&&canChoose&&turn?.participants?.length===1&&!election.available.includes(detail.date)&&
      <p className="alert warning" role="status">{election.availabilityReasons?.[detail.date]??'Este ciclo no es viable para la persona que elige en este turno.'}</p>}
     <div className="button-row">{data.awards.filter((a:any)=>a.cycle_date===detail.date).map((a:any)=><span className="person-chip" key={a.id}>{data.members.find((m:any)=>m.id===a.member_id)?.code}</span>)}</div>
     {message&&<p role="status" className="alert warning">{message}</p>}
     {mode==='choose'&&canChoose&&<>
      {simulation&&quickMode&&<p className="election-auto-notice">La adjudicación se realiza automáticamente al completar todos los ciclos de este turno.</p>}
      {turn?.participants?.length>1&&<div className="joint-picker"><p>Turno conjunto: selecciona el controlador y sus ciclos.</p>{turn.participants.map((id:string)=><button key={id} className={(jointTarget||turn.participants[0])===id?'primary':'secondary'} onClick={()=>setJointTarget(id)}>{data.members.find((m:any)=>m.id===id)?.code}: {(jointSelected[id]??[]).length}/{turn.requiredByMember[id]}</button>)}</div>}
      <p className="election-selected-summary">Elige <strong>{turn?.participants?.length>1?data.members.find((m:any)=>m.id===(jointTarget||turn.participants[0]))?.code:current?.code}</strong></p>
      {turn.needed>1&&turn?.participants?.length===1&&<p className="election-multiple-summary">{selected.length}/{turn.needed} ciclos seleccionados: {selected.map(formatDate).join(' + ')||'ninguno'}</p>}
      {turn?.participants?.length>1&&<p className="election-multiple-summary">{turn.participants.map((id:string)=>data.members.find((m:any)=>m.id===id)?.code+': '+((jointSelected[id]??[]).map(formatDate).join(' + ')||'pendiente')).join(' | ')}</p>}
      <div className="button-row">
       {(!simulation||!quickMode||!!message)&&<button type="button" className="primary"
        disabled={busy||choiceSubmitting||previewReadOnly||loadingOptions||
         (turn?.participants?.length>1?turn.participants.some((id:string)=>(jointSelected[id]??[]).length!==turn.requiredByMember[id]):selected.length!==turn.needed)}
        onClick={()=>void submitChoice(turn?.participants?.length>1
         ?turn.participants.flatMap((id:string)=>(jointSelected[id]??[]).map((date:string)=>({member_id:id,cycle_date:date})))
         :selected.map(date=>({member_id:turn.memberId,cycle_date:date})))}>
        {simulation&&quickMode?'Reintentar adjudicación':'Confirmar '+(turn?.participants?.length>1?'turno conjunto':turn.needed===3?'tres ciclos':turn.needed===2?'ambos ciclos':'ciclo')}
       </button>}
       <button type="button" className="secondary" onClick={()=>{setDetail(null);setSelected([]);setJointSelected({});setMessage('');}}>Cancelar selección</button>
      </div>
     </>}
    </section>}
    {manage&&<section className="panel election-history-panel" aria-label="Historial de elección">
     <div className="election-history-head"><h2>Últimos turnos y adjudicaciones</h2>
      <div className="election-workflow-actions">
       {!frozen&&(election.undo||data.undo)&&open&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{if(await confirm('¿Deshacer el último cambio de elección, incluyendo cola y ocupación?'))data.undo?legacy({action:'undo_vacations',undoId:data.undo.id},'Cambio deshecho'):act({action:'election_undo',historyId:election.undo},'Cambio de elección deshecho');}}>↶ Deshacer</button>}
       {!frozen&&(election.redo||data.redo)&&open&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{if(await confirm('¿Rehacer el cambio de elección?'))data.redo?legacy({action:'redo_vacations',undoId:data.redo.id},'Cambio rehecho'):act({action:'election_redo',historyId:election.redo},'Cambio de elección rehecho');}}>↷ Rehacer</button>}
       {canOpenReconstruction&&!choosingReconstructionStart&&<details className="election-more-actions election-history-more"><summary aria-label="Más acciones del historial">Más ⋯</summary><div className="election-more-menu"><button type="button" className="secondary" onClick={()=>setChoosingReconstructionStart(true)}>Reconstruir desde un turno…</button></div></details>}
      </div>
     </div>
     {choosingReconstructionStart&&canOpenReconstruction&&<div className="history-reconstruction-picker" role="region" aria-label="Elegir inicio de reconstrucción">
      <div className="history-reconstruction-picker-head"><strong>¿Desde qué turno quieres reconstruir?</strong><button type="button" className="secondary" onClick={()=>{setChoosingReconstructionStart(false);setArchivedTarget('');}}>Cancelar</button></div>
      <p>Busca el turno en este historial y pulsa «Desde aquí». No se cambiará ninguna adjudicación hasta que confirmes.</p>
      {archivedCandidates.length>0&&<details className="history-archived-choices"><summary>Decisiones de ramas anteriores ({archivedCandidates.length})</summary>
       <p>Estas decisiones fueron deshechas o sustituidas y ya no están vigentes. Puedes recuperarlas como referencia para una nueva reconstrucción.</p>
       <label>Decisión anterior<select aria-label="Elegir decisión de rama anterior" value={archivedCandidates.some((candidate:any)=>candidate.id===archivedTarget)?archivedTarget:archivedCandidates[0].id} onChange={event=>setArchivedTarget(event.target.value)}>
        {archivedCandidates.map((candidate:any)=><option key={candidate.id} value={candidate.id}>Ronda {candidate.round} · {candidate.memberIds.map(codeFor).join(' + ')} · {candidate.action==='defer'?'Aplazamiento':candidate.action==='resolve_tie'?'Sorteo':'Elección'} · {candidate.choices.map((choice:any)=>formatDate(choice.cycle_date)).join(' + ')}</option>)}
       </select></label>
       <button type="button" className="secondary" disabled={busy} onClick={()=>startReconstructionFrom(archivedCandidates.find((candidate:any)=>candidate.id===(archivedTarget||archivedCandidates[0].id)))}>Reconstruir desde la decisión anterior</button>
      </details>}
     </div>}
     <p className="muted">Más recientes primero. R1 · 1 indica el primer ciclo adjudicado en la ronda 1. Sorteos y aplazamientos no se numeran; los cambios deshechos no figuran como vigentes.</p>
     {(election.timeline??[]).length?<>
      <ol className="election-log">{(election.timeline??[]).slice(0,historyLimit).map((event:any)=>{
       const code=(id:string)=>data.members.find((m:any)=>m.id===id)?.code??'?';
       const title=event.kind==='tie'?'Sorteo de empate':event.kind==='joint'?(event.jointAction==='register_joint'?'Acuerdo de turno conjunto':'Anulación de turno conjunto'):event.kind==='defer'?code(event.memberIds[0])+' — Aplazamiento':event.memberIds.map(code).join(' + ');
       return <li key={event.id}><div className="election-log-entry">
        <div className="election-log-title"><b>{title}</b>{event.round&&<span>Ronda {event.round}</span>}</div>
        {event.kind==='tie'&&<p className="election-log-note">{event.method==='random'?'Sorteo realizado en la aplicación':'Sorteo externo registrado'}{event.anticipated?' · Resuelto anticipadamente':''} · Orden inicial: {(event.order??[]).map(code).join(' → ')}</p>}
        {event.kind==='defer'&&<p className="election-log-note">Turno aplazado, sin adjudicación. Acumula un ciclo para la siguiente ronda.</p>}
        {event.kind==='joint'&&<p className="election-log-note">{event.memberIds.map(code).join(' + ')} · {event.jointAction==='register_joint'?'Elegirán cuando llegue el último participante de la ronda':'Acuerdo anulado antes de consumir turnos'}.</p>}
        {(event.kind==='choice'||event.kind==='legacy')&&<>
         {event.choices.map((choice:any,index:number)=>{
          const cycle=data.result.cycles.find((c:any)=>c.date===choice.cycle_date);
          return <div className="election-log-cycle" key={choice.member_id+'|'+choice.cycle_date}>{cycleNumbers.get(event.id)&&<strong className="election-cycle-number">R{event.round} · {cycleNumbers.get(event.id)![index]} — </strong>}{event.memberIds.length>1?code(choice.member_id)+' · ':''}{formatDate(choice.cycle_date)} · {cycle?.score??'—'} puntos</div>;
         })}
         {event.kind==='legacy'&&<p className="election-log-note">Adjudicación importada o anterior al registro de turnos.</p>}
         {event.kind==='choice'&&event.memberIds.length>1&&<p className="election-log-note">Turno conjunto de {event.memberIds.length} controladores.</p>}
         {event.kind==='choice'&&event.deferredTurns>0&&<p className="election-log-note">Turno {event.deferredTurns===1?'doble':'triple'}: recupera {event.deferredTurns} aplazamiento(s) anterior(es).</p>}
         {event.impact&&<details className="election-log-impact">
          <summary>Impacto registrado · {event.impact.changes?.length??0} ciclos modificados · política {event.impact.policyVersion}</summary>
          <ul>{describeImpact(event.impact).map((line:string,i:number)=><li key={i}>{line}</li>)}</ul>
          {event.impact.status!=='exact'&&<p>El cálculo contiene cotas indeterminadas; no se ha supuesto disponibilidad cero.</p>}
         </details>}
         {(event.ties??[]).map((tie:any)=>{
          const memberCode=code(tie.memberId),previous=data.config?.previousScores?.[memberCode];
          return <p className="election-log-note election-log-tie" key={tie.memberId}>Empate{previous!==undefined?' a '+previous+' puntos':''} · {memberCode}: {tie.position}.º de {tie.total} · Orden de esta ronda: {tie.order.map(code).join(' → ')}</p>;
         })}
        </>}
        {choosingReconstructionStart&&canOpenReconstruction&&candidatesById.has(event.id)&&<button type="button" className="secondary election-reconstruction-row-action" disabled={busy} aria-label={'Reconstruir desde '+(event.kind==='tie'?'sorteo de ':'')+event.memberIds.map(codeFor).join(' + ')+' (ronda '+event.round+')'} onClick={()=>startReconstructionFrom(candidatesById.get(event.id))}>Desde aquí <span aria-hidden="true">→</span></button>}
       </div></li>;
      })}</ol>
      {(election.timeline??[]).length>historyLimit&&<button type="button" className="secondary election-show-more" onClick={()=>setHistoryLimit(n=>n+40)}>Mostrar anteriores ({Math.min(40,election.timeline.length-historyLimit)})</button>}
      {historyLimit>40&&<button type="button" className="secondary election-show-more" onClick={()=>setHistoryLimit(40)}>Mostrar menos</button>}
      {historyLimit>=(election.timeline??[]).length&&<p className="muted">Inicio del historial · No hay eventos anteriores.</p>}
     </>:<p className="muted">Todavía no hay turnos registrados ni ciclos adjudicados.</p>}
     {election.reconstruction?.status==='completed'&&state?.automaticPaused&&<details className="election-last-reconstruction"><summary>Última reconstrucción · {election.reconstruction.progress} decisiones revisadas</summary>
      <p>La reconstrucción ha terminado y los automatismos siguen detenidos. Puedes reanudarlos en el control administrativo de la parte superior.</p>
      {(election.reconstruction.impact??[]).length>0&&<><p>Disponibilidad modificada para {(election.reconstruction.impact??[]).length} controlador(es) que aún podían elegir:</p>
       <ul>{election.reconstruction.impact.map((entry:any)=><li key={entry.memberId}><strong>{codeFor(entry.memberId)}</strong>: primera preferencia válida {entry.previousFirst?formatDate(entry.previousFirst):'ninguna'} → {entry.currentFirst?formatDate(entry.currentFirst):'ninguna'}</li>)}</ul></>}
     </details>}
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
  {manage&&<details className="panel"><summary>Revisiones y cierre del ejercicio</summary>{data.result.issues.length>0&&<p className="alert error">{data.result.issues.join(' · ')}</p>}{data.result.warnings.length>0&&<p className="alert warning">{data.result.warnings.join(' · ')}</p>}<button className="secondary" disabled={busy||!open||state?.status==='active'} onClick={()=>legacy({action:'calculate'},'Revisión calculada')}>Calcular revisión</button>{data.runs.map((run:any)=><p key={run.id}>{new Date(run.created_at).toLocaleDateString('es-ES')} · {run.id.slice(0,8)} {superuser&&run.source_version===data.campaign.version&&<button className="secondary" disabled={busy||state?.status==='active'} onClick={async()=>{if(await confirm('¿Guardar esta revisión como resultado final y cerrar el ejercicio?'+(data.campaign.year===2027&&(data.result.policyWarnings??[]).length?'\\n\\nAvisos de RR. HH. que quedarán revisados y registrados a tu nombre:\\n'+data.result.policyWarnings.map((w:any)=>'— '+w.message).join('\\n'):'')))legacy({action:'publish',runId:run.id,reviewedWarnings:(data.result.policyWarnings??[]).map((w:any)=>w.code)},'Revisión final publicada');}}>Guardar resultado final</button>}</p>)}</details>}
 </>;
}











