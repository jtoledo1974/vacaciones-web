export type HelpDocument={id:string;title:string;audience:'public'|'admin';filename:string;content:string};
export function helpDocuments(role:string,documents:HelpDocument[]){return documents.filter(d=>d.audience==='public'||role==='superadmin'||role==='team_admin');}
