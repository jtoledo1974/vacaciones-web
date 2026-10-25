# Política definitiva LECS 2027 · v3

Fuente: Guía de elección LECS 2027 v1.1, 25/10/2026, páginas 2–3. Aclaración del responsable: los extracupos de preverano y postverano se generan exclusivamente con huecos de su propio periodo; son estancos.

## Política única

- Seis ciclos ordinarios por CTA, salvo autorización individual de RRHH. Dos estivales son referencia de dimensionamiento, no una reserva individual ni un máximo de elecciones.
- Ningún ciclo vacío. Máximo cuatro personas, sujeto a exclusiones EC4 de RRHH ya cargadas en el calendario de 2027.
- Preverano: dos EC3 y un EC4, encadenables. El EC4 puede dejar un ciclo individual (decisión del responsable, 25/10/2026: se suprime «La utilización del cupo 4 no podrá generar un ciclo adicional con un solo CTA de vacaciones», que hacía inalcanzable el máximo). Máximo tres ciclos individuales, sin convertir ese techo en un tercer EC3.
- Postverano: un EC3 y un EC4, encadenables; máximo dos ciclos individuales.
- Verano: bolsa compartida de dos permisos, cada uno EC3 o EC4 según las elecciones. Se admite encadenar EC3 y EC4 en un destino, consumiendo ambos permisos. Se admiten ciclos individuales derivados de esos permisos, sin obligación de crearlos. Con dos permisos no pueden justificarse tres huecos individuales.
- Origen y destino de cada extra permanecen en el mismo periodo. Las terceras plazas ordinarias necesarias no se confunden con los permisos extraordinarios. No se impone un total estival fijo.

## Implementación y compatibilidad

Versión semántica: lecs-2027-occupancy-v4 (v3 impedía que el EC4 de preverano dejara un ciclo individual). Se elimina strictRegions y el contraste con flexibilidad territorial; no hay aviso administrativo que permita autorizar una infracción territorial. La búsqueda comprueba que todas las vacaciones pendientes siguen siendo asignables, sin duplicar ciclos individuales. Una búsqueda acotada inconclusa sigue siendo indeterminada.

Las referencias informativas al dimensionamiento estival se conservan. Las revisiones históricas y su versión original permanecen archivadas. Los snapshots de disponibilidad de otra versión no se reutilizan; los nuevos cálculos usan v3. Publicar un cálculo antiguo exige recalcular mediante el control de versión existente. No se migran ni alteran adjudicaciones reales durante las pruebas.

## TDD

Primer commit: pruebas de aceptación que fallaban con v2 (verano individual, compensación territorial y completación parcial). Segundo paso: política única y actualización de regresiones que dependían expresamente de la interpretación provisional. Validar tests unitarios, tipos, CI de escritorio y móvil antes de merge y despliegue.
