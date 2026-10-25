# Notificaciones de vacaciones

## Funcionamiento previsto (PR #16)

- **Elección:** el servidor confirma la elección en D1. Ninguna operación de elección lee, escribe o espera tablas de notificaciones.
- **Primer intento:** después de confirmarse la elección, el Worker de ChatGPT Sites lanza `dispatchNotifications(..., campaignId)` mediante `waitUntil()`. Los errores se aíslan y nunca revierten la elección.
- **Recuperación:** otro Worker, en la cuenta gratuita de Cloudflare del administrador, llama a `POST /api/notifications/dispatch` cada minuto. El proceso comprueba los turnos activos y reintenta avisos pendientes.
- **Sin acuses de lectura ni recepción:** una respuesta HTTP 2xx del servicio Web Push se considera aceptación. No se garantiza visualización por el usuario.
- **Eventos:** una notificación por campaña real, miembro, ronda y cursor de turno. No se envían notificaciones de simulaciones, campañas pausadas o empates pendientes de resolver.
- **Varios dispositivos:** se almacena un resultado por evento/dispositivo. Si uno falla, se reintenta ese dispositivo, no los que ya obtuvieron respuesta satisfactoria. Se utilizan leases de D1 para minimizar envíos duplicados en ejecuciones concurrentes.
- **Turnos caducados:** los avisos pendientes dejan de ser enviables cuando el turno deja de ser el actual. Los eventos enviados permanecen como historial.

La entrega Web Push es **al menos una vez en condiciones de reintento**, no exactamente una: si la red entrega el mensaje pero se pierde la actualización de D1, podría haber una repetición. El campo `tag` de la notificación ayuda a agrupar esos avisos en el navegador.

## Configuración en ChatGPT Sites

Configurar las siguientes variables privadas del entorno del Site:

- `VAPID_PRIVATE_JWK`: clave privada ECDSA P-256 exportada como JSON JWK.
- `VAPID_PUBLIC_KEY`: clave pública P-256 no comprimida, en base64url.
- `VAPID_SUBJECT`: identidad de contacto válida, por ejemplo `mailto:admin@example.org`.
- `NOTIFICATIONS_DISPATCH_SECRET`: secreto aleatorio largo para autenticar al Worker periódico.

Ejemplo para generar las claves en Node moderno, ejecutado localmente:

```js
const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify(
  await crypto.subtle.exportKey('jwk', pair.privateKey)
));
console.log('VAPID_PUBLIC_KEY=' + Buffer.from(
  await crypto.subtle.exportKey('raw', pair.publicKey)
).toString('base64url'));
```

No introducir estas claves privadas ni el secreto en GitHub, comentarios de PR o variables públicas del frontend.

## Worker externo gratuito

El código está en `workers/notifications-cron/` y no necesita D1, credenciales personales ni datos de los controladores.

1. Verificar que `SITE_ORIGIN` en `workers/notifications-cron/wrangler.toml` es la URL pública correcta del Site.
2. Instalar y autenticar Wrangler en la cuenta personal de Cloudflare (`wrangler login`).
3. Desde la raíz del repositorio, crear el secreto del Worker con:
   `wrangler secret put NOTIFICATIONS_DISPATCH_SECRET --config workers/notifications-cron/wrangler.toml`
4. Desplegar con:
   `wrangler deploy --config workers/notifications-cron/wrangler.toml`
5. Comprobar en Cloudflare que existe el Cron Trigger `* * * * *`.
6. Comprobar que las invocaciones reciben un HTTP 200 del Site. Antes de desplegar el Worker, probar explícitamente que el endpoint del Site es accesible desde fuera de ChatGPT Sites y que conserva la cabecera Authorization. Sin ello, el mecanismo de recuperación no funcionará.

El secreto debe ser **idéntico** en ambos entornos y nunca debe enviarse desde la interfaz del navegador.

## Interfaz

- `/notificaciones`: activar/desactivar Web Push en cada navegador autenticado y revisar historial.
- **Prueba real de Push (solo superadmin):** en `/notificaciones`, tras activar la suscripción de su dispositivo, el botón «Enviar Push de prueba a este dispositivo» envía una notificación cifrada a ese endpoint y comprueba la aceptación del proveedor. La API verifica el rol de superadmin y que la suscripción pertenece a su propia identidad. No crea eventos de turno, no encola reintentos, no modifica elecciones y nunca prueba alertas de simulaciones. Un resultado aceptado por el servicio Push no garantiza la aparición en pantalla.
- `/notificaciones/diagnostico`: comprobar APIs, permiso y visualización local de una notificación.
- En iPhone, Web Push exige condiciones especiales para webs instaladas en la pantalla de inicio.
- Chrome y el sistema operativo determinan el sonido de las notificaciones; la app no puede imponerlo.

## Pruebas obligatorias antes de fusionar y desplegar

1. Compilación TypeScript y migración D1 `0006_turn_notifications.sql` (incluyendo la tabla `push_deliveries`).
2. Comprobar en un entorno con claves VAPID que se puede suscribir un navegador y recibir el primer aviso tras una elección real.
3. Verificar que el usuario recibe la respuesta de la elección aunque el servicio Web Push falle o `waitUntil` no esté disponible.
4. Simular caída del primer envío; verificar que Cron completa el envío sin repetirlo en un dispositivo donde ya conste como entregado.
5. Simular dos despachadores concurrentes, varios dispositivos, borrado de suscripción 404/410 y cambio de usuario.
6. Probar elección conjunta, aplazamiento, empate, elección automática, pausa, simulación, cancelación y cambio de turno mientras se envía.
7. Confirmar que al pulsar el aviso se abre el equipo y el ejercicio correctos.
8. Probar el endpoint externo y los secretos en el alojamiento real.

**Estado:** PR en borrador; no fusionado ni desplegado. La cuenta Cloudflare personal aún debe configurarse. El código de Cron está preparado, pero no existe ninguna tarea externa activa hasta desplegar el Worker.

## «Tu lista ha elegido por ti» (#66)
El dispatcher de Cron también avisa cuando una lista de preferencias adjudica un ciclo (acción `advance` de la auditoría) en una campaña real. Solo avisa a la cuenta vinculada al controlador elegido, y únicamente si la adjudicación sigue vigente: una elección deshecha no se anuncia. Para no repetir el histórico al desplegar, solo se tienen en cuenta las elecciones de las últimas 6 horas. El aviso dice el ciclo y la ronda, y abre el equipo y el año. Usa la misma cola `turn_notifications` con identificador `auto:<auditoría>:<miembro>:<fecha>`, sin migración, y no se marca como obsoleto cuando avanza el turno ni cuando la elección termina. Pruebas en `tests/notifications-automatic.test.ts`.
