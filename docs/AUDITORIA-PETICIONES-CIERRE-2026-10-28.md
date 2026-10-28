# Auditoría de peticiones, elección y cierre — 28/10/2026

## Regla funcional aclarada por Juan

Durante la elección las decisiones pueden deshacerse, sustituirse y reconstruirse. Ninguna elección provisional adquiere por ello carácter de petición original protegida para la puntuación del año siguiente. La referencia es la relación definitiva de vacaciones cerrada y enviada a RRHH. Los cambios posteriores durante el año no alteran esa referencia de puntuación.

El historial técnico de operaciones puede conservarse para deshacer, reconstruir y auditar; no debe consumir posiciones de vacaciones ni convertirse en la referencia de puntuación. Las preferencias tampoco son vacaciones definitivas.

## Alcance y evidencia

- Lectura de servidor, dominio, esquema, pruebas y documentación del checkout `cli-browser-login`, commit `3ad84c4`.
- Se consultó `main` de GitHub: `15f5c3dced3e1d7938d7d6027cec724537596844`. No hay diferencias frente al checkout en `server/election-service.ts`, `server/reconstruction.ts`, `server/service-commands.ts`, `server/service.ts`, `domain/vacations.ts`, `tests/reconstruction.test.ts` y `tests/election-service.test.ts`.
- Copia de producción descargada por CLI a las 09:14:27 UTC, con integridad interna verificada. Datos privados, reproducción y resultados en `evidencias/20261028/`, excluidos de Git.
- La versión 75 de Sites indica otro commit de empaquetado (`149b0786...`), no disponible en el remoto GitHub. La identidad byte a byte del paquete publicado no se certifica con esta auditoría.
- No se han modificado campañas, puntuaciones ni datos de producción. La primera corrección de este PR se describe en el apartado siguiente.

## Primera implementación de este PR

Se eliminan las reglas que protegían peticiones provisionales al reconstruir, editar y elegir. Las operaciones de elección actualizan solo las solicitudes de los participantes afectados, descartando fechas sustituidas; deshacer/rehacer normaliza también instantáneas antiguas. Reconstruir vuelve a las peticiones de las adjudicaciones recuperadas y finalizar reconcilia la campaña. Las previsiones de puntos y las revisiones para publicar también se calculan con las adjudicaciones vigentes. Al cerrar o publicar una campaña abierta, las solicitudes se fijan a partir de sus adjudicaciones; repetir el cierre de una campaña ya cerrada no reescribe su referencia.

No se realiza una migración global ni se modifican campañas cerradas existentes. Este primer cambio no añade un registro independiente de envío a RRHH ni redefine la reapertura de una relación ya enviada: esos aspectos del hallazgo 5 quedan pendientes de una segunda implementación. Exportar un Excel no demuestra su entrega. Las revisiones publicadas permanecen intactas.

Validación privada local: con la copia de Bravo v236, tanto elegir como avanzar automáticamente adjudican el ciclo solicitado a la persona afectada; continúan otras dos elecciones automáticas, y el proceso espera correctamente las cuatro horas configuradas para la persona siguiente. La versión local llega a 239. Solicitudes y adjudicaciones de la persona afectada contienen las mismas seis fechas y ya no incluyen 26/02. Las otras campañas permanecen sin cambios. No se adjunta la copia privada al repositorio.

Alfa y Delta pudieron cerrar porque cerrar solo cambiaba el estado y no pedía una posición nueva de solicitud. El bloqueo requiere una elección adicional con las seis posiciones ya ocupadas y menos de seis adjudicaciones. En la copia, Delta no presenta divergencias; Alfa tiene tres personas con fechas diferentes, pero no exceso de solicitudes respecto de adjudicaciones. Eso no certifica sus puntuaciones: la relación enviada a RRHH debe cotejarse por separado antes de reparar un ejercicio cerrado.

## Hallazgos detectados antes de la corrección

### 1. P1 — La reconstrucción conserva como operativas las solicitudes anteriores al rebobinado

`server/reconstruction.ts:495`: al recuperar la instantánea anterior al punto reconstruido se sustituye deliberadamente su lista de solicitudes por `origin.requests`, que contiene las del estado desde el que se inició la reconstrucción. Por tanto, retroceden las adjudicaciones pero pueden sobrevivir peticiones de decisiones posteriores.

`server/reconstruction.ts:675`: al aplicar decisiones nuevas se conserva la solicitud anterior como referencia de puntuación; si ya hay tantas solicitudes como adjudicaciones no se registra la nueva fecha. Esto mezcla la reconstrucción de una elección abierta con la protección de vacaciones ya enviadas a RRHH.

`server/reconstruction.ts:598`: finalizar marca la sesión como completada, reinicia el reloj y registra el impacto, pero no reconcilia esas solicitudes con el resultado definitivo de la reconstrucción.

Efectos: fechas sustituidas siguen interviniendo en puntuación y ocupando posiciones; la reconstrucción puede terminar sin eliminar la divergencia.

### 2. P1 — El guardado normal limita las elecciones por el historial de solicitudes

`server/election-service.ts:865`: la transacción añade una solicitud por cada adjudicación nueva si no encuentra ya esa fecha. Busca una posición libre entre 1 y `cyclesPerPerson`, contando también las solicitudes antiguas que sobrevivieron a una reconstrucción. La regla se aplica antes del cierre, sin distinguir la referencia de RRHH.

Caso reproducido con B-2027 v236: la persona afectada tiene cinco adjudicaciones y seis solicitudes, una del 26/02 que no está adjudicada. El motor acepta 23/04 y encuentra una terminación legal, pero el servicio rechaza tanto `choose` como `advance` con HTTP 400: «No quedan posiciones para registrar la solicitud original». La transacción no se confirma y la versión permanece en 236. Esto impide tanto el guardado manual como continuar los automatismos después de la elección anterior.

La protección errónea está en el flujo compartido de elecciones, por lo que revisar solo el botón manual no resolvería el problema.

### 3. P1 — La edición de adjudicaciones conserva solicitudes antes del cierre según exista un estado de elección

`server/service-commands.ts:274`: `delete_award` elimina la solicitud asociada únicamente cuando no existe `election.state`. Si hay estado de elección, incluso pausada y con campaña abierta, conserva la solicitud por una interpretación de los criterios de puntuación.

`server/service-commands.ts:293`: `award` añade la adjudicación, pero no actualiza la solicitud correspondiente. El resultado depende de cómo se creó la campaña, en vez de depender de si existe una relación definitiva enviada a RRHH.

Efectos: corregir una elección abierta puede conservar puntos de una fecha anulada y separar las dos relaciones sin que exista todavía una referencia cerrada que proteger.

### 4. P1 — La puntuación para el siguiente orden se deriva de solicitudes, no de la relación definitiva de RRHH

`domain/vacations.ts:45`: `nextYearOrdering` suma las fechas de `requests`, ponderadas por su posición. No recibe una referencia de cierre ni una relación de RRHH congelada. `calculate` la invoca con las solicitudes de la campaña.

`server/service.ts:837`: la hoja de RRHH se rellena con `awards`. Por tanto, los ciclos que se exportan y los que se usan para el siguiente orden pueden diferir.

Mostrar una previsión de puntos durante la elección es compatible con la regla aclarada, siempre que use las adjudicaciones vigentes y no se trate como puntuación definitiva. La referencia final debe proceder de las vacaciones cerradas y enviadas a RRHH.

### 5. P1 — El cierre no establece la referencia que realmente debe preservarse

`server/service-commands.ts:393`: cerrar/reabrir únicamente actualiza `campaigns.status`. No crea una instantánea de vacaciones definitivas ni reconcilia las solicitudes.

`executeCalculate` guarda revisiones en `runs`, y publicar enlaza una mediante `published_run_id`; pero esas revisiones contienen las solicitudes y adjudicaciones ya divergentes. Ese mecanismo no garantiza que la puntuación derive del contenido enviado a RRHH.

`server/service.ts:845`: la exportación exige campaña cerrada, lee las adjudicaciones y audita año, versión y plantilla. No establece por sí misma una referencia inmutable de ciclos para puntuar. Reabrir y volver a cerrar tampoco expresa si se corrige un cierre todavía no remitido o se pretende reemplazar una referencia ya enviada.

La corrección debe vincular explícitamente cierre, relación de RRHH y referencia de puntuación. Descargar un Excel no demuestra que se haya enviado: no debe suponerse una entrega externa a partir de una mera exportación.

### 6. P2 — Pruebas y documentación fijan la interpretación equivocada

- `tests/reconstruction.test.ts:203` exige que una solicitud anterior permanezca después de finalizar una reconstrucción con otra adjudicación.
- `tests/election-service.test.ts:586` exige conservar la solicitud y sus puntos al cambiar una adjudicación de una elección pausada, sin haber cerrado la campaña.
- `tests/election-service.test.ts:630` acepta una puntuación histórica basada en solicitudes diferentes de las adjudicaciones, sin fijar la frontera de cierre.
- `docs/ELECCION.md:7` y `:8` describen ese comportamiento como cumplimiento de la normativa, sin distinguir cambios durante la elección de cambios posteriores al envío a RRHH.

Cambiar solo el código dejaría pruebas que reclaman reintroducir el defecto. Deben corregirse conjuntamente el contrato funcional, las pruebas y esa documentación. No se propone alterar la transcripción del documento normativo: la aclaración corresponde a la interpretación de su aplicación.

## Extensión observada en la copia

Se compararon, por persona, los conjuntos de fechas de solicitudes y adjudicaciones en las ocho campañas reales de 2027, sin simulaciones:

| Equipo | Estado | Personas con fechas diferentes | Con más solicitudes que adjudicaciones |
| --- | --- | ---: | ---: |
| B | Abierto | 3 | 2 |
| H | Abierto | 1 | 0 |
| A | Cerrado | 3 | 0 |
| C, D, E, F, G | Varios | 0 | 0 |

Son divergencias verificadas, no prueba de que todos esos casos tengan el mismo origen. El A ya está cerrado: antes de corregir sus datos se debe cotejar la relación efectivamente enviada a RRHH. Una igualación masiva de solicitudes y adjudicaciones podría destruir una referencia legítima posterior al cierre.

## Criterio de corrección

1. En campaña abierta, adjudicaciones vigentes como única relación operativa de vacaciones; deshacer, rehacer, reconstruir y corregir no deben dejar solicitudes anuladas ocupando posiciones. La auditoría técnica permanece separada.
2. Al cerrar y establecer la relación definitiva para RRHH, crear una referencia explícita y versionada de persona, ciclo y datos necesarios para reproducir la puntuación. No reutilizar sin más la historia de peticiones de la elección.
3. Tras ese hito, permitir diferenciar las vacaciones vigentes de la referencia de puntuación protegida. Reapertura y sustitución de una relación definitiva deben ser operaciones explícitas, no un efecto incidental de cambiar el estado.
4. Reparar campañas abiertas con evidencia y copia previa. Revisar por separado campañas cerradas contra su referencia de RRHH; no reconstruirla suponiendo que lo vigente hoy es necesariamente lo remitido.
5. Regresiones: reconstrucción terminada con fecha sustituida; deshacer y nueva rama; edición con elección pausada; sexto ciclo manual y automático; cierre y puntos de RRHH; cambio posterior sin alterar puntuación histórica; reapertura y nueva exportación; restauración y aislamiento de campañas.

## Conclusión

El defecto de la persona afectada es una manifestación de una interpretación aplicada en varios flujos. El sistema protege como originales peticiones registradas antes del cierre y, a la vez, no establece de forma suficiente la referencia definitiva que sí debe proteger. La solución debe corregir esa frontera funcional, no limitarse a ampliar las seis posiciones o borrar la solicitud de la persona afectada.
