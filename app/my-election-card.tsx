'use client';
import {Bell} from 'lucide-react';
import {formatDate} from './cycle-calendar';
import type {MyElection} from './my-election-state';

const listText:Record<MyElection['list']['state'],string>={
 none:'Sin lista: nadie elegirá por ti.',
 'active-next':'Tu lista elegirá por ti en tu próximo turno.',
 'active-all':'Tu lista elegirá por ti en todos tus turnos.',
 used:'Tu lista ya se usó y está inactiva: no elegirá por ti.',
 paused:'Tu lista está guardada; los automatismos están detenidos.',
};

/** The controller's own situation, first on the page: turn, cycles and list. */
export default function MyElectionCard({me,onChoose,onList}:{me:MyElection;onChoose:()=>void;onList:()=>void}){
 const turn=me.phase==='my-turn';
 const headline=turn?'Es tu turno'
  :me.phase==='waiting'?(me.turnsAhead===0?'Eres el siguiente':me.turnsAhead!==null?`Faltan ${me.turnsAhead} turnos para el tuyo`:'Esperando tu turno')
  :me.phase==='paused'?'La elección está en pausa'
  :me.phase==='not-started'?'La elección aún no ha empezado'
  :'Ya tienes todas tus vacaciones';
 const sub=turn?`Elige ${me.needed===1?'1 ciclo':me.needed+' ciclos'} en el calendario.`
  :me.phase==='waiting'&&me.turnsAhead!==null?'Estimación: los turnos conjuntos y aplazamientos pueden cambiarla.'
  :'';
 const lost=me.list.entries.filter(e=>!e.mine&&e.free===0).length;
 return <section className={'panel my-election'+(turn?' is-my-turn':'')} aria-label="Mi elección">
  <div className="my-election-head">
   <div><span className="my-election-kicker">MI ELECCIÓN{me.round?` · RONDA ${me.round}`:''}</span>
    <h2>{headline}</h2>{sub&&<p>{sub}</p>}</div>
   {turn&&<button type="button" className="primary my-election-cta" onClick={onChoose}>Elegir ahora</button>}
  </div>
  <div className="my-election-row">
   <strong>Mis vacaciones · {me.cycles.length}/{me.entitlement}</strong>
   {me.cycles.length?<div className="my-election-chips">{me.cycles.map(c=><span key={c.date}>{formatDate(c.date)} – {formatDate(c.end)}</span>)}</div>
    :<span className="my-election-quiet">Todavía ninguna.</span>}
  </div>
  <div className={'my-election-row my-election-list is-'+me.list.state}>
   <div><strong>{listText[me.list.state]}</strong>
    {me.list.entries.length>0&&<span className="my-election-quiet">{me.list.entries.length} opciones{lost?` · ${lost} sin plazas`:''}{me.list.firstViable?` · primera disponible: ${formatDate(me.list.firstViable)}`:''}</span>}</div>
   <button type="button" className="secondary" onClick={onList}>{me.list.state==='none'?'Preparar mi lista':me.list.state==='used'?'Reactivar mi lista':'Revisar mi lista'}</button>
  </div>
  <a className="my-election-notify" href="/notificaciones"><Bell size={16} aria-hidden="true"/>Avísame cuando me toque</a>
 </section>;
}
