'use client';

import { AlertCircle } from 'lucide-react';

type Props = {
  email:string;
  provider:string;
  team:string;
  year:number;
  hasOtherAccess:boolean;
  onPublicView:()=>void;
  onFirebaseSignOut:()=>Promise<void>;
};

/** Explicitly distinguish a valid login from permission to represent a controller. */
export default function CampaignAccessNotice({
  email,provider,team,year,hasOtherAccess,onPublicView,onFirebaseSignOut,
}:Props) {
  return <section className="panel" aria-labelledby="account-access-title">
    <div className="section-head">
      <div>
        <span className="eyebrow">ACCESO PERSONAL NO HABILITADO</span>
        <h2 id="account-access-title"><AlertCircle size={19} aria-hidden="true"/> Tu cuenta no está vinculada a un controlador de esta campaña</h2>
      </div>
    </div>
    <p>Has iniciado sesión correctamente, pero no tienes acceso personal para elegir vacaciones ni guardar preferencias en este equipo.</p>
    <p><strong>Cuenta autenticada:</strong> {email||'Identidad sin correo disponible'}<br/>
      <strong>Campaña:</strong> Equipo {team} · {year}</p>
    <p>{hasOtherAccess
      ? 'Tu cuenta puede tener acceso a otro equipo o ejercicio. Selecciona la campaña correspondiente o consulta con su responsable.'
      : 'Pide al responsable del equipo que compruebe el correo de tu cuenta de ChatGPT en la plantilla.'}
      {' '}La vinculación se guarda automáticamente al terminar de editar; comprueba «Todos los cambios guardados» en la plantilla.</p>
    <div className="button-row">
      {provider==='chatgpt'&&<a className="secondary" href="/signout-with-chatgpt?return_to=/" target="_top">Cerrar sesión / cambiar de cuenta</a>}
      {provider==='firebase'&&<button type="button" className="secondary" onClick={()=>void onFirebaseSignOut()}>Cerrar sesión / cambiar de cuenta</button>}
      <button type="button" className="primary" onClick={onPublicView}>Continuar en consulta pública</button>
    </div>
    <p className="muted">La consulta pública permite ver los ciclos y las adjudicaciones, pero no guardar preferencias.</p>
  </section>;
}
