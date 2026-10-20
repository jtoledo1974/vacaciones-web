'use client';
import {useMemo,useState} from 'react';

export const formatDate=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('es-ES',{day:'numeric',month:'short'});
const months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type Cycle={date:string;end:string;score:number;period:number;occupied:number;max:number};
type Award={id:string;member_id:string;cycle_date:string};
type Member={id:string;code:string};
type View='map'|'calendar'|'members';
type Props={year:number;cycles:Cycle[];selected:string[];onSelect:(cycle:Cycle)=>void;preferenceMode?:boolean;busy?:boolean;highlighted?:string[];awards?:Award[];members?:Member[];order?:string[];points?:{member_id:string;points:number;cycles:number}[]};

function slots(c:Cycle){return Math.max(0,c.max-c.occupied);}
function availabilityClass(c:Cycle){return 'vac2-free-'+Math.min(4,slots(c));}
function isSummer(c:Cycle){return c.period===1;}
function monthIndex(date:string){return Number(date.slice(5,7))-1;}
function cycleTitle(c:Cycle){return formatDate(c.date)+' – '+formatDate(c.end)+' · '+c.score+' puntos · '+slots(c)+' plazas libres';}

export default function CycleCalendar({year,cycles,selected,onSelect,preferenceMode=false,busy=false,highlighted=[],awards=[],members=[],order=[],points=[]}:Props){
 const [view,setView]=useState<View>('map');
 const [activeMonth,setActiveMonth]=useState(0);
 const byDate=useMemo(()=>new Map(cycles.map(c=>[c.date,c])),[cycles]);
 const byId=useMemo(()=>new Map(members.map(m=>[m.id,m.code])),[members]);
 const holders=useMemo(()=>{
  const out=new Map<string,string[]>();
  for(const a of awards){const names=out.get(a.cycle_date)??[];names.push(byId.get(a.member_id)??'?');out.set(a.cycle_date,names);}
  return out;
 },[awards,byId]);
 const membersOrder=useMemo(()=>{
  const ids=[...order,...members.map(m=>m.id)];
  return [...new Set(ids)].filter(id=>byId.has(id));
 },[order,members,byId]);
 const byMonth=useMemo(()=>months.map((_,m)=>cycles.filter(c=>monthIndex(c.date)===m)),[cycles]);
 const monthDates=useMemo(()=>months.map((_,m)=>{
  const result:(Cycle|null)[]=[];
  const offset=(new Date(Date.UTC(year,m,1)).getUTCDay()+6)%7;
  for(let i=0;i<offset;i++)result.push(null);
  const days=new Date(Date.UTC(year,m+1,0)).getUTCDate();
  for(let day=1;day<=days;day++){
   const date=new Date(Date.UTC(year,m,day)).toISOString().slice(0,10);
   result.push(cycles.find(c=>c.date<=date&&date<=c.end)??null);
  }
  return result;
 }),[year,cycles]);
 const codesFor=(date:string)=>holders.get(date)??[];
 function renderCycle(c:Cycle){
  const free=slots(c),people=codesFor(c.date);
  return <button type="button" key={c.date} data-cycle-date={c.date} disabled={busy} onClick={()=>onSelect(c)}
   aria-pressed={selected.includes(c.date)}
   aria-label={cycleTitle(c)+(people.length?' · '+people.join(', '):'')}
   title={cycleTitle(c)}
   className={'vac2-cycle '+availabilityClass(c)+(isSummer(c)?' vac2-summer':'')+(selected.includes(c.date)?' vac2-selected':'')+(highlighted.includes(c.date)?' vac2-person':'')}>
    <span className="vac2-line"><b>{formatDate(c.date)} – {formatDate(c.end)}</b><b>{free} libres</b></span>
    <span className="vac2-line vac2-cycle-sub"><span>{c.score} pt</span><span>{c.occupied}/{c.max} ocupadas</span></span>
    {preferenceMode&&selected.includes(c.date)&&<span className="vac2-preference-rank">Preferencia {selected.indexOf(c.date)+1}</span>}
    {people.length>0&&<span className="vac2-names" title={people.join(', ')}>{people.join(' · ')}</span>}
   </button>;
 }
 function renderMonth(m:number,detail:boolean){
  const monthCycles=byMonth[m];
  return <section key={m} className="vac2-month" aria-label={months[m]}>
   <h3>{months[m]}</h3>
   {detail?<>
    <div className="vac2-weekdays">{'LMXJVSD'.split('').map((d,i)=><span key={i}>{d}</span>)}</div>
    <div className="vac2-days">{monthDates[m].map((c,i)=>{
     if(!c)return <span key={'pad-'+i}/>;
     const day=i-((new Date(Date.UTC(year,m,1)).getUTCDay()+6)%7)+1;
     const first=c.date===new Date(Date.UTC(year,m,day)).toISOString().slice(0,10);
     return <button type="button" key={i} data-cycle-date={c.date} disabled={busy} onClick={()=>onSelect(c)}
      className={'vac2-day '+availabilityClass(c)+(isSummer(c)?' vac2-summer':'')+(selected.includes(c.date)?' vac2-selected':'')+(first?' vac2-cycle-start':'')}
      aria-pressed={selected.includes(c.date)}
      title={cycleTitle(c)} aria-label={day+' '+months[m]+': '+cycleTitle(c)}>{day}</button>;
    })}</div>
    <div className="vac2-month-people">{cycles.filter(c=>c.date<=new Date(Date.UTC(year,m+1,0)).toISOString().slice(0,10)&&c.end>=new Date(Date.UTC(year,m,1)).toISOString().slice(0,10)).map(c=>
     <button type="button" className="vac2-occupants" key={c.date} onClick={()=>onSelect(c)} disabled={busy}>
      <b>{formatDate(c.date)}</b><span>{codesFor(c.date).join(' · ')||'Sin adjudicar'}</span>
     </button>
    )}</div>
   </>:<div className="vac2-cycles">{monthCycles.map(renderCycle)}</div>}
  </section>;
 }
 function renderMembers(){
  return <div className="vac2-members-wrap">
   <p className="muted">Cada fila muestra hasta seis ciclos por CTA, ordenados por fecha de vacaciones, no por turno de petición.</p>
   <div className="vac2-members-desktop table-wrap"><table><thead><tr><th>CTA</th>{Array.from({length:6},(_,i)=><th key={i}>C{i+1}</th>)}<th>Pts</th></tr></thead><tbody>{membersOrder.map(id=>{
    const entries=awards.filter(a=>a.member_id===id).map(a=>byDate.get(a.cycle_date)).filter((c):c is Cycle=>!!c).sort((a,b)=>a.date.localeCompare(b.date));
    const p=points.find(p=>p.member_id===id);
    return <tr key={id}><th>{byId.get(id)}</th>{Array.from({length:6},(_,i)=><td key={i}>{entries[i]?<button type="button" className="vac2-date-link" onClick={()=>onSelect(entries[i])}>{formatDate(entries[i].date)}</button>:'—'}</td>)}<td>{p?.points??entries.reduce((s,c)=>s+c.score,0)}</td></tr>;
   })}</tbody></table></div>
   <div className="vac2-members-mobile">{membersOrder.map(id=>{
    const entries=awards.filter(a=>a.member_id===id).map(a=>byDate.get(a.cycle_date)).filter((c):c is Cycle=>!!c).sort((a,b)=>a.date.localeCompare(b.date));
    return <details key={id} className="vac2-member-card"><summary><b>{byId.get(id)}</b><span>{entries.length} ciclos · {points.find(p=>p.member_id===id)?.points??0} pt</span></summary>
     <div>{entries.length?entries.map(c=><button type="button" className="vac2-member-cycle" key={c.date} onClick={()=>onSelect(c)}>{formatDate(c.date)} – {formatDate(c.end)} · {c.score} pt</button>):<p className="muted">Sin ciclos adjudicados</p>}</div>
    </details>;
   })}</div>
  </div>;
 }
 return <section className="panel vac2-panel" aria-label="Calendario de ciclos">
  <div className="vac2-heading">
   <div><h2>Disponibilidad y baremo</h2><p className="muted">{preferenceMode?'Pulsa ciclos para añadirlos a tu lista. Revisa el orden y guarda para confirmarla.':'Selecciona cualquier ciclo para ver detalles y ocupantes.'}</p></div>
   <div className="vac2-view-switch" role="group" aria-label="Vista del calendario">
    <button type="button" className={view==='map'?'active':''} aria-pressed={view==='map'} onClick={()=>setView('map')}>Mapa</button>
    <button type="button" className={view==='calendar'?'active':''} aria-pressed={view==='calendar'} onClick={()=>setView('calendar')}>Meses</button>
    <button type="button" className={view==='members'?'active':''} aria-pressed={view==='members'} onClick={()=>setView('members')}>Por CTA</button>
   </div>
  </div>
  <div className="vac2-legend" aria-label="Leyenda de plazas disponibles">
   <b>Plazas libres</b>{[4,3,2,1,0].map(n=><span key={n}><i className={'vac2-key vac2-free-'+n}/>{n===4?'4+':n}</span>)}
   <span className="vac2-legend-summer"><i className="vac2-summer-key"/>Verano ENAIRE</span>
  </div>
  {view==='map'&&<div className="vac2-month-grid vac2-map">{months.map((_,m)=>renderMonth(m,false))}</div>}
  {view==='calendar'&&<>
   <div className="vac2-month-nav"><button type="button" disabled={activeMonth===0} onClick={()=>setActiveMonth(m=>m-1)}>← Anterior</button><b>{months[activeMonth]}</b><button type="button" disabled={activeMonth===11} onClick={()=>setActiveMonth(m=>m+1)}>Siguiente →</button></div>
   <div className="vac2-month-grid vac2-calendar">{months.map((_,m)=><div className={m===activeMonth?'vac2-active-mobile':'vac2-hidden-mobile'} key={m}>{renderMonth(m,true)}</div>)}</div>
  </>}
  {view==='members'&&renderMembers()}
  <p className="vac2-footnote">El marco dorado indica ciclos de verano según la configuración de la campaña; el color interior indica plazas restantes. El cupo se vuelve a comprobar al confirmar.</p>
 </section>;
}
