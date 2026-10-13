# Regresión histórica de las vacaciones 2020/2022 — Equipo H

Fuentes originales del propietario (no incluidas aquí, por contener datos personales):

- `vacaciones V19.8 Perpetuo.xlsm`, hoja `Vac` y `Baremo`, año 2020, SHA-256 `cbcad4bf3e33302f668a6985244bbf3f70907a9cd60b95bb91b2178e5fc86c03`.
- `vacaciones V20.0 Perpetuo 2022.xlsm`, año 2022, SHA-256 `470d2327be17f1d2ddc76f3df3450544bb35772d16ed303d616211e3c3a83a4f`.

Se usan identificadores anónimos `P01` a `P15`. Los valores y fechas proceden de celdas **almacenadas**, sin recalcular Excel. El fichero `tests/historical-2020-2022.json` contiene una extracción compacta e independiente de los resultados que se comparan en `tests/historical-replay.test.ts`.

## Orden y elección histórica

- `Vac!A6:B20`: orden visible de elección en **2020**.
- `Vac!C6:H20`: seis elecciones por CTA, ordenadas por columnas (primera a sexta ronda), **90 entradas**.
- `Vac!I6:I20`: suma de los seis ciclos para cada controlador.
- `Vac!B35:C49`: clasificación siguiente, rotulada **2021**, comprobada con los 15 totales de 2020.
- `Vac!K5:L50`: 46 ciclos, baremos y fechas.
- `Vac!F1`: 15 extracupos adicionales autorizados; el registro final utiliza **9 terceros cupos**, todos fuera del verano; ocupación: 11 ciclos con uno, 26 con dos y 9 con tres CTA.

La reproducción se hace en el orden de las filas para cada una de las seis columnas. Es una cronología plausible a partir de la estructura del libro; **no prueba la existencia, momento o acuerdo de turnos conjuntos ni de permutas históricas**. Dos personas tienen los mismos seis ciclos, hecho registrado sin interpretar su causa. El cómputo y la clasificación del año posterior se contrastan por separado para evitar una prueba tautológica.

## Cálculo anual

Los dos libros corresponden a la rotación del **equipo H** y utilizan correturnos el **1 de marzo**. Sus 46 inicios coinciden exactamente con la rotación. En 2020 hay un salto bisiesto de nueve días entre 27 de febrero y 7 de marzo.

Los valores diarios de la hoja Baremo se representan como una lista de cambios de puntuación en las fechas especificadas. Se suministran al motor como `baseScores` sin volver a aplicar festivos. Así se compara la **suma automática de días por ciclo** contra `Vac!K5:K50`, pero **no se certifica aquí la independencia de los cálculos de festivos del original**, porque se utilizan puntuaciones diarias almacenadas. Para esa segunda comprobación habría que portar separadamente las reglas de la hoja Baremo del ejercicio y compararlas día por día.

Para 2022 pueden validarse 46 fechas, pero solo los **primeros 45 baremos**: la plantilla tiene `#N/A` en el día 10 de enero de 2023, que pertenece al último ciclo. No se debe fabricar un baremo sustitutorio para marcar esa prueba como superada.

## Cupos y limitaciones

El motor moderno de `relationQuotas` no tiene un campo específico que represente directamente `Vac!F1`. Para la reproducción de 2020 se traslada su **saldo de 15 extras** a la gracia dinámica histórica (manteniendo los límites de uno, dos y tres por ciclo), y se documenta la traducción. Esto valida que la secuencia es admisible bajo ese cupo observado; no afirma que el método de distribución de RRHH del año 2020 sea idéntico al de 2025.

No se convierte 2020 en un test de reglas de 2025: no está demostrado que fuesen iguales. Las pruebas de criterios de 2025 se mantienen separadas.

## Cómo ejecutarlo

`pnpm test` incluye automáticamente `tests/historical-replay.test.ts`; GitHub Actions la ejecuta en cada PR. Si cambia el algoritmo del calendario, la baremación, los cupos o el avance de turno, se detectan diferencias frente a los históricos.
