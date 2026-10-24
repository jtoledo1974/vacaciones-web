# Cotejo del calendario LECS 2027 con el libro de RR. HH.

Fecha: 25/10/2026. Fuente: `2027_LECS_Vac .xlsm`, SHA-256 `de5755fdaedbffb32889667750afa81e94b70dc28a37ad79eb8177ac24539e75`, el mismo que cita `domain/hr-2027.ts`. Se leyó el XML del libro sin ejecutar macros. Este documento no contiene datos personales.

## Método

Para cada hoja de turno (A–H) se extrajeron todas las filas con periodo («Resto» o «Verano») y fecha de inicio: inicio, fin, periodo y formato de la celda de inicio. Se compararon una a una con `calendar(2027, turno, defaultConfig(2027))` y `hr2027FourthExcluded`.

## Resultado

371 ciclos comparados, **sin diferencias** en inicio, fin, periodo verano/resto ni ciclos rojos.

| Turno | Ciclos | Verano | Preverano | Postverano | Rojos (excluidos de cuarta plaza) |
|---|---:|---|---:|---:|---|
| A | 45 | 1 jun → 21 sep (15) | 18 | 12 | 21 mar, 14 abr, 18 dic |
| B | 46 | 2 jun → 22 sep (15) | 19 | 12 | 22 mar, 7 abr, 27 dic |
| C | 46 | 3 jun → 23 sep (15) | 19 | 12 | 23 mar, 16 abr, 28 dic |
| D | 46 | 4 jun → 16 sep (14) | 19 | 13 | 24 mar, 9 abr, 21 dic |
| E | 46 | 5 jun → 17 sep (14) | 19 | 13 | 25 mar, 10 abr, 22 dic |
| F | 46 | 6 jun → 18 sep (14) | 19 | 13 | 18 mar, 11 abr, 31 dic |
| G | 45 | 7 jun → 19 sep (14) | 19 | 12 | 19 mar, 12 abr, 24 dic |
| H | 45 | 8 jun → 20 sep (14) | 19 | 12 | 20 mar, 13 abr, 25 dic |

Las fechas de verano son inicios de ciclo; el issue #57 citaba el último fin de verano (por ejemplo, 28 sep en A).

Los rojos están marcados con letra roja (`FFFF0000`) en la celda de inicio. Hay cuatro celdas con un estilo distinto pero visualmente idéntico al normal (B: 23 abr, 1 may, 9 may; F: 23 dic): misma letra negra y mismo borde. Parecen celdas que estuvieron en rojo y se devolvieron a negro; no se interpretan como rojas.

## Discrepancia de filas y metadatos (D/E/F)

La hoja oculta de plantilla guarda un metadato «Ciclos» por turno. Coincide con las filas fechadas en todos los turnos salvo D, E y F:

| Turno | Filas fechadas | Metadato «Ciclos» | Ciclo adicional |
|---|---:|---:|---|
| D | 46 | 45 | 29 dic 2027 → 5 ene 2028 |
| E | 46 | 45 | 30 dic 2027 → 6 ene 2028 |
| F | 46 | 45 | 31 dic 2027 → 7 ene 2028 |

El indicador de «ocupación de cupos» de la hoja de inicio usa ese metadato, así que cuenta 45 ciclos en D/E/F. Sin embargo, B y C sí cuentan su ciclo de 27 y 28 de diciembre, que también termina en 2028.

**El código sigue las filas fechadas (46 en D/E/F)**, igual que el resto de la hoja y los formularios de solicitud. Queda pendiente que RR. HH. confirme si los ciclos que empiezan el 29, 30 y 31 de diciembre pertenecen a la campaña 2027 de D, E y F. Si no, basta con cambiar `count` a 45 en `domain/hr-2027.ts` para esos tres turnos.
