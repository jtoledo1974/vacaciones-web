# Cupos diarios de RRHH para vacaciones de antigüedad

Estado: **operativa implementada** en `main`, comprobada contra `scripts/va-cupos.mjs`, `scripts/admin-cli-help.mjs` y `server/va-quotas.ts` el 31/10/2026. Esta página sustituye a la propuesta inicial de comandos. Para el uso de la web, véase [GUI.md](GUI.md); para el orden de puesta en marcha, [ELECCION.md](ELECCION.md).

## Quién y dónde

Los cupos de VA son **diarios, comunes a toda LECS y por ejercicio**. El administrador de VA y el superadministrador pueden cargarlos o corregirlos. Un responsable de equipo no adquiere ese permiso por administrar ordinarias.

**No hay editor de cupos en la web:** el panel «Censo y accesos de VA» solo muestra el resumen y la fuente de la última carga; la escritura se realiza con `scripts/admin-cli.mjs`. El CLI soporta la autenticación de navegador vinculada a la cuenta, con los permisos que verifica el servidor.

## Órdenes existentes

Consultar la ayuda integrada antes de operar: `node scripts/admin-cli.mjs help va-cupos`. Para detalles generales de autenticación, copia previa y flags, `node scripts/admin-cli.mjs help`.

```bash
# Vista previa: valida el Excel local sin ejecutar sus macros; NO escribe.
node scripts/admin-cli.mjs va-cupos importar "Calendario VA 2027.xlsm" --year 2027 --out revision.json

# Aplicar EXACTAMENTE el mismo calendario y opciones, con el token de la vista previa.
node scripts/admin-cli.mjs va-cupos aplicar "Calendario VA 2027.xlsm" --year 2027 --review-token TOKEN

# Consultar el estado y guardar la respuesta estructurada.
node scripts/admin-cli.mjs va-cupos ver --year 2027 --out cupos.json

# Corregir una fecha: primero vista previa; después repetir con su token.
node scripts/admin-cli.mjs va-cupos cambiar 2027-09-15 3
node scripts/admin-cli.mjs va-cupos cambiar 2027-09-15 3 --review-token TOKEN
```

`importar` y `aplicar` aceptan **.xlsm, .xlsx y .json**. En JSON se admite el objeto `{"days":{"2027-02-01":2}}` o directamente el mapa `{"2027-02-01":2}`. `--year` puede omitirse si todos los días del archivo pertenecen inequívocamente al mismo año. La huella SHA-256 se calcula a partir del archivo de entrada; `--title` y `--received AAAA-MM-DD` permiten anotar su procedencia.

`cambiar` parte del calendario ya cargado: incorpora la nueva capacidad en una **vista previa del calendario completo**. No funciona si aún no se han importado cupos. La sintaxis real no incluye `--motivo`; no atribuirle una justificación textual que el CLI no recoge.

## Reglas de validación y seguridad

- Día omitido o con capacidad cero significa **cero plazas**. No hay trato especial para enero ni para ningún otro mes. El resumen devuelve días con cupo, plazas, días sin cupo, días VA reconocidos (si hay censo) y diferencia frente a la versión anterior.
- Se validan el ejercicio, las fechas y los enteros no negativos. El archivo Excel se procesa **sin ejecutar VBA**.
- `importar` y la primera llamada a `cambiar` devuelven un `reviewToken`; aplicar repite los mismos datos y exige ese token. Un cambio concurrente invalida la revisión previa.
- No se acepta una actualización que reduzca un cupo por debajo de las adjudicaciones VA existentes. La transacción vuelve a comprobar la ocupación antes de persistirla. Si hace falta resolver un conflicto, se corrige primero el estado de elecciones con las herramientas administrativas auditadas.
- La fuente conserva título, SHA-256, fecha declarada de recepción y actualización; la operación queda en auditoría. La corrección deriva el título de la fuente vigente y añade «· corregido». No afirmar que registra un motivo libre: **el comando actual no lo solicita**.

## Formato de referencia recibido

El ejemplo proporcionado por RRHH el 28/10/2026 es el fichero `Calendario VA 2026 - ejecutivo.xlsm` (SHA-256 `8bc9b16af87f3c5ccf690027752f54c23a1dbb04ad37e357013ff0e8d85c0733`), acompañado de su impresión PDF. Contiene un calendario de febrero a diciembre de 2026; su ausencia de enero **no debe extrapolarse a 2027**. No incorporar una plantilla antigua como cupo oficial de un ejercicio nuevo sin verificarla.

## Pendiente fuera de esta herramienta

La carga de cupos **no** genera ni exporta el Excel VA definitivo de adjudicaciones para RRHH. Ese flujo sigue pendiente de implementación. Para la puesta en marcha debe existir un calendario oficial del ejercicio correcto y el censo VA revisado.
