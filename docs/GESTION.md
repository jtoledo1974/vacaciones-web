# Gestionar vacaciones

La vista **Vacaciones** sustituye las páginas separadas de solicitudes y asignaciones. El calendario permite consultar o seleccionar; las preferencias son alternativas futuras y las elecciones confirmadas ocupan cupo inmediatamente.


## Mesa de elección y dispositivos móviles

La pantalla de elección tiene tres vistas que comparten los mismos ciclos y cupos:

- **Mapa:** año completo, ciclos agrupados por mes de comienzo; color según plazas libres (0, 1, 2, 3 o 4+) y códigos abreviados de ocupantes.
- **Calendario:** días de cada mes, puntos en el detalle del ciclo y relación de códigos que ya eligieron; en móvil se navega mes a mes.
- **Por CTA:** seis columnas de ciclos adjudicados a cada CTA ordenados por **fecha de vacaciones**, no necesariamente por turno de elección. En móvil son fichas desplegables.

El borde dorado identifica los ciclos de verano según las fechas de la configuración anual. El borde es visual; cambiar las fechas configuradas sí afecta al cálculo de cupos adicionales por período, sin cambiar la prioridad de las personas. Los colores interiores solo indican disponibilidad. Si un ciclo cruza meses, la ocupación también puede aparecer en el detalle del mes al que se extiende.

En administración, el turno activo, la confirmación y Deshacer/Rehacer aparecen juntos; la historia inversa de adjudicaciones se construye a partir de elecciones vigentes y marcas de auditoría. Los ciclos importados, cuando no tienen registro secuencial de elección, se identifican como tales. Las preferencias reutilizan el calendario, pero no ocupan plazas antes de su adjudicación.

En móvil, la zona de acción precede al calendario y las secciones largas de historial, preferencias y orden se presentan después. El mapa conserva el año completo en desplazamiento vertical. El informe PDF final seguirá diseñándose y contrastándose con el Excel histórico en una fase independiente.

## Preparar una elección

1. Revisa la plantilla y las reglas del equipo y ejercicio.
2. En **Preparar el orden de elección**, revisa los nicks por puntuación anterior, uno por línea, e indica su origen. Si se han guardado las puntuaciones anteriores, el orden aparece preparado y el servidor detecta los empates. En otro caso, declara los grupos empatados consecutivos; su orden interno es provisional. No se deriva de las puntuaciones del año actual.
3. Confirma los Criterios Vacaciones 1.1 (2025). Cada persona elige un ciclo por ronda; si se habilita el aplazamiento, puede acumular hasta dos para elegir dos o tres ciclos en su siguiente turno, sin superar el total anual.
4. Activa la elección. La cola espera la elección válida de la persona que aparece en pantalla. Un turno sin opciones válidas no se pasa automáticamente.

Antes de que el primer integrante de cada grupo empatado pueda elegir, la aplicación pide registrar el sorteo. El responsable puede sortear en la app o pulsar los nombres en el orden obtenido en un sorteo externo y guardar. El resultado persiste tras recargar y rota en las rondas siguientes. Las restricciones anuales de RRHH deben contrastarse con su documento específico; no se deducen del coloreado de una tabla impresa.

## Listas propias y delegadas

En Administración → Plantilla del equipo, edita las columnas «Correo de acceso / UID» y «Autenticación» de cada controlador y pulsa «Guardar cambios». Para ChatGPT Sites introduce el correo electrónico con el que inicia sesión; el servidor exige que proceda de la autenticación. Para Firebase introduce el UID de su proyecto. Selecciona «Sin vincular» para desvincular. La cuenta recibe acceso a sus preferencias y a elegir en su turno; no administración. Una cuenta corresponde a una persona, con identidad conservada entre ejercicios y traslados.

En **Preparar preferencias**, el administrador puede seleccionar a cualquier controlador del equipo e introducir su lista. Las flechas establecen prioridad. El consentimiento de automatización es explícito y se guarda con la lista. Se prueban las opciones en orden cuando llega su turno; las elecciones previas se respetan. Para una elección doble se busca una pareja válida y se confirma de forma conjunta, o se espera.

El trabajo automático se guarda en lotes acotados. La web continúa esos lotes mientras está abierta; si se interrumpe, **Continuar automatismos** permite reanudarlos. Si cierras la web en mitad de una cadena de lotes, otra sesión puede reanudarla. No hay un planificador en segundo plano.

## Quién falta en la ronda

El panel **Quién falta en esta ronda** muestra, en orden, a quienes aún tienen que elegir en la ronda y cómo actuará la lista de cada uno: *Automático*, *Espera 2 h*, *Elige a mano · lista como nota* o *Elige a mano · sin lista*. No muestra los ciclos de cada lista. Debajo, **Si reanudas ahora** simula lo que se adjudicaría al instante (con los ciclos) y dónde se pararía la ronda. Con la elección en pausa el panel se abre solo: sirve para llevar la elección en paralelo por el método tradicional sabiendo qué se asignaría al reanudar. Al reanudar, quien tenga un plazo empieza a contarlo desde ese momento.

Cuando vence el plazo de una lista y nadie tiene la web abierta, el aviso programado de cada minuto aplica la preferencia; en el historial aparece como automática y en la auditoría con el actor `sistema:plazo`.

## Simular varias veces

Administración → **Herramientas avanzadas** → **Simulaciones privadas** crea escenarios con nombre del mismo equipo y año. Copian plantilla y parámetros, empiezan sin vacaciones y copian el orden en pausa si existe. Opcionalmente copian preferencias.

El selector **Escenario** distingue la campaña real de cada simulación. Son privadas para administradores y no alteran la campaña real ni las plantillas que se copian a años futuros. Puedes probar varias en paralelo, cerrarlas o reiniciarlas. Los traslados entre grupos y la vinculación de cuentas se gestionan desde las campañas reales.

## Deshacer, corregir y reiniciar

**Deshacer último cambio** y **Rehacer último cambio** recuperan el último lote guardado: preferencias, ocupación y posición de la cola, o un reinicio completo. Conservan un paso entre recargas; otra operación invalida ese paso. No son un historial ilimitado ni permiten deshacer cambios de plantilla, permisos o publicaciones.

**Pausar elección** detiene el proceso para corregir datos. Las correcciones de vacaciones anteriores están en el desplegable de elecciones confirmadas; las peticiones antiguas sin elección se muestran aparte solo si existen. Cambiar plantilla o reglas invalida la cola para que se vuelva a confirmar un orden coherente. Los traslados requieren también que el destino esté en pausa.

Administración → **Herramientas avanzadas** → **Empezar de cero las vacaciones** vacía preferencias, selecciones anteriores, elecciones y estado de cola del escenario seleccionado, conservando plantilla, configuración y revisiones archivadas. Exige escribir equipo-año. Pausa la elección antes; después del reinicio puedes deshacer inmediatamente.

## Cerrar y reabrir

**Cerrar equipo** bloquea los cambios de vacaciones y mantiene la consulta. Reabrir no reanuda la cola automáticamente: usa **Reanudar elección** cuando proceda. Cada equipo y cada simulación se cierran por separado.

En **Revisiones y cierre del ejercicio**, calcular y guardar el resultado final conserva una copia independiente. La consulta pública muestra las asignaciones actuales sin necesitar ese cierre final.

## Plantillas por año

Las altas, bajas y cambios de grupo afectan solo al año seleccionado. Los años ya creados no cambian. Los futuros pueden copiar la plantilla de un ejercicio concreto, la última anterior de cada equipo o empezar vacíos, independientemente de sus parámetros. No copian vacaciones ni preferencias.

La tabla permite editar también las vinculaciones de acceso. Para dar de baja o trasladar, abre el menú «···» de la fila; primero guarda cualquier edición pendiente. Resuelve previamente las elecciones y preferencias de la persona. Una antigüedad vacía significa desconocida.

## Copias y restauración

La copia completa y la restauración están en **Administración → Herramientas avanzadas**. El CSV y el enlace público están en **Vacaciones → Compartir y exportar**.

Descarga una copia completa antes de cambios importantes. Incluye todos los equipos, escenarios, cuentas vinculadas, preferencias, estados de elección, revisiones y auditoría. No incluye secretos del entorno. Guarda el JSON fuera del Site.

Restaurar sustituye los datos de toda la aplicación, no solo del escenario elegido. Comprueba SHA-256, referencias y estados, y se aplica en una transacción. Las copias anteriores a esta ampliación se admiten con las nuevas tablas vacías. No hay una copia externa programada: la descarga es manual.

