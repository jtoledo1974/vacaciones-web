# ADR 0002: vacaciones de antigüedad sobre el motor de elecciones de ordinarias

Estado: **propuesta para aprobar**. Responde al issue #179. Matiza el punto 6 del ADR 0001: las reglas normativas siguen separadas, pero el mecanismo, el código y las tablas se comparten.

## Contexto

VA tiene hoy un sistema paralelo: estado en un JSON (`va_campaigns`), historia propia (`va_election_history`), reconstrucción propia (`va_reconstructions`), motor propio (`domain/va-election.ts`, `server/va-election.ts`, `server/va-controls.ts`), interfaz propia (`app/va-*.tsx`) y un evento `va_election` duplicado en `audit`.

Decisiones del propietario (issue #179):

- El motor común debe poder ejecutar en VA **todos** los comportamientos: turnos conjuntos, aplazamientos, preferencias automáticas, deshacer/rehacer, reconstrucción. Las limitaciones se aplican en la interfaz.
- **Una sola campaña de VA por año**, como una campaña por equipo y año.
- La campaña de VA de este año **no ha empezado**: se puede rediseñar desde cero, tirar código e interfaz, y volver a cargar a los participantes. No hay historial que migrar.

## Hallazgo: el motor de ordinarias ya está casi parametrizado

| Pieza de ordinarias | Qué ofrece | ¿Sirve para VA? |
| --- | --- | --- |
| `campaigns` + `campaign_members` | Miembros congelados por campaña, con orden propio | **Sí.** Una campaña no depende de los miembros actuales del equipo |
| `domain/sequence.ts` | Turnos por rondas, créditos por aplazamiento, turnos conjuntos, empates. "Independiente de la política": recibe `entitlement` como función | **Sí**, con un gancho para las unidades por ronda (ver abajo) |
| `VacationPolicy` (`domain/policy.ts`) | `entitlement(config, member)` y `occupancy` (admisión de cada elección) | **Sí.** VA es otra política |
| `awards`, `requests`, `preferences`, `election_states` | Proyección del estado | **Sí.** `cycle_date` guarda una fecha; en VA será un día |
| `audit` + `appliedAudit` + `election-commands.ts` + `reconstruction.ts` | Historia, undo/redo selectivo, ramas, reconstrucción, anticipadas, redacción | **Sí, sin cambios de fondo.** Todo va por `campaign_id` |
| Notificaciones, automatismos, backup v2, compresión (ADR 0001) | Por campaña | **Sí** |

Diferencias normativas reales de VA:

1. **Unidad:** días sueltos, no ciclos.
2. **Derecho:** días de VA por persona (antigüedad), no ciclos por persona.
3. **Admisión:** cupo por día (`va_quotas`) y no coincidir con las vacaciones ordinarias de la misma persona (incluido el ciclo de diciembre que acaba en enero).
4. **Rondas:** en la primera se elige un día; en la segunda, todo el saldo restante.
5. **Participantes:** personas de varios equipos y externas.

Todas caben como **política** y **datos de campaña**, no como un motor distinto.

## Decisión

### 1. VA es una campaña de un equipo reservado

- Se crea un equipo de sistema (`teams.id = 'va'`, con una columna nueva `kind = 'va'`; los equipos normales, `kind = 'ordinary'`).
- La campaña de VA de un año es una fila normal de `campaigns` con `team_id = 'va'`. La clave única existente (`team_id, year, scope_key`) garantiza **una sola campaña de VA por año**, y además permite simulaciones con `scope_key` igual que en ordinarias.
- **Permisos:** el actual `vaAdmin` pasa a ser un `team_admin` del equipo `va` (vía `grants`). `canWrite(p, 'va')` funciona sin código específico.
- Las listas de equipos de la interfaz y los informes por equipo filtran `kind = 'ordinary'`.

Alternativas descartadas:

- *`team_id` opcional:* obliga a reconstruir `campaigns` (columna NOT NULL referenciada por muchas tablas) y a revisar unas 150 referencias a equipo. Más cambio para el mismo resultado.
- *Tipo de campaña sin equipo:* igual de invasivo, y pierde los permisos por equipo.

### 2. La política se elige por campaña, no solo por año

- `policyFor(year)` pasa a `policyFor(campaign)` (28 llamadas en `server`, `domain` y `app`). Para ordinarias devuelve lo mismo que hoy; para el equipo `va`, la política VA.
- **Política VA:**
  - `entitlement`: días de VA de la persona, **congelados al cargar el censo** en una columna nueva y genérica `campaign_members.entitlement` (nula en ordinarias). La firma pasa a recibir el miembro de campaña (`id`, `person_id`, `code`, `entitlement`), no solo el código: en VA conviven códigos de varios equipos. La política VA lee el valor congelado y nunca lo recalcula. Ordinarias ignora la columna y sigue como hoy. Test con el mismo código en dos equipos.
  - `occupancy`: cupo por día desde `va_quotas` y coincidencia con las adjudicaciones ordinarias de la persona en el mismo año (lógica que hoy está en `ordinary()`/`blocked` de `server/va-election.ts`). Se implementa la interfaz `OccupancyRules`. Muchos métodos son triviales en VA (no hay pruebas de completitud globales); si la interfaz resulta demasiado ligada a 2027, se extrae una interfaz mínima de admisión que ambas implementen.
  - `unitsInRound(round, remaining)`: gancho nuevo en `domain/sequence.ts`. Ordinarias: 1. VA: 1 en la primera ronda, `remaining` en la segunda. Sustituye la constante `1` de `owed()`.
  - **Rondas: exactamente dos.** Primera ronda, un día; segunda, el saldo restante. La política lo declara y el motor termina tras la segunda ronda. Un aplazamiento no puede pasar unidades más allá de la segunda ronda.
  - **Datos externos: solo los cupos de RRHH.** Se cargan antes de iniciar la campaña y quedan fijos hasta cerrarla. El servidor los pasa a la política junto con el contexto de la campaña; no se versionan. Los días ocupados por ordinarias no son datos externos sino otra campaña de la aplicación, protegida por la sección 3 bis.

### 3. Calendario y vocabulario

- `calendar(year, team, config)` genera ciclos. Para VA se genera un calendario de días del año con su cupo. La vista de elección usa un componente de calendario según el tipo de campaña; el resto de la interfaz de elección (turnos, preferencias, historial, deshacer, reconstrucción) es el mismo.
- Los mensajes que dicen "ciclo" pasan a depender de la política (`presentation`), que ya existe para 2027.

### 3 bis. Integridad cruzada entre ordinarias y VA

Una persona no puede tener el mismo día en vacaciones ordinarias y en VA. La protección actual es una aserción SQL dentro del mismo batch que guarda la decisión (`vaOrdinaryGuards` en `server/va-election.ts`, invocada desde `Service.commit`, más la aserción del lado VA), comprobada en ambos sentidos. Se mantiene con este contrato:

- **Dónde:** como aserción SQL en el **mismo batch** que guarda cualquier cambio de adjudicaciones, nunca solo en el motor en memoria de una campaña. Así cubre los accesos concurrentes: si la otra campaña cambió entre la lectura y la escritura, la transacción falla entera.
- **Qué operaciones:** cualquiera que escriba en `awards` o cambie los límites de los ciclos, en cualquiera de las dos campañas. Eso incluye adjudicar, anticipar, modificar adjudicaciones, deshacer/rehacer, reconstruir (pasos y finalizar), importar, cambiar la configuración del calendario y los cambios de plantilla.
- **Cómo:** con VA en `awards`, la aserción cruza `awards` y `campaign_members` por `person_id` entre la campaña ordinaria y la de VA. Una adjudicación ordinaria ocupa desde `cycle_date` hasta el fin de su ciclo; una de VA, un día. Ya no hace falta `json_each` sobre `va_campaigns`.
- **Ámbito:** la aserción transaccional solo se aplica entre campañas `scope_key = 'live'`. Una simulación de administrador (VA u ordinarias) compara sus elecciones con las campañas `live` de la otra clase **en solo lectura**: ve los choques reales, pero nunca bloquea ni queda bloqueada por escrituras reales. No se clonan ni vinculan ámbitos. Prueba: una simulación de VA rechaza días que coinciden con ordinarias `live` y no escribe nada en ellas.
- **Cambio de año:** la campaña de VA del año Y se compara con las ordinarias de **Y y de Y−1**, porque el último ciclo de diciembre de Y−1 puede continuar en enero de Y (lo que hoy hace `context()` de `server/va-election.ts`). A la inversa, una ordinaria de Y se compara con VA de Y y de Y+1.
- **Política en memoria:** la admisión de la política VA hace la misma comprobación para dar mensajes claros y para las preferencias automáticas. La aserción es la garantía; la política, la experiencia.

### 3 ter. Calendario y configuración de VA

`domain/calendar.ts::validateConfig` exige `cycleLength === 8`, y `calculate`/`cycleTable`/`calendar` trabajan sobre ciclos. No se relaja esa validación para ordinarias:

- La **política** aporta su calendario y la validación de su configuración. Ordinarias delega en las funciones actuales sin cambiarlas. VA aporta un calendario de días (los días del año con cupo en `va_quotas`, cada uno con `end = date`) y su propia validación, sin `cycleLength`.
- Los consumidores genéricos (`currentTurn`, admisión, vistas de elección, exportación) piden el calendario a la política de la campaña, no a `calendar()` directamente. Las llamadas a `calendar()` y `calculate()` que hoy son propias de ordinarias se quedan detrás de la política de ordinarias.
- Se hace en la fase 1 (refactor sin cambio de comportamiento) antes de introducir la política VA.

### 3 quater. Elecciones anticipadas de VA

La prueba actual de seguridad de una anticipada (`domain/early-election.ts`) enumera las combinaciones que podría elegir el predecesor, con un presupuesto de 1.500. Con días sueltos y varias unidades pendientes (segunda ronda de VA) el presupuesto se agota y el resultado queda indeterminado.

En VA los días son independientes (cupo por día, sin reglas entre días), así que la prueba es directa y exacta: **anticipar el día X es seguro si el predecesor no puede elegirlo** (ya lo tiene, coincide con sus ordinarias o el día está completo) **o si a X le quedan al menos dos plazas.**

- Gancho opcional `earlyProof` en `VacationPolicy`. Ordinarias conserva la prueba combinatoria actual; VA aporta la directa.
- Test: segunda ronda de VA con un predecesor que debe varios días.

### 3 quinquies. Simulaciones

- Se mantienen las **simulaciones de administrador** de VA (clon de la campaña con su `scope_key`), para validar el software mientras hay una campaña en marcha.
- **No hay simulaciones personales para controladores en VA** (`domain/personal-simulation.ts`, `server/personal-simulation.ts`): la política VA las desactiva y la interfaz no las ofrece.

### 3 sexies. Cupos fijos durante la campaña

Los cupos que envía RRHH son válidos para todo el proceso, igual que los datos de RRHH de ordinarias. **No se contempla cambiarlos con la campaña iniciada.**

- La carga de cupos solo se admite antes de iniciar la campaña de VA, es decir, antes de que el administrador la abra para elegir. Durante la preparación (censo y cupos) se puede repetir. Con la campaña iniciada se rechaza, aunque los cupos nuevos fueran compatibles con lo elegido: se prefiere menos código.
- Si RRHH enviara cupos distintos, el administrador reinicia la campaña por CLI: backup de lo que hay y nueva carga. La aplicación no tiene código para adaptar, validar compatibilidad ni retroceder adjudicaciones.
- Desaparece la aserción actual de `server/va-quotas.ts::loadVaQuotas` sobre `va_campaigns`; la sustituye el rechazo de cargas con la campaña iniciada.

### 4. Personas externas

`campaign_members.person_id` referencia `people`. Las personas externas están en `va_external_people`, no en `people`. **Decisión propuesta:** las externas pasan a ser filas de `people` del equipo `va` (que no aparece en las listas de ordinarias). Así desaparecen `va_external_people` y `va_external_accounts`, y sus cuentas usan `controller_accounts` como el resto.

**Confirmado por el propietario:** una única tabla de personas, para no duplicar datos como los correos.

### 5. Qué se elimina

- Tablas: `va_campaigns`, `va_election_history`, `va_reconstructions` y, si se confirma el punto 4, `va_external_people` y `va_external_accounts`.
- Código: `domain/va-election.ts`, `server/va-election.ts`, `server/va-controls.ts`, el evento `va_election` de `audit` y la parte de `server/va-census.ts` que duplica la carga de miembros.
- Interfaz: `app/va-election-panel.tsx`, `app/va-section.tsx`; `app/va-day-calendar.tsx` se reaprovecha como calendario de días.

Se conservan: `va_quotas` y `va_quota_sources` (datos de admisión de la política VA) y el cálculo del censo VA (quién participa y cuántos días le corresponden), que pasa a alimentar `campaign_members`.

## Plan por fases

Cada fase se fusiona por separado y deja la aplicación funcionando.

| Fase | Contenido | Cambia el comportamiento de ordinarias |
| --- | --- | --- |
| 1 | `policyFor(campaign)`; gancho `unitsInRound` (1 para ordinarias); calendario, validación de configuración y vocabulario según la política (sección 3 ter). Refactor puro | No: la suite actual debe pasar sin tocar los tests |
| 2 | Equipo `va` (`teams.kind`), permisos de VA mediante `grants`, personas externas en `people`. Inventario y filtrado de los consumidores globales (las consultas con `scope_key='live'`, `stats()`, vistas públicas y exportaciones) mediante un único filtro reutilizable de campañas ordinarias; test de que activar VA no cambia estadísticas ni año mostrado | No |
| 3 | Política VA: derecho, admisión (cupos + ordinarias), rondas, dos rondas, cupos fijos desde el inicio, calendario de días, prueba directa de anticipadas (3 quater), sin simulaciones personales. Aserción cruzada ordinarias/VA sobre `awards` (sección 3 bis), con casos interanuales y concurrentes | No |
| 4 | Alta de la campaña VA desde el censo: crear la campaña del equipo `va`, congelar miembros con sus días (`campaign_members.entitlement`). Plantilla RRHH por año y tipo (`hr_templates` con `kind`) y Excel de VA. Interfaz de elección común con calendario de días; limitaciones de la interfaz (si no se quieren turnos conjuntos o aplazamientos visibles) | No |
| 5 | Eliminar tablas, código e interfaz antiguos de VA. Volver a cargar los participantes de este año | No |

La compresión de `audit` (fase 3 del ADR 0001) es independiente y beneficia a ambos.

## Criterios de aceptación

- Ordinarias: la suite y los E2E actuales pasan en todas las fases sin cambiar sus expectativas.
- VA con el motor común: primera ronda de un día y segunda que agota el saldo; cupo diario; rechazo de días que coinciden con ordinarias (incluido el ciclo de diciembre a enero); preferencias inmediatas, tras espera y manuales; turno conjunto y aplazamiento ejecutables por el servidor aunque la interfaz los oculte; deshacer/rehacer selectivo; reconstrucción atrás, cancelar y finalizar; anticipadas, si se permiten; permisos del equipo `va`; backup y restauración.
- VA: dos rondas exactas; la carga de cupos con la campaña iniciada se rechaza.
- Integridad cruzada: un día ordinario y de VA de la misma persona se rechaza en ambos sentidos para cada operación de la sección 3 bis; dos escrituras concurrentes en campañas distintas que juntas chocarían dejan solo una aplicada; el ciclo ordinario de diciembre de Y−1 que acaba en enero de Y bloquea esos días en la VA de Y; las simulaciones se contrastan en lectura con las campañas `live` de la otra clase, pero no les aplican aserciones transaccionales cruzadas (probado en ambos sentidos: simulación de VA frente a ordinarias `live` y simulación de ordinarias frente a VA `live`).
- Una segunda campaña de VA del mismo año (`scope_key = 'live'`) es imposible por la clave única.

## Decisiones del propietario sobre las preguntas abiertas

1. **Personas externas:** filas de `people` del equipo `va`. Una única tabla de personas.
2. **Exportación a RRHH:** VA usa un **Excel distinto**, que el administrador sube como plantilla y la aplicación rellena, igual que en ordinarias. Se reutiliza la mecánica de exportación de ordinarias (`domain/hr-export.ts`); cambian la plantilla y el mapeo de celdas, que pasan a depender de la política. Hoy `hr_templates.year` es la clave primaria y la carga hace UPSERT por año, así que subir la plantilla de VA sustituiría la de ordinarias. Se añade una columna `kind` (`ordinary` | `va`) y la clave pasa a `(year, kind)`; las filas existentes quedan como `ordinary`. Se adaptan `Service.hrWorkbook`, la carga, la exportación y el inventario de backup v2, con un test de los dos libros del mismo año coexistiendo. Va en la fase 4.
3. **Elecciones anticipadas: se permiten en VA.** Se usa el mecanismo de ordinarias, incluida su redacción en el registro.

La protección cruzada entre ordinarias y VA queda resuelta en la sección 3 bis.
