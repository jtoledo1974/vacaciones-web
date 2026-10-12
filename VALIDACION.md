# Validación y alcance del MVP

12 de octubre de 2026. Fuentes: Excel original conservado en `../fuentes`, módulos VBA y cinco archivos Apps Script en `../src`. El original y la conversión funcional permanecen intactos.

## Comprobaciones realizadas

| Comprobación | Evidencia |
|---|---|
| Calendario y baremo 2026, equipo C | Coincidencia exacta de las 45 fechas y 45 puntuaciones con valores guardados en el Excel original. Fixture sin nombres ni identificadores reales. |
| Pascua, Feria y fechas UTC | Pruebas del computus, +18 original, fecha inválida y año bisiesto. |
| Ocho equipos y cambios anuales | 120 calendarios, años 2026–2040, sin fechas duplicadas; intervalos de ocho días y ajuste de nueve días cuando corresponde. Es una comprobación de invariantes, no 120 comparaciones contra Excel recalculado. |
| Cupos dinámicos | Port directo de S, T, AA y celdas auxiliares, con casos de agotamiento global y de verano. Se conserva el límite U5:U49. |
| Baremos y desempates | Ponderación de las seis columnas originales y orden ascendente, con empate por antigüedad. |
| Roles y equipos | Viewer/anónimo sin escritura; responsable de A no modifica C; miembro ajeno rechazado; configuración reservada al superadministrador; delegación caducada sin permiso. |
| Concurrencia | Edición obsoleta rechazada; compare-and-swap fallido revierte todo el lote SQL. |
| Campañas | Creación de ocho campañas nuevas sin alterar el ejercicio anterior; no copia solicitudes/adjudicaciones. |
| Publicación | Revisión antigua no publicable; lector solo recibe snapshot publicado; borradores posteriores no alteran la vista de consulta. |
| Copia y restauración | Exportación JSON, SHA-256, rechazo de corrupción, restauración y rollback por referencias inválidas. |
| HTTP con D1 local | Persistencia tras nueva petición; 401 sin sesión, 403 sin Origin, 409 con versión obsoleta; copia completa. |
| Interfaz | Guardado de solicitud ficticia en navegador; comprobación de calendario/escritorio y formulario/móvil (390 px), sin desbordamiento horizontal. |

28 pruebas automatizadas del motor y servicio pasan. TypeScript de la aplicación pasa y el build Worker compila. Pruebas SQL críticas usan SQLite real con claves foráneas, además de pruebas HTTP sobre D1/Miniflare local. No equivalen por sí solas a verificación de la base alojada.

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


