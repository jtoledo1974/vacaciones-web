"use client";

import { useState } from "react";

type ProbeResult = { name: string; status: "OK" | "NO" | "ERROR" | "PENDIENTE"; detail: string };

export default function NotificationDiagnostics() {
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [working, setWorking] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  async function runProbe() {
    setWorking(true);
    const next: ProbeResult[] = [];
    const add = (name: string, status: ProbeResult["status"], detail: string) => next.push({ name, status, detail });
    try {
      add("Contexto seguro HTTPS", window.isSecureContext ? "OK" : "NO", location.origin);
      add("Service Worker API", "serviceWorker" in navigator ? "OK" : "NO", "");
      add("Push API", "PushManager" in window ? "OK" : "NO", "");
      add("Notifications API", "Notification" in window ? "OK" : "NO", "");
      add("Permiso del navegador", "Notification" in window ? "OK" : "NO", "Notification" in window ? Notification.permission : "No compatible");
      setPermission("Notification" in window ? Notification.permission : "unsupported");

      if (!window.isSecureContext || !("serviceWorker" in navigator)) {
        add("Registro del Service Worker", "NO", "Requiere HTTPS y Service Worker disponible");
      } else {
        try {
          const sw = await navigator.serviceWorker.register("/push-probe-sw.js", { scope: "/notificaciones/" });
          await sw.update();
          setRegistration(sw);
          const readyWorker = sw.active || sw.waiting || sw.installing;
          add("Registro del Service Worker", "OK", sw.scope);
          if (readyWorker) {
            const pong = await new Promise<boolean>((resolve) => {
              const nonce = crypto.randomUUID();
              const timeout = window.setTimeout(() => { navigator.serviceWorker.removeEventListener("message", receive); resolve(false); }, 4000);
              function receive(e: MessageEvent) {
                if (e.data?.type === "PUSH_PROBE_PONG" && e.data.nonce === nonce) {
                  clearTimeout(timeout);
                  navigator.serviceWorker.removeEventListener("message", receive);
                  resolve(true);
                }
              }
              navigator.serviceWorker.addEventListener("message", receive);
              readyWorker.postMessage({ type: "PUSH_PROBE_PING", nonce });
            });
            add("Mensajería Service Worker", pong ? "OK" : "NO", pong ? "Respuesta recibida" : "Sin respuesta en 4 s (puede requerir recargar)");
          }
          add("PushManager accesible", sw.pushManager ? "OK" : "NO", "No se crea ninguna suscripción");
        } catch (e) { add("Registro del Service Worker", "ERROR", String(e)); }
      }
    } catch (e) { add("Diagnóstico", "ERROR", String(e)); }
    setResults(next);
    setWorking(false);
  }

  async function testNotification() {
    if (!registration || !("Notification" in window)) return;
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") { setResults(r => [...r, { name: "Notificación de prueba", status: "NO", detail: "Permiso: " + granted }]); return; }
      const worker = registration.active || registration.waiting;
      if (!worker) throw new Error("Service Worker todavía no activo. Repite diagnóstico.");
      worker.postMessage({ type: "PUSH_PROBE_NOTIFICATION" });
      setResults(r => [...r, { name: "Notificación de prueba", status: "PENDIENTE", detail: "Solicitud enviada al Service Worker; comprueba la notificación del sistema" }]);
    } catch (e) { setResults(r => [...r, { name: "Notificación de prueba", status: "ERROR", detail: String(e) }]); }
  }

  return <main style={{ maxWidth: 760, margin: "3rem auto", padding: "0 1rem", fontFamily: "system-ui" }}>
    <a href="/">← Volver a vacaciones</a>
    <h1>Diagnóstico de notificaciones web</h1>
    <p>Prueba técnica. No activa notificaciones reales de turnos, no crea suscripciones ni guarda datos. Ejecuta el diagnóstico en el dominio publicado y desde cada dispositivo que quieras utilizar.</p>
    <button disabled={working} onClick={runProbe} style={{ padding: 12, marginRight: 12 }}>{working ? "Comprobando…" : "Comprobar compatibilidad"}</button>
    <button disabled={!registration || working} onClick={testNotification} style={{ padding: 12 }}>Solicitar permiso y mostrar aviso de prueba</button>
    <p>Permiso actual: <strong>{permission}</strong></p>
    <ul>{results.map((r, i) => <li key={i}><strong>{r.status} · {r.name}</strong>{r.detail ? ": " + r.detail : ""}</li>)}</ul>
    <p><strong>Importante:</strong> esta prueba confirma APIs y visualización local, pero no demuestra todavía la entrega de Web Push con el navegador cerrado. Para eso hará falta configurar VAPID y probar una suscripción y un envío reales.</p>
  </main>;
}
