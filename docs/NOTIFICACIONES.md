# Notificaciones de elección de vacaciones

## Estado

Fase 1: diagnóstico **sin activar producción** en `/notificaciones/diagnostico`.
No hay suscripciones, claves VAPID, envío de eventos ni recordatorios reales.
El alojamiento ChatGPT Sites no documenta una garantía específica para Service Workers
ni Web Push. Comprobar en el dominio desplegado antes de continuar.

## Plan por fases

1. Verificar HTTPS, registro SW, mensajes y visualización local en Windows/Android/iOS.
   En iOS, probar también la web añadida a pantalla de inicio.
2. Crear suscripción Push por **dispositivo** y **principal autenticado**; guardar
   endpoint y claves cifradas/seguras en D1. Nunca aceptar userId enviado por cliente.
   Añadir baja, limpieza 404/410, preferencias y rotación de claves VAPID.
3. Crear evento de aviso **tras confirmación transaccional de una elección real**:
   campaña/equipo/año/ronda/turno + destinatario, con deduplicación persistente.
   Las simulaciones no emiten avisos. Un proceso de entrega reintenta errores
   transitorios, nunca notifica al usuario incorrecto y deja auditoría.
4. Ofrecer avisos de proximidad (dos personas por delante), turno, confirmación,
   incidencias y recordatorios configurables. Contemplar empates rotatorios,
   dobles, conjuntos, turnos aplazados y cambios administrativos.
5. Centro de notificaciones dentro de la aplicación, que no dependa de Push.
   Considerar email como respaldo, con consentimiento y límites de frecuencia.

## Aceptación de la fase 1

- La página funciona sin alterar las elecciones reales.
- El Service Worker queda limitado a `/notificaciones/` y no intercepta fetch.
- La solicitud de permiso se hace **solo** al pulsar el botón.
- Los errores muestran causas legibles; sin notificaciones no se rompe la app.
- No declarar «Web Push con navegador cerrado» validado sin una prueba VAPID real.
