# Validación y alcance del MVP

12 de octubre de 2026. Fuentes: Excel original conservado en `../fuentes`, módulos VBA y cinco archivos Apps Script en `../src`. El original y la conversión funcional permanecen intactos.

## Comprobaciones realizadas

| Comprobación | Evidencia |
|---|---|
| Calendario y baremo 2026, equipo C | Coincidencia exacta de las 45 fechas y 45 puntuaciones con valores guardados en el Excel original. Fixture sin nombres ni identificadores reales. |
| Pascua, Feria y fechas UTC | Pruebas del computus, +18 original, fecha inválida y año bisiesto. |
| Ocho equipos y cambios anuales | 120 calendarios, años 2026–2040, sin fechas duplicadas; intervalos de ocho días y ajuste de nueve días cuando corresponde. Es una comprobación de invariantes, no 120 comparaciones contra Excel recalculado. |
| Cupos dinámicos | Port directo de S, T, AA y celdas auxiliares, con casos de agotamiento global y de verano. Se conserva el límite U5:U49. |
| Baremos y desempates | Se mantiene la ordenación informativa heredada de Excel, pero el turno operativo sigue Criterios Vacaciones 1.1: sorteo de empatados y rotación entre rondas, no antigüedad. |
| Roles y equipos | Viewer/anónimo sin escritura; responsable de A no modifica C; miembro ajeno rechazado; configuración reservada al superadministrador; delegación caducada sin permiso. |
| Concurrencia | Edición obsoleta rechazada; compare-and-swap fallido revierte todo el lote SQL. |
| Campañas | Creación de ocho campañas nuevas sin alterar el ejercicio anterior; no copia solicitudes/adjudicaciones. |
| Publicación | Revisión antigua no publicable; lector solo recibe snapshot publicado; borradores posteriores no alteran la vista de consulta. |
| Copia y restauración | Exportación JSON, SHA-256, rechazo de corrupción, restauración y rollback por referencias inválidas. |
| HTTP con D1 local | Persistencia tras nueva petición; 401 sin sesión, 403 sin Origin, 409 con versión obsoleta; copia completa. |
| Interfaz | Guardado de solicitud ficticia en navegador; comprobación de calendario/escritorio y formulario/móvil (390 px), sin desbordamiento horizontal. |

33 pruebas automatizadas pasan, incluidas cuatro sobre plantillas independientes, copia explícita o vacía, traslados atómicos y protección de personas con vacaciones. TypeScript de la aplicación pasa y el build Worker compila. Pruebas SQL críticas usan SQLite real con claves foráneas, además de pruebas HTTP sobre D1/Miniflare local. No equivalen por sí solas a verificación de la base alojada.

## Correspondencia con el original y decisiones explícitas

- La adjudicación es manual por el responsable. No se ha inventado un algoritmo de asignación automática: las macros originales copian/ordenan peticionarios y turnos disponibles. La web calcula baremos, orden y cupos, registra adjudicaciones y conserva revisiones.
- La selección D:I puntúa con la peculiar permutación de ponderaciones del original J: primera selección utiliza el peso de I5; las siguientes D5–H5. Se conserva.
- El modelo web separa solicitud y adjudicación; en el original las seis fechas seleccionadas alimentan también la relación. Esta separación es explícita para permitir preparar peticiones sin presentarlas como adjudicaciones. La puntuación corresponde a la selección solicitada; ocupación y cupos a la adjudicación registrada.
- Hay dos grupos de cupos: planificación por períodos de DATOS y controles numéricos independientes de la relación Vac (mínimo, base, máximo, extra enero–mayo y extra octubre–diciembre). No se enlazan automáticamente, igual que las celdas originales.
- Vac!G3 e Y3 contienen el número 2 literal; U51 excluye la fila 50. Se conservan en el port y se documentan. Cambiarlos sería una nueva versión de las reglas, no una reparación silenciosa.
- Se conserva Feria +18, aunque el nombre indica miércoles. No se ha comprobado con calendario oficial.
- La fecha del correturnos se guarda por ejercicio. El motor conserva el cambio de rotación antes de su ciclo y el día adicional del año bisiesto. Un ciclo distinto de ocho días se rechaza porque no existe una rotación validada para otros tamaños.
- Los valores de referencia provienen de la caché del Excel guardado, no de ejecutar Excel vivo en este turno. Se observaron entradas de origen con fechas de distinto ejercicio; no se importaron. Para una campaña nueva se usan los ciclos de junio a septiembre, seleccionados mediante límites de mes, y parámetros anuales explícitos.
- Antigüedad es una entrada explícita por persona y se copia al ejercicio; no se infiere de nombres, orden alfabético ni identidad de ChatGPT. Si coincide tanto puntuación como antigüedad, se mantiene el orden de entrada. No se añade sorteo ni otra preferencia.
- La configuración anual compleja se conserva como JSON validado y versionado, separado del resto de entidades relacionales. Se puede normalizar más tarde sin acoplar el motor a D1.
- Se impiden adjudicaciones duplicadas, fuera de campaña o que excedan los cupos. El número de ciclos de verano por persona es un objetivo de planificación; se muestra como aviso, porque el original contiene personas con más de dos selecciones de verano. y se informan incidencias. No se ha certificado una adjudicación operativa real.

## Pendientes y límites

La carga de datos originales fue autorizada expresamente después del primer despliegue. El fichero original conservado y la copia de Descargas tienen el mismo SHA-256 y contienen una única plantilla de 16 personas del equipo C. No se han encontrado las plantillas de los otros siete equipos. La importación local y la comprobación alojada verifican 16 nombres, 81 selecciones/adjudicaciones y las 16 puntuaciones guardadas. Los nombres quedan en D1 y en copias privadas, fuera del código y de GitHub. Antes de uso operativo faltan validación de campañas adicionales frente a Excel/Sheets recalculados (incluido un bisiesto y distribución real de extracupos), aceptación de responsables y contraste de festivos aplicables. La equivalencia probada no cubre todas las fórmulas de Cuenta horas/Tosto turnero ni los informes de horas trabajadas: son superficies fuera del MVP de vacaciones.

Firebase/Google, envío de correo, comparación visual entre simulaciones, copias externas automáticas y migración a PostgreSQL no están implementados. La estructura admite proveedor de identidad, permisos temporales y varias revisiones, pero no se afirma que esas integraciones hayan sido probadas.

La configuración de fechas y rotación más avanzada se edita/importa mediante el documento de parámetros, con validación en el servidor. No exige SQL ni cambios de código; mejorar ese editor con formularios específicos es una ampliación reversible.

Sites provee DB y encabezados de identidad, y mantiene una lista de visitantes independiente de los roles. No hay contraseñas propias. La verificación de Firebase en este alojamiento requiere probar dominios autorizados y el flujo de login, no solo disponer del SDK.

La exportación JSON cubre todos los datos; CSV cubre adjudicaciones del equipo. Las copias se descargan manualmente. El límite del importador es 5 MB y 25.000 registros; la restauración debe mantenerse dentro de los límites de lote/consultas de D1 del entorno. La gratuidad permanente no está garantizada por una prueba técnica y no se ha activado ningún servicio facturable.

Ver [README.md](README.md) para uso, despliegue, Firebase y migración a Cloudflare. La prueba del Site alojado y su URL se registran en [DESPLIEGUE.md](DESPLIEGUE.md).




## Aclaración del proceso de elección
El orden operativo no se ha validado: debe derivarse de remanentes del ejercicio anterior. El cálculo actual corresponde al baremo de las selecciones del ejercicio abierto. Se elimina la etiqueta que lo identificaba como orden de petición. La reproducción de un proceso secuencial requiere normas, remanentes de origen y secuencia de elección, además de los resultados finales.

## Ampliación de elección secuencial y simulaciones

45 pruebas automatizadas pasan. Se añaden turno y prioridad de listas, rechazo de elección fuera de turno, aplazamiento y elección doble atómica, consentimiento automático, opciones compatibles del segundo ciclo, aislamiento de preferencias y nombres, cuenta vinculada sin administración, undo/redo de cola y ocupación, cierre de campaña, simulaciones independientes y restauración de tablas nuevas y copias antiguas.

HTTP sobre D1 local: dos escenarios completos probaron tres elecciones con automatismos y cinco elecciones con aplazamiento/recuperación, rechazo de cambios en una campaña cerrada, lectura anónima de la campaña real, rechazo anónimo de simulaciones y preservación de los datos de origen. En Chrome se creó un tercer escenario desde la UI y se eligieron directamente ciclos simples y dobles, con confirmación integrada, avance de cola y undo/redo. Vista de 390 px sin desbordamiento horizontal; filtro por controlador con ciclos resaltados. Son simulaciones ficticias locales, no una adjudicación operativa ni logins reales de controladores externos.

La consulta pública actual sustituye la limitación de mostrar solo el último resultado publicado. La revisión final archivada sigue siendo independiente e inmutable. No se publican preferencias, cuentas ni nombres completos.

Recibido: Criterios Vacaciones 1.1 (10/06/2025), documentado en docs/CRITERIOS_VACACIONES_1.1_2025.md. Ahora se implementan rotación de empates, dos aplazamientos, turnos conjuntos, cupos RRHH, registro separado de solicitudes originales y puntuación de nuevas incorporaciones. La regresión histórica ya reproduce desde el motor TypeScript las 46 fechas y 46 baremos de 2020, las 46 fechas y 45 baremos verificables de 2022, y las 90 elecciones reales de 2020 con cupos y clasificación resultante de 2021. Véase docs/VALIDACION_HISTORICA.md. Pendiente: el PDF original binario, datos históricos contrastados de todos los equipos, verificación independiente de la lógica histórica de festivos, y reconstrucción exacta de eventuales elecciones conjuntas o permutas. La plantilla de 2022 tiene #N/A en su último ciclo.

## Playwright — 13 de octubre de 2026

Suite reproducible: 4 escenarios en escritorio y móvil (8 pruebas), servidor propio en 5199 y D1 exclusiva de QA. Ejecución completa con Chrome instalado: 8/8 correctas en 1,3 minutos. Consulta pública, aislamiento, aplazamiento y elección doble, undo/redo, preferencias automáticas, bloqueo, descarga y restauración. No certifica el login real de ChatGPT ni Safari nativo. Ver docs/PRUEBAS.md.


## Aplicación de Criterios Vacaciones 1.1 — 13 de octubre de 2026

Las pruebas añadidas verifican explícitamente la elección triple, la rotación de grupos empatados, los turnos conjuntos, los cupos RRHH de un solo CTA, el cálculo de altas y la conservación de solicitudes tras una modificación de adjudicación. El orden inicial y el sorteo requieren verificación del administrador; las vacaciones de antigüedad dependen de otro documento todavía no aportado. Los cambios se desarrollan en la PR #1 y deben ser aprobados antes de producción.


## Regresión histórica, equipo H (13 de octubre de 2026)

Pruebas automatizadas basadas en libros Excel V19.8 (2020) y V20.0 (2022): comprobadas 46+46 fechas, 46+45 baremos, 90 elecciones, 15 totales personales y las 15 posiciones del orden para 2021. GitHub Actions: 57/57 pruebas Node y 10/10 pruebas Playwright; typecheck correcto. Los valores diarios se toman de las cachés del original: no es una certificación de sus fórmulas de festivos ni una demostración de cronología de permutas. [Metodología y límites](docs/VALIDACION_HISTORICA.md).
