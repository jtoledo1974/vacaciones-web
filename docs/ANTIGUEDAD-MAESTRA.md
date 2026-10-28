# Antigüedad maestra de ENAIRE

`POST /api/people/seniority` permite a un superadministrador completar las fechas vacías de las fichas maestras de personas activas, sin modificar instantáneas de campañas, colas, preferencias, adjudicaciones ni sus estados abiertos/cerrados. No calcula derechos de VA ni altera automáticamente el baremo de vacaciones ordinarias.

La petición lleva `action: preview`, una fuente con `title`, `asOf` (fecha ISO) y `sha256`, y entre 1 y 300 `entries`. Cada entrada contiene `personId`, `date` (fecha ISO de antigüedad en ENAIRE), `controllerNumber` y `page` del escalafón. La identificación debe resolverse antes de llamar a la API; esta operación no acepta semejanzas de nombres como prueba.

La previsualización devuelve los valores anteriores, versiones, número de cambios y `reviewToken`. Para aplicar se repite el cuerpo con `action: apply` y ese token. Cambiar cualquier ficha o la fuente invalida la revisión. El lote es atómico y las fechas ya iguales son idempotentes; una fecha existente distinta exige revisión individual y no se sobrescribe. Las fechas imposibles, posteriores a la fuente, fichas inactivas y números CTA duplicados se rechazan. El número CTA se guarda en la ficha (`people.controller_number`, único): una carga posterior no puede asignarlo a otra persona ni cambiar el de una ficha que ya lo tiene. Las fichas se leen en bloques de 100, no una consulta por persona.

El evento administrativo `master_seniority` conserva valores anteriores y procedencia (huella, fecha, título, página y número CTA). No contiene una copia de la base completa. Los datos del escalafón y los cruces de producción se mantienen fuera del repositorio.

Las futuras campañas VA deberán consultar estas fichas maestras. Las campañas ordinarias existentes conservan sus propios datos históricos. Este endpoint no añade una campaña VA ni activa elecciones.
