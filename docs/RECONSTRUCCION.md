# Reconstrucción administrativa de elecciones — especificación acordada

Estado: **diseño funcional; pendiente de implementación**. Este documento no implica que la reconstrucción guiada esté disponible en el Site.

## A. Preferencias normales

1. Guardar preferencias equivale a autorizar su asignación automática cuando corresponda. No hay casilla de autorización independiente.
2. Por defecto la lista está vigente hasta completar el **siguiente turno efectivo** del CTA, incluso si previamente aplazó. Una opción explícita permite mantenerla para las rondas restantes.
3. Una adjudicación **manual o automática**, individual o conjunta, consume la lista de un solo turno. Un aplazamiento **no** la consume. La lista queda conservada pero inactiva.
4. Los ciclos con cupo agotado desaparecen de la lista visible, sin borrar ni reordenar la lista original. Si un undo libera cupo, vuelven a aparecer en la misma posición.
5. El administrador y el motor deben respetar el orden de elección y las restricciones de cupo, incluidos los extracupos.
6. Guardar la lista durante el propio turno puede adjudicarlo inmediatamente: mostrar una confirmación clara antes de guardar.

## B. Revisión administrativa

Existen tres operaciones distintas:

- **Undo exacto**: restaura un estado anterior, incluidos cupos, cola, solicitudes originales, adjudicaciones, aplazamientos, preferencias y actas de sorteo.
- **Redo exacto**: repone el estado deshecho sin solicitar nuevas aprobaciones del CTA.
- **Reconstrucción guiada**: vuelve a un punto anterior y puede rehacer las decisiones con cambios. No debe confundirse con el redo exacto.

Durante la reconstrucción:

1. La campaña queda en modo **reconstrucción**; ningún CTA puede editar preferencias ni seleccionar vacaciones.
2. Los automatismos quedan congelados; no se asigna nada sin una acción explícita del administrador durante la sesión.
3. Cualquier administrador del equipo autorizado puede continuar la reconstrucción, también después de cerrar el navegador. No se permite reanudar la elección ordinaria hasta terminar.
4. El administrador puede decidir por los CTA y consultarles **fuera de la aplicación** si lo estima necesario; no se requiere ninguna UI de aprobación para usuarios.
5. El administrador responsable del equipo puede consultar las preferencias históricas necesarias durante la reconstrucción. Este acceso no implica que otras personas puedan consultarlas.
6. El sistema conserva tanto las adjudicaciones originales como las preferencias vigentes **en el instante del turno que se está reconstruyendo**. Las preferencias actuales no reemplazan retrospectivamente a las históricas.
7. Para cada turno se ofrecen: (a) primera preferencia histórica aún válida, (b) elección original, si cabe, y (c) elección o aplazamiento alternativos. La preferencia histórica es sugerencia prioritaria, **no una decisión obligatoria**: el administrador tiene la última palabra.
8. Aplazamientos y turnos conjuntos son decisiones que admiten undo, redo y cambio durante la reconstrucción. Igual los sorteos cuando afecten al orden.
9. Se respeta siempre el orden de prioridad. Permitir adelantarse o confirmar un bloque requiere demostrar que no restringe los derechos de ningún CTA anterior, considerando todos los cupos y extracupos; de lo contrario se bloquea.
10. Las decisiones nuevas crean una rama histórica alternativa; no se borra la rama anterior. Un undo o redo intercalado debe preservar la integridad de todas las ramas.

## C. Cierre y reanudación

- Terminar la reconstrucción **no** reactiva las elecciones automáticas.
- El administrador ve un resumen de decisiones modificadas y un análisis **informativo** de CTA posteriores cuyas preferencias válidas o primera elección prevista hayan cambiado, comparando la situación anterior y la posterior.
- La comparación no adivina preferencias nuevas ni envía notificaciones.
- El administrador revisa la información y, si lo decide, habilita explícitamente los automatismos mediante una acción independiente y confirmada.
- Una reconstrucción puede ser larga y relevarse entre administradores, manteniendo la campaña bloqueada para la elección ordinaria hasta su cierre.

## D. Criterios técnicos de aceptación (pendientes de la fase de reconstrucción)

1. Audit append-only con instantáneas suficientes para recuperar **cada decisión**, aunque una petición original adjudicase varios turnos automáticos en lote.
2. Una sesión duradera de reconstrucción, con versión optimista/CAS para evitar conflictos entre administradores y sin pérdida del punto original ni de las decisiones ya reconstruidas.
3. Acciones exclusivas de administrador para iniciar desde cualquier decisión, cambiar, confirmar, deshacer y rehacer una reconstrucción, finalizar y reactivar **separadamente** la elección automática.
4. Sin edición de preferencias durante la reconstrucción, incluido el propietario de la lista.
5. Restauración atómica de solicitudes originales, premios, ocupación, orden, empates, créditos de aplazamiento y estado de preferencias.
6. Pruebas de backend sobre múltiples undo seguidos, múltiples redo, undo después de parte de los redo, nueva selección tras undo, nuevo undo/redo en la rama, cambio de ronda, cupo liberado, cupo nuevo agotado, preferencia histórica que prevalece sobre elección anterior, persistentes/de turno, conjunto, aplazamiento, empate y operaciones de dos administradores.
7. Un error de validación deja intacto todo el estado de la campaña. Las pruebas comparan instantáneas completas y usan SQLite/D1 real de test además de pruebas puras del motor.
8. Pruebas de autorización: CTA no modifica nada durante reconstrucción; delegado puede ver solo datos históricos de su equipo en modo autorizado; no hay exposición en consulta pública.

## E. Delimitación de implementación

La primera fase del PR #14 incluye vigencia de preferencias, ocultación reversible, migraciones, snapshots y undo/redo lineal multioperación con ramificación histórica en auditoría.

**No incluye todavía** la sesión de reconstrucción multi-ronda, la comparación automática de impacto, la autorización especial a las preferencias históricas ni la pausa explícita de automatismos posterior a la reconstrucción. Esos puntos no pueden considerarse implementados hasta superar los tests indicados.
