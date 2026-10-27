# Handover: exportar las vacaciones al Excel de RRHH

## Objetivo

El proceso de vacaciones termina cuando se entrega a RRHH su plantilla `2027_LECS_Vac_.xlsm` rellena. La web debe generar **dos descargas**:

1. **Por turno (equipo A–H):** la plantilla con solo la hoja de ese equipo rellena. La descarga el administrador del equipo.
2. **Global:** la plantilla con las 8 hojas rellenas. La descarga el superadministrador y debe avisar o bloquear si algún equipo no está cerrado.

> ⚠️ La plantilla real contiene **nombres y números de empleado reales**. **No se debe commitear** (el README ya prohíbe subir fuentes Excel). Opciones: el administrador la sube desde la web en cada uso, o se guarda en D1/R2 fuera del repositorio. Para los tests, usa una copia **anonimizada** generada con un script.

## Estructura de la plantilla (analizada)

Es un `.xlsm` **con macros** (`xl/vbaProject.bin`, módulo `crea`), controles de formulario (`ctrlProps`), dibujos, `calcChain.xml`, `metadata.xml` (fórmulas de matriz dinámica) y `sharedStrings.xml`.

| Hoja | Fichero XML | Estado | Contenido |
|---|---|---|---|
| Oculta | sheet1 | veryHidden | Letras A–H |
| OcultaEmpleados | sheet2 | veryHidden | Nombre + número de empleado (~160 personas) |
| Inicio | sheet3 | visible | Panel con fórmulas `INDIRECT` sobre las hojas A–H: ciclos bloqueados (límite de verano 3), días críticos (90 %) y ocupación de cupos |
| Meta | sheet4 | veryHidden | `Dependencia=LECS`, `Año=2027` |
| Equipo | sheet5 | veryHidden | Hoja modelo |
| **A … H** | **sheet6 … sheet13** | visible | **Una por equipo; es donde se escribe** |
| Empleados | sheet14 | veryHidden | `Equipo, Empleado, FechaInicio, Ciclos(45), CupoMax(3), NumEmpleado` (E2 = 3) |
| CRs | sheet15 | veryHidden | `Fecha, M, T, N` |

Obtén la correspondencia hoja → fichero XML de `xl/workbook.xml` y `xl/_rels/workbook.xml.rels`. No la escribas fija en el código.

### Hoja de equipo (A–H)

- Encabezados en la fila 7: `B7 Periodo`, `C7:D7` (combinadas, fechas), `E7..H7 "CTA"`, `J7 "CTA"`, `K7 Verano`, `L7 Resto` y `M7 TOTAL`.
- **Filas 8–52: los 45 ciclos de 8 días.** `B` = `"Verano"`/`"Resto"`, `C` = inicio y `D` = fin (fechas). Cada equipo tiene su propio desfase (A empieza el 08/01/2027, B el 01/01, C el 02/01, …, H el 07/01).
- **E8:H52: celdas vacías donde se escribe** el nombre de cada persona a la que se adjudica el ciclo. Tienen validación de lista sobre la plantilla del equipo (`H$8:$J28`).
- **J8:J28: plantilla del equipo** (≈19–20 nombres), con el formato exacto de RRHH, `"APELLIDOS,NOMBRE"`. Algunos llevan un espacio tras la coma, como `"APELLIDO APELLIDO, NOMBRE"`. Hay que respetarlo carácter a carácter.
- `K/L` son fórmulas de matriz `=SUMPRODUCT(($E$8:$G$53=J8)*($B$8:$B$53=$K$7))` y `M = K+L`.
  **Ojo:** los totales cuentan solo **E:G (3 columnas)**, igual que `CupoMax=3`. La columna H parece reservada o extra. Hay que confirmarlo con el usuario antes de escribir en H.

## Enfoque recomendado

**No regenerar el libro con una librería** como ExcelJS o SheetJS, porque pueden perder el VBA, los controles, `metadata.xml` o las fórmulas de matriz. En su lugar:

1. Descomprimir el `.xlsm` (zip) en el Worker con una dependencia ligera como `fflate`, que funciona en Workers.
2. Por cada hoja de equipo, editar `xl/worksheets/sheetN.xml` y escribir **solo** los `<c r="E8">…</c>` de E8:H52 como `t="inlineStr"` (`<is><t>NOMBRE</t></is>`). Así no hace falta tocar `sharedStrings.xml`. Conserva el atributo `s=` (estilo) de la celda si ya existe en el XML y crea la celda o la fila en orden si no existe.
3. No tocar nada más. Poner `<calcPr fullCalcOnLoad="1"/>` en `workbook.xml` (o eliminar `calcChain.xml` y su relación y su entrada en `[Content_Types].xml`) para que Excel recalcule los totales al abrir.
4. Volver a comprimir con los mismos nombres de entrada y devolverlo con `Content-Type: application/vnd.ms-excel.sheet.macroEnabled.12` y nombre `2027_LECS_Vac_<equipo|global>.xlsm`.

### Capas, según la arquitectura del repo

- `domain/hr-export.ts` (nuevo, puro y testeable): a partir de campaña + adjudicaciones + miembros, devuelve `{ sheet: 'A'..'H', rows: { cycleIndex 0..44 → string[] (≤3 nombres) } }`. Reglas:
  - El ciclo `i` de la web debe coincidir con la fila `8+i`. **Valida que las fechas C/D de la plantilla coincidan** con los ciclos de la campaña, y si no, da un error claro.
  - Orden dentro de la fila: estable, por ejemplo por orden de adjudicación o por orden de la plantilla de J. Hay que confirmarlo.
  - Si hay más nombres que columnas disponibles, error.
- `server/hr-xlsx.ts` (nuevo): parcheo del zip y del XML (puntos 1–4).
- **Correspondencia de personas:** cada miembro anual necesita su nombre RRHH exacto, el valor de J. Opciones: un campo `hrName` en el miembro anual (migración Drizzle) o hacerlo automáticamente al subir la plantilla (normalizando tildes y espacios) y luego confirmarlo a mano. **Ninguna persona adjudicada puede quedar sin correspondencia**: si falta alguna, se bloquea la exportación y se lista quiénes faltan.
- `server/service.ts`: casos de uso `exportHrTeam(team, year)` (administrador del equipo, equipo cerrado) y `exportHrGlobal(year)` (superadministrador, con aviso de los equipos abiertos). Registrar en auditoría la revisión exportada.
- Rutas en `app/api/[...path]/route.ts`, siguiendo el modelo de la descarga existente (`server/lite-pdf.ts`, `app/download.ts`).
- UI en el panel de Administración: un botón por equipo y un botón global, más la subida de la plantilla.

Revisa antes `domain/hr-2027.ts` y `domain/hr-calendars.ts`, que ya parecen modelar el calendario de RRHH, `domain/calendar.ts` para los ciclos, y `server/campaign-snapshot.ts` y `server/lite-pdf.ts` para ver cómo se lee la situación final.

## Tests

- `tests/hr-export.test.ts`: mapeo puro (filas, orden, límites y errores de correspondencia).
- Test del parcheo con una plantilla **anonimizada** en `tests/fixtures/`, generada por un script desde la real y sustituyendo nombres y números. Comprobar que:
  - el zip resultante contiene `vbaProject.bin` y el resto de entradas byte a byte iguales, salvo las hojas editadas y `workbook.xml`;
  - si se vuelve a leer (por ejemplo con `python3 -c "import openpyxl"` en una comprobación manual), E8:G52 contiene lo esperado y K/L/M siguen siendo fórmulas.
- Comando del repositorio: `node --experimental-transform-types --test tests/*.test.ts` y `tsc --noEmit -p tsconfig.app.json`.
- Comprobación final manual: abrir en Excel, que no salga el aviso de reparación, que funcionen las macros y que los totales K/L/M y el panel `Inicio` cuadren.

## Preguntas abiertas para el usuario

1. ¿Las casillas `CTA` E–H de cada ciclo son los huecos para las personas a las que se adjudica? ¿Se usa H (los totales solo cuentan E:G)? ¿Importa el orden?
2. ¿RRHH envía la plantilla cada año con los empleados ya cargados (J, `Empleados`) o la rellenamos nosotros?
3. ¿Dónde se guarda la plantilla: se sube en cada exportación o se almacena en la aplicación?
4. ¿La exportación global debe bloquearse o solo avisar si hay equipos sin cerrar?
