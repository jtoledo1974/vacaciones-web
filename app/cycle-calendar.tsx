'use client';
export const formatDate=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('es-ES',{day:'numeric',month:'short'});
const months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
export default function CycleCalendar({year,cycles,selected,onSelect,busy=false,highlighted=[]}:any){
 return <section className="panel calendar-panel"><div className="section-head"><div><h2>Elige en el calendario</h2><p>Pulsa cualquier día de un ciclo para ver su baremo y ocupación.</p></div><div className="legend"><span><i className="awarded"/>Con elecciones</span><span><i className="free"/>Inicio de ciclo</span></div></div><div className="calendar-grid">{months.map((month,m)=>{
  const days=new Date(Date.UTC(year,m+1,0)).getUTCDate(),offset=(new Date(Date.UTC(year,m,1)).getUTCDay()+6)%7;
  return <div className="month" key={month}><h3>{month}<span>{String(m+1).padStart(2,'0')}</span></h3><div className="days">{'LMXJVSD'.split('').map((d,i)=><span className="day-label" key={'h'+i}>{d}</span>)}{Array.from({length:offset},(_,i)=><span key={'o'+i}/>)}{Array.from({length:days},(_,i)=>{
   const date=`${year}-${String(m+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`,cycle=cycles.find((c:any)=>c.date<=date&&c.end>=date);
   return <button key={date} disabled={!cycle||busy} className={'day '+(cycle?.occupied?'has-award':'')+(cycle?.date===date?' cycle-start':'')+(selected.includes(cycle?.date)?' selected':'')+(highlighted.includes(cycle?.date)?' person-vacation':'')} aria-label={cycle?`${date}: ciclo ${cycle.date}, ${Math.max(0,cycle.max-cycle.occupied)} plazas, ${cycle.score} puntos`:date+': sin ciclo'} title={cycle?`${formatDate(cycle.date)} – ${formatDate(cycle.end)} · ${cycle.score} puntos · ${cycle.occupied}/${cycle.max} plazas`:''} onClick={()=>onSelect(cycle)}>{i+1}{cycle?.date===date&&<span/>}</button>;
  })}</div></div>;
 })}</div><div className="calendar-bottom">La disponibilidad se comprueba de nuevo al confirmar una elección.</div></section>;
}


