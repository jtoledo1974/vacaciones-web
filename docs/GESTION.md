# Gestionar vacaciones

Selecciona siempre el equipo y el ejercicio antes de guardar. Los cambios afectan únicamente a esa campaña.

## Solicitudes y adjudicaciones

En **Solicitudes**, elige persona, ciclo y posición de preferencia. Guardar la misma posición sustituye su fecha. Puedes eliminar un registro con la papelera.

En **Adjudicaciones**, registra los ciclos asignados. El servidor comprueba duplicados, cupos y fechas. Eliminar una solicitud no elimina su adjudicación, ni al contrario.

## Deshacer y rehacer

Los botones **Deshacer último cambio** y **Rehacer último cambio** están disponibles en las vistas de gestión. Conservan un único paso para solicitudes, adjudicaciones y reinicios, incluso al recargar la página.

Una operación posterior invalida el paso anterior para evitar sobrescribir cambios posteriores. No permiten retroceder por todo el historial ni deshacer cambios de plantilla, configuración o publicaciones. Los cambios anteriores a la incorporación de esta función no tienen deshacer retroactivo.

## Empezar de cero un equipo

En **Administración → Corregir o empezar de cero**, pulsa **Empezar de cero las vacaciones**. Se indica cuántas solicitudes y adjudicaciones se borrarán y se pide escribir el código del equipo y el año, por ejemplo C-2026.

El reinicio vacía las dos listas del borrador. Conserva la plantilla, la configuración, los demás equipos y los resultados publicados. Puedes deshacerlo inmediatamente. Si la campaña está cerrada, un superadministrador debe reabrirla primero. Para cambiar el resultado visible al público hay que calcular y publicar una nueva revisión.

## Calcular y publicar

**Calcular revisión** guarda una revisión con las entradas actuales. Resuelve las incidencias y pulsa **Publicar** para mostrarla en consulta y cerrar la campaña. Si modificas los datos, tendrás que calcular otra revisión antes de publicarla.

Reabrir permite trabajar sobre el borrador sin alterar el resultado publicado.

## Plantillas y ejercicios

En Administración puedes editar toda la plantilla en una tabla y guardar juntos los cambios. También puedes pegar columnas desde Excel o importar una plantilla preparada mediante archivo o JSON pegado. Una antigüedad vacía significa desconocida.

Crear un nuevo ejercicio prepara los ocho equipos, copia la plantilla activa y permite copiar los parámetros. No copia solicitudes ni adjudicaciones.

## Copias de seguridad

Descarga una copia completa antes de operaciones importantes y guárdala fuera del Site. La copia JSON incluye todos los equipos, permisos e historial; no contiene secretos del entorno.

Restaurar sustituye los datos de toda la aplicación, no solo del equipo seleccionado. Está reservado al superadministrador y verifica la integridad SHA-256. Una copia anterior a una importación no contiene los nuevos datos.
