# Reconstrucción administrativa de elecciones — especificación acordada

Estado: **implementación en el PR #20, todavía pendiente de fusión y despliegue**. La implementación y la web desplegada pueden diferir. Se conservan los criterios funcionales acordados.

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

## E. Implementación y límites

- El PR #20 añade **reconstruction_sessions** (migración 0007), guardadas exclusivamente en el servidor y en las copias de seguridad.
- Permite iniciar una reconstrucción desde cualquier decisión vigente de la auditoría, registrar decisiones individuales, conjuntas, aplazamientos y resultados de empates, deshacer y rehacer pasos, cancelar y restaurar el estado anterior íntegro o finalizar con automatismos aún pausados.
- La interfaz congela las acciones normales para CTA y administradores mientras dure la sesión y facilita el relevo entre responsables mediante control de versión (CAS). El administrador puede consultar las preferencias históricas incluso de CTA vinculados **solo en el contexto de reconstrucción**.
- En cada turno se ofrecen primero las preferencias históricas válidas, después la adjudicación original todavía posible y, finalmente, la elección o decisión manual. El motor valida todos los cupos; no se adjudica nada de forma automática en este modo.
- Se mantienen las listas actuales que hayan cambiado después del punto de retroceso; las anteriores se consultan desde el historial. Se preservan las solicitudes originales ya registradas para el baremo, aunque la adjudicación reconstruida sea distinta.
- La evaluación de impacto antes de reanudar compara los ciclos válidos de las preferencias de CTA que aún pueden elegir, sin generar notificaciones ni requerir aprobaciones dentro del sistema.
- Por seguridad la reconstrucción avanza **estrictamente en orden de turno**; todavía no adelanta bloques cuando podría demostrarse que no perjudican a nadie.
- **Limitación del historial anterior**: las adjudicaciones de una misma operación antigua registradas en un único evento de auditoría pueden no descomponerse en varias decisiones recuperables sin datos adicionales. Los turnos automáticos posteriores al PR #18 ya se registran individualmente.
- El control de concurrencia evita que dos administradores reescriban simultáneamente la sesión. Las reconstrucciones anteriores se conservan en auditoría, pero la tabla de sesiones mantiene solo la última sesión activa o completada del equipo.

No habilitar la reconstrucción en producción hasta completar las pruebas automáticas, verificar la migración de base de datos y desplegar el PR.


## F. Acceso desde el timeline (UX)

El administrador trabaja en la vista ordinaria sin ver el formulario de reconstrucción. La sección **Últimos turnos y adjudicaciones**, que muestra en orden inverso elecciones, aplazamientos y sorteos, conserva los controles habituales de deshacer y rehacer. Una opción secundaria **Más ⋯ → Reconstruir desde un turno…** abre temporalmente el modo de selección del punto histórico.

En ese modo, las entradas recuperables del timeline incorporan **Desde aquí**. El identificador seleccionado es el ID de auditoría del evento: no se infiere a partir del orden visual (una elección conjunta o un turno doble son una única decisión). Los eventos importados o sin snapshot recuperable no presentan una acción engañosa.

En la secuencia vigente, una elección anticipada que ya ha llegado a su turno se corrige en su posición ordinaria. Se conservan las adjudicaciones de quienes la preceden, aunque se registraran después de aquella anticipada. Por ejemplo, reconstruir desde la posición 9 empieza en esa persona y conserva las posiciones 7 y 8. Las elecciones parciales del mismo turno se agrupan, incluidos sus ciclos aplazados. Las anticipadas todavía privadas siguen fuera de la reconstrucción. Cancelar restaura el estado y el historial anteriores.

Las elecciones deshechas o reemplazadas que ya no forman parte de la secuencia vigente **no se mezclan** con el timeline; se consultan dentro de **Decisiones de ramas anteriores**, accesible únicamente en modo de corrección. Se informa expresamente de que ya no están vigentes.

Al seleccionar el punto se solicita confirmación antes de retroceder y congelar las elecciones. Solo entonces aparece el panel de reconstrucción. Si se cancela el diálogo, no se modifica nada. Durante la sesión se mantiene el asistente visible; al finalizar se oculta y el resumen puede consultarse plegado dentro del historial mientras los automatismos permanezcan detenidos. Se sigue exigiendo la acción independiente para reanudarlos.

Las acciones de reconstrucción solo están disponibles para administradores autorizados, nunca para las vistas previas como controlador ni para los usuarios ordinarios.
