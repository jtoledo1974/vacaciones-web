# Vacaciones · MVP web

Proyecto independiente: no modifica el Excel, la hoja nativa ni sus Apps Script. React/Vinext con Worker, D1 y autenticación de Sites. Las tablas y parámetros permanecen al desplegar versiones nuevas.

## Uso

1. Abrir el Site público. Para administrar, iniciar sesión con una de las dos cuentas autorizadas.
2. Pulsar **Preparar campaña de prueba**: ocho equipos A–H, 16 códigos ficticios por equipo y ejercicio 2026. La importación de datos reales requiere una petición expresa; la carga del Excel original ha sido autorizada en esta sesión.
3. Seleccionar equipo y ejercicio. Registrar solicitudes y adjudicar ciclos en borrador.
4. **Calcular revisión** guarda un resultado independiente. **Publicar** hace visible esa revisión y cierra la campaña. Reabrir permite trabajar sobre un nuevo borrador sin cambiar el resultado visible.
5. Administración → campañas: crear el siguiente ejercicio, con parámetros originales o copiados. Los resultados nunca se copian.
6. Descargar una copia completa antes de operaciones importantes. Restaurar requiere confirmación, verifica SHA-256 y sustituye los datos de forma atómica.

## Estructura

- `domain/`: fechas UTC, rotación, baremos, orden y cupos. Sin acceso a hojas, UI o D1.
- `server/service.ts`: casos de uso, autorización, publicación, auditoría y backup.
- `server/repository.ts`: contrato pequeño y adaptador D1 con SQL parametrizado.
- `app/`: interfaz responsive en español y rutas HTTP.
- `db/schema.ts`, `drizzle/`: esquema y migraciones versionadas. No ejecutar DDL en peticiones.
- `tests/`: referencia numérica sin nombres y pruebas automatizadas.

## Identidad y permisos

`Identity` identifica proveedor y sujeto; `principal` resuelve los permisos; `Service` autoriza cada operación. ChatGPT proporciona identidad verificada a través de su proxy. No publicar el Worker con estos encabezados como autenticación directamente en un alojamiento que permita al visitante falsificarlos.

`SUPERADMIN_EMAILS` se configura en el entorno de Sites, nunca en el frontend. Las dos cuentas solicitadas están autorizadas mediante ese entorno. Los sujetos estables de otras cuentas pueden asignarse a equipos desde Administración. Las delegaciones admiten fecha de caducidad. El superadministrador no se concede desde el navegador ni por pertenecer simplemente al Site.

El Site tiene además una lista de visitantes de la plataforma. Esta lista y los permisos de la aplicación son independientes. El acceso público, si se autoriza después, no concede escritura ni acceso a borradores: la API entrega solo la copia publicada y códigos abreviados, sin antigüedad, identidad del responsable ni configuración.

## Datos, concurrencia y copias

Entidades: equipos, personas, usuarios, asignaciones de permisos, campañas, parámetros anuales, miembros anuales, solicitudes, adjudicaciones, revisiones y auditoría. Los miembros anuales conservan su identidad, código, nombre y antigüedad propios. La composición se copia desde una campaña anual explícita o la última anterior; people conserva identidades, no una plantilla global activa que gobierne los años futuros. Altas, bajas, importaciones y traslados cambian únicamente el ejercicio elegido. La configuración compleja se guarda como documento JSON versionado por campaña; no contiene solicitudes ni adjudicaciones. Es una decisión reversible con un adaptador o migración futura.

Cada operación comprueba versión de campaña y ejecuta un lote transaccional D1 con compare-and-swap y una aserción SQL. El fallo revierte toda la operación, incluida la auditoría. Las revisiones guardan parámetros, entradas y resultados; una edición invalida su publicación. SHA-256 detecta daños accidentales en el backup, no autentica su origen. La restauración solo está disponible al superadministrador.

Backup JSON incluye todas las tablas de negocio, permisos e historial de cambios; CSV permite exportar adjudicaciones del equipo. No hay una copia automática fuera de Sites: conservar periódicamente el JSON en una ubicación independiente. La copia no contiene secretos de entorno ni credenciales. Restaurar no sustituye las migraciones del esquema.

## Desarrollo local

Node >=22.13 y pnpm 11.25.0. Instalar con el helper Sites `install-dependencies.mjs`, indicando `SITES_PNPM_BIN` si el runtime no tiene pnpm en PATH. El proyecto utiliza pnpm porque este host no incluye npm. Se conservan las bibliotecas del starter oficial y la integración de build `sites()`.

Pruebas: `node --experimental-transform-types --test tests/*.test.ts` con Node 24. Tipos: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`.

Generar migración: `node node_modules/drizzle-kit/bin.cjs generate`. Compilar con `build-site.mjs`. Aplicar la SQL local con Wrangler según el starter, usando `--local`, `dist/server/wrangler.json` y `.wrangler/state`. La base local y la alojada son distintas.

Vista local: `node scripts/run-framework.mjs dev`. `.dev.vars` puede autorizar `seedy@sites.test` SOLO en desarrollo; ese fichero está ignorado. La sesión simulada de loopback del starter no se incluye en producción.

Despliegue: registrar una sola identidad de Site, conservar `.openai/hosting.json`, sincronizar fuente con `site-workflow.mjs` y publicar el archivo construido desde el mismo commit. Sites aplica las migraciones y provisiona DB. Nunca subir fuentes Excel ni `.sites-runtime`, `.dev.vars`, `.wrangler`, copias de usuario o secretos.

## Firebase, Cloudflare y límites

Consultar [VALIDACION.md](VALIDACION.md) para alcance comprobado, discrepancias y pendientes. Firebase no está habilitado ni se afirma que su login haya sido probado en este Site. Añadir un adaptador que verifique tokens en el servidor (firma, issuer, audience, expiración y sujeto), y vincular proveedor/sujeto a los permisos existentes. Para promover superadministradores con Firebase debe exigirse además `email_verified`, sin confiar en un correo suministrado por el cliente. Configurar dominio autorizado y probar popup/redirect antes de activar. Referencias: https://firebase.google.com/docs/auth/admin/verify-id-tokens y https://firebase.google.com/docs/auth/web/google-signin.

Migración a Cloudflare: desplegar el build Worker con Wrangler, crear DB, aplicar las SQL versionadas, importar el backup, configurar las variables de entorno y sustituir el adaptador de autenticación de Sites por Firebase verificado u otro proveedor. El motor y el repositorio D1 se conservan. PostgreSQL requeriría otro repositorio y traducción acotada de SQL/transacciones; no se ha implementado. La vinculación de identidades entre proveedores requiere confirmar cuentas: no mapear automáticamente sujetos de ChatGPT a Firebase.

No se ha contratado ningún servicio de pago. No existe prueba de gratuidad permanente: las cuotas y condiciones dependen de Sites y, tras migrar, del plan del proveedor. D1 tiene límites de tamaño, consultas y lote; el MVP limita las importaciones y debe ampliar la estrategia de restauración si el historial crece. Referencia: https://developers.cloudflare.com/d1/platform/limits/.


La administración de plantillas permite nombres, nicks Unicode y fechas de antigüedad opcionales en una tabla conjunta; pegado por columnas y archivo de importación preparado desde el Excel. Los nombres son exclusivos de administración. No se generan fechas de antigüedad para celdas vacías. El código se conserva también en el repositorio privado https://github.com/jtoledo1974/vacaciones-web; las importaciones y copias de datos quedan excluidas.



En todas las vistas de administración hay Deshacer y Rehacer para el último cambio en solicitudes/adjudicaciones. Se conserva entre recargas y funciona también con el reinicio. Otra operación invalida el paso anterior para evitar sobrescribir trabajo posterior. En Administración, Empezar de cero las vacaciones exige escribir equipo-año; borra solo solicitudes y adjudicaciones del borrador y conserva plantilla, parámetros y publicaciones. Los cambios anteriores a esta versión no tienen undo retroactivo.

## Ayuda en la web
El apartado Ayuda permite leer y descargar las guías. La guía de consulta es pública; la guía de gestión y README, VALIDACION y DESPLIEGUE se entregan solo a administradores mediante una ruta que comprueba el rol en el servidor. Los originales Markdown se incorporan al build del servidor, por lo que sus cambios se reflejan al desplegar.


## Paradigma de elección
El propietario ha confirmado una elección secuencial con orden predeterminado por remanentes del año anterior. Ver [ELECCION.md](ELECCION.md). El baremo calculado sobre las selecciones actuales no es el orden de elección; el flujo de rondas, remanentes y avance espera las normas del ejercicio.
