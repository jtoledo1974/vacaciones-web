// Criterios Vacaciones 1.1 (2025), "Nuevos CTA", página 3.
export type CompletedCycle={round:number;points:number};
export type HistoricalScore={score:number;source:'six-cycles'|'four-or-five'|'team-average-plus-one';missingRounds:number[]};
export function newcomerScore(completed:CompletedCycle[],teamPointsByRound:number[][]):HistoricalScore{
 if(!Array.isArray(completed)||completed.length>6||new Set(completed.map(c=>c.round)).size!==completed.length||
 completed.some(c=>!Number.isInteger(c.round)||c.round<1||c.round>6||!Number.isFinite(c.points)))
  throw new Error('Ciclos disfrutados no válidos');
 if(teamPointsByRound.length!==6||teamPointsByRound.some(row=>!Array.isArray(row)||!row.length||row.some(p=>!Number.isFinite(p))))
  throw new Error('Faltan puntuaciones del equipo para las seis rondas');
 const missingRounds=[1,2,3,4,5,6].filter(r=>!completed.some(c=>c.round===r));
 const sum=completed.reduce((n,c)=>n+c.points,0);
 if(completed.length===6)return {score:sum,source:'six-cycles',missingRounds:[]};
 if(completed.length>=4){
  // The criteria explicitly impute round 6, or rounds 5 and 6, regardless
  // of how the incoming controller's completed cycles are labelled.
  const missing=completed.length===5?[6]:[5,6];
  const imputed=missing.reduce((n,r)=>n+average(teamPointsByRound[r-1]),0);
  return {score:sum+imputed,source:'four-or-five',missingRounds:missing};
 }
 const totals=teamPointsByRound[0].map((_,i)=>teamPointsByRound.reduce((n,round)=>n+round[i],0));
 if(teamPointsByRound.some(row=>row.length!==totals.length))throw new Error('Cada ronda debe contener los mismos controladores');
 return {score:average(totals)+1,source:'team-average-plus-one',missingRounds};
}
const average=(values:number[])=>values.reduce((s,v)=>s+v,0)/values.length;
