import type { ComponentType } from 'react';
import type { PolicyPresentation } from '../domain/occupancy';

function Rules2027() {
  return (
    <details className="panel" aria-label="Interpretación normativa aplicada a vacaciones 2027">
      <summary>Cómo se aplican los cupos de 2027</summary>
      <p>
        En preverano hay tres extracupos: dos ampliaciones a tres plazas y una a cuatro, o tres ampliaciones a tres.
        Como máximo, un ciclo con cuatro y tres ciclos con una sola persona.
      </p>
      <p>
        En verano hay dos extracupos, de tres o de cuatro plazas; como máximo, dos ciclos con cuatro y dos con una sola
        persona. En postverano hay dos: una ampliación a tres y una a cuatro, o dos a tres; como máximo, un ciclo con
        cuatro y dos con una sola persona. La ampliación a cuatro puede usarse como ampliación a tres, nunca al revés.
        Ningún ciclo puede quedar vacío y los extracupos no pasan de un periodo a otro.
      </p>
      <p>
        RR. HH. fija el total de verano en dos ciclos por persona; el resto del año recibe los demás. Una persona puede
        elegir más o menos de dos en verano, pero el total del equipo no cambia.
      </p>
    </details>
  );
}

/** Rules panels by `PolicyPresentation.explanationId`. */
const EXPLANATIONS: Record<string, ComponentType> = { 'lecs-2027': Rules2027 };

/** The panel that explains the campaign's rules, if its policy has one. */
export default function PolicyExplanation({ presentation }: { presentation: PolicyPresentation | null | undefined }) {
  const Panel = presentation?.explanationId ? EXPLANATIONS[presentation.explanationId] : undefined;
  return Panel ? <Panel /> : null;
}
