# Campaña de vacaciones de antigüedad (VA)

Estado: **registro histórico de fuentes, requisitos y decisiones tomadas el 28/10/2026**. Los apartados de «pendientes de entrevista», «plan» y «encaje técnico observado» reproducen el estado inicial del descubrimiento, no el funcionamiento actual.

**Estado del producto (31/10/2026):** la campaña VA, los cupos diarios, el censo global, los turnos de dos rondas, las preferencias y los controles administrativos ya están implementados. La documentación del comportamiento vigente está en [GUI.md](GUI.md), el flujo técnico en [ELECCION.md](ELECCION.md) y la operativa real del CLI de cupos en [CUPOS-RRHH.md](CUPOS-RRHH.md). Aún faltan la elección conjunta autogestionada y el cierre/exportación VA al Excel definitivo de RRHH. No debe interpretarse la lista de preguntas históricas como tareas aún sin decidir.

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

En esa fase inicial se había publicado la operación administrativa de antigüedad maestra descrita en [ANTIGUEDAD-MAESTRA.md](../ANTIGUEDAD-MAESTRA.md). Posteriormente se implementó el motor VA independiente, documentado en [ELECCION.md](ELECCION.md). Las referencias anteriores a «pendiente de implementar» pertenecen exclusivamente a esta fase histórica.


## Avance del descubrimiento (28/10/2026)

El usuario confirma que el primer derecho a VA requiere 20 años de antigüedad como controlador; la carga de fechas no debe limitarse a quienes tengan derecho a VA. Los demás tramos, el corte de cómputo y la operación de la campaña siguen pendientes de entrevista.

Se ha localizado el escalafón ordinal de ENAIRE a 31/12/2025, en una fuente de acceso restringido. Su SHA-256 es `05be9553769445796f80a6386d1783444368d2ea51900ab111cd670261ef2d63`. Las tablas internas se extrajeron directamente, sustituyendo el OCR exploratorio.

Se cruzó el censo de las campañas reales de 2027 de los ocho equipos con el escalafón, por nombres RRHH y número CTA cuando estaba disponible. El número de empleado de RRHH y el número CTA son identificadores distintos. Los casos sin correspondencia quedaron sin fecha inferida. Este censo de elecciones no representa necesariamente toda la plantilla LECS fuera de los ocho equipos.

La operación de fichas maestras se publicó en Sites v76; la carga solo completa fechas vacías de `people.seniority`. Los datos personales, el PDF y los cruces permanecen fuera del repositorio. Las campañas ordinarias mantienen sus instantáneas independientes.

## Primera ronda de entrevista (28/10/2026)

1. **Alcance:** campaña anual común a toda LECS, con una sola cola por número CTA y un único cupo diario de RRHH.
2. **Administración:** nuevo rol global de administrador de VA, distinto del responsable de equipo y asignado por un superadministrador.
3. **Primera versión:** censo y derecho, cupos y dos rondas, y exportación para RRHH. La elección conjunta queda para después; entretanto la gestiona el administrador de VA aplazando turnos y eligiendo en nombre de los afectados, con auditoría.

La interfaz implementada se documenta en [GUI.md](GUI.md), ya no como propuesta.
4. **Cupos:** los huecos diarios se cargan y corrigen por CLI, sin pantalla. El administrador de VA tiene derecho a editarlos. Ver [CUPOS-RRHH.md](CUPOS-RRHH.md).
5. **CLI:** su ayuda debe bastar para que un agente lo use sin acceso al código del repositorio.

## Segunda ronda de entrevista (28/10/2026)

1. **Tramos:** la escala de la plantilla es la correcta: 1 día al cumplir 20 años de antigüedad, 2 a los 25, 3 a los 30 y 4 a los 35. Sin tope: un día más cada 5 años (5 a los 40, 6 a los 45), aunque en la práctica nadie llega a 45.
2. **Corte:** el derecho se tiene en el año natural en que se cumplen los años (corte al 31/12 del ejercicio de las VA). Como las VA se eligen en octubre del año anterior, quien cumple 20 años en 2027 ya elige en la campaña de octubre de 2026.
3. **Caso de comprobación:** un controlador que pide VA por segunda vez en la campaña de 2026 para 2027 cumplió 20 años en 2026. El cálculo debe reproducirlo con su fecha cargada.
4. **Participantes (decidido):** toda LECS con derecho, no solo los ocho equipos. El cruce por nombre de la plantilla v1.2 con las campañas de 2027 muestra personas fuera de los equipos: los jefes de sala de `Hoja1` y al menos un TCA. Habrá que darlas de alta en el censo VA con su fecha y número CTA del escalafón; no tienen campaña ordinaria.
5. Las personas de 2027 sin fecha son incorporaciones recientes: no figuran en el escalafón a 31/12/2025 y no tienen derecho a VA en 2027. Su fecha se completará con el escalafón siguiente.
6. **Pendiente:** si la fecha base es siempre la antigüedad en ENAIRE del escalafón (la cargada).

## Tercera ronda de entrevista (28/10/2026): turnos

1. **Orden:** el que determina RRHH en su hoja. En la plantilla v1.2 las 69 filas están ordenadas por número CTA ascendente, que en la práctica es antigüedad y, a igual antigüedad, número CTA. La app importa ese orden y avisa si no coincide con el número CTA; no lo recalcula por su cuenta.
2. **Mecánica:** la de las vacaciones ordinarias, adaptada a días: turnos por orden y lista de preferencias opcional del propio controlador. Con esa lista elige él mismo cómo se usa al llegar su turno: al momento, tras una espera que fija él (1 minuto a 24 horas, para poder elegir antes a mano) o nunca. No hay plazo impuesto: el administrador no salta a nadie ni elige por su cuenta.
3. **Sin aplazamiento individual:** las normas de VA no lo prevén; solo la elección conjunta de la norma 6. Todos eligen en su turno de la ronda 1.

## Cuarta ronda de entrevista (28/10/2026)

1. Días sin tope: uno más cada 5 años a partir de 20.
2. El administrador de VA no accede a las ordinarias salvo que también sea responsable de equipo.
3. Se pueden reabrir las ordinarias; los choques con días VA elegidos se avisan y no se aplican hasta resolverlos.
4. Un cambio de cupo por debajo de lo ya elegido se rechaza; primero se corrige la elección afectada, con auditoría.
5. La elección conjunta gestionada por el administrador no exige anotar el consentimiento.
6. Ningún mes recibe trato especial: si falta en el calendario de RRHH, se trata como cualquier día sin cupo.
7. La exportación rellena el Excel oficial de RRHH, como en las ordinarias. Falta la versión definitiva de ese Excel.


## Situación implementada y pendientes (31/10/2026)

Esta sección sustituye al plan inicial a efectos operativos:

| Área | Situación actual |
| --- | --- |
| Derecho y censo | Escala de 20 años y +1 día cada cinco, cálculo al 31/12 del ejercicio; censo global en el orden importado de RRHH, vinculación de cuentas y altas de personas sin equipo por CLI |
| Cupos | Importación y corrección por CLI con vista previa y token; capacidad por día, sin editor web |
| Rondas | Primera ronda: un día. Segunda: todo el saldo restante **de una vez, sin selección parcial**; transición automática |
| Preferencias | Lista personal y privada, aplicación manual, inmediata o con espera configurable de 1 a 1440 minutos |
| GUI y administración | Calendario diario y mapa anual; elección propia o delegada; pausa, salto motivado, aplazamiento, historial, deshacer/rehacer y reconstrucción |
| Elección conjunta | El administrador puede aplazar turnos y elegir por otros (hasta tres participantes), pero **no existen invitaciones/aceptaciones entre usuarios** |
| Exportación VA | **Pendiente** la exportación final al Excel oficial de RRHH; no confundir con la de ordinarias |
| Ejecución sin navegador | El despacho de elecciones automáticas está integrado en el servidor; su ejecución periódica requiere configuración externa, no acreditada por estos documentos |

La denominación mostrada en la interfaz es «Nº empleado». El antiguo identificador de código `controllerNumber` actúa como alias de `employeeNumber` por compatibilidad; este contrato técnico posterior no debe confundirse con las distinciones de fuentes discutidas durante el descubrimiento.

La norma de dos rondas procede de las fuentes originales, pero **no habilita** que el usuario confirme un saldo parcial en la segunda ronda: la implementación actual lo rechaza. Los cupos no se copian de otro ejercicio y ningún mes ausente se considera disponible.

**Fuentes de verdad para mantenimiento:** [GUI.md](GUI.md), [ELECCION.md](ELECCION.md), [CUPOS-RRHH.md](CUPOS-RRHH.md), el CLI y los módulos `server/va-*.ts` y `domain/va-*.ts`. Esta documentación describe el código; no certifica la activación de VA en producción.
