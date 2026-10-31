# Interfaz de vacaciones de antigüedad (VA)

Estado: **guía del funcionamiento implementado en `main`**, revisada el 31/10/2026. Sustituye al borrador de GUI del 28/10. Esta página describe lo que hace el código, no funcionalidades propuestas. Para reglas y antecedentes, véase [REQUISITOS.md](REQUISITOS.md); para flujos, invariantes y comprobaciones técnicas, [ELECCION.md](ELECCION.md); para carga del calendario de RRHH, [CUPOS-RRHH.md](CUPOS-RRHH.md).

## Alcance y navegación

- Las VA constituyen una campaña **global por ejercicio** para toda LECS, independiente de las campañas ordinarias de cada equipo: una cola ordenada conforme a la hoja de RRHH, cupos **diarios** comunes y días sueltos, sin ciclos ni puntuación de vacaciones ordinarias.
- Entrada «Antigüedad» en la navegación cuando la vista de acceso indica participación o permisos VA, en `/antiguedad`. La administración se encuentra en `/administracion/antiguedad` y en la sección de Administración; no se usa el selector de equipo para VA.
- Pueden participar las personas con derecho incluidas en el censo importado y con cuenta vinculada, incluidas las que no tienen equipo ordinario (alta por CLI). El rol global de **administrador de VA** es independiente de los permisos de los responsables de equipos. Un superadministrador también puede administrar VA. Los permisos se acumulan: ser administrador no quita el derecho a elegir para uno mismo.

## Derecho reconocido y datos personales

La sección muestra la antigüedad cargada, el número de empleado cuando está disponible, los años y días reconocidos; la sección de elección añade días adjudicados y saldo. Si falta la fecha de antigüedad, se solicita validarla. La escala de derecho es **1 día a los 20 años y 1 adicional cada cinco años**, sin tope artificial: 2 a los 25, 3 a los 30, 4 a los 35, etc. Se calcula para el año de disfrute, con corte a 31 de diciembre, aunque la elección se celebre en octubre del año anterior.

El número de empleado se presenta como tal; `controllerNumber` es un alias técnico heredado de `employeeNumber`. Ni las fechas maestras ni los números de empleado se publican en la vista general. Las correcciones de antigüedad y la incorporación de personas sin equipo se realizan mediante CLI y no editando el censo a mano en la web.

## Pantalla del controlador

1. **Turno y saldo.** La tarjeta de elección indica la ronda, quién elige, la posición pendiente y el derecho propio; destaca el turno del titular. Antes de abrir se informa de que la administración debe cerrar las ordinarias y abrir VA manualmente.
2. **Calendario diario.** Modo «Meses», un mes con rejilla lunes-domingo, y «Mapa anual» para saltar a otro mes. Se comparte con las ordinarias el lenguaje de disponibilidad (verdes según plazas libres y textura para cero), pero se eligen fechas y no ciclos. Las fechas con VA propias, los días de vacaciones ordinarias propias y la selección pendiente tienen marcas distintas. El número de plazas se expresa en el texto accesible y en el título de la fecha.
3. **Selección.** En la ronda 1 se elige exactamente **un día**; tocar otro lo sustituye. En la ronda 2 se elige **todo el saldo restante en una confirmación única**, incluso combinando meses. Las fechas elegidas aparecen como fichas, desde las que se puede navegar al mes o quitarlas. No se habilita confirmar una selección parcial.
4. **Confirmación.** «Revisar y confirmar» abre un diálogo de revisión. El servidor comprueba turno, versión, disponibilidad, duplicados y solapamientos con ordinarias, aplicando todos los días o ninguno. Si cambió el estado, se informa del conflicto y se conserva el borrador para revisarlo. Sin conexión se bloquea la confirmación y el titular conserva su selección contextual en el navegador cuando hay almacenamiento disponible.
5. **Preferencias propias.** Conmutador «Calendario / Mis preferencias». La lista de fechas se ordena con subir/bajar, permite incluir días actualmente completos y **no reserva cupo**. El titular decide: «Nunca: elegiré manualmente», «Al llegar mi turno» o «Después de mi espera» (1–1440 minutos). En la ronda 2 la aplicación automática solo procede si puede cubrir el saldo completo. Al guardar preferencias activas durante el turno se avisa de que pueden adjudicar inmediatamente. Las listas son privadas y distintas de las ordinarias.
6. **Seguimiento.** Se muestran la cola de turnos, las fechas ya confirmadas y su ronda. El titular ve las suyas; la administración dispone de una visión más amplia. Los cambios posteriores se solicitan a RRHH antes de publicarse el cuadrante mensual; la web no los aprueba.

Las selecciones VA no se pueden solapar con los días de vacaciones ordinarias propias. Un día ausente del calendario de RRHH tiene cero plazas, igual que uno con cupo explícito cero.

## Administración VA

La vista administrativa combina, en ese orden, **elección/turnos** y **censo y accesos**:

- **Preparación:** importar por CLI el censo en el orden entregado por RRHH (`va-censo`), completar antigüedad y número de empleado, incorporar personas sin equipo (`va-personas`) y cargar cupos (`va-cupos`). El panel de censo muestra personas con derecho, días reconocidos, cuentas sin vincular y fechas pendientes; buscador, agrupación por equipo o sin equipo, y vinculación de cuenta con guardado al salir del campo. Los datos maestros se corrigen por CLI, no desde las filas.
- **Apertura:** «Abrir primera ronda» es una acción expresa del administrador. El servidor requiere campañas ordinarias del ejercicio cerradas y calendario RRHH con plazas. El censo y los derechos quedan congelados para la elección abierta. Al terminar la primera ronda se inicia automáticamente la segunda para quienes tienen saldo.
- **Gestión de turnos:** pausar y reanudar, comprobar preferencias automáticas, saltar el turno con motivo, **aplazar hasta otro turno posterior** con motivo y confirmar días en nombre del controlador de turno. El aplazamiento permite gestionar excepcionalmente la elección conjunta de hasta tres personas; no existe todavía un flujo de invitación/aceptación entre controladores. El administrador debe haber obtenido el consentimiento; no se almacena un registro de cómo lo obtuvo.
- **Historial:** «Deshacer» y «Rehacer» restauran elecciones, rondas y turno, pero no sustituyen las preferencias privadas vigentes. Detienen los automatismos hasta pulsar «Reanudar automatismos». «Gestionar elección · Historial y reconstrucción» permite comenzar una reconstrucción privada, avanzar o retroceder paso a paso, usar preferencias en un paso, aplicar el resultado completo o cancelarlo. Mientras existe el borrador no se publican sus decisiones ni se permite continuar la elección pública.
- **Integridad:** la aplicación de VA, sus restauraciones y las ediciones de ordinarias se comprueban contra el cupo y los conflictos en el servidor. Los cambios administrativos quedan auditados.

## Automatismos y límites actuales

- Las preferencias inmediatas se procesan al abrir turnos. La aplicación tras espera se revisa también desde páginas abiertas; para ejecutarla **sin navegadores conectados** se necesita programar en el despliegue la invocación autenticada del despachador `/api/notifications/dispatch`. La existencia del código no confirma que el Worker esté configurado en producción.
- **No implementado como flujo autónomo de usuario:** invitaciones para elegir conjuntamente con otra persona o grupo. Se gestiona administrativamente mediante aplazamiento y elección delegada.
- **Pendiente:** cierre y exportación al fichero Excel VA definitivo de RRHH. No confundir con el exportador de vacaciones ordinarias ni dar por entregada esta función.
- La página `/lite` no ofrece actualmente una interfaz VA equivalente al calendario completo; no describir esa vista como existente.

## Referencias técnicas y comprobación

- GUI: `app/va-section.tsx`, `app/va-election-panel.tsx`, `app/va-day-calendar.tsx`, `app/va-census-panel.tsx` y `app/dashboard.tsx`.
- Reglas, guardas y persistencia: `domain/va-election.ts`, `domain/va-entitlement.ts`, `server/va-election.ts`, `server/va-controls.ts`, `server/va-census.ts`, `server/va-quotas.ts`.
- Pruebas: `tests/va-election.test.ts`, `tests/va-census.test.ts`, `tests/va-quotas.test.ts` y `tests/e2e/va-election*.spec.ts`. La presencia de tests no equivale a comprobar su estado en producción.

Esta guía está basada en el código de `main`; no certifica por sí sola una campaña activada, un despliegue actualizado ni la configuración del planificador externo.
