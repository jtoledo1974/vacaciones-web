# Elección de vacaciones por turnos — Criterios Vacaciones 1.1 (2025)

Fuente: [resumen documental](CRITERIOS_VACACIONES_1.1_2025.md) de «250610 Criterios Vacaciones 1.1.pdf» (10/06/2025). Prevalece el PDF original, que debe subirse al repositorio desde un entorno capaz de adjuntar binarios.

## Selección y puntuación

- La elección secuencial escribe **requests (solicitudes originales)** y **awards (vacaciones vigentes)** en la misma transacción, incluido el sexto ciclo.
- Si se modifica después una adjudicación, la solicitud original permanece: criterios, página 2. Las permutas pueden regirse por otro cómputo si así lo acuerda el equipo, decisión que ha de registrarse explícitamente.
- El orden es de menor a mayor puntuación del ejercicio anterior; el administrador confirma el orden y su origen. No se altera por los puntos de la elección abierta.

## Empates, aplazamientos y grupos

- El administrador declara cada grupo de empatados contiguo en la lista provisional. Si hay puntuaciones anteriores guardadas, el servidor detecta los grupos automáticamente. Antes del primer turno del grupo, se bloquean elecciones y automatismos hasta registrar el sorteo. El responsable puede pulsar **Sortear y guardar orden**, o seleccionar todos los nombres en el orden obtenido fuera de la app y pulsar **Guardar orden externo**. Se conservan orden, método, fecha y responsable; no se permite repetir el sorteo registrado. El motor rota una posición por ronda: 1,2,3 → 2,3,1 → 3,1,2 (p.3). No utiliza antigüedad como desempate operativo.
- Dos aplazamientos consecutivos permiten elegir hasta tres ciclos juntos en el turno siguiente (p.2). Nunca superan seis ciclos por persona.
- Dos o tres CTA pueden configurar un turno conjunto con antelación. En cada ronda actúan en el turno del último integrante; un responsable confirma el grupo como una adjudicación transaccional. El aplazamiento combinado de grupos carece de UI y requiere gestión administrativa.
- Toda lista de preferencias guardada es una instrucción de elección automática, sin consentimiento separado. Por defecto sirve solo para el siguiente turno efectivo y queda inactiva cuando se completa una elección, manual o automática, pero no cuando se aplaza; el CTA puede hacerla persistente para rondas futuras. El indicador histórico `automatic` ya no condiciona su aplicación, incluso si antes estaba a `false`. Los ciclos sin cupo se ocultan en UI, pero se conserva el orden íntegro para restaurarlos si un undo libera plazas. Al guardar durante el turno individual abierto, la interfaz advierte y pide confirmación antes de una posible adjudicación inmediata. Las preferencias solo se aplican a turnos individuales; no se adelantan a un turno conjunto. Sin opciones válidas suficientes se espera una elección manual.

## Cupos y nuevos CTA

- Config.specialQuotas define un máximo explícito para un ciclo (por ejemplo, cupo extra RRHH de un CTA). Se mantienen asimismo las restricciones globales del modelo.
- No hay reserva de dos ciclos de verano por persona. El sexto puntúa.
- domain/historical-order.ts implementa newcomerScore para 6, 4–5 y menos de 4 ciclos completos disfrutados (p.3). El equipo administrador debe documentar las vacaciones disfrutadas y las medias por ronda; no pueden inferirse de otra dependencia sin datos.

## Tests y compatibilidad

- tests/criterios-2025.test.ts verifica empates, elección triple, turno conjunto, cupo de uno y nuevos CTA.
- tests/election-service.test.ts verifica la persistencia de las solicitudes originales, turnos conjuntos, varios undo/redo intercalados, cambios de rama y restauración de preferencias. El registro append-only de auditoría conserva las instantáneas anteriores al cambio; una selección nueva tras undo descarta la ruta de redo activa sin borrar las decisiones históricas. Una reconstrucción guiada entre diferentes rondas todavía requiere interfaz y control de sesión administrativos específicos.
- GitHub Actions ejecuta Node tests, TypeScript typecheck y Playwright al abrir o actualizar el PR. Los casos históricos Excel se validan con un perfil específico (45 frente a 46 ciclos) y no se alteran silenciosamente las fórmulas heredadas.
