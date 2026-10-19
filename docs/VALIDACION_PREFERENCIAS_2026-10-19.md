# Validación local de preferencias · 19/10/2026

Base: `main` en `96eaeaa` (PR #10). Rama: `ux/preferencias-responsive-local-20261019`.

## Implementación

El calendario añade ciclos a un borrador y muestra su posición. Hasta 900 px, una barra fija indica cantidad, cambios pendientes y acceso a «Revisar y guardar». El panel de revisión permite ordenar, quitar y guardar, con cierre y guardado siempre accesibles. En escritorio, el editor lateral ajusta su altura al espacio visible y desplaza su contenido. Los avisos se integran en los controles, sin tarjetas flotantes sobre el calendario.

El estado guardado se deriva de las preferencias recibidas del servidor. Los cambios en fechas y uso por rondas forman parte del borrador; deshacer una edición hasta coincidir con el servidor elimina el aviso pendiente. Cambiar de modo, controlador, equipo, ejercicio, escenario o apartado requiere confirmar el descarte. La recarga o cierre activa el aviso del navegador. Cerrar la revisión conserva el borrador y no guarda nada.

Se reutilizan el filtrado de cupos, el orden y los comandos existentes. No hay cambios en `domain/`, `server/`, esquema o migraciones. Se conserva la confirmación antes de que guardar en el turno individual pueda adjudicar inmediatamente. El selector usa la lista de controladores autorizados por el servidor.

## Verificación

| Comprobación | Resultado |
| --- | --- |
| `node --experimental-transform-types --test tests/*.test.ts` | 86 aprobados |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json` | Correcto |
| `pnpm build` | Correcto |
| `PLAYWRIGHT_CHANNEL=chrome`, suite completa | 44 aprobados en 6,5 minutos |

Hay cuatro omisiones intencionadas: la matriz explícita de tamaños se ejecuta una vez, en el proyecto `chromium`, y evita duplicarse en el proyecto `mobile`. Los demás recorridos se ejecutan en ambos proyectos.

La suite comprueba persistencia por API y recarga, prioridad, uso por rondas, cancelación y confirmación de descarte, error de guardado sin pérdida del borrador, ciclos ocultos que reaparecen y listas de 14 preferencias. También pasan las regresiones de permisos, privacidad, aplazamientos, turnos conjuntos, empates, automatismos, deshacer/rehacer, sincronización, cierre y restauración.

Cada ejecución crea una carpeta nueva bajo `.sites-runtime/e2e-state/`, con migraciones locales y sesión ficticia. Esto evita que sesiones o límites de login contaminen repeticiones. La última ruta queda en `.sites-runtime/e2e-latest-state.txt`. No se utiliza D1 remota.

## Revisión visual

Se abrió la aplicación local en navegador y se inspeccionaron las capturas de los nueve estados pedidos en cada tamaño: vacío, primera selección, revisión, reordenación, guardado, modificación posterior, cambio de modo pendiente, ciclos ocultos y confirmación de adjudicación inmediata.

| Tamaño | Capturas inspeccionadas | Resultado |
| --- | --- | --- |
| 375 × 667 | 9 | Barra visible, revisión desplazable, cierre y guardado accesibles |
| 390 × 844 | 9 | Orden y estado legibles; confirmaciones completas |
| 768 × 1024 | 9 | Calendario utilizable y revisión centrada con ancho limitado |
| 1440 × 900 | 9 | Calendario y editor simultáneos; guardar visible también al inicio de página |

La inspección llevó a integrar los avisos en la barra/editor y ajustar la altura del editor de escritorio. Se verificaron además capturas de listas largas, ausencia de desbordamiento horizontal, foco contenido, retorno del foco, Escape y botones con etiquetas accesibles y superficie táctil suficiente.

Las 36 capturas, dos capturas de listas largas y láminas de revisión se conservan en el entorno local, fuera del repositorio. No se generan estas capturas en CI ni se suben artefactos a Actions.

## Alcance

Validación en Chrome, con tamaños y emulación móvil. No se han probado Safari nativo, teléfonos físicos, lectores de pantalla ni el inicio de sesión real de ChatGPT. La compilación local no demuestra funcionamiento en producción. No se ha hecho merge, desplegado ni modificado datos de producción.
