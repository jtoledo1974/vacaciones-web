import type {AvailabilitySnapshot,CycleAvailability,AvailabilitySlot,AvailabilityImpact} from '../domain/availability-2027';

/** The backend, not the visual maximum, determines legal global capacity. */
export function cycleAvailability(cycle:{date:string;occupied:number;max:number},snapshot:AvailabilitySnapshot|null|undefined,year:number){
 const live=year===2027;
 const data=live?snapshot?.cycles?.[cycle.date]:undefined;
 const local=Math.max(0,cycle.max-cycle.occupied);
 if(!live)return {data:null as CycleAvailability|null,label:String(local),description:local+' plazas libres',className:'vac2-free-'+Math.min(4,local)};
 if(!data)return {data:null as CycleAvailability|null,label:'?',description:'Disponibilidad global aún no calculada',className:'vac2-unknown'};
 if(data.status==='invalid')return {data,label:'—',description:'El reparto no admite una completación válida; requiere revisión',className:'vac2-unknown'};
 if(data.status==='indeterminate'){
  const range=data.provenAdditional+'–'+data.possibleAdditionalUpperBound;
  return {data,label:'?',description:'Disponibilidad sin determinar ('+range+' plazas adicionales posibles)',className:'vac2-unknown'};
 }
 return {data,label:String(data.additional),description:data.additional+' plazas adicionales globalmente viables (no garantiza cualquier combinación de personas)',className:'vac2-free-'+data.additional};
}

/** Explain a proven block without promoting a search timeout to an illegality. */
export function slotExplanation(slot:AvailabilitySlot|undefined):string{
 if(!slot)return 'Plaza sin diagnóstico';
 if(slot.status==='occupied')return 'Plaza adjudicada';
 if(slot.status==='available')return 'Adjudicación globalmente posible; la persona concreta se valida al elegir';
 if(slot.status==='indeterminate')return 'Viabilidad indeterminada: '+(slot.reasons.map(r=>r.message).join('; ')||'no se ha demostrado el resultado');
 return slot.reasons.map(r=>r.message).join('; ')||'Bloqueo global demostrado';
}

/** Only describe proven losses: an interval is explicitly uncertain. */
export function describeImpact(impact:AvailabilityImpact):string[]{
 const lines:string[]=[];
 for(const change of impact.changes){
  const old=change.before.additional,now=change.after.additional;
  const heading=change.kind==='directOccupancy'?'Adjudicación directa':'Restricción global';
  if(old!==null&&now!==null){
   const lost=old-now;
   if(lost>0)lines.push(heading+': '+change.cycle+' reduce '+lost+' plaza(s) adicionales ('+old+' → '+now+').');
   else if(lost<0)lines.push(heading+': '+change.cycle+' aumenta '+(-lost)+' plaza(s) adicionales ('+old+' → '+now+').');
  }else{
   lines.push(heading+': '+change.cycle+' cambia con cotas no concluyentes ('+change.before.lower+'–'+change.before.upper+' → '+change.after.lower+'–'+change.after.upper+').');
  }
 }
 const fourth=impact.events.filter(e=>e.code==='SUMMER_FOURTH_LIMIT_REACHED'||e.code==='FOURTH_PERIOD_LIMIT_REACHED');
 for(const event of fourth){
  lines.push(event.period===1?'Alcanzado el límite de ciclos con cuarta plaza en verano; las terceras plazas siguen sujetas a sus propias reglas.':'Alcanzado el límite de ciclos con cuarta plaza de este periodo.');
 }
 for(const event of impact.events.filter(e=>e.code==='EXTRA_THIRD_MARGIN_LOST'))
  lines.push('Se ha reducido el margen para ampliaciones extraordinarias a tercera plaza'+(event.period===0?' en preverano':event.period===2?' en postverano':'')+'.');
 return [...new Set(lines)];
}
