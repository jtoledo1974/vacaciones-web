# Campaña de vacaciones de antigüedad (VA)

Estado: descubrimiento de requisitos. PR inicial; las decisiones de producto se resolverán en entrevista antes de implementar el flujo operativo.

## Fuentes y trazabilidad

Lectura realizada el 28/10/2026. WhatsApp MCP sincronizado, sin error declarado. El archivo de WhatsApp puede no contener todo el móvil. Se revisó el intercambio completo del tema del 28/10 y se buscaron antecedentes de VA/antigüedad/escalafón en el chat de un compañero; los antecedentes históricos no sustituyen la versión actual.

un compañero, 28/10/2026 (Europe/Madrid):

- 09:27:06: propone incorporar las VA en la webapp. Mensaje `[mensaje]`.
- 09:27:14: indica que se entregan después de las vacaciones normales. Mensaje `[mensaje]`.
- 09:57:53: adjunta los dos archivos siguientes.
- 09:58:20: indica que la antigüedad puede obtenerse del escalafón. Mensaje `[mensaje]`.

| Archivo original | Mensaje | SHA-256 |
| --- | --- | --- |
| 261009 Vacaciones Antigüedad v1.1.docx | `[mensaje]` | `cfff93ff891fdb9fc554fe4a5e1007f2618ff55cd183dada925b32214ed5b975` |
| Vacaciones antigüedad PLANTILLA 1.2.xlsm | `[mensaje]` | `bb0a2d870ad8d376aefb0133495562ceea9bb7f9258a9c1992201c083f34699e` |

Originales descargados y huellas verificadas; conservados fuera del repositorio en `evidencias/va-20261028/` del espacio de trabajo, como `normas-v1.1.docx` y `plantilla-v1.2.xlsm`. La plantilla contiene datos personales. Este PR incorpora su análisis sin copiar el censo ni enlaces temporales de descarga.

## Reglas expresas del documento v1.1

1. Las VA se solicitan en octubre, a continuación de las vacaciones ordinarias.
2. RRHH proporciona una tabla con los huecos disponibles para cada día del año.
3. Las peticiones y los huecos se refieren a días, no a servicios.
4. El criterio de ordenación es la antigüedad en Enaire, expresada como número de controlador.
5. Hay dos rondas: en la primera cada CTA puede elegir un día; en la segunda puede elegir en su turno todos los días de que disponga.
6. Un CTA puede dejar pasar su turno para elegir con otro: ambos eligen cuando corresponda al que elige más tarde. Para tres CTAs, eligen en el turno del último de los tres.
7. Antes de publicarse el cuadrante mensual correspondiente, el CTA puede solicitar cambios a RRHH. Su autorización depende de la organización del servicio. Esto no implica que la web pueda aprobarlos automáticamente.

## Lectura de la plantilla v1.2

Se inspeccionaron las dos hojas, todas las celdas pobladas y fórmulas, comentarios, validaciones, tablas, nombres definidos y elementos ocultos, sin ejecutar VBA ni recalcular el original.

- `VA`: tabla `A1:K70`, con 69 filas de personas. Campos: orden, nombre, número CTA, antigüedad de referencia 2026, antigüedad del ejercicio, días VA, saldo y cuatro columnas de fechas. `O1` contiene 2027.
- La columna D está oculta. E actualiza la antigüedad de D añadiendo la diferencia entre el ejercicio y 2026. F usa `INT((antigüedad-15)/5)`. G resta las celdas ocupadas de H:K.
- Una nota de E2 advierte expresamente que el dato es ficticio para el funcionamiento de la tabla y que la antigüedad real es otra. No debe importarse el censo como dato validado.
- La fórmula de F sugiere tramos de 20/25/30/35 años para 1/2/3/4 días. El documento no define esos tramos, el corte anual ni los límites: pendientes de validación, no reglas aprobadas.
- H:K permite introducir día y mes; el texto de L1 pide no introducir año. En la web se propone almacenar fechas completas del ejercicio.
- M2/N2 contienen fórmulas matriciales para listar fechas repetidas, con rangos hasta N499 y H2:K101. Una fecha repetida no demuestra por sí sola un exceso de cupo: es necesario compararla con la capacidad de RRHH.
- La validación declarada en H1:K1048576 carece de tipo y de fórmula; no acredita una restricción efectiva de fechas.
- `Hoja1`: 75 entradas de nombre y días en una única columna, además de la cabecera. No coincide en tamaño con la tabla VA y no declara ejercicio. Requiere conciliación, no una unión automática por nombre.
- No hay tabla de cupos diarios entre las celdas de estas hojas. Falta obtener y validar esa fuente.
- El archivo contiene `xl/vbaProject.bin`. Sus macros no se han ejecutado ni auditado; la inspección de celdas no certifica su comportamiento en Excel.

## Encaje técnico observado

Base inspeccionada: `main`, commit `15f5c3d` (28/10/2026).

- `db/schema.ts`: las campañas actuales se vinculan a un equipo y tienen unicidad equipo/año/ámbito. Una campaña global VA requiere decidir el alcance y modelarlo expresamente.
- `people` y `campaign_members` guardan `seniority` como texto; `server/roster.ts` lo valida como fecha. El número CTA debe tener un campo propio validado; no debe sobrecargarse esa fecha ni confundirse con el código visible.
- `domain/vacations.ts` opera sobre ciclos y puntuaciones de vacaciones ordinarias. Las VA necesitan capacidad por día y su propio orden de elección.
- Reutilización propuesta: identidad de personas y cuentas, permisos, auditoría y controles de concurrencia, una vez definido quién administra la campaña global.

## Decisiones pendientes de entrevista

### Primera ronda: alcance y usuarios

1. ¿Una campaña anual común de toda LECS o campañas por equipo? Propuesta: común, con los participantes de todos los equipos; confirmar el ámbito de los cupos de RRHH.
2. ¿Quién elige y quién administra? Propuesta: elección por cada CTA con delegación administrativa auditada; definir permisos para actuar sobre otros equipos.
3. ¿Qué debe cubrir la primera versión para poder usarla? Propuesta: censo validado, cupos, dos rondas, parejas/tríos y exportación para RRHH. Confirmar si también necesita preferencias automáticas, avisos o cambios posteriores.

### Rondas posteriores, según las respuestas

- Inicio: ¿el administrador abre VA tras comprobar el cierre de las ordinarias? ¿Qué campañas deben estar terminadas y qué ocurre si se reabren?
- Datos: fuente oficial y ejercicio del escalafón, número CTA, antigüedad computable, días reconocidos, participantes elegibles, bajas y conciliación de las dos hojas.
- Cupos: ámbito, formato de importación, días ausentes frente a cupo cero, actualización y efecto sobre elecciones ya hechas.
- Turnos: dirección del orden por número CTA, empates o números ausentes, plazo, ausencia, renuncia, primera ronda omitida y saldo en segunda ronda.
- Elección conjunta: consentimiento, creación/cancelación por ronda, consumo individual del cupo, si deben escoger las mismas fechas y tratamiento de capacidad insuficiente para todo el grupo.
- Fechas: elegibilidad en días sin servicio, solapamiento con ordinarias y fechas ya elegidas; calendario del ejercicio y tratamiento de cambios de equipo.
- Confirmación: elección manual o preferencias, reservas provisionales, confirmación atómica y conflictos concurrentes.
- Cierre: revisión, publicación, columnas/formato de exportación y destinatario operativo de RRHH.
- Cambios posteriores: registro de solicitudes o gestión externa, permisos, aprobación y auditoría.

## Plan de implementación sujeto a decisiones

1. Cerrar el contrato de usuario y documentar las respuestas de la entrevista.
2. Modelar campaña VA y censo anual con identificadores estables, número CTA y derecho reconocido; diseñar migración compatible con campañas existentes.
3. Importar cupos con vista previa y aceptación explícita; rechazar datos incompletos sin inventar disponibilidad.
4. Implementar motor diario de dos rondas y turnos conjuntos, con saldo y capacidad verificados en la misma transacción.
5. Añadir calendario, elección, administración, auditoría y exportación conforme al alcance aprobado.
6. Validar en simulación antes de cualquier activación real.

## Criterios de aceptación que deben concretarse

- El orden no depende de la puntuación de vacaciones ordinarias.
- La primera ronda permite como máximo un día por persona y la segunda respeta su saldo reconocido.
- Ninguna confirmación supera el cupo diario ni duplica un día de la misma persona, incluso con peticiones concurrentes.
- Los turnos conjuntos respetan el turno del último y los derechos individuales; los detalles de atomicidad se resolverán en entrevista.
- Las fechas y saldos quedan vinculados al ejercicio, con trazabilidad de fuentes y correcciones.
- Las campañas ordinarias conservan su comportamiento y datos.
- Los permisos reflejan el alcance aprobado; un permiso de equipo no concede implícitamente administración global.

El PR incluye también la operación administrativa de antigüedad maestra descrita en `../ANTIGUEDAD-MAESTRA.md`, publicada para la carga solicitada. Esta operación solo completa `people.seniority`: conserva las instantáneas de campañas ordinarias y no activa VA. Su validación incluye pruebas de permisos, concurrencia, auditoría y conservación de campañas. El motor de VA sigue pendiente de las decisiones de entrevista.


## Avance del descubrimiento (28/10/2026)

El usuario confirma que el primer derecho a VA requiere 20 años de antigüedad como controlador; la carga de fechas no debe limitarse a quienes tengan derecho a VA. Los demás tramos, el corte de cómputo y la operación de la campaña siguen pendientes de entrevista.

Se ha localizado el escalafón ordinal de ENAIRE a 31/12/2025, en una fuente de acceso restringido. Su SHA-256 es `05be9553769445796f80a6386d1783444368d2ea51900ab111cd670261ef2d63`. Las tablas internas se extrajeron directamente, sustituyendo el OCR exploratorio.

Se cruzó el censo de las campañas reales de 2027 de los ocho equipos con el escalafón, por nombres RRHH y número CTA cuando estaba disponible. El número de empleado de RRHH y el número CTA son identificadores distintos. Los casos sin correspondencia quedaron sin fecha inferida. Este censo de elecciones no representa necesariamente toda la plantilla LECS fuera de los ocho equipos.

La operación de fichas maestras se publicó en Sites v76; la carga solo completa fechas vacías de `people.seniority`. Los datos personales, el PDF y los cruces permanecen fuera del repositorio. Las campañas ordinarias mantienen sus instantáneas independientes.
