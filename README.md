# Vacaciones web

Proyecto independiente: no modifica el Excel, la hoja nativa ni sus Apps Script. React/Vinext con Worker, D1 y autenticación de Sites. Las tablas y parámetros permanecen al desplegar versiones nuevas.

## Uso

1. Consulta pública: elige equipo A–H y año para ver calendario, elecciones actuales y baremos. Usa «Por CTA» para consultar por persona sus ciclos y puntos (sin resaltar los días en el calendario).
2. Administración: inicia sesión con una de las tres cuentas autorizadas. Vincula las cuentas personales a controladores para que puedan guardar sus preferencias y elegir en su turno.
3. Vacaciones: añade alternativas desde el calendario y ordénalas. Guardarlas autoriza su aplicación automática en el siguiente turno efectivo; una casilla permite mantenerlas para todas las rondas restantes. Si guardas durante tu turno, una confirmación avisa de que pueden adjudicarse inmediatamente. Las listas de un solo turno quedan inactivas al elegir, incluso si la elección fue manual. El administrador también puede introducir listas de otras personas.
4. Confirma manualmente el orden de origen antes de activar la cola. La elección sigue las reglas del ejercicio: para 2027, la Guía LECS 2027 v1.3 junto con los cupos de RR. HH.; para ejercicios anteriores, Criterios Vacaciones 1.1 (10/06/2025). Incluye un ciclo por ronda, hasta dos aplazamientos para elegir tres ciclos, rotación de empatados sorteados y turnos conjuntos. Se debe confirmar el orden y el sorteo usando las puntuaciones del ejercicio anterior.
5. Simulaciones compartidas entre los administradores del mismo equipo: crea varios escenarios del mismo ejercicio para ensayar elecciones completas. Copian la plantilla, las reglas y el orden (si existe), pero nunca las preferencias privadas reales. Cada escenario tiene preferencias y adjudicaciones propias, y puede reiniciarse o eliminarse sin afectar la campaña real. Los grupos tienen nombres fijos, A–H.
6. Cerrar un equipo bloquea cambios pero mantiene la consulta. El cierre final puede guardar una revisión archivada; la ocupación actual es pública durante el proceso.
7. Descarga una copia completa JSON, que incluye preferencias, cuentas, cola, escenarios y revisiones. La restauración afecta a toda la aplicación, verifica integridad y se ejecuta en una transacción.

## Estructura

- `domain/`: fechas UTC, rotación, baremos, orden y cupos. Sin acceso a hojas, UI o D1.
- `server/service.ts`: casos de uso, autorización, publicación, auditoría y backup.
- `server/repository.ts`: contrato pequeño y adaptador D1 con SQL parametrizado.
- `app/`: interfaz responsive en español y rutas HTTP.
- `db/schema.ts`, `drizzle/`: esquema y migraciones versionadas. No ejecutar DDL en peticiones.
- `tests/`: referencia numérica sin nombres y pruebas automatizadas.

## Administración delegada y escenarios

El responsable de un equipo puede configurar su campaña real, crear y administrar simulaciones compartidas, preparar y pausar elecciones, y vincular cuentas de los compañeros. Puede introducir preferencias reales **solo de controladores sin cuenta vinculada**; en un escenario simulado puede crear preferencias ficticias para todos. La creación de escenarios nunca copia preferencias de la campaña real. Los administradores pueden dar y retirar permisos de administrador para **su equipo**, pero no pueden dejarlo sin un administrador permanente ni modificar permisos de otros equipos. Solo el superadministrador mantiene las operaciones globales y la restauración completa. La sustitución de la cuenta previamente vinculada de un controlador requiere superadministrador.

## Identidad y permisos

`Identity` identifica proveedor y sujeto; `principal` resuelve los permisos; `Service` autoriza cada operación. ChatGPT proporciona identidad verificada a través de su proxy. No publicar el Worker con estos encabezados como autenticación directamente en un alojamiento que permita al visitante falsificarlos.

`SUPERADMIN_EMAILS` se configura en el entorno de Sites, nunca en el frontend. Las dos cuentas solicitadas están autorizadas mediante ese entorno. Los permisos de otras cuentas ChatGPT Sites se asignan por correo electrónico autenticado desde Administración (Firebase continúa usando UID). Los vínculos anteriores por sujeto estable se siguen admitiendo. Las delegaciones admiten fecha de caducidad. El superadministrador no se concede desde el navegador ni por pertenecer simplemente al Site.

El Site tiene además una lista de visitantes de la plataforma. Esta lista y los permisos de la aplicación son independientes. La consulta pública muestra asignaciones actuales y códigos abreviados sin requerir cierre final. No entrega preferencias, antigüedad, nombres completos, cuentas, origen privado del orden ni configuración. Las simulaciones son privadas. Una cuenta vinculada modifica solo su lista y elige solo cuando le corresponde; la administración no se concede por iniciar sesión.

## Datos, concurrencia y copias

Entidades: equipos, personas, usuarios, asignaciones de permisos, campañas, parámetros anuales, miembros anuales, solicitudes, adjudicaciones, revisiones y auditoría. Los miembros anuales conservan su identidad, código, nombre y antigüedad propios. La composición se copia desde una campaña anual explícita o la última anterior; people conserva identidades, no una plantilla global activa que gobierne los años futuros. Altas, bajas, importaciones y traslados cambian únicamente el ejercicio elegido. La configuración compleja se guarda como documento JSON versionado por campaña; no contiene solicitudes ni adjudicaciones. Es una decisión reversible con un adaptador o migración futura.

Cada operación comprueba versión de campaña y ejecuta un lote transaccional D1 con compare-and-swap y una aserción SQL. El fallo revierte toda la operación, incluida la auditoría. Las revisiones guardan parámetros, entradas y resultados; una edición invalida su publicación. SHA-256 detecta daños accidentales en el backup, no autentica su origen. La restauración solo está disponible al superadministrador.

Backup JSON incluye todas las tablas de negocio, permisos e historial de cambios; `/lite/pdf?equipo=X&year=AAAA` muestra la situación actual del equipo en PDF y `/lite` es una versión de solo lectura sin JavaScript para móviles antiguos. No hay una copia automática fuera de Sites: conservar periódicamente el JSON en una ubicación independiente. La copia no contiene secretos de entorno ni credenciales. Restaurar no sustituye las migraciones del esquema.

## Desarrollo local

Node >=22.13 y pnpm 11.25.0. Instalar con el helper Sites `install-dependencies.mjs`, indicando `SITES_PNPM_BIN` si el runtime no tiene pnpm en PATH. El proyecto utiliza pnpm porque este host no incluye npm. Se conservan las bibliotecas del starter oficial y la integración de build `sites()`.

Pruebas: `node --experimental-transform-types --test tests/*.test.ts` con Node 24. Tipos: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`.

Generar migración: `node node_modules/drizzle-kit/bin.cjs generate`. Compilar con `build-site.mjs`. Aplicar la SQL local con Wrangler según el starter, usando `--local`, `dist/server/wrangler.json` y `.wrangler/state`. La base local y la alojada son distintas.

Vista local: `node scripts/run-framework.mjs dev`. `.dev.vars` puede autorizar `seedy@sites.test` SOLO en desarrollo; ese fichero está ignorado. La sesión simulada de loopback del starter no se incluye en producción.

Despliegue: registrar una sola identidad de Site, conservar `.openai/hosting.json`, sincronizar fuente con `site-workflow.mjs` y publicar el archivo construido desde el mismo commit. Sites aplica las migraciones y provisiona DB. Nunca subir fuentes Excel ni `.sites-runtime`, `.dev.vars`, `.wrangler`, copias de usuario o secretos.

## Sincronización y autenticación opcional

Los clientes activos comprueban la revisión de D1 cada cinco segundos y actualizan calendario, turno, historial y permisos cuando se guarda un cambio. Al regresar a una pestaña en segundo plano se refrescan inmediatamente. No son WebSockets ni se garantiza una notificación instantánea.

Firebase Authentication puede reutilizar usuarios y UID de un proyecto externo sin migrar contraseñas ni sustituir D1. Se activa solo al configurar los bindings de Firebase en Sites; las credenciales Sites existentes permanecen disponibles. Ver [docs/AUTENTICACION_FIREBASE.md](docs/AUTENTICACION_FIREBASE.md) para variables, dominios autorizados, tokens y verificaciones previas al despliegue.

## Firebase, Cloudflare y límites

Consultar [VALIDACION_HISTORICA.md](docs/VALIDACION_HISTORICA.md) para la reproducción de los Excel del equipo H de 2020/2022. Firebase sigue sin estar habilitado en el Site alojado, pero ya existe un adaptador opcional que verifica tokens ID en el servidor (firma, issuer, audience, expiración y sujeto) y vincula proveedor/sujeto a los permisos existentes. Para promover superadministradores con Firebase debe exigirse además `email_verified`, sin confiar en un correo suministrado por el cliente. Configurar dominio autorizado y probar popup/redirect antes de activar. Referencias: https://firebase.google.com/docs/auth/admin/verify-id-tokens y https://firebase.google.com/docs/auth/web/google-signin.

Migración a Cloudflare: desplegar el build Worker con Wrangler, crear DB, aplicar las SQL versionadas, importar el backup, configurar las variables de entorno y sustituir el adaptador de autenticación de Sites por Firebase verificado u otro proveedor. El motor y el repositorio D1 se conservan. PostgreSQL requeriría otro repositorio y traducción acotada de SQL/transacciones; no se ha implementado. La vinculación de identidades entre proveedores requiere confirmar cuentas: no mapear automáticamente sujetos de ChatGPT a Firebase.

No se ha contratado ningún servicio de pago. No existe prueba de gratuidad permanente: las cuotas y condiciones dependen de Sites y, tras migrar, del plan del proveedor. D1 tiene límites de tamaño, consultas y lote; la aplicación limita las importaciones y debe ampliar la estrategia de restauración si el historial crece. Referencia: https://developers.cloudflare.com/d1/platform/limits/.


La administración de plantillas permite nombres, nicks Unicode y fechas de antigüedad opcionales en una tabla conjunta; pegado por columnas y archivo de importación preparado desde el Excel. Los nombres son exclusivos de administración. No se generan fechas de antigüedad para celdas vacías. El código se conserva también en el repositorio privado https://github.com/jtoledo1974/vacaciones-web; las importaciones y copias de datos quedan excluidas.



En todas las vistas de administración hay Deshacer y Rehacer para el último cambio en solicitudes/adjudicaciones. Se conserva entre recargas y funciona también con el reinicio. Otra operación invalida el paso anterior para evitar sobrescribir trabajo posterior. En Administración, Empezar de cero las vacaciones exige escribir equipo-año; borra solo solicitudes y adjudicaciones del borrador y conserva plantilla, parámetros y publicaciones. Los cambios anteriores a esta versión no tienen undo retroactivo.

## Ayuda en la web
El apartado Ayuda permite leer y descargar las guías. La guía de consulta es pública; la guía de gestión y README y DESPLIEGUE se entregan solo a administradores mediante una ruta que comprueba el rol en el servidor. Los originales Markdown se incorporan al build del servidor, por lo que sus cambios se reflejan al desplegar.


## Paradigma de elección
El orden secuencial proviene de las puntuaciones de los seis ciclos originalmente solicitados en el ejercicio anterior. Ver [ELECCION.md](docs/ELECCION.md) y [normas 1.1](docs/CRITERIOS_VACACIONES_1.1_2025.md). Los empates se sortean y alternan por rondas; nuevas incorporaciones requieren los datos históricos disfrutados y las medias del equipo.

## Motor y contratos reutilizables

`domain/election.ts` implementa reglas puras sobre DTO: turno actual, validación de elecciones, aplazamiento y avance por preferencias. No importa React, D1, Cloudflare ni autenticación. La disponibilidad y los baremos conservan el motor original validado.

`server/election-service.ts` autoriza cada comando, obtiene los datos mediante Repository y guarda las elecciones, la cola y la auditoría con control de versión y transacción. `server/simulations.ts` clona escenarios aislados. `app/cycle-calendar.tsx`, `app/election-workspace.tsx` y `app/confirmation.tsx` separan calendario, flujo y confirmación accesible; no usan confirmaciones nativas de JavaScript.

API: GET `/api/campaign/:id` para la consulta actual, GET con `?published=1` para la revisión archivada; POST `/api/election/:id` para preferencias, elección, aplazamiento y administración de cola; GET `/api/election/:id/options` para comprobar el segundo ciclo; POST `/api/simulations/:id` para escenarios privados. Los comandos incluyen la versión de campaña. El transporte web actual usa la sesión de Sites y Origin; un cliente nativo futuro deberá usar un adaptador de identidad/transportes verificado. El motor y los casos de uso se conservan al cambiar de alojamiento o interfaz; no se afirma que exista ya una aplicación móvil o login Firebase.

Los automatismos se procesan en lotes acotados y la web continúa hasta el siguiente turno manual. Si se interrumpe la cadena, otra sesión autorizada puede continuarla. Deshacer y rehacer recuperan el último lote, incluyendo cola y preferencias. El reinicio vacía también el estado de elección; los escenarios separados permiten varias simulaciones simultáneas.

Pruebas de interfaz: pnpm test:e2e. Preparación, aislamiento y diagnóstico de fallos en docs/PRUEBAS.md.

## Vista como controlador (superadministrador en real y responsable de equipo en simulación)

Añade `verComo=CODIGO` a la URL, por ejemplo `/?equipo=B&year=2027&verComo=B05`.
La identidad **real** sigue siendo la del usuario autenticado y el backend valida el permiso
y el código en la plantilla **del ejercicio y campaña seleccionados**.

- En campañas reales, la interfaz representa a ese controlador (su turno, sus preferencias
  privadas y sus controles), permite probar selecciones y cambios locales, pero **no guarda**
  nada. El servidor rechaza todas las escrituras y los botones de confirmación están desactivados.
- En simulaciones privadas, se puede interactuar y guardar **como el controlador**. Solo
  se autorizan sus preferencias y las elecciones que realmente le correspondan; nunca
  adquiere privilegios de administración. Las escrituras se auditan bajo la identidad real
  del superadministrador.
- Para entrar en una simulación desde la URL se conserva `escenario=ID_DE_CAMPAÑA` al
  elegirla. Después se añade `verComo=CODIGO`; el enlace sigue apuntando al escenario.
- Una barra indica el modo y ofrece «Salir de vista previa». Las sesiones de otras personas
  no se ven afectadas. No se suplantan credenciales externas de Google o ChatGPT.

## Prueba Push para superadmin

La pantalla `/notificaciones` muestra a un superadministrador autenticado el botón
«Enviar Push de prueba a este dispositivo» cuando el navegador está suscrito con **su
propia cuenta**. El endpoint comprueba rol y titularidad de la suscripción antes de enviar;
no toca campañas, elecciones, preferencias ni cola de avisos. La prueba no reproduce
el cambio real de turno ni envía alertas automáticas en simulaciones. Requiere claves
VAPID y un navegador compatible con Web Push.

## Normas definitivas de 2027

La política vigente es `lecs-2027-occupancy-v6`: solo la guía de elección v1.3 y las cifras de la hoja «Info.Cupos RRHH». Ver [reglas](docs/policy-2027-definitive-guide.md).
