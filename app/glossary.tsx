'use client';

/** Plain-language meanings of the words the election screen uses (#64). */
const terms: [string, string][] = [
  ['Ciclo', 'Bloque de 8 días de vacaciones. Cada persona elige normalmente 6 ciclos al año.'],
  ['Ronda', 'Vuelta completa de turnos. En cada ronda cada persona elige un ciclo, en el orden de la lista.'],
  ['Turno', 'Tu momento de elegir dentro de una ronda. Mientras no eliges, la elección espera.'],
  [
    'Puntos (baremo)',
    'Valor de cada ciclo según su época: los más solicitados puntúan más. La suma de tus puntos de este año fija tu orden el año que viene: quien menos puntos tiene, elige antes.',
  ],
  [
    'Plazas libres',
    'Cuántas personas más pueden coger ese ciclo sin romper las normas del reparto. Si alguien lo coge, pueden cambiar también las plazas de otros ciclos.',
  ],
  [
    'Por confirmar (?)',
    'La aplicación no ha podido demostrar si esa plaza respeta las normas: puede estar libre o bloqueada, y esperar no lo resuelve. Al confirmar se vuelve a comprobar y, si sigue sin demostrarse, no se adjudica.',
  ],
  ['Verano', 'Ciclos marcados con la barra dorada. Tienen normas propias de reparto.'],
  [
    'Preferencias',
    'Tu lista ordenada de ciclos. Si las guardas, al llegar tu turno se elige automáticamente el primero disponible, sin que tengas que estar conectado.',
  ],
  ['Aplazar', 'Dejar pasar tu turno en una ronda para elegir dos (o tres) ciclos juntos en la siguiente.'],
  ['Turno conjunto', 'Dos o tres personas eligen a la vez, cuando llega el turno de la última de ellas.'],
  [
    'Sorteo de empate',
    'Si varias personas tienen la misma puntuación, un sorteo decide su orden, que luego va rotando en cada ronda.',
  ],
];

export default function Glossary() {
  return (
    <details id="glosario" className="panel glossary">
      <summary>ⓘ ¿Qué significa…?</summary>
      <dl>
        {terms.map(([term, meaning]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
