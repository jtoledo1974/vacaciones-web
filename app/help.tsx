'use client';
import {useEffect,useState,Fragment} from 'react';
import {firebaseUser,subscribeFirebaseSession} from './firebase-client';
import {api,apiFetch} from './api-client';
type Doc={id:string;title:string;audience:string;filename:string;content:string};
function Inline({text,documents,select}:{text:string;documents:Doc[];select:(id:string)=>void}){
 return <>{text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i)=>{
  if(part.startsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
  if(part.startsWith('`'))return <code key={i}>{part.slice(1,-1)}</code>;
  const link=part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if(link){const doc=documents.find(d=>d.filename===link[2]);if(doc)return <button key={i} className="help-inline-link" onClick={()=>select(doc.id)}>{link[1]}</button>;if(/^https:\/\//.test(link[2]))return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;return <span key={i}>{link[1]}</span>;}
  return <Fragment key={i}>{part}</Fragment>;
 })}</>;
}
function Markdown({text,documents,select}:{text:string;documents:Doc[];select:(id:string)=>void}){
 const lines=text.replace(/\r/g,'').split('\n'),blocks:any[]=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];if(!line.trim())continue;
  const props={documents,select};
  if(line.startsWith('```')){const code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);blocks.push(<pre key={i}>{code.join('\n')}</pre>);continue;}
  if(line.startsWith('|')){const rows=[];while(i<lines.length&&lines[i].startsWith('|')){const cells=lines[i].split('|').slice(1,-1).map(s=>s.trim());if(!cells.every(s=>/^:?-+:?$/.test(s)))rows.push(cells);i++;}i--;blocks.push(<div className="table-wrap" key={i}><table><thead><tr>{rows[0]?.map((c,n)=><th key={n}><Inline text={c} {...props}/></th>)}</tr></thead><tbody>{rows.slice(1).map((r,n)=><tr key={n}>{r.map((c,k)=><td key={k}><Inline text={c} {...props}/></td>)}</tr>)}</tbody></table></div>);continue;}
  if(/^#{1,3} /.test(line)){const level=line.indexOf(' '),text=line.slice(level+1);blocks.push(level===1?<h2 key={i}>{text}</h2>:<h3 key={i}>{text}</h3>);continue;}
  if(/^(- |\d+\. )/.test(line)){const ordered=/^\d/.test(line),items=[];while(i<lines.length&&(ordered?/^\d+\. /:/^- /).test(lines[i])){items.push(<li key={i}><Inline text={lines[i].replace(/^(- |\d+\. )/,'')} {...props}/></li>);i++;}i--;blocks.push(ordered?<ol key={i}>{items}</ol>:<ul key={i}>{items}</ul>);continue;}
  const paragraph=[line];while(i+1<lines.length&&lines[i+1].trim()&&!/^(#|\||-|\d+\. |```)/.test(lines[i+1]))paragraph.push(lines[++i]);blocks.push(<p key={i}><Inline text={paragraph.join(' ')} {...props}/></p>);
 }
 return <>{blocks}</>;
}
export default function Help(){
 const [documents,setDocuments]=useState<Doc[]>([]),[selected,setSelected]=useState('consulta'),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  const reload=async()=>{
   try{
    const d:any=await api('help',{},'No se pudo cargar la documentación');
    if(active){setDocuments(d);setError('');}
   }catch(e:any){if(active)setError(e.message);}
  };
  const unsubscribe=subscribeFirebaseSession(()=>{void reload();});
  void reload();
  return ()=>{active=false;unsubscribe();};
 },[]);
 const doc=documents.find(d=>d.id===selected)??documents[0];
 return <section className="panel help-panel"><div className="section-head"><div><h2>Ayuda y documentación</h2><p>Guías de consulta y, según tus permisos, instrucciones de gestión y documentación del proyecto.</p></div></div>{error?<div role="alert" className="alert error">{error}</div>:!doc?<p>Cargando documentación…</p>:<><nav className="button-row" aria-label="Documentos de ayuda">{documents.map(d=><button key={d.id} className={d.id===doc.id?'primary':'secondary'} aria-pressed={d.id===doc.id} onClick={()=>setSelected(d.id)}>{d.title}</button>)}</nav><article className="help-document"><div className="section-head"><span className="tag">{doc.audience==='public'?'Consulta pública':'Administración'}</span>{firebaseUser()?<button className="secondary" onClick={async()=>{
  try{
   const r=await apiFetch('help/'+doc.id);
   if(!r.ok)throw new Error('No se pudo descargar el documento');
   const blob=new Blob([await r.text()],{type:'text/markdown'});
   const uri=URL.createObjectURL(blob),a=document.createElement('a');
   a.href=uri;a.download=doc.filename;a.click();setTimeout(()=>URL.revokeObjectURL(uri),1500);
  }catch(e:any){setError(e.message);}
 }}>Descargar {doc.filename}</button>:<a href={'/api/help/'+doc.id} className="secondary">Descargar {doc.filename}</a>}</div><Markdown text={doc.content} documents={documents} select={setSelected}/></article></>}</section>;
}

