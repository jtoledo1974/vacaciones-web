# Superadministrador local de pruebas (sin Google ni passkeys)

Esta opción es **independiente** de ChatGPT Sites y Firebase. Sirve para recuperar el acceso durante pruebas o despliegues. Está **desactivada por defecto**: no existe ningún usuario ni contraseña predefinidos en el repositorio.

## Configurar en el entorno privado del despliegue

Configurar conjuntamente las siguientes tres variables de entorno como **secretos** (nunca en el repositorio ni en variables públicas del frontend):

- `LOCAL_ADMIN_USERNAME`: nombre de usuario alfanumérico de 3 a 100 caracteres (puede contener `.`, `_`, `@` o `-`).
- `LOCAL_ADMIN_PASSWORD`: contraseña o frase de paso estática, **24 caracteres como mínimo** y máximo 512. Generar una contraseña aleatoria y única.
- `LOCAL_ADMIN_SESSION_SECRET`: clave aleatoria independiente de al menos 32 caracteres para firmar las sesiones. Generar con un CSPRNG (por ejemplo `openssl rand -base64 48`). No reutilizar la contraseña.

Al configurar las tres variables, aparece «Acceso administrador con contraseña» en la barra lateral. Iniciar sesión con el usuario y la contraseña. La identidad reconocida es `local_admin:<LOCAL_ADMIN_USERNAME>` y recibe el rol de `superadmin`, con los mismos permisos que cualquier otro superadministrador. No es necesario insertar ninguna fila en D1 ni activar Firebase.

Después de entrar, se establece una cookie de sesión firmada con HMAC-SHA256, `HttpOnly`, `Secure`, `SameSite=Strict` y duración máxima de 8 horas. No contiene ni la contraseña ni la clave de firma. El servidor valida firma, caducidad y revocación en cada petición. No se almacena la contraseña en la base de datos ni en el navegador. La identidad local tiene prioridad sobre la identidad de Sites; un token Bearer de Firebase válido tiene prioridad sobre la sesión local. La interfaz desconecta Firebase antes de iniciar sesión local.

La ruta `POST /api/local-admin/login` exige origen coincidente, JSON y credenciales correctas. Reserva atómicamente los intentos por IP (identificador irreversible derivado con la clave de despliegue), y tras **cinco intentos en quince minutos (también cuentan los correctos)** devuelve 429. Los intentos se guardan en su propia tabla D1, `local_admin_attempts`, sin credenciales ni IP en claro, y se purgan al salir de la ventana de quince minutos. En producción es recomendable añadir **rate limiting en el borde de Cloudflare** para esta ruta, ya que un límite por IP en base de datos no sustituye un WAF.

La ruta `POST /api/local-admin/logout` revoca la sesión en el servidor y borra la cookie; una copia de esa cookie deja de funcionar. Cada login crea una sesión independiente. Cambiar la contraseña también invalida las sesiones previas. Las restauraciones de copias nunca reactivan sesiones.

## Dónde se guardan las sesiones

Las sesiones viven en la tabla `local_admin_sessions` (identificador de sesión, actor, creación, caducidad y revocación). La tabla `audit` solo recibe dos eventos sin datos sensibles, `local_admin_login` y `local_admin_logout`, y nunca se reescribe.

Ni `local_admin_sessions` ni `local_admin_attempts` forman parte de las copias de seguridad. **Restaurar una copia cierra todas las sesiones locales**: hay que volver a iniciar sesión. Las copias antiguas, que guardaban sesiones e intentos en `audit` (`local_admin_session`, `local_admin_session_revoked`, `local_admin_login_attempt`), se siguen restaurando: esas filas se descartan. La migración `0011` traslada las sesiones abiertas a la tabla nueva y borra esas filas de `audit`. Para revocar **todas** las sesiones locales, rotar `LOCAL_ADMIN_SESSION_SECRET`. Para desactivar por completo el acceso local, retirar cualquiera de las tres variables (preferiblemente todas) y desplegar de nuevo. Ninguna de estas operaciones modifica los datos históricos de vacaciones.

## Instrucción para ChatGPT Work al desplegar

> Despliega la última versión del repositorio, configura en los secretos privados del Site un `LOCAL_ADMIN_USERNAME` de pruebas y genera una contraseña estática aleatoria de al menos 24 caracteres para `LOCAL_ADMIN_PASSWORD`. Genera por separado `LOCAL_ADMIN_SESSION_SECRET` con un generador criptográficamente seguro. No incluyas los valores en GitHub, commits, logs, capturas ni variables públicas. Entrégame la contraseña por un canal privado apropiado. Comprueba que aparece el formulario local, que el inicio de sesión otorga superadmin, que una contraseña incorrecta se rechaza y que el logout funciona. No desactives la autenticación existente de ChatGPT Sites ni Firebase. Al terminar las pruebas, retira los secretos si ya no necesito este acceso.

## Riesgos y limitaciones

Es una cuenta de emergencia **altamente privilegiada**; una contraseña fija no ofrece resistencia a phishing ni las propiedades de una passkey. Usarla solo durante las pruebas, con HTTPS y una contraseña larga y única. Limitar los administradores y eliminar este acceso cuando se restablezca el login habitual.

Los secretos deben quedar en el almacén privado de la plataforma. Si ChatGPT Sites no ofrece una forma de configurar secretos persistentes, **no** sustituirlos por valores hardcoded ni un formulario público de provisión de admin. Se necesita un entorno que admita secretos del servidor.


## CLI con autenticación en el navegador

El modo habitual no necesita credenciales del administrador local:

```bash
export VACACIONES_URL=https://vacaciones.lazaro.es
node scripts/admin-cli.mjs login        # solo la primera vez o cuando caduque
node scripts/admin-cli.mjs campaign <id> --out campana.json
node scripts/admin-cli.mjs post campaign/<id> cuerpo.json
node scripts/admin-cli.mjs logout       # revoca el acceso antes de que caduque
```

La terminal se empareja **una vez**. Muestra un código de 16 caracteres y abre `/cli` (sin código ni datos en la URL). Si aún no tienes sesión, inicia sesión con ChatGPT. Escribe en la página el código de **tu** terminal y pulsa **Autorizar esta terminal**. Puede emparejar y aprobar un superadministrador, un responsable de equipo con al menos una concesión vigente o un administrador de VA; únicamente la misma cuenta que introdujo el código puede aprobarlo. No uses códigos recibidos de otra persona. `--no-open` evita abrir el navegador; abre `/cli` manualmente en el perfil donde ya tienes sesión. Cualquier orden empareja sola si no hay acceso guardado; `login` lo hace explícitamente.

El acceso aprobado vale **30 días** para llamar a la API, siempre sujeto a los permisos actuales de cada ruta (equipos asignados, VA y operaciones globales). El CLI lo guarda en `~/.vacaciones-cli/<host>.json` (o en `VACACIONES_CLI_TOKEN_FILE`), legible solo por tu usuario, y lo reutiliza. En Windows, donde los permisos `0600` no restringen la lectura, el CLI aplica antes a la carpeta una ACL sin herencia con solo tu usuario (`icacls`); si no puede, no guarda el acceso y lo revoca. Lo reutiliza en cada orden sin volver a pedir el navegador. Trátalo como una contraseña: quien copie ese fichero actúa como tú hasta que caduque o lo revoques. Antes de cada orden el CLI comprueba `/api/session`: si el servidor ya no reconoce el acceso (caducado o revocado), vuelve a emparejar; si la cuenta ha perdido todos sus permisos administrativos, no ejecuta nada.

El código y el token son independientes: el código solo empareja la terminal (5 minutos) y D1 guarda solo la SHA-256 de ambos. Los permisos se resuelven de nuevo en cada petición, así que retirar las concesiones y roles administrativos impide al CLI seguir operando como administrador. Cada aprobación y cada intento rechazado quedan en la auditoría (`cli_authorized`, `cli_authorization_rejected`), y cada operación queda auditada con tu identidad como en la web. Hay límites persistentes: 5 emparejamientos cada 15 minutos por administrador, y uniones y revocaciones por IP.

Las escrituras siguen intentando descargar una **copia global** antes de aplicar cambios, y esa descarga solo está disponible para superadministradores. Los responsables de equipo y administradores de VA pueden ejecutar escrituras autorizadas con `--no-backup` **explícito**, tras revisar la previsualización cuando exista; sin esta opción, el CLI rechaza la operación antes de escribir. `--no-backup` no concede ningún permiso adicional y no se evita la validación de cada ruta.

`logout` revoca el acceso en el servidor y, solo cuando el servidor lo confirma, borra el fichero; si la revocación falla, termina con error y conserva el fichero para reintentarla. `login` sobre un acceso guardado lo revoca primero con la misma regla, así que nunca quedan dos accesos vivos de la misma terminal. Si la terminal se cancela con Ctrl+C/SIGTERM antes de la aprobación, revoca el emparejamiento pendiente: la revocación deja una marca que impide una aprobación tardía. Una cancelación detiene la espera, la copia previa y cualquier paso pendiente; un POST ya enviado no se aborta (ni por Ctrl+C ni por tiempo de espera) ni se reintenta, porque puede haberse aplicado. Si se pierde la conexión tras enviarlo, el CLI termina con código 3 e indica que el resultado es desconocido: comprueba el estado antes de repetir la orden. Las esperas reintentan errores de red, 429 y 5xx dentro de los 5 minutos. La revocación se reintenta tres veces. Cerrar sesión en la web no revoca el acceso concedido al CLI. No se cambian secretos ni se cierran sesiones del navegador o de otros administradores. Las filas caducadas se borran en cada operación CLI y en el despachador periódico de notificaciones (`dispatchNotifications`); sin ese despachador solo se limpian con tráfico CLI, aunque caducadas ya no autorizan nada. Una restauración invalida también las sesiones CLI; ninguna de las dos tablas se incluye en las copias.

Antes de habilitar este flujo, aplica `drizzle/0013_cli_sessions.sql` (crea `cli_sessions` y `cli_attempts`) y despliega el código del servidor y la página `/cli`. No requiere nuevas variables secretas. Un Site privado debe permitir además el acceso de clientes no interactivos en la capa de Sites: esta autorización no sustituye los controles de entrada del alojamiento.

## CLI con administrador local

`scripts/admin-cli.mjs` inicia sesión con estas credenciales, ejecuta una orden y cierra la sesión al terminar (la cookie queda revocada). Sirve para cualquier operación de la API de administración, porque la interfaz usa esa misma API.

```bash
export VACACIONES_URL=https://<origen> VACACIONES_ADMIN_USER=<usuario> VACACIONES_ADMIN_PASSWORD=<contraseña>
node scripts/admin-cli.mjs session
node scripts/admin-cli.mjs campaign <id> --out campana.json
node scripts/admin-cli.mjs post campaign/<id> cuerpo.json --dry-run
node scripts/admin-cli.mjs post campaign/<id> cuerpo.json
```

Antes de cada `post` guarda una copia completa en `admin-backups/` (excluida de Git) y no escribe si no la obtiene. Cada ejecución consume uno de los cinco inicios de sesión permitidos cada quince minutos.

Si no defines `VACACIONES_ADMIN_USER` ni `VACACIONES_ADMIN_PASSWORD`, el CLI usa el acceso guardado del navegador. `--browser` fuerza este modo aunque estén definidas. La protección de copia previa, el control de versión de la API y `--dry-run` se mantienen en ambos modos.
