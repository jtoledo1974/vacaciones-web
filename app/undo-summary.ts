export type UndoSummary={action:string;memberId:string|null;at:string|null;choices:{memberId:string;date:string}[]};

/** The confirmation for «Deshacer», naming the exact change it reverts. */
export function undoQuestion(summary:UndoSummary|null|undefined,codeFor:(id:string)=>string,formatDate:(date:string)=>string):string{
 const tail=' Se restaurarán la cola y la ocupación anteriores; las listas de preferencias guardadas después se conservan.';
 if(!summary)return '¿Deshacer el último cambio de elección, incluyendo cola y ocupación?';
 const who=summary.memberId?codeFor(summary.memberId):'';
 const byMember=new Map<string,string[]>();
 for(const c of summary.choices)byMember.set(c.memberId,[...(byMember.get(c.memberId)??[]),formatDate(c.date)]);
 const awarded=[...byMember].map(([id,dates])=>codeFor(id)+' ('+dates.join(', ')+')').join(', ');
 const what=awarded
  ?(summary.action==='advance'?'la adjudicación automática de ':'la adjudicación de ')+awarded
  :summary.action==='preferences'&&who?'la lista de preferencias de '+who
  :summary.action==='defer'&&who?'el aplazamiento de '+who
  :summary.action==='start'?'el inicio de la elección'
  :['pause','resume','resume_automatic'].includes(summary.action)?'la pausa o reanudación de los automatismos'
  :'el último cambio de elección';
 const at=summary.at?new Date(summary.at):null;
 const time=at&&!Number.isNaN(at.getTime())?' ('+at.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'})+')':'';
 return '¿Deshacer '+what+time+'?'+tail;
}
