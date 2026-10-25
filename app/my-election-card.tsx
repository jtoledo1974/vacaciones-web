'use client';
import {useEffect,useState} from 'react';
import {Bell} from 'lucide-react';
import {formatDate} from './cycle-calendar';
import {aheadNote,type MyElection} from './my-election-state';

const listText:Record<MyElection['list']['state'],string>={
 none:'No tienes preferencias guardadas: en tu turno tendrás que elegir tú.',
 'active-next':'En tu próximo turno se elegirá automáticamente de tus preferencias.',
 'active-all':'En todos tus turnos se elegirá automáticamente de tus preferencias.',
 used:'Tus preferencias ya se usaron: en tu próximo turno no se elegirá de ellas.',
 paused:'Preferencias guardadas, pero la elección automática está detenida.',
};

export type AutoPick={id:string;round:number;dates:{date:string;end:string}[]};

const listShort:Record<MyElection['list']['state'],string>={none:'sin preferencias','active-next':'preferencias para tu próximo turno','active-all':'preferencias para todos tus turnos',used:'preferencias ya usadas',paused:'elección automática detenida'};

/** The controller's own situation, first on the page: turn, cycles and list.
 * compact: a one-line summary that unfolds, for managers running the table while it is not their turn. */
export default function MyElectionCard({me,autoPick,onChoose,onList,onSimulate,compact=false}:{me:MyElection;autoPick?:AutoPick|null;onChoose:()=>void;onList:()=>void;onSimulate?:()=>void;compact?:boolean}){
 // An automatic pick stays visible until dismissed on this device: it may have happened while away.
 const [dismissed,setDismissed]=useState(true);
 useEffect(()=>{
  try{setDismissed(!autoPick||localStorage.getItem('vacaciones_auto_seen')===autoPick.id);}
  catch{setDismissed(!autoPick);}
 },[autoPick?.id]);
 function dismiss(){
  setDismissed(true);
  try{if(autoPick)localStorage.setItem('vacaciones_auto_seen',autoPick.id);}catch{/* Solo en esta sesión. */}
 }
 const turn=me.phase==='my-turn';
 const headline=turn?'Es tu turno'
  :me.phase==='waiting'?(/* turnsAhead includes whoever is choosing right now. */
   me.turnsAhead!==null&&me.turnsAhead<=1?'Eres el siguiente':me.turnsAhead!==null?`Faltan ${me.turnsAhead} turnos para el tuyo`:'Esperando tu turno')
  :me.phase==='paused'?'La elección está en pausa'
  :me.phase==='not-started'?'La elección aún no ha empezado'
  :'Ya tienes todas tus vacaciones';
 const sub=turn?`Elige ${me.needed===1?'1 ciclo':me.needed+' ciclos'} en el calendario.`
  :me.phase==='waiting'&&me.turnsAhead!==null?'Estimación: los turnos conjuntos y aplazamientos pueden cambiarla.'
  :'';
 const note=aheadNote(me);
 const lost=me.list.entries.filter(e=>!e.mine&&e.free===0).length;
 const body=<>
  <div className="my-election-head">
   <div><span className="my-election-kicker">MI ELECCIÓN{me.round?` · RONDA ${me.round}`:''}</span>
    <h2>{headline}</h2>{sub&&<p>{sub}</p>}</div>
   {turn&&<button type="button" className="primary my-election-cta" onClick={onChoose}>Elegir ahora</button>}
  </div>
  {note&&<p className="my-election-soon">{note}</p>}
  {autoPick&&!dismissed&&<div className="my-election-auto" role="status">
   <span><strong>Se ha elegido por ti de tus preferencias:</strong> {autoPick.dates.map(d=>formatDate(d.date)+' – '+formatDate(d.end)).join(' + ')} · ronda {autoPick.round}.</span>
   <button type="button" className="secondary" onClick={dismiss}>Entendido</button>
  </div>}
  <div className="my-election-row">
   <strong>Mis vacaciones · {me.cycles.length}/{me.entitlement}</strong>
   {me.cycles.length?<div className="my-election-chips">{me.cycles.map(c=><span key={c.date}>{formatDate(c.date)} – {formatDate(c.end)}</span>)}</div>
    :<span className="my-election-quiet">Todavía ninguna.</span>}
  </div>
  <div className={'my-election-row my-election-list is-'+me.list.state}>
   <div><strong>{listText[me.list.state]}</strong>
    {me.list.entries.length>0&&<span className="my-election-quiet">{me.list.entries.length===1?'1 opción':me.list.entries.length+' opciones'}{lost?` · ${lost} sin plazas`:''}{me.list.firstViable?` · primera disponible: ${formatDate(me.list.firstViable)}`:''}</span>}</div>
   <button type="button" className="secondary" onClick={onList}>{me.list.state==='none'?'Preparar mis preferencias':me.list.state==='used'?'Reactivar mis preferencias':'Revisar mis preferencias'}</button>
  </div>
  <a className="my-election-notify" href="/notificaciones"><Bell size={16} aria-hidden="true"/>Avísame cuando me toque</a>
  {onSimulate&&me.phase==='waiting'&&<button type="button" className="secondary my-election-sim" onClick={onSimulate}>¿Qué se me bloquea? Simular</button>}
 </>;
 if(compact)return <details className="panel my-election my-election-compact" aria-label="Mi elección" open={!!autoPick&&!dismissed}>
  <summary><span className="my-election-kicker">Tu elección</span><span>{headline} · {me.cycles.length}/{me.entitlement} · {listShort[me.list.state]}</span></summary>
  {body}
 </details>;
 return <section className={'panel my-election'+(turn?' is-my-turn':'')} aria-label="Mi elección">{body}</section>;
}
