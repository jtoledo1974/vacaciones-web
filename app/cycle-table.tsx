'use client';
import {useMemo,useState} from 'react';
import type {CSSProperties} from 'react';
import type {AvailabilitySnapshot} from '../domain/occupancy';
import {cycleAvailability,slotExplanation} from './cycle-availability-ui';

type Cycle={date:string;end:string;score:number;period:number;occupied:number;max:number;available?:boolean};
type Award={id:string;member_id:string;cycle_date:string};
type Member={id:string;code:string};

type Props={
 year:number;
 /** The campaign has an occupancy engine: show proven availability per slot. */
 ruled:boolean;
 cycles:Cycle[];
 awards:Award[];
 members:Member[];
 selected:string[];
 highlighted:string[];
 preferenceMode:boolean;
 busy:boolean;
 onSelect:(cycle:Cycle)=>void;
 availability?:AvailabilitySnapshot|null;
 notForMe?:string[];
};

function shortDate(iso:string):string{
 return new Date(iso+'T12:00:00Z').toLocaleDateString('es-ES',{day:'numeric',month:'short'}).replaceAll('.','').replaceAll(' ','-');
}

export default function CycleTable({year,ruled,cycles,awards,members,selected,highlighted,preferenceMode,busy,onSelect,availability,notForMe}:Props){
 const blocked=new Set(notForMe??[]);
 const [fontSize,setFontSize]=useState(12);
 const codes=useMemo(()=>new Map(members.map(m=>[m.id,m.code])),[members]);
 const occupants=useMemo(()=>{
  const result=new Map<string,string[]>();
  for(const a of awards)result.set(a.cycle_date,[...(result.get(a.cycle_date)??[]),codes.get(a.member_id)??'?']);
  return result;
 },[awards,codes]);
 const columns=Math.max(4,...cycles.map(c=>Math.max(c.max,c.occupied)));
 const chosen=new Set(selected),marked=new Set(highlighted);
 const styles={'--vac3-font-size':fontSize+'px'} as CSSProperties;
 return <div className={"vac3"+(ruled?" vac3-ruled":"")} style={styles}>
  <div className="vac3-tools">
   <span><strong>{cycles.length}</strong> ciclos · 8 días por ciclo · 1º eligió antes</span>
   <span className="vac3-size-actions">
    <button type="button" onClick={()=>setFontSize(x=>Math.max(12,x-1))} disabled={fontSize<=12} aria-label="Reducir letra de la tabla">A−</button>
    <button type="button" onClick={()=>setFontSize(x=>Math.min(16,x+1))} disabled={fontSize>=16} aria-label="Ampliar letra de la tabla">A+</button>
   </span>
  </div>
  <div className="vac3-scroll" role="region" tabIndex={0} aria-label="Tabla de ciclos de vacaciones; desplaza para consultar todas las filas y columnas">
   <table className="vac3-table">
    <caption className="vac3-sr">Baremo, inicio de cada ciclo y controladores en orden de elección (primera plaza: primera elección)</caption>
    <thead><tr>
     <th scope="col" className="vac3-points">Pts</th>
     <th scope="col" className="vac3-date">Ciclo</th>
     {Array.from({length:columns},(_,i)=><th scope="col" className="vac3-slot" key={i}>{i+1}º</th>)}
    </tr></thead>
    <tbody>
     {cycles.map(c=>{
      const people=occupants.get(c.date)??[],selectedIndex=selected.indexOf(c.date);
      const free=Math.max(0,c.max-c.occupied),extra=free===0&&c.available===true;
      const status=cycleAvailability(c,availability,ruled);
      const label=shortDate(c.date)+' a '+shortDate(c.end)+', '+c.score+' puntos, '+c.occupied+' plazas ocupadas, '+status.description+(extra&&!ruled?', posible cupo adicional':'')+(people.length?', '+people.join(', '):'');
      return <tr key={c.date} className={(c.period===1?'vac3-summer ':'')+(blocked.has(c.date)?'vac3-not-for-me ':'')+(chosen.has(c.date)?'vac3-selected ':'')+(marked.has(c.date)?'vac3-highlight ':'')} onClick={()=>{if(!busy)onSelect(c);}} data-cycle-date={c.date}>
       <td className="vac3-points">{c.score}</td>
       <td className="vac3-date">
        <button type="button" data-cycle-date={c.date} aria-label={label} aria-pressed={chosen.has(c.date)} disabled={busy} title={label} onClick={event=>{event.stopPropagation();onSelect(c);}}>
         <time dateTime={c.date}>{shortDate(c.date)}</time>
         {selectedIndex!==-1&&<span className="vac3-choice-indicator" aria-label={preferenceMode?'Preferencia '+(selectedIndex+1):'Seleccionado '+(selectedIndex+1)}>{preferenceMode?'P'+(selectedIndex+1):'✓'}</span>}
        </button>
       </td>
       {Array.from({length:columns},(_,i)=>{
        const occupant=people[i],slot=status.data?.slots[i];
        const disabled=ruled?slot?.status==='blocked':i>=c.max;
        const unknown=ruled&&(!slot||slot.status==='indeterminate');
        const occupied=Boolean(occupant);
        const add=!ruled&&disabled&&i===c.max&&extra;
        const cellTitle=occupant?'Ocupado por '+occupant:ruled?slotExplanation(slot):add?'Cupo adicional potencial, sujeto a confirmación':disabled?'Cupo no autorizado':'Cupo libre';
        return <td key={i} className={'vac3-slot'+(disabled?' vac3-disabled':'')+(unknown?' vac3-unknown':'')+(occupied?' vac3-occupied':'')} title={cellTitle} aria-label={(i+1)+'ª plaza: '+cellTitle}>
         <span className="vac3-slot-code">{occupant??(unknown?'?':add?'+?':disabled?'×':'')}</span>
        </td>;
       })}
      </tr>;
     })}
    </tbody>
   </table>
  </div>
  {!ruled&&<div className="vac3-legend"><span>× No autorizado · +? Cupo adicional posible</span></div>}
 </div>;
}
