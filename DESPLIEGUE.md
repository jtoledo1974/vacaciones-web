# Site público con administración protegida

URL pública: https://vacaciones.lazaro.es. La dirección `*.chatgpt.site` del despliegue y los identificadores de proyecto y despliegue de Sites no se documentan aquí; el flujo de publicación usa `.openai/hosting.json`. En `VACACIONES_URL` debe usarse el dominio vigente: el CLI no sigue redirecciones y falla con 307.
Repositorio: https://github.com/jtoledo1974/vacaciones-web

Se verificó en Chrome la sesión de superadministrador del propietario y la inicialización de ocho equipos en D1 alojado. No se sustituye ese mecanismo por un acceso inseguro.

Los superadministradores se configuran en el entorno privado de Sites (`SUPERADMIN_EMAILS`). La lista de visitantes de la plataforma es independiente del rol de la aplicación. El Site es público por decisión del propietario; no hay otras concesiones de escritura.

Los archivos de importación (Excel de equipos, plantillas de RRHH, escalafones) contienen datos personales y quedan fuera de los repositorios y paquetes de despliegue. Tras cada importación conviene descargar una copia nueva.


## Acceso local de emergencia (opcional)

Se ha añadido un acceso de **superadministrador de pruebas** mediante usuario y contraseña estática configurados únicamente como secretos del despliegue. No altera ChatGPT Sites ni Firebase. Por defecto está desactivado.

Consultar [docs/ADMIN_LOCAL.md](docs/ADMIN_LOCAL.md) para `LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD` y `LOCAL_ADMIN_SESSION_SECRET`, medidas de seguridad y procedimiento para ChatGPT Work. La identidad local se puede desactivar retirando los secretos; nunca escribir contraseñas en GitHub.
