# Importar una campaña con orden explícito

Una tabla de ciclos por persona no declara por sí sola la secuencia de elección. Toda importación que contenga fechas, aunque solo copie solicitudes, debe incluir `source.selectionOrder`. La API y el CLI rechazan su ausencia. Es deliberado: las solicitudes copiadas sin adjudicaciones también se revisan contra turno y cupo, para que una campaña no herede peticiones que la secuencia declarada no permitiría; esas incidencias se muestran aunque luego no se escriban adjudicaciones. Las filas siguen definiendo la plantilla y sus columnas; la secuencia enumera cada selección exactamente una vez, con su ronda, nick y fecha.

En una tabla por rondas, cada columna es una ronda y se recorre de arriba abajo. Por ejemplo:

```json
{
  "action": "import_roster",
  "version": 7,
  "source": {
    "format": "vacaciones-roster-v1",
    "team": "D",
    "year": 2027,
    "copySelections": true,
    "rows": [
      {"code":"AA","label":"Persona A","seniority":"","dates":["2027-12-21","2027-12-29"]},
      {"code":"BB","label":"Persona B","seniority":"","dates":["2027-01-03","2027-08-31"]}
    ],
    "selectionOrder": [
      {"round":1,"code":"AA","date":"2027-12-21"},
      {"round":1,"code":"BB","date":"2027-01-03"},
      {"round":2,"code":"AA","date":"2027-12-29"},
      {"round":2,"code":"BB","date":"2027-08-31"}
    ]
  }
}
```

No se admiten pasos duplicados, fechas ajenas ni volver a una ronda anterior. Las columnas de una fila son sus ciclos en el orden en que los eligió, no sus rondas.

### Aplazamientos y turnos conjuntos

Según la guía (apartado 11), un CTA puede dejar pasar una ronda y elegir dos o tres ciclos en una ronda posterior. El paso aplazado se declara sin fecha, `{"round":2,"code":"AA","deferred":true}`, y los ciclos que acumula llevan la ronda real en que se eligieron:

```json
"rows": [
  {"code":"AA","label":"Persona A","seniority":"","dates":["2027-12-21","2027-12-29","2027-07-06"]},
  {"code":"BB","label":"Persona B","seniority":"","dates":["2027-01-03","2027-08-31","2027-10-12"]}
],
"selectionOrder": [
  {"round":1,"code":"AA","date":"2027-12-21"},
  {"round":1,"code":"BB","date":"2027-01-03"},
  {"round":2,"code":"AA","deferred":true},
  {"round":2,"code":"BB","date":"2027-08-31"},
  {"round":3,"code":"AA","date":"2027-12-29"},
  {"round":3,"code":"AA","date":"2027-07-06"},
  {"round":3,"code":"BB","date":"2027-10-12"}
]
```

Una fila nunca va por delante de sus turnos: su ciclo n necesita al menos la ronda n. Los turnos conjuntos se declaran de dos formas, como en una elección en directo: `source.jointGroups` para grupos permanentes (2 o 3 nicks, todas las rondas) y `source.jointTurns`, `[{"round":2,"codes":["AA","BB"]}]`, para un acuerdo de una sola ronda. Los nicks se comparan sin distinguir mayúsculas, y nadie puede estar en dos turnos conjuntos de la misma ronda. Los ciclos de un turno conjunto se escriben seguidos en la ronda en que eligió el grupo. La vista previa reproduce los pasos con las mismas reglas de turno que una elección en directo: límites de aplazamiento, turno doble y turno conjunto. No se puede recorrer la fila completa de AA y después la de BB. Los huecos permanecen vacíos: no se inventan selecciones.

## Revisar antes de guardar

`POST /api/campaign/{id}` con `action: "preview_import_roster"`, versión y fuente devuelve `sequence`, `findings`, `blockingIssues` y `reviewToken`, sin escribir ni cambiar la versión.

La revisión recorre la secuencia propuesta: comprueba prioridad inicial cuando existen puntuaciones, turno y rotación de empates con el motor de elección, y cupos/completabilidad con las reglas del ejercicio después de cada selección. Una comprobación indeterminada se muestra como incidencia, nunca como una validación positiva. Sin puntuaciones anteriores se advierte que la prioridad inicial no pudo verificarse. La posición de la plantilla declara el orden inicial dentro de los empates; no se fabrica un sorteo.

Las incidencias indican paso, ronda, nick y fecha. Se puede cancelar sin modificar la campaña. Para guardar se envía `action: "import_roster"` con el `reviewToken` recibido. Si hubo incidencias de progresión se requiere además `acceptViolations: true`, tras revisarlas. La aceptación se registra en auditoría con el informe completo. Los datos estructuralmente inválidos y los incumplimientos del reparto final siguen bloqueando la carga.

El `reviewToken` es una garantía de integridad, no una prueba de revisión: es un SHA-256 de fuente, configuración e informe, datos que quien llama ya conoce. Detecta cualquier cambio entre la vista previa y la escritura, pero un cliente podría calcularlo sin mostrar el informe a nadie. La revisión humana la imponen la pantalla y el CLI, no la API; la auditoría conserva el informe aceptado.

Si cambia cualquier dato, configuración o versión de campaña, hay que revisar otra vez. La escritura sigue siendo atómica y conserva el control de versión. Con elección activa se debe pausar antes de importar. Una plantilla sin fechas sigue pudiendo importarse sin una secuencia ficticia, pero también necesita su vista previa y su `reviewToken`: sustituye la plantilla y borra solicitudes y adjudicaciones.

## CLI

Con el acceso de administrador local ya configurado, el primer comando solo pide el informe:

```text
node scripts/admin-cli.mjs post campaign/ID carga.json --out revision.json
```

Sin `reviewToken`, el CLI convierte la acción en previsualización. No guarda copia ni modifica datos en esta fase. Tras leer el informe, se puede cancelar o confirmar exactamente esos datos:

```text
node scripts/admin-cli.mjs post campaign/ID carga.json --review-token HASH_DEL_INFORME
```

Si se decide aceptar incidencias de progresión, añadir `--accept-violations` (sin `--review-token` se ignora, con un aviso en stderr). Antes de escribir, el CLI conserva su copia previa e integridad verificadas. `--dry-run` solo muestra el cuerpo que enviaría; no equivale a la revisión normativa del servidor. El CLI comprueba el contrato de orden incluso en `--dry-run`.

## Persistencia, historial y compatibilidad

Aplicar la migración `0014_import_selection_order.sql` antes de desplegar. Cada adjudicación importada guarda su posición global y ronda (`selection_index`, `selection_round`), conservadas en copias y restauración de instantáneas. El historial las muestra por ronda y orden de selección, identificadas como importadas y sin inventar horas de elección. La API devuelve las adjudicaciones en esa secuencia; «Por CTA» usa por defecto orden de petición.

Los registros antiguos sin esa información conservan un respaldo por columna de solicitud y posición de plantilla. Dentro de un mismo ciclo, una solicitud de ronda 1 precede a una de ronda 3 aunque su CTA esté después en la plantilla. El JOIN agrupa solicitudes por persona y fecha con `MIN(slot)`, para que datos restaurados duplicados no multipliquen adjudicaciones.

Los metadatos antiguos no se convierten automáticamente en una secuencia certificada: hay que aportar y revisar el orden de la fuente para importar de nuevo. Los archivos anteriores que contengan selecciones sin `selectionOrder` se rechazan expresamente.
