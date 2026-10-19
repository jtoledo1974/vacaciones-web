/* Diagnostic service worker only: no subscriptions or background sends. */
self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("message", (event) => {
  if (event.data?.type === "PUSH_PROBE_PING") {
    event.source?.postMessage({ type: "PUSH_PROBE_PONG", nonce: event.data.nonce });
  }
  if (event.data?.type === "PUSH_PROBE_NOTIFICATION") {
    event.waitUntil(self.registration.showNotification("Vacaciones: prueba de notificación", {
      body: "Si ves este aviso, las notificaciones del Service Worker funcionan.",
      tag: "vacaciones-push-probe",
      data: { url: "/notificaciones/diagnostico" }
    }));
  }
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
