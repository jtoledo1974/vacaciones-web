# Elección diaria de VA: calendario, rondas y preferencias

Entrega de desarrollo del 28/10/2026. Incluye las preferencias automáticas en la primera entrega operativa, conforme a la confirmación del usuario. La elección conjunta entre controladores y el cierre con el Excel definitivo de RRHH pertenecen a las siguientes entregas. El administrador puede aplazar turnos y elegir por otra persona, con auditoría.

## Preparación

La migración `0018_va_election.sql` añade una campaña global por ejercicio; `0019_va_history_external.sql` incorpora historial reversible, reconstrucciones privadas y fichas/cuentas de personas sin equipo. Las tablas y el motor de vacaciones ordinarias siguen siendo independientes. La copia de seguridad incluye el nuevo estado, las preferencias y las decisiones; las copias anteriores se restauran sin campañas VA.

1. Completar y validar las fichas maestras con el **Nº empleado y la antigüedad del escalafón oficial**, sin inventar otro identificador. Las entradas nuevas aceptan `employeeNumber`; `controllerNumber` es un alias técnico del mismo número por compatibilidad. La interfaz muestra «Nº empleado». Las personas sin equipo se incorporan explícitamente con `va-personas`, sin crear equipos ni campañas ordinarias artificiales.
2. Preparar un JSON con los identificadores estables de las personas, **en el orden de RRHH**, por ejemplo:

   ```json
   { "year": 2027, "people": ["identificador-persona-1", "identificador-persona-2"] }
   ```

3. Ejecutar `node scripts/admin-cli.mjs va-censo importar censo.json --year 2027 --title "Censo RRHH 2027" --out revision.json`.
4. Revisar el orden, el derecho reconocido, las personas con derecho omitidas y las discrepancias con el número de empleado. El servidor no ordena por su cuenta. Los datos maestros que falten se corrigen antes de seguir.
5. Aplicar repitiendo el fichero y las opciones, con `va-censo aplicar ... --review-token TOKEN`. El token corresponde exactamente a esa vista previa y queda invalidado si cambian el censo o sus fichas. Un administrador de VA que no es superadministrador debe usar `--no-backup`; la copia completa previa está reservada al superadministrador.
6. Cargar los cupos con `va-cupos`, cerrar las campañas ordinarias del ejercicio y revisar en **Administración › Antigüedad**. El botón **Abrir primera ronda** comprueba el cierre y los cupos en el servidor.

`va-censo ver --year 2027` muestra el estado y, para el administrador de VA, el censo congelado. La importación solo sustituye campañas en preparación. La apertura congela el orden y los derechos; un cambio o baja posterior de ficha maestra no reescribe elecciones ni saldos ni oculta el acceso del participante. El acceso sigue comprobando la vinculación de cuenta actual: una desvinculación expresa sí lo retira.

## Elección

- Una cola para toda LECS. Primera ronda: como máximo un día por persona. Al terminar, se abre automáticamente la segunda ronda en la misma operación; esta incluye solo a quienes conservan saldo y recupera el orden original del censo.
- Segunda ronda: se elige todo el saldo restante, entre meses si es necesario, en una única operación. No se permiten elecciones parciales ni renuncias implícitas, tampoco en administración o reconstrucción. Confirmación expresa del usuario al retomar #163: un día en la primera ronda y todo el resto junto en la segunda. El servidor rechaza también el antiguo indicador `acceptUnused` como vía para elegir menos.
- Un día sin cupo tiene cero plazas. Cada persona consume una plaza; el servidor valida todas las fechas antes de registrar ninguna, rechaza duplicados y comprueba los días de vacaciones ordinarias con los límites exactos de su calendario.
- Cada confirmación usa la versión de campaña que se revisó. Si cambian el turno, las preferencias o los cupos, se pide revisar de nuevo sin descartar el borrador. El navegador conserva la selección del titular en almacenamiento local cuando está disponible.
- El calendario identifica por texto accesible los cupos, los días propios y las ordinarias. Se ha retirado «Días con hueco»; la selección conserva sus fechas al cambiar de mes.

## Experiencia de uso compartida con ordinarias

La presentación de VA sigue los patrones de las vacaciones ordinarias, sin reutilizar sus reglas de ciclos ni puntuaciones:

- Tarjeta de turno con el mismo estilo y resaltado verde cuando le toca al titular; saldo y días elegidos a continuación.
- Conmutador **Calendario / Mis preferencias**, controles de mes y escala de plazas compartidos con ordinarias (`app/calendar-controls.tsx`). El calendario diario está en `app/va-day-calendar.tsx`.
- Verdes por disponibilidad, cero plazas con textura, selección magenta, borde interior para días propios y marcas `P1`, `P2`… para las preferencias. Las ordinarias propias se distinguen y no se pueden elegir.
- **Mapa anual / Meses**: el mapa permite abrir un mes sin perder las fechas seleccionadas. En primera ronda, tocar otro día sustituye la selección única; en segunda, se acumulan fechas hasta el saldo.
- El mismo diálogo modal accesible que ordinarias (`app/confirmation.tsx`), con cancelación mediante Escape y devolución de foco. El botón de confirmación solo se habilita al completar el número de días del turno. La versión revisada no se sustituye silenciosamente por la del sondeo: si cambia la campaña, se rechaza la confirmación y se conserva el borrador.
- Salir de preferencias sin guardar pide confirmación; guardar una lista automática durante el turno avisa de que puede adjudicar días.
- En administración, la elección aparece antes del censo. **Elegir en nombre de…** lleva al calendario con foco de teclado. **Deshacer / Rehacer** permanecen visibles, con confirmación compartida con ordinarias. **Gestionar elección · Historial y reconstrucción** agrupa los controles secundarios en un desplegable, abierto al reconstruir. El titular no recibe esos controles.
- Los borradores del titular quedan vinculados al ejercicio, la persona del turno, la ronda y el modo de reconstrucción. No se arrastra una selección al turno siguiente ni se recuperan borradores antiguos sin ese contexto.

No se presentan vistas por ciclos, puntos, simulaciones ni selección de equipo en VA: no tienen el mismo significado en una campaña global de días sueltos.

## Preferencias

Lista privada y ordenada de días, independiente de las preferencias ordinarias. Permite conservar fechas completas para volver a aprovecharlas si cambia su ocupación; no reserva plazas.

El titular elige entre aplicación inmediata al llegar su turno, aplicación tras una espera personal de 1 a 1440 minutos, o elección manual. Los días elegidos y los que chocan con ordinarias se excluyen al aplicar la lista. En la primera ronda se toma el primer día disponible. En la segunda se toma todo el saldo; si no hay suficientes fechas disponibles en la lista, espera sin adjudicar parcialmente. El titular debe completar una selección válida con todo su saldo; si faltan huecos en el calendario, la administración debe resolverlo sin consumir parcialmente el saldo.

La pausa administrativa congela también el reloj de espera. Guardar preferencias no reinicia el reloj de un turno ya abierto.

Las mutaciones que abren un turno aplican las listas inmediatas. Las páginas abiertas comprueban también las esperas cada 15 segundos. Para aplicarlas **sin ningún navegador abierto**, el despacho existente `/api/notifications/dispatch`, autenticado con su secreto, llama a `advanceVaElections`. Su ejecución periódica debe estar configurada en el entorno de despliegue; no se ha activado ni modificado un Worker remoto desde esta entrega.

## Administración, integridad y privacidad

El administrador de VA puede abrir la primera ronda, pausar/reanudar, saltar con motivo, aplazar hasta un turno posterior y confirmar para quien tiene el turno. No edita preferencias ajenas. La auditoría registra actor, persona, motivo, fechas y aplicación automática.

El guardado de campaña verifica en la misma transacción su versión, la versión del calendario RRHH y las campañas ordinarias leídas. Corregir cupos no puede reducir una fecha por debajo de las elecciones ya confirmadas. Una modificación de adjudicaciones ordinarias que se solape con VA se revierte por completo; reabrir una ordinaria sin introducir conflicto sigue permitido.

La vista pública contiene nicks, cola, fechas confirmadas y ocupación; no publica fechas de antigüedad, números de empleado, fuentes, listas privadas ni saldos ajenos. El censo congelado completo solo lo recibe la administración VA; cada titular recibe su lista y sus días ordinarios.

### Deshacer, rehacer y reconstruir

- **Deshacer/Rehacer** restaura turno, rondas y elecciones, pero conserva las preferencias privadas actuales. Ambos detienen los automatismos hasta pulsar expresamente **Reanudar automatismos**. La restauración vuelve a validar cupos y conflictos con ordinarias. Una nueva decisión descarta la rama pendiente de rehacer.
- **Reconstruir desde el principio** crea un borrador privado para administración. La vista pública conserva las elecciones originales hasta aplicar el resultado; las decisiones públicas quedan bloqueadas mientras tanto. Se puede elegir, saltar con motivo, aplicar las preferencias del turno explícitamente y volver un paso. No se aplican automáticamente listas sucesivas dentro del borrador.
- **Cancelar reconstrucción** descarta el borrador y conserva el resultado original. **Aplicar reconstrucción** sustituye el resultado público en una transacción y permite deshacer esa aplicación. En ambos casos los automatismos quedan detenidos hasta reanudación expresa. El historial y los borradores se incluyen en las copias de seguridad.

### Personas sin equipo por CLI

Crear un JSON con `entries`, usando `code`, `label`, `employeeNumber`, `seniority` (fecha ISO) y `category` (`tca`, `jefe_sala`, `pasillo`, `otro`). Usar siempre datos revisados del escalafón, no números ficticios.

```text
node scripts/admin-cli.mjs va-personas importar personas.json --title "Escalafón oficial revisado" --out revision.json
node scripts/admin-cli.mjs va-personas aplicar personas.json --title "Escalafón oficial revisado" --review-token TOKEN --no-backup
node scripts/admin-cli.mjs va-personas ver
```

Revisar siempre la vista previa; se rechazan números ya presentes en equipos y cuentas duplicadas entre ambos censos. Actualizar una ficha no modifica el derecho de una elección abierta. Después se incluye su identificador estable en el orden explícito de `va-censo` y se vincula su cuenta desde administración.

## Validación

Pruebas de integración con SQLite comprueban ambos sentidos del conflicto ordinarias/VA, concurrencia, versiones obsoletas, capacidad, rondas, rechazo de saldos parciales, espera, pausa, privacidad y restauración. La prueba de navegador recorre censo, preferencias entre meses, confirmación delegada, transición automática a segunda ronda, deshacer/rehacer y pasos/cancelación de reconstrucción en escritorio y móvil, restaurando después la base aislada de QA. La aplicación del borrador y su deshacer se comprueban además con SQLite.

Revalidación local tras integrar `main` con la corrección de reconstrucción ordinaria del PR #164 y unificar la presentación: **584 pruebas Node/SQLite pasadas**, TypeScript con `npx tsc --noEmit -p tsconfig.app.json`, build y formato correctos. **15 comprobaciones de navegador pasadas** con Chrome: 4 de VA (flujo principal y aceptación de saldo parcial, escritorio/móvil) y 11 de censo, navegación, calendario mensual y reconstrucción ordinaria. QA en `../va-qa-local`, con base aislada; la última pasada usa el puerto 5219 y una caché Vite propia para no compartir puerto ni optimización con otros servidores locales. El servidor del usuario sigue en 5207, sin reiniciarlo ni borrar sus elecciones. Se comprueban también cambios/bajas de fichas después de abrir y equivalencia de `employeeNumber` con el alias heredado. El lint no presenta regresiones al excluir `.sites-runtime/**`; el ratchet general queda contaminado por una antigua copia QA anidada en esa carpeta. No se ha actualizado la línea base para ocultarla. Esto no valida toda la suite de navegador ni un despliegue de producción.

No se ha abierto ni alterado ninguna campaña de producción. Antes de una activación real se deben validar el censo y el calendario RRHH oficiales y tener disponible el cierre/exportación de la siguiente entrega.
