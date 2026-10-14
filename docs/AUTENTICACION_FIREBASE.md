# Firebase Authentication compartido y sincronización entre clientes

## Activación

La aplicación acepta simultáneamente la identidad de ChatGPT Sites y, opcionalmente, tokens ID verificados de Firebase Auth. **No usa Firestore para las vacaciones**: D1 continúa almacenando los equipos, adjudicaciones, perfiles y permisos. Firebase solo autentica.

Para reutilizar la autenticación del otro sitio hay que configurar las siguientes variables en el entorno privado del Site (no en el repositorio):

- FIREBASE_PROJECT_ID: ID real del proyecto Firebase; el proyecto utilizado previamente para la aplicación de cambios es cambios-76578, sujeto a confirmación antes de activarlo.
- FIREBASE_API_KEY: clave web pública Firebase del mismo proyecto.
- FIREBASE_AUTH_DOMAIN: dominio de autenticación Firebase (habitualmente projectId.firebaseapp.com).
- FIREBASE_APP_ID: identificador de la app web registrada en ese mismo proyecto.

La API de configuración solo publica valores normales de configuración Firebase, no secretos. No hace falta clave JSON de cuenta de servicio. No configurar tokens de admin en el frontend.

En Firebase Console > Authentication > Settings > Authorized domains, autorizar el dominio real del Site (por ejemplo <site>.chatgpt.site), y comprobar que el proveedor Google está habilitado. Hay que verificar en un navegador real que las restricciones de ventanas emergentes y la política CSP de Sites permiten cargar el SDK oficial desde www.gstatic.com y realizar el inicio de sesión. Si el proveedor existente utiliza otro mecanismo, adaptar únicamente el cliente; la validación de tokens en el servidor permanece igual.

El usuario entra con Google mediante Firebase Auth del proyecto ya existente, que devuelve el mismo UID que en el otro sitio, aunque la sesión del navegador se mantiene de manera independiente por dominio. Las peticiones desde la web envían Authorization: Bearer ID_TOKEN. El Worker valida firma RS256 con claves públicas de Google, issuer, audience, uid, expiración, hora de autenticación y email_verified. Un token inválido no cae silenciosamente al inicio de sesión de Sites.

La autorización usa siempre provider:subject. Por ejemplo firebase:<UID> y chatgpt:<ID> son cuentas diferentes. El administrador puede conceder acceso a un equipo a un UID Firebase o vincular un UID Firebase a una persona concreta. Nunca relacionar automáticamente las identidades por nombre o correo. Solo un email verificado puede activar el acceso de superadministrador configurado expresamente en SUPERADMIN_EMAILS.

No se almacenan contraseñas de Firebase ni se crean cuentas Firebase desde esta app. Las reglas de D1 y la privacidad de preferencias permanecen intactas. Para revertir el login federado, retirar FIREBASE_PROJECT_ID y FIREBASE_API_KEY: Sites sigue activo.

## Sincronización de clientes abiertos

Cada cliente consulta la revisión global de D1 mediante GET /api/revision cada 5 segundos cuando la pestaña está visible; el valor solo cambia tras operaciones confirmadas y persistidas. Cuando aumenta, el cliente recarga índice, campaña actual y permisos. También comprueba al regresar a una pestaña o recuperar el foco. En pestañas de fondo el navegador puede suspender los intervalos; la actualización ocurre al volver a ellas.

No se usa Firebase Realtime Database ni Firestore como canal de cambios: D1 no proporciona notificaciones directas en esta arquitectura. La sincronización es **casi en tiempo real** (latencia usual hasta 5 segundos, no instantánea) y la validación de versiones de campaña sigue protegiendo frente a escrituras simultáneas. Los cambios de otras sesiones no deben sobrescribir preferencias locales aún sin guardar.

Si se necesita push verdaderamente instantáneo en el futuro, estudiar Durable Objects y WebSockets/SSE o un canal de notificaciones, conservando D1 como única fuente de datos.

## Pruebas pendientes antes de activar en producción

1. Configurar las cuatro variables en una versión de pruebas del Site y autorizar su dominio.
2. Iniciar sesión con un usuario del proyecto existente y comprobar que el UID coincide en ambos sitios.
3. Dar permisos limitados a ese UID y comprobar que no puede escribir en otros equipos.
4. Probar sesión expirada, correo no verificado, logout, acceso anónimo y cuentas de Sites existentes.
5. Abrir dos navegadores independientes y verificar actualización automática de calendario y turno. Comprobar también móvil y pestaña que recupera el foco.
6. Descargar copia de seguridad antes del despliegue, y comprobar que la actualización no altera adjudicaciones existentes.

El despliegue en Sites requiere publicar un build desde su entorno; fusionar GitHub por sí solo no actualiza el Site.
