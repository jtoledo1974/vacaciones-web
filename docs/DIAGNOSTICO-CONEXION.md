# Diagnóstico de conexión a D1

`GET /api/diagnostics/database` requiere una sesión de superadministrador. Es una comprobación manual: no añade sondeos automáticos, escrituras ni reintentos. Devuelve 200 si ambas pruebas funcionan y 503 si alguna falla. Las respuestas no se almacenan en caché.

- `connection`: `SELECT 1 AS ok`, sin tablas de la aplicación ni lógica de vacaciones.
- `app_state`: lectura de la revisión de la fila principal. No devuelve el valor, solo el resultado de la comprobación.

Cada prueba incluye duración, resultado y una categoría fija de error si falla. La respuesta contiene hora UTC e identificador de petición.

## Durante una incidencia

1. Con una sesión de superadministrador, abrir `/api/diagnostics/database` en la web. Guardar la respuesta y su hora.
2. Consultar por separado la base de datos con las herramientas de Sites: primero su esquema y después una fila de `app_state`. Este acceso no ejecuta el código de la web.
3. Contrastar con `/api/revision`, `/api/index` y los registros de producción en la misma franja horaria.

Si fallan el acceso directo de Sites y el diagnóstico, hay indicios de un problema de infraestructura. Si Sites funciona pero `connection` falla, investigar el enlace del Worker con D1 o su configuración. Si `connection` funciona y `app_state` falla, investigar esquema, fila y consulta. Si ambas funcionan pero la aplicación falla, investigar autenticación, consultas y lógica de negocio. Son indicios, no una prueba definitiva cuando las peticiones ocurren en distintos momentos o rutas del proveedor.

La autorización usa los mecanismos existentes. El superadministrador con correo verificado configurado en `SUPERADMIN_EMAILS` no necesita leer roles en D1. Las sesiones locales o CLI pueden necesitar D1 para validarse: si la autenticación falla antes del diagnóstico, usar el acceso directo de Sites; no se omite la autorización.

## Registros y privacidad

Las lecturas y lotes fallidos del repositorio desde la API registran `server_failure`, hora, identificador de petición, familia de ruta, fase, duración y categoría. El manejador también registra errores inesperados y devuelve `requestId` en respuestas de error del servidor para correlacionarlos.

Las categorías distinguen cuotas diarias, almacenamiento, esquema, restricciones, consulta, tiempo agotado, reinicio de D1, saturación, error D1 y conexión. Los errores no reconocidos se etiquetan `unclassified`. No se registran SQL, parámetros, mensajes originales, cookies, credenciales, identidades, identificadores de campaña ni datos de vacaciones. No se modifica el error original ni se reintentan escrituras.

Una misma excepción propagada por varias capas de una petición se registra una sola vez, conservando el identificador, fase y duración del primer registro. El seguimiento vive en el contexto de esa petición, sin modificar la excepción ni suprimir errores de otras peticiones. Las causas específicas de conexión tienen prioridad sobre el indicador genérico `D1_ERROR`.

Estos registros permiten acotar futuros fallos; no reconstruyen la excepción de una incidencia anterior ni demuestran por sí solos que el proveedor sea responsable.
