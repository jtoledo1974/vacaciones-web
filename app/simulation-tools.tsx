'use client';
export default function SimulationTools({data,busy,create}:any){
 return <section id="simulations-panel" className="panel">
   <h2>Escenarios de simulación</h2>
   <p>Los escenarios son compartidos por todos los administradores de este equipo. Copian la plantilla, las reglas y el orden si está preparado, pero empiezan sin vacaciones ni preferencias privadas reales. En el escenario podrás crear preferencias ficticias para todos los controladores.</p>
   <form className="entry-form" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);create({name:String(form.get('name'))});}}>
    <label>Nombre del escenario<input name="name" required maxLength={60} placeholder="Prueba de empates, turnos dobles…"/></label>
    <button className="primary" disabled={busy}>Crear simulación</button>
   </form>
   <p className="muted">Cambia entre la campaña real y tus simulaciones desde el selector «Escenario» de la cabecera. Reiniciar o eliminar un escenario nunca afecta a la campaña real.</p>
 </section>;
}
