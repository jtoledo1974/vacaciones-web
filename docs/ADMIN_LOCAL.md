# Superadministrador local de pruebas (sin Google ni passkeys)

Esta opción es **independiente** de ChatGPT Sites y Firebase. Sirve para recuperar el acceso durante pruebas o despliegues. Está **desactivada por defecto**: no existe ningún usuario ni contraseña predefinidos en el repositorio.

## Configurar en el entorno privado del despliegue

Configurar conjuntamente las siguientes tres variables de entorno como **secretos** (nunca en el repositorio ni en variables públicas del frontend):

- `LOCAL_ADMIN_USERNAME`: nombre de usuario alfanumérico de 3 a 100 caracteres (puede contener `.`, `_`, `@` o `-`).
- `LOCAL_ADMIN_PASSWORD`: contraseña o frase de paso estática, **24 caracteres como mínimo** y máximo 512. Generar una contraseña aleatoria y única.
- `LOCAL_ADMIN_SESSION_SECRET`: clave aleatoria independiente de al menos 32 caracteres para firmar las sesiones. Generar con un CSPRNG (por ejemplo `openssl rand -base64 48`). No reutilizar la contraseña.

Al configurar las tres variables, aparece «Acceso administrador con contraseña» en la barra lateral. Iniciar sesión con el usuario y la contraseña. La identidad reconocida es `local_admin:<LOCAL_ADMIN_USERNAME>` y recibe el rol de `superadmin`, con los mismos permisos que cualquier otro superadministrador. No es necesario insertar ninguna fila en D1 ni activar Firebase.

Después de entrar, se establece una cookie de sesión firmada con HMAC-SHA256, `HttpOnly`, `Secure`, `SameSite=Strict` y duración máxima de 8 horas. No contiene ni la contraseña ni la clave de firma. El servidor valida firma, caducidad y revocación en cada petición. No se almacena la contraseña en la base de datos ni en el navegador. La identidad local tiene prioridad sobre la identidad de Sites; un token Bearer de Firebase válido tiene prioridad sobre la sesión local. La interfaz desconecta Firebase antes de iniciar sesión local.

La ruta `POST /api/local-admin/login` exige origen coincidente, JSON y credenciales correctas. Reserva atómicamente los intentos por IP (identificador irreversible derivado con la clave de despliegue), y tras **cinco intentos en quince minutos (también cuentan los correctos)** devuelve 429. Los intentos se registran en la tabla de auditoría D1 sin credenciales ni IP en claro. En producción es recomendable añadir **rate limiting en el borde de Cloudflare** para esta ruta, ya que un límite por IP en base de datos no sustituye un WAF.

La ruta `POST /api/local-admin/logout` revoca la sesión en el servidor y borra la cookie; una copia de esa cookie deja de funcionar. Cada login crea una sesión independiente. Cambiar la contraseña también invalida las sesiones previas. Las restauraciones de copias nunca reactivan sesiones. Para revocar **todas** las sesiones locales, rotar `LOCAL_ADMIN_SESSION_SECRET`. Para desactivar por completo el acceso local, retirar cualquiera de las tres variables (preferiblemente todas) y desplegar de nuevo. Ninguna de estas operaciones modifica los datos históricos de vacaciones.

## Instrucción para ChatGPT Work al desplegar

> Despliega la última versión del repositorio, configura en los secretos privados del Site un `LOCAL_ADMIN_USERNAME` de pruebas y genera una contraseña estática aleatoria de al menos 24 caracteres para `LOCAL_ADMIN_PASSWORD`. Genera por separado `LOCAL_ADMIN_SESSION_SECRET` con un generador criptográficamente seguro. No incluyas los valores en GitHub, commits, logs, capturas ni variables públicas. Entrégame la contraseña por un canal privado apropiado. Comprueba que aparece el formulario local, que el inicio de sesión otorga superadmin, que una contraseña incorrecta se rechaza y que el logout funciona. No desactives la autenticación existente de ChatGPT Sites ni Firebase. Al terminar las pruebas, retira los secretos si ya no necesito este acceso.

## Riesgos y limitaciones

Es una cuenta de emergencia **altamente privilegiada**; una contraseña fija no ofrece resistencia a phishing ni las propiedades de una passkey. Usarla solo durante las pruebas, con HTTPS y una contraseña larga y única. Limitar los administradores y eliminar este acceso cuando se restablezca el login habitual.

Los secretos deben quedar en el almacén privado de la plataforma. Si ChatGPT Sites no ofrece una forma de configurar secretos persistentes, **no** sustituirlos por valores hardcoded ni un formulario público de provisión de admin. Se necesita un entorno que admita secretos del servidor.

