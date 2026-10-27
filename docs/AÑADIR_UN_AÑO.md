# Añadir un año al motor normativo

Esta guía recoge lo que hay que tocar hoy para que un ejercicio nuevo (por ejemplo 2028) tenga sus propias normas. La base es el refactor de #99. El código genérico pregunta a `policyFor(year)` y `occupancyFor(year)` y no compara años. La prueba `tests/policy-pluggable.test.ts` lo comprueba con una política ficticia para 2099 (`tests/policy-2099.ts`): recorre la campaña, la vista, las opciones, la elección, deshacer y rehacer, el impacto, la auditoría y la vista pública sin que aparezca nada de 2027.

Un año sin política registrada sigue funcionando con los cupos de relación heredados (`LEGACY` en `domain/policy.ts`). Lo que sigue solo hace falta si el año tiene un motor de ocupación propio.

## 1. Registro de la política

`domain/policy.ts`:

- Define un `VacationPolicy` con `entitlement` (ciclos que debe disfrutar cada controlador) y `occupancy` (el motor, o `null` para usar los cupos heredados).
- Añádelo a `POLICIES`, que hoy es `{2027:LECS_2027}`.
- `registerPolicy(year, policy)` existe **solo para tests**: registra una política y devuelve la función que deshace el registro. El código de producción no debe usarlo.

## 2. Calendario de RRHH

`domain/hr-calendars.ts`, solo si RRHH fija el calendario del año (número de ciclos por equipo y periodo de cada ciclo):

- Transcribe el libro de RRHH a un módulo `domain/hr-AAAA.ts`, como `domain/hr-2027.ts`, con su SHA-256 de origen.
- Añade el año a `WORKBOOKS` y `PERIODS`.
- Sin calendario de RRHH, `calendar()` usa los periodos de la configuración (`summerStart` y `summerEnd`) y los ciclos 45 y 46 según `excludePenultimate` y `excludeLast`.

**Ojo:** `grantsIndividualEntitlements(year)` devuelve `year in WORKBOOKS`. Registrar un calendario de RRHH habilita también las excepciones individuales de ciclos, y no registrarlo las prohíbe. Ver «Pendiente» más abajo.

## 3. El motor (`OccupancyRules`)

El contrato está en `domain/occupancy.ts`. La implementación de 2027 está repartida entre `domain/policy-2027.ts`, `domain/availability-2027.ts` y `domain/election-2027.ts`. Para un año nuevo:

- `version`: es única e incluye el año, por ejemplo `lecs-2028-…`. Se guarda en revisiones, diarios y auditoría, y si cambia, las revisiones anteriores quedan invalidadas.
- `authority` y `name`: aparecen en los mensajes de error («…según RRHH 2028», «otra versión de normas 2028»).
- `state()`: construye el `PolicyState` a partir de `calendar(year, team, config)`. Incluye `summerTotal` si RRHH fija el total de verano.
- `cycleMaximum()`: el máximo duro del ciclo. `calculate()` lo usa para la columna `max` y para la incidencia «supera el cupo máximo».
- `evaluateCandidate`, `evaluateFinal`, `canComplete`, `immediateIssues` y `partialAssessment`: la admisión y la prueba de completación.
- `availability`, `recordedAvailability`, `restoredAvailability`, `impact`, `previewChoiceImpact` y `compact`: la disponibilidad por ciclo y su forma de auditoría. `recordedAvailability` solo debe reutilizar una instantánea si su `stateKey` coincide con el estado. `restoredAvailability` no debe buscar: es lo que se usa al deshacer y rehacer.
- `permitReport`: los permisos que toda completación consume, para el simulador personal. Una lista vacía es válida.

`tests/policy-2099.ts` es el ejemplo mínimo que cumple el contrato entero.

## 4. Presupuestos

`budgets` en el motor (`commit`, `options.total`, `options.perCandidate` y `review`). Cambiar un presupuesto cambia qué pruebas terminan, así que es una decisión normativa. Fíjalos en un test, como hace `tests/policy-registry.test.ts` para 2027.

## 5. Presentación

Lo que la interfaz dice de las normas viene del motor, en `presentation` (`PolicyPresentation` en `domain/occupancy.ts`). El servidor la publica en la vista como `election.policyPresentation`. Es pública y no lleva datos personales. La de 2027 es `PRESENTATION_2027` en `domain/policy.ts`, y la de 2099, un ejemplo mínimo en `tests/policy-2099.ts`.

- `periodNames`: nombres de los tres periodos, en minúscula («preverano»). El simulador personal los pone con mayúscula inicial.
- `permits`: el nombre de cada tipo de permiso de `permitReport` (`PermitCount.kind`) y el sufijo tras «usados de límite».
- `impactEvents`: el texto de cada evento de impacto por código, con las plantillas `{period}`, `{ratio}`, `{count}` y `{cycles}`. Un código sin texto no se muestra.
- `staticReasons` y `ownRightsReason`: los códigos de motivo que el resumen de impacto no cuenta como consecuencia de una decisión.
- `explanationId`: el panel de normas que se muestra, de `app/policy-explanations.tsx`, o `null` para ninguno. Un año nuevo añade allí su componente.

Quedan supuestos de 2027 en la interfaz que no cambian el texto de las normas, pero sí la forma:

| Dónde | Qué supone |
| --- | --- |
| `app/election-workspace.tsx` | «Detalle de las cuatro plazas y motivos de bloqueo». |
| `app/personal-simulator.tsx` | La sección «Extracupos» y su explicación. |
| `app/cycle-availability-ui.ts:19` | La clase de color satura en 4 plazas libres (`Math.min(4, …)`). |
| `app/cycle-calendar.tsx:160` | La leyenda de plazas libres va de 4 a 0. |
| `app/cycle-table.tsx:40` | Como mínimo, cuatro columnas de plazas. |

## 6. Ayuda

La ayuda que sirve `server/documentation.ts` (`docs/CONSULTA.md`, `docs/GESTION.md`, `docs/ELECCION.md` y similares) describe las normas vigentes. Revísala cuando cambien. La interpretación normativa de 2027 está en `docs/policy-2027-definitive-guide.md` y `docs/COTEJO_CALENDARIO_2027.md`. Un año nuevo necesita su propia guía.

## 7. Tests

- Un test de registro como `tests/policy-registry.test.ts`, con la versión, los presupuestos, `cycleMaximum` y el calendario de RRHH.
- Tests del motor contra casos reales, como `tests/policy-2027.test.ts` y `tests/availability-2027.test.ts`.
- Un recorrido por el servicio como `tests/policy-2027-service.test.ts`.
- `tests/policy-pluggable.test.ts` debe seguir pasando: protege que el código genérico no dependa de 2027.
- Para la e2e, `tests/e2e/policy-2027.spec.ts` es la referencia.

## Pendiente: lo que todavía no es enchufable

Suposiciones de 2027, o del libro Excel de origen, que siguen en código genérico y no se han cambiado porque alterarían el comportamiento:

- `domain/vacations.ts:109`: con motor de ocupación, cada ciclo informa `min:1` y `base:2` fijos, en lugar de pedírselos al motor o tomarlos de la configuración.
- `domain/hr-calendars.ts:20`: las excepciones individuales de ciclos dependen de que haya calendario de RRHH (`year in WORKBOOKS`) y no de la política. Deberían ser una propiedad de `VacationPolicy`.
- `domain/calendar.ts:99`: una excepción individual admite de 0 a 6 ciclos, el máximo de 2027.
- `domain/defaults.ts:5`: el baremo por defecto viene del libro de 2026 y marca como `nextYear` las fechas de 2027. Para cualquier otro año se interpreta como «enero del año siguiente», que es lo esperado, pero los valores son los de ese libro.
- Los supuestos de forma de la sección 5.

Arreglado al hacer la prueba de 2099:

- `domain/personal-simulation.ts`: el simulador personal daba un ciclo por lleno con `occupied>=4` («Las cuatro plazas del ciclo están ocupadas»). Ahora usa el número de plazas que publica el motor (`slots.length`), que en 2027 sigue siendo 4.
