'use client';
import {useEffect,useMemo,useState} from 'react';
import CycleTable from './cycle-table';
import type {AvailabilitySnapshot} from '../domain/availability-2027';
import {cycleAvailability} from './cycle-availability-ui';

export const formatDate=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('es-ES',{day:'numeric',month:'short'});
const months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type Cycle={date:string;end:string;score:number;period:number;occupied:number;max:number;available?:boolean};
type Award={id:string;member_id:string;cycle_date:string};
type Member={id:string;code:string};
type View='map'|'calendar'|'members'|'table';
type Props={year:number;cycles:Cycle[];selected:string[];onSelect:(cycle:Cycle)=>void;preferenceMode?:boolean;busy?:boolean;highlighted?:string[];awards?:Award[];members?:Member[];order?:string[];points?:{member_id:string;points:number;cycles:number}[];availability?:AvailabilitySnapshot|null;notForMe?:string[];glossary?:boolean};

function slots(c:Cycle){return Math.max(0,c.max-c.occupied);}
function extraAvailable(c:Cycle){return slots(c)===0&&c.available===true;}
function isSummer(c:Cycle){return c.period===1;}
function monthIndex(date:string){return Number(date.slice(5,7))-1;}
function cycleTitle(c:Cycle,year:number,availability?:AvailabilitySnapshot|null){
 const status=cycleAvailability(c,availability,year);
 return formatDate(c.date)+' – '+formatDate(c.end)+' · '+c.score+' puntos · '+status.description;
}

export default function CycleCalendar({year,cycles,selected,onSelect,preferenceMode=false,busy=false,highlighted=[],awards=[],members=[],order=[],points=[],availability,notForMe,glossary=false}:Props){
 // On one's own turn, cycles one cannot take are marked up front rather than discovered by tapping.
 const blocked=new Set(notForMe??[]);
 const [view,setView]=useState<View>('map');
 useEffect(()=>{
  try{
   const stored=document.cookie.split('; ').find(part=>part.startsWith('vacaciones_cycle_view='))?.split('=').slice(1).join('=');
   const choice=stored?decodeURIComponent(stored):localStorage.getItem('vacaciones_cycle_view');
   if(choice==='table'||choice==='map'||choice==='calendar'||choice==='members')setView(choice);
  }catch{ /* La vista sigue disponible si el navegador bloquea el almacenamiento. */ }
 },[]);
 function changeView(next:View){
  setView(next);
  try{
   document.cookie='vacaciones_cycle_view='+encodeURIComponent(next)+'; Max-Age=31536000; Path=/; SameSite=Lax';
   localStorage.setItem('vacaciones_cycle_view',next);
  }catch{ /* La vista funciona sin cookies. */ }
 }
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
  const free=slots(c),people=codesFor(c.date),status=cycleAvailability(c,availability,year);
  return <button type="button" key={c.date} data-cycle-date={c.date} disabled={busy} onClick={()=>onSelect(c)}
   aria-pressed={selected.includes(c.date)}
   aria-label={cycleTitle(c,year,availability)+(people.length?' · '+people.join(', '):'')}
   title={cycleTitle(c,year,availability)}
   className={'vac2-cycle '+status.className+(blocked.has(c.date)?' vac2-not-for-me':'')+(isSummer(c)?' vac2-summer':'')+(selected.includes(c.date)?' vac2-selected':'')+(highlighted.includes(c.date)?' vac2-person':'')}>
    <span className="vac2-line"><b>{formatDate(c.date)} – {formatDate(c.end)}</b><b>{blocked.has(c.date)?'No disponible para ti':year===2027?(status.label==='?'?'? por confirmar':status.label==='1'?'1 libre':status.label+' libres'):extraAvailable(c)?'Cupo adicional posible':free+' libres'}</b></span>
    <span className="vac2-line vac2-cycle-sub"><span>{c.score} pt</span><span>{c.occupied}/{c.max} ocupadas{extraAvailable(c)?' · ampliable':''}</span></span>
    {preferenceMode&&selected.includes(c.date)&&<span className="vac2-preference-rank">Preferencia {selected.indexOf(c.date)+1}</span>}
    {people.length>0&&<span className="vac2-names" title={people.join(', ')}>{people.join(' · ')}</span>}
   </button>;
 }
 function renderMonth(m:number,detail:boolean){
  const monthCycles=byMonth[m];
  return <section key={m} className="vac2-month" aria-label={months[m]} id={detail?undefined:'vac2-map-month-'+m}>
   <h3>{months[m]}</h3>
   {detail?<>
    <div className="vac2-weekdays">{'LMXJVSD'.split('').map((d,i)=><span key={i}>{d}</span>)}</div>
    <div className="vac2-days">{monthDates[m].map((c,i)=>{
     if(!c)return <span key={'pad-'+i}/>;
     const day=i-((new Date(Date.UTC(year,m,1)).getUTCDay()+6)%7)+1;
     const first=c.date===new Date(Date.UTC(year,m,day)).toISOString().slice(0,10);
     const status=cycleAvailability(c,availability,year);
     return <button type="button" key={i} data-cycle-date={c.date} disabled={busy} onClick={()=>onSelect(c)}
      className={'vac2-day '+status.className+(blocked.has(c.date)?' vac2-not-for-me':'')+(isSummer(c)?' vac2-summer':'')+(selected.includes(c.date)?' vac2-selected':'')+(first?' vac2-cycle-start':'')}
      aria-pressed={selected.includes(c.date)}
      title={cycleTitle(c,year,availability)} aria-label={day+' '+months[m]+': '+cycleTitle(c,year,availability)}>{day}{year===2027&&first&&<small className="vac2-day-count" aria-hidden="true">{status.label}</small>}</button>;
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
    return <details key={id} className="vac2-member-card"><summary><b>{byId.get(id)}</b><span>{entries.length===1?'1 ciclo':entries.length+' ciclos'} · {points.find(p=>p.member_id===id)?.points??0} pt</span></summary>
     <div>{entries.length?entries.map(c=><button type="button" className="vac2-member-cycle" key={c.date} onClick={()=>onSelect(c)}>{formatDate(c.date)} – {formatDate(c.end)} · {c.score} pt</button>):<p className="muted">Sin ciclos adjudicados</p>}</div>
    </details>;
   })}</div>
  </div>;
 }
 return <section className={"panel vac2-panel"+(year===2027?" vac2-year-2027":"")} aria-label="Calendario de ciclos">
  <div className="vac2-heading">
   <div><h2>Disponibilidad y baremo</h2>{!preferenceMode&&<p className="muted">Selecciona cualquier ciclo para ver detalles y ocupantes.</p>}</div>
   <div className="vac2-view-switch" role="group" aria-label="Vista del calendario">
    <button type="button" className={view==='table'?'active':''} aria-pressed={view==='table'} onClick={()=>changeView('table')}>Tabla</button>
    <button type="button" className={view==='map'?'active':''} aria-pressed={view==='map'} onClick={()=>changeView('map')}>Mapa</button>
    <button type="button" className={view==='calendar'?'active':''} aria-pressed={view==='calendar'} onClick={()=>changeView('calendar')}>Meses</button>
    <button type="button" className={view==='members'?'active':''} aria-pressed={view==='members'} onClick={()=>changeView('members')}>Por CTA</button>
   </div>
  </div>
  {/* One legend for every view (#64): same colours, same words. */}
  <div className="vac2-legend" aria-label="Leyenda de plazas disponibles">
   {view==='table'
    ?<><span><i className="vac3-key vac3-key-free"/>Plaza libre</span><span><i className="vac3-key vac3-key-occupied"/>Ocupada (código)</span><span><i className="vac2-key vac2-free-0"/>Sin plaza</span></>
    :<><b>Plazas libres</b>{[4,3,2,1,0].map(n=><span key={n}><i className={'vac2-key vac2-free-'+n}/>{n}</span>)}</>}
   {year===2027&&<span><i className="vac2-key vac2-unknown"/>? Por confirmar</span>}
   <span className="vac2-legend-summer"><i className="vac2-summer-key"/>Verano</span>
   {glossary&&<a className="vac2-glossary-link" href="#glosario" onClick={()=>{const g=document.getElementById('glosario') as HTMLDetailsElement|null;if(g)g.open=true;}}>ⓘ Qué significa</a>}
   <span><i className="vac2-selection-key"/>{preferenceMode?'Tus preferencias':'Tu selección'}</span>
  </div>
  {view==='table'&&<CycleTable year={year} cycles={cycles} awards={awards} members={members} selected={selected} highlighted={highlighted} preferenceMode={preferenceMode} busy={busy} onSelect={onSelect} availability={availability} notForMe={notForMe}/>}
  {view==='map'&&<nav className="vac2-month-jump" aria-label="Ir al mes">{months.map((name,m)=>byMonth[m].length>0&&<button type="button" key={m}
   onClick={()=>document.getElementById('vac2-map-month-'+m)?.scrollIntoView({behavior:'smooth',block:'start'})}>{name.slice(0,3)}</button>)}</nav>}
  {view==='map'&&<div className="vac2-month-grid vac2-map">{months.map((_,m)=>renderMonth(m,false))}</div>}
  {view==='calendar'&&<>
   <div className="vac2-month-nav"><button type="button" disabled={activeMonth===0} onClick={()=>setActiveMonth(m=>m-1)}>← Anterior</button><b>{months[activeMonth]}</b><button type="button" disabled={activeMonth===11} onClick={()=>setActiveMonth(m=>m+1)}>Siguiente →</button></div>
   <div className="vac2-month-grid vac2-calendar">{months.map((_,m)=><div className={m===activeMonth?'vac2-active-mobile':'vac2-hidden-mobile'} key={m}>{renderMonth(m,true)}</div>)}</div>
  </>}
  {view==='members'&&renderMembers()}
  <p className="vac2-footnote">{year===2027
   ?'Las plazas libres tienen en cuenta las normas del reparto: si una persona coge un ciclo, puede reducir las de otros. «?» significa que aún se está calculando; no es un bloqueo. Los nombres aparecen por orden de elección. Pulsa un ciclo para ver el detalle.'
   :'Un ciclo completo puede admitir un cupo adicional si está autorizado; se comprueba al confirmar.'}</p>
 </section>;
}
