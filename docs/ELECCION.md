# Elección de vacaciones por turnos

Nota de requisitos, 13 de octubre de 2026. Fuente: explicación directa del propietario. El documento de normas aplicable al ejercicio está pendiente de recibir.

## Paradigma confirmado

- Los controladores piden secuencialmente, cuando les corresponde su turno de elección.
- Cada persona elige en función de las vacaciones que van quedando libres después de las elecciones anteriores.
- El orden de elección viene predeterminado por la puntuación remanente de las peticiones del año anterior.
- La plantilla puede cambiar entre ejercicios. El historial debe vincularse a una identidad estable, incluso al cambiar de equipo o identificador.

La elección es un proceso ordenado sobre disponibilidad cambiante. No debe presentarse como una recogida simultánea de preferencias que luego se ordena por las puntuaciones del ejercicio actual.

## Diferencia con la aplicación actual

El baremo mostrado actualmente se calcula a partir de las selecciones del ejercicio abierto. Sirve para comparar las entradas con las hojas originales, pero **no establece el orden de elección de este año**. Las altas anuales crean identidades y los traslados conservan la identidad; las importaciones de históricos tendrán que confirmar la correspondencia entre personas, sin deducirla automáticamente de nombres o nicks.

La aplicación actual permite registrar solicitudes y adjudicaciones manualmente. La ampliación incorpora cola con orden confirmado por administrador, preferencias privadas, automatismos al llegar el turno y una política provisional de un ciclo por turno, con un aplazamiento para elegir dos en la siguiente ocasión. El remanente histórico, su cálculo y los desempates oficiales siguen pendientes del documento de normas. Las elecciones ya existentes se conservan y no se activa una cola para la campaña real automáticamente.

## Propuesta de interfaz

La vista principal **Vacaciones** reúne calendario, cola y preferencias:

1. **Orden del equipo:** lista fija de participantes, puntuación remanente de origen y estado de elección. Debe mostrar el ejercicio y la fuente que justifican el orden. Las peticiones actuales no lo recalculan.
2. **Quién elige ahora:** persona activa y, si las normas establecen varias rondas, ronda actual. Acciones de confirmar elección, pasar o aplazar solo si están previstas por las normas. El administrador registra la elección; no se concede escritura pública a los controladores.
3. **Qué queda libre:** calendario de ciclos disponibles, cupos restantes y explicación de restricciones aplicables. Una elección confirmada actualiza la ocupación antes del siguiente turno.

Separar visualmente **remanente anterior**, **baremo de la elección actual** y **remanente para el próximo ejercicio**. Nunca usar una única columna «Puntuación» para los tres conceptos.

Confirmar una elección deberá guardar persona, ciclo, turno/ronda, origen del orden y reglas utilizadas en una transacción. Deshacer o rehacer tendrá que recuperar también la posición de la cola y la disponibilidad, no solo las listas de vacaciones. El avance, la identidad de quien elige y los cupos deberán comprobarse en el servidor.

La consulta pública muestra las elecciones confirmadas actuales, su ocupación y baremos, incluso antes del cierre final. Conserva únicamente los identificadores abreviados; nombres, antigüedades, cuentas, preferencias y simulaciones no son públicos. Los administradores gestionan el orden; una cuenta vinculada puede guardar sus preferencias y elegir en su turno.

## Pendiente del documento de normas

- Qué significa exactamente «puntuación remanente», cómo se obtiene y qué peticiones computan.
- Sentido del orden, desempates y regla para datos desconocidos.
- Número de rondas y cantidad o tipo de ciclos elegibles en cada turno.
- Cómo se actualizan o consumen puntuaciones; si el orden cambia entre rondas.
- Reglas para altas, reincorporaciones, bajas y cambios de equipo, incluida la antigüedad.
- Qué hace una ausencia, un aplazamiento, una renuncia o una corrección de una elección anterior.
- Cuándo la petición reserva o confirma un cupo y cómo se gestionan restricciones o excepciones.
- Cómo se cierra el ejercicio y qué saldo se transmite al siguiente.

No asumir menor puntuación primero, desempate por antigüedad, una petición por ronda ni un saldo inicial de cero para nuevas personas hasta contrastarlo con las normas.

## Validación con históricos

Las hojas finales permiten contrastar calendarios, baremos, saldos y ocupación. Para reproducir el proceso secuencial hacen falta también el orden inicial y, cuando sea relevante, la secuencia o las rondas de elección: un resultado final por sí solo no demuestra que el proceso de elección se reproduzca correctamente. Incluir varios equipos, cambios de plantilla y un año bisiesto.

