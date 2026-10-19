'use client';
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
type Confirm=(message:string,requiredText?:string)=>Promise<boolean>;
type Pending={message:string;requiredText?:string;resolve:(answer:boolean)=>void};
const Context=createContext<Confirm|null>(null);
export function useConfirmation(){const confirm=useContext(Context);if(!confirm)throw new Error('ConfirmationProvider is required');return confirm;}
export function ConfirmationProvider({children}:{children:ReactNode}){
 const [pending,setPending]=useState<Pending|null>(null),[value,setValue]=useState(''),cancel=useRef<HTMLButtonElement>(null),previous=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  if(!pending)return;
  const sheet=document.querySelector<HTMLElement>('.preference-sheet-backdrop');
  if(sheet)sheet.inert=true;
  setValue('');cancel.current?.focus();
  return ()=>{if(sheet)sheet.inert=false;};
 },[pending]);
 const finish=(answer:boolean)=>{
  const sheet=document.querySelector<HTMLElement>('.preference-sheet-backdrop');if(sheet)sheet.inert=false;
  pending?.resolve(answer);setPending(null);previous.current?.focus();
 };
 const confirm:Confirm=(message,requiredText)=>new Promise(resolve=>{previous.current=document.activeElement as HTMLElement;setPending({message,requiredText,resolve});});
 return <Context.Provider value={confirm}>{children}{pending&&<div className="confirmation-backdrop"><div className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" onKeyDown={event=>{if(event.key==='Escape')finish(false);if(event.key==='Tab'){const buttons=event.currentTarget.querySelectorAll<HTMLElement>('button,input'),first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}><h2 id="confirmation-title">Confirmar cambio</h2><p>{pending.message}</p>{pending.requiredText&&<label>Escribe {pending.requiredText}<input aria-label="Confirmación del equipo y año" value={value} onChange={event=>setValue(event.target.value)} autoComplete="off"/></label>}<div className="button-row"><button ref={cancel} className="secondary" onClick={()=>finish(false)}>Cancelar</button><button className="primary" disabled={!!pending.requiredText&&value!==pending.requiredText} onClick={()=>finish(true)}>Confirmar</button></div></div></div>}</Context.Provider>;
}
