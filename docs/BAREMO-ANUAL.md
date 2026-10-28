# Baremo anual y acumulados

## Referencia de 2027

Autoridad comprobada: `_FINAL2 BRAVO 2027 Perpetuo V22.0.0.D1.xlsx`.
SHA-256: `6543028f0499e2815b632f8cec890e78f0bed0bc1303474707c1949fed6fda7f`.

- `Baremo!AO100:AR496`: 397 fechas con base, festivo y `MAX(base, festivo)`.
- Los intervalos de Lunes Santo a Domingo de Resurrección y de Lunes a Domingo de Feria tienen valoración festiva completa.
- Los festivos usan la columna de fechas **corregidas**, sin volver a trasladarlos ni rebajarlos cuando caen en sábado.
- `Baremo!AS` suma los días del ciclo; `Vac!M5:M50` recoge esos valores.
- `Vac!J6:J25` suma las seis selecciones. `Vac!D5:I5` fija los seis pesos a uno: no hay excepciones autorizadas ni controles de ponderación en la interfaz.

El registro existente en `domain/policy.ts` incorpora el módulo `domain/scoring-2027.ts` mediante la propiedad `VacationPolicy.scoring`. `domain/scoring.ts` consulta ese registro, sin importar directamente implementaciones anuales: tramos base, fechas/puntos festivos explícitos y seis pesos oficiales. El 1 de mayo de 2027 vale 8; el 1 de enero de 2028, incluido en los ciclos de esta campaña, vale 10. La valoración diaria es un máximo, no una suma de base más festivo.

## Inicialización, copia y campañas existentes

`defaultConfig(year)` inicializa el baremo registrado del año. `copyConfig` selecciona el baremo del destino en lugar de arrastrar el del origen. Una configuración anual explícita no se lleva a otro año que carezca de registro: en ese caso se recupera el comportamiento heredado.

El motor consulta el registro **también al calcular campañas existentes**. Así las fórmulas antiguas almacenadas no pueden mantener el 1 de mayo a 5. Se conservan en la base de datos por trazabilidad; no se necesita una migración de parámetros, miembros ni adjudicaciones. Los campos de configuración guardados no son la autoridad del baremo en un año registrado. La vista administrativa y la exportación de parámetros muestran **los valores oficiales efectivos** y su versión, no los valores antiguos almacenados. Tramos y festivos se muestran en controles de solo lectura; el JSON avanzado también es de solo lectura en esos ejercicios, sin impedir editar los demás controles. Se han eliminado de la interfaz los seis campos de ponderación. Para 2027, el cálculo fija los pesos a `[1,1,1,1,1,1]` aunque la configuración antigua guardada contenga otros valores. La API rechaza cambios explícitos en tramos, festivos o pesos que el motor ignoraría, con un mensaje que identifica la versión oficial. No se añade GUI de edición del baremo anual.

Al desplegar este código, la vista de campaña recalcula los ciclos y la clasificación ascendente de puntos para el año siguiente en cada consulta. No modifica el orden inicial del año en curso, las selecciones, la elección ni las preferencias. Las campañas incompletas tienen acumulados provisionales.

Las revisiones y publicaciones son instantáneas: no se reescriben. Cada resultado y revisión incluye `scoringVersion`, además de `engineVersion`. Se impide publicar una revisión con una versión anual distinta o ausente en un ejercicio registrado, incluso si no ha cambiado la versión global del motor; hay que calcular una revisión nueva. También se rechazan revisiones de una versión anterior del motor. Las publicaciones históricas permanecen tal como se publicaron.

## Registrar un nuevo ejercicio

1. Obtener y aprobar su fuente anual, con versión y SHA-256.
2. Transcribir tramos base, festivos efectivos y sus puntuaciones, intervalos completos de Semana Santa/Feria y los días del año siguiente que alcancen los ciclos.
3. Registrar el módulo anual en la propiedad `scoring` de la política de su ejercicio en `domain/policy.ts`, con una versión nueva. Mantener la encapsulación: los consumidores genéricos consultan `domain/scoring.ts`; solo el registro importa la implementación anual.
4. Cotejar calendarios por equipo, días de correturnos y ajustes de años bisiestos. **Este PR valida 2027, no valida automáticamente ciclos de nueve días en futuros ejercicios.**
5. Añadir un fixture independiente con resultados de la fuente, sin datos identificativos de personas, y comprobar todos los días, todos los ciclos y acumulados completos.
6. Registrar los pesos oficiales que se usarán para los acumulados y revisar los desempates. En 2027 los seis son uno y no se admiten excepciones por parámetros. Un cambio normativo autorizado exige código, versión anual nueva y tests; no se añade un editor de pesos.

Los ejercicios sin registro conservan por compatibilidad las reglas antiguas de configuración. **Eso no significa que su baremo haya sido aprobado o cotejado**: antes de usar un nuevo año en producción debe añadirse su referencia anual. No extrapolar 2027 cambiando únicamente el año de las fechas.

## Pruebas contra BRAVO

`tests/fixtures/scoring-2027-final2.json` contiene los valores guardados de FINAL2, extraídos del XLSX sin ejecutar sus funciones Google Sheets exportadas. Incluye los seis pesos de `Vac!D5:I5`, 397 días, 46 ciclos y las seis fechas y el acumulado de 20 filas; omite nombres e identificadores personales.

- `tests/scoring-2027.test.ts`: fechas/puntos festivos, tramos base y puntuaciones diarias completas, 46 ciclos, 20 acumulados, clasificación, configuración antigua y copia entre años. Los ciclos de los ocho equipos se suman contra los 397 días del fixture independiente, no contra otra salida del motor; conserva el cotejo Excel de 2026.
- `tests/scoring-service.test.ts`: campañas abiertas y cerradas con parámetros antiguos y pesos `[2,3,4,5,6,7]`, recálculo de los 20 totales por el servicio sin reescribir solicitudes, adjudicaciones ni parámetros; proyección de parámetros efectivos con pesos uno; rechazo de ediciones de cada uno de los seis pesos; guardado de versiones y rechazo de publicaciones con baremo antiguo o ausente, sin cambiar el motor global.
- `tests/e2e/policy-2027.spec.ts`: administración oficial de solo lectura en escritorio y móvil, versión visible, valores oficiales, ausencia de los seis campos de ponderación y rechazo por API de cambios en festivos y pesos.
- `tests/import-boundaries.test.ts`: ejecutar con los archivos nuevos **añadidos al índice**, ya que la prueba usa `git ls-files`.

En BRAVO las mismas 120 selecciones producen 3 puntos más para las filas 9, 12 y 16 de `Vac` (ciclo del 1 al 8 de mayo: 40 → 43). Las filas 8 y 12 intercambian sus posiciones 15/16. No se incluyen backups ni identidades personales en el repositorio.
