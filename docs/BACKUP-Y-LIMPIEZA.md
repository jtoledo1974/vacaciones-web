# Backup v2 y mantenimiento conservador

## Estado y límites de esta entrega

No se ha fusionado, desplegado ni ejecutado la nueva limpieza en producción. Las rutas v2 requieren la migración `0020_backup_clock.sql`; **el código de este PR no está disponible en el sitio hasta un despliegue aprobado por separado**. No se ha obtenido una copia completa de producción con este código todavía.

La restauración v2 implementada es **fuera de línea, en un SQLite nuevo**. Se comprueba su uso por el repositorio y el servicio, incluida una reconstrucción activa, volver/avanzar, cancelar y undo/redo. No hay importador v2 masivo a D1 en caliente ni sustitución automática de la base de Sites. El endpoint y formulario v1 siguen disponibles para copias pequeñas compatibles; su límite HTTP sigue siendo 5 millones de caracteres y no deben usarse para esta base de producción. No convertir v2 a un único JSON v1 para intentar sortear este límite.

## Descargar y verificar

```sh
VACACIONES_URL=https://vacaciones.lazaro.es node scripts/admin-cli.mjs backup --out copia.ndjson
node scripts/restore-backup-v2.mjs copia.ndjson restauracion-nueva.sqlite
```

Node >=22.13, con `node:sqlite`. El CLI utiliza la sesión delegada existente o el mecanismo habitual de autenticación; no elude permisos. Es exclusivo del superadministrador. Las escrituras administrativas del CLI también usan v2 para la copia previa y se detienen si esta no termina correctamente.

En la web, «Descargar copia completa v2» usa File System Access y escritura directa a disco. Requiere navegador compatible (por ejemplo Chrome/Edge en escritorio) y contexto seguro. Si no está disponible, se indica usar el CLI: **no hay fallback a Blob ni acumulación completa en memoria**. Firebase y las sesiones locales/delegadas usan el mismo cliente autenticado.

El CLI crea un archivo `.partial` con modo 0600 en POSIX, comprueba cada página, sincroniza el archivo y solo lo publica después del cierre válido (enlace atómico sin sobrescritura; requiere un sistema de archivos compatible). En Windows hay que elegir una carpeta con ACL privada: el modo POSIX no reemplaza sus permisos. No sobrescribe destinos existentes. En fallo normal elimina el parcial; si se mata el proceso o se pierde la máquina puede quedar `.partial`, que no es una copia válida. En la web se aborta el escritor si falla la descarga. No se reanudan copias de revisiones distintas: hay que empezar de nuevo.

### Formato

NDJSON `vacaciones-backup-v2`:

1. Manifiesto: revisión, esquema, columnas e inventario de filas, SHA-256.
2. Páginas: revisión y cursor `{table,row,offset}`, hasta ocho fragmentos de 8.192 caracteres Unicode, SHA-256 de su payload. Una fila/celda grande **no se devuelve entera**: SQLite aplica `substr(json_object(...))` antes de devolver datos.
3. Página final: vuelve a comprobar revisión y huella del esquema.
4. Cierre: cantidad de páginas y cadena SHA-256 de manifiesto y páginas. El verificador valida secuencia de fragmentos, cursores y recuento de filas por tabla. Sin cierre o con diferencias, no hay éxito ni SQLite publicado.

Los bytes SHA se calculan sobre `JSON.stringify(payload)` en UTF-8. La cadena empieza por el hash del manifiesto; cada paso es SHA-256 de `JSON.stringify([cadenaAnterior, hashPagina])`. Esto detecta corrupción, **no autentica el origen**. Guardar las huellas/copia en una ubicación independiente y protegida si se necesita resistencia a manipulación deliberada.

El transporte de datos está acotado por página, no por tamaño total de la base. El esquema/inventario es pequeño y está ligado al esquema versionado del repositorio. Se rechazan tablas desconocidas o rowid fuera del rango entero seguro positivo: nunca se ignoran silenciosamente. La lectura puede ser más lenta que un volcado nativo: repite el procesamiento SQL de las filas grandes para cortarlas. No se ha probado su rendimiento remoto ni atribuido el error D1 original a un límite de volumen.

### Coherencia

`backup_clock` cambia mediante triggers INSERT/UPDATE/DELETE de **cada tabla respaldada**, incluso si la escritura no pasa por `Service.commit`. Cada página lee reloj y fragmentos en el mismo `db.batch` transaccional. Cualquier diferencia de revisión aborta con 409. También se compara el esquema al cerrar. No bloquea a los usuarios durante toda la descarga, pero necesita un intervalo sin escrituras para completarse; cambios en notificaciones también la invalidan. No promete completar bajo escritura continua. En tal caso hace falta acordar una ventana de quietud o un snapshot nativo del proveedor, sin desactivar estos controles.

No hacer migraciones/DDL ni manipular relojes/triggers durante el respaldo. Los cambios de esquema ordinarios se detectan al cerrar; una intervención privilegiada que quite y reponga triggers y modifique datos fuera del reloj no está cubierta.

### Contenido y exclusiones

Incluye tablas v1 de negocio, permisos y **audit completo en orden de rowid**, reconstrucciones ordinarias y VA, escenarios, preferencias y vinculaciones. Amplía v1 con `app_state`, borradores privados, plantillas RRHH, suscripciones push, notificaciones y entregas. No elimina nada del origen. Las colas se conservan como datos, no se ejecutan durante restauración.

Excluye expresamente sesiones e intentos de autenticación (credenciales no portables), aserciones transitorias, relojes técnicos e infraestructura de migraciones del motor (`__appgarden_migrations`, D1/Drizzle). No contiene secretos de entorno, pero **sí datos personales, documentos RRHH y claves de suscripciones push**: cifrar/proteger su almacenamiento y no subirlos al repositorio, adjuntos de PR ni logs. `.ndjson`, `.sqlite*`, `.partial` y `admin-backups/` se ignoran en Git.

### Restauración fuera de línea

El restaurador usa solo las migraciones SQL del repositorio de confianza; **no ejecuta SQL procedente del archivo**. Exige que tablas y columnas coincidan con esta versión. Conserva rowid para no alterar el orden de auditoría. Compone las filas en una tabla temporal SQLite y las inserta por extracción JSON SQL, sin construir una fila grande en JavaScript. El caché SQLite se limita a 4 MiB; SQLite sí necesita memoria temporal para procesar la mayor celda/fila. No es una garantía de memoria constante frente a una celda individual arbitrariamente grande. La descarga y lectura JavaScript se limitan por página/línea; SQLite conserva sus propios límites de longitud.

Comprueba cadena, inventario, claves foráneas e `integrity_check`, y confirma una sola transacción en un archivo nuevo. Ante error revierte y elimina el destino parcial. No sobrescribe otra base. El archivo restaurado no contiene accesos delegados y exige reautenticación.

No conectar este SQLite automáticamente a un despachador de notificaciones: revisar leases/estados pendientes antes de activar cualquier envío, para evitar duplicados. Para una recuperación de Sites/D1 falta un procedimiento operativo revisado de importación/sustitución, autenticación y tratamiento de colas. La restauración fuera de línea no es aprobación para ejecutarlo sobre producción.

## API de limpieza

Solo superadministrador; usa la autenticación y comprobación Origin/JSON habituales del API. Ningún rol de equipo o administrador solo de VA puede previsualizar ni aplicar.

```sh
node scripts/admin-cli.mjs cleanup preview --mode compact-reconstruction-events --out plan.json
# REVISAR el plan y la copia previa; no ejecutar en producción sin aprobación:
node scripts/admin-cli.mjs cleanup apply plan.json

node scripts/admin-cli.mjs cleanup preview --mode expired-auth-only --out plan-tecnico.json
```

- `GET /api/cleanup?mode=compact-reconstruction-events` o `expired-auth-only` (por defecto).
- `POST /api/cleanup` con `{mode,cutoff,token}` del preview.
- El preview no modifica datos de aplicación. El middleware de autenticación puede seguir realizando la housekeeping de sesiones caducadas que ya hacía antes de este PR.
- Devuelve categorías, filas, bytes lógicos brutos **del próximo lote**, dependencias, efectos y capacidades conservadas/perdidas. No implica que sean todos los candidatos de toda la base.
- El token SHA-256 liga el plan exacto, modalidad, cutoff y revisión; caduca a los 15 minutos. Un cambio respaldable invalida el plan. Para autenticación caducada se añade un reloj de cambios de filas caducadas; crear/cerrar una sesión todavía vigente no invalida por sí solo una confirmación.
- Se recalcula el plan y se hace CAS/aserción SQL antes de modificar, todo en un batch transaccional. Una carrera entre recalcular y escribir revierte todo. No se puede reutilizar el token; solicitar preview para cada lote. Se registra un nuevo evento `maintenance_cleanup` con actor, plan y token, sin contenidos personales, en la misma transacción.
- Los bytes son ahorro lógico bruto; el nuevo evento de auditoría tiene un coste y el motor puede conservar páginas reutilizables. No promete reducción equivalente del almacenamiento facturado ni ejecuta VACUUM.

### Modalidades

**`compact-reconstruction-events`: una sesión por lote.** Aplica a `originalEvents` la misma proyección acotada que ya se aplica al crear sesiones nuevas desde #169: mantiene estado, decisión y listas de sus participantes; retira premios, solicitudes, listas ajenas e informe de disponibilidad duplicados. **Exige que cada dato retirado coincida exactamente con el original conservado en audit**. Si falta ese origen o la estructura es desconocida, omite la sesión. No toca `origin`, `applied`, `undone`, checkpoints de disponibilidad ni el informe `impact` superior. No elimina sesiones completas, incluidas las completadas.

Conserva undo/redo, reconstrucción/cancelación/repetición, ramas anteriores, informes completos en audit, disponibilidad histórica, negocio vigente, identidades, permisos y preferencias. La prueba integrada recorre estas operaciones tras compactar y después de restaurar v2. Es idempotente; las sesiones nuevas ya compactadas no vuelven a crecer por esas copias. No hay nueva reestructuración global de snapshots.

**`expired-auth-only`: hasta 500 filas por categoría/lote.** Solo sesiones locales y CLI expiradas e intentos cuyo periodo de limitación ya terminó (15 minutos para accesos locales). No borra sesiones vigentes, usuarios, permisos ni historial oficial de decisiones. Se pierde únicamente el registro técnico caducado seleccionado; no se interrumpe el acceso vigente. La autenticación existente ya elimina parte de estos datos automáticamente, por lo que puede no haber ahorro.

**No hay modalidad de poda de audit**, de runs o de reconstrucciones completas. `before_json` participa en undo y reconstrucción; `after_json` contiene referencias, efectos e informes usados para interpretar ramas y disponibilidad. La antigüedad/estado completado no demuestra que sean prescindibles. Una poda con pérdida histórica exige otra política y aprobación explícita, no está escondida bajo «limpieza».

## Previsualización disponible para aprobación: producción 30/10/2026

Se hicieron únicamente GET de `/api/diagnostics/storage?offset=0,10,20,30`, a las 18:28:25–18:28:29 UTC. Solo se recuperaron agregados, no filas ni datos personales. No son un snapshot coherente ni un preview con token de la nueva API (todavía no desplegada).

| Categoría | Filas | Bytes lógicos observados | Propuesta |
| --- | ---: | ---: | --- |
| audit | 2.441 | 63.475.276 | Proteger íntegramente; **0 filas/0 bytes a borrar** |
| reconstruction_sessions | 4 | 3.409.228 | Candidatas a inspección conservadora; máximo teórico inferior a este total, **ahorro exacto aún no medido** |
| requests + awards | 2.433 | 291.487 | Proteger; 0 filas/0 bytes a borrar |
| hr_templates | 1 | 216.642 | Respaldar, no limpiar |
| personal_simulations | 3 | 1.221 | Respaldar, no limpiar |
| autenticación local/CLI | 3 sesiones, 0 intentos | 793 | No se consultaron vencimientos individuales; elegibilidad/ahorro por confirmar |

Total lógico observado: **68.014.419 bytes**, incluidos datos técnicos. `audit.before_json`: 48.364.486; `audit.after_json`: 14.700.926. Fila mayor de audit: 100.920 bytes; sesión mayor de reconstrucción: 1.977.816. No se ha medido el desglose interno de `after_json`, ni se afirma que el tamaño sea la causa del fallo genérico D1.

Request IDs de lectura: `567c6d55-128b-4ec9-82b4-7668cf1337b6`, `fb892b3b-849a-4ad5-a8b9-10bb20346674`, `5c90104a-9b15-42e4-9580-216b1bbb05dd`, `c752e622-5404-421e-8cd9-e9696d198d1a`.

**Pendiente para una aprobación ejecutable:** tras revisión y despliegue autorizados por separado, completar backup v2, restaurarlo/validarlo fuera de línea y solicitar el preview v2 real para obtener cantidades/bytes/token exactos del próximo lote. Esta tabla no autoriza a ejecutar limpieza ni inventa ese token. El backup fiable no depende de aprobar una poda de audit.

## Validación reproducible

- `node --experimental-transform-types --test tests/backup-v2.test.ts`: >72 MB de texto sintético, celda de 2 MB, Unicode, páginas acotadas, round-trip, interrupción, corrupción, cambios entre páginas/finales y de esquema, roles, confirmación, lotes y carrera entre preview y commit.
- `tests/reconstruction.test.ts`: reconstrucción activa tras compactar, backup/restauración, back/forward/cancel y undo/redo.
- `tests/admin-cli.test.ts`: copia previa streaming, permisos, integridad, cancelación, escritura única y privacidad de archivos.
- Playwright local con D1/Miniflare: descarga v2 a escritor, compatibilidad de restauración v1. Solo base sintética local separada.

Resultado local final: **618/618** pruebas unitarias/integración; build, format:check y lint:ratchet correctos. Playwright Chrome/D1 local: descarga v2, aborto del escritor ante 409 sin publicar copia y restauración v1, correcto. Tras reforzar publicación sin sobrescritura se repitieron las 36 pruebas de backup/CLI, todas correctas. TypeScript global no está limpio: **437 diagnósticos**, igual que `main` comprobado por separado (no se presenta como typecheck superado).

Las pruebas locales no demuestran aún éxito remoto de la nueva ruta en Sites ni eliminan otros posibles fallos D1. No incluir copias reales en pruebas, commits o PR.
