> Documento histórico de la política v2, sustituido por [la guía definitiva y política v3](policy-2027-definitive-guide.md). No utilizar como norma vigente.

# Política LECS 2027 · corrección del 24 de octubre de 2026

**Fuente prevalente:** [acuerdo normativo y aclaraciones en PR #58](https://github.com/jtoledo1974/vacaciones-web/pull/58#issuecomment-6383119950). Este documento no sustituye el acta de RRHH y no representa autorización definitiva de las interpretaciones pendientes. Sustituye las afirmaciones incompatibles del issue #57 y de la descripción previa del PR.

**Versión semántica:** `lecs-2027-occupancy-v2`. Solo para campañas 2027; el motor de elecciones históricas, orden, desempates y solicitudes originales conserva sus reglas.

## Reglas firmes

- Por controlador: seis ciclos, salvo derecho individual distinto expresamente autorizado por RRHH. No existe un requisito individual de exactamente dos estivales.
- Final: ningún ciclo vacío, verano mínimo dos, otros periodos mínimo uno; ocupación máxima cuatro. Excepciones rojas de RRHH no admiten cuarta plaza.
- Ciclos con cuatro: máximos preverano / verano / postverano = 1 / 2 / 1. Verano no admite ciclos con una persona.
- Preverano: **dos** ampliaciones adicionales a tres, sobre **dos destinos diferentes**, y **una** ampliación a cuatro, sobre un **tercer destino diferente**. La cuarta no sustituye ninguna tercera y no puede producir otro ciclo individual. Máximo tres ciclos con una persona, **sin aviso por superar dos**; el techo no es una tercera ampliación contable.
- Postverano: una ampliación a tres y una a cuatro, que pueden concentrarse sobre el mismo destino. Máximo dos ciclos con una persona. Ejemplos de reversión: `1/3 → 2/2`, `1/4 → 2/3`, `2/4 → 3/3`.
- Las terceras plazas ordinarias fuera de verano se justifican por una bolsa compartida entre pre y post; los permisos adicionales son específicos de cada periodo.

## Testigo contable y semántica

El motor examina el **reparto final** y busca una justificación existencial: ciclos ordinarios de dos o tres, permisos de tercera/cuarta sobre destinos apropiados y fuentes de plazas compatibles. No modela permutas históricas ni asocia un permiso a un controlador.

Para preverano, las terceras adicionales se vinculan a **dos destinos con tres**, y la cuarta a **otro destino con cuatro**. La cuarta debe proceder de una fuente que mantenga al menos dos personas, no de un nuevo ciclo individual. En postverano, un destino con cuatro puede provenir de la utilización conjunta de EC3 y EC4. Las fuentes se contabilizan sin establecer un orden histórico; un mismo reparto final tiene el mismo veredicto.

El modo `strictRegions` es **contraste territorial**: el origen de cada plaza adicional debe estar en el periodo que otorga el permiso. La norma aplicada provisionalmente permite que la fuente sea de otro periodo (incluido verano), siempre que permanezcan sus mínimos, límites y derechos. Si hay reparto válido aplicado pero no completación compatible con `strictRegions`, se expone `CROSS_PERIOD_FLEXIBILITY`, se muestra a todos y requiere revisión administrativa en la publicación. Que el comprobador alcance el límite de exploración **no demuestra incompatibilidad**.

`SUMMER_REFERENCE` es **informativo**, comparando con dos ciclos por controlador (ajustado al derecho individual). No se exige el total `2 × plantilla`: una diferencia no basta para concluir que se vulnera la interpretación territorial estricta. Los estados parciales conservan su condición de incompletos; las advertencias de imposibilidad solo se emiten tras comprobar terminaciones.

La eventual consideración adicional de las cuartas plazas estivales sigue formalmente **pendiente**. Operativamente se conserva mínimo dos y máximo dos ciclos con cuatro, sin abrir ciclos con una persona, sin inventar presupuesto estival y sin imponer un total estival fijo. Cualquier cambio requerirá nueva versión y pruebas. Las medidas posteriores de vacaciones de antigüedad quedan fuera del alcance.

## Integración, publicación y datos existentes

Dominio, elección manual/automática/conjunta, preferencias, simulaciones, reconstrucción y API utilizan el evaluador común; la verificación de servidor es atómica y versionada. Un aviso permite publicar **solo** tras confirmación explícita, nunca sortear restricciones firmes. La revisión registra actor, fecha, versión de campaña, versión de política y avisos reconocidos.

Una revisión calculada con versión distinta de `v2` debe recalcularse antes de publicar. Los snapshots/publicaciones antiguas conservan su procedencia original: **no** se recalculan ni se migran automáticamente. Antes de activar esta revisión en campañas iniciadas, inspeccionar ejecuciones almacenadas (versión de política, avisos reconocidos y validación anterior) y diseñar una migración supervisada. **No ejecutar operaciones sobre campañas reales para validar este PR.**

## Verificación de aceptación

- Testigos independientes para dos EC3 + un EC4 preverano, destinos distintos y cuarta sin déficit extra; no habilitar una tercera EC3 por contar tres ciclos individuales.
- Encadenamiento postverano; exclusiones rojas, límite de cuartas 1/2/1, mínimos finales, permisos, derechos individuales y estados parciales.
- Flexibilidad con origen exterior y contraste `strictRegions`; no derivar una violación estricta solamente de `SUMMER_REFERENCE`.
- Reutilización de testigos validada con `evaluate2027Final`, búsqueda entera exacta, independencia del orden y resultados indeterminados sin falsos rechazos definitivos.
- Opciones/API, calendario, tabla, preferencias, publicación y motivos accesibles; simulaciones/equipos reales autorizados y rendimiento representativo. Consultar el CI del HEAD del PR; un CI anterior no valida esta revisión.
