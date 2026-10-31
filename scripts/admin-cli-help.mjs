// Help detailed enough for someone, or an agent, without access to the repository.
// tests/admin-cli.test.ts checks that every order has a purpose, permissions and an example.

export const HELP = {
  login: {
    summary: 'Empareja esta terminal con tu cuenta durante 30 días.',
    usage: 'admin-cli.mjs login [--no-open]',
    permissions: 'Superadministrador, responsable de equipo con concesión vigente o administrador de VA.',
    writes: 'No toca datos de vacaciones; guarda el acceso en ~/.vacaciones-cli/<host>.json.',
    details: [
      'Abre el navegador en /cli: inicia sesión y aprueba el código que muestra la terminal.',
      'Con --no-open, abre tú esa dirección. El emparejamiento caduca a los cinco minutos.',
      'Las rutas API siguen comprobando los permisos de cada equipo y función. La copia global requiere superadmin; para escribir como administrador limitado hay que indicar expresamente --no-backup.',
    ],
    example: 'VACACIONES_URL=https://vacaciones.lazaro.es node scripts/admin-cli.mjs login',
  },
  logout: {
    summary: 'Revoca el acceso guardado de esta terminal y borra el fichero.',
    usage: 'admin-cli.mjs logout',
    permissions: 'Cualquiera con un acceso guardado.',
    writes: 'Revoca la sesión en el servidor.',
    example: 'node scripts/admin-cli.mjs logout',
  },
  session: {
    summary: 'Muestra la identidad y el rol con que actúa el CLI.',
    usage: 'admin-cli.mjs session',
    permissions: 'Cualquiera.',
    writes: 'No.',
    example: 'node scripts/admin-cli.mjs session',
  },
  index: {
    summary: 'Equipos, campañas visibles y entrada de VA de la cuenta.',
    usage: 'admin-cli.mjs index [--out fichero]',
    permissions: 'Cualquiera.',
    writes: 'No.',
    example: 'node scripts/admin-cli.mjs index --out indice.json',
  },
  admin: {
    summary: 'Usuarios, permisos y auditoría reciente.',
    usage: 'admin-cli.mjs admin [--out fichero]',
    permissions: 'Superadministrador.',
    writes: 'No.',
    example: 'node scripts/admin-cli.mjs admin --out admin.json',
  },
  campaign: {
    summary: 'Vista completa de una campaña ordinaria.',
    usage: 'admin-cli.mjs campaign <id> [--out fichero]',
    permissions: 'Responsable del equipo o superadministrador.',
    writes: 'No.',
    details: ['El id de cada campaña aparece en «index».'],
    example: 'node scripts/admin-cli.mjs campaign 385fe18a-391f-4ac9-8056-365136dcf47a --out campana.json',
  },
  backup: {
    summary: 'Copia completa v2 fragmentada con inventario y cadena SHA-256.',
    usage: 'admin-cli.mjs backup --out copia.ndjson',
    permissions: 'Superadministrador.',
    writes: 'No. Contiene datos personales: guárdala en un lugar privado.',
    details: [
      'Escribe en disco sin acumular la base en memoria. Si cambia la base, aborta y elimina el parcial.',
      'Restauración fuera de línea: node scripts/restore-backup-v2.mjs copia.ndjson destino-nuevo.sqlite. No sobrescribe producción ni un fichero existente.',
    ],
    example: 'node scripts/admin-cli.mjs backup --out copia.ndjson',
  },
  cleanup: {
    summary: 'Previsualiza y confirma limpieza conservadora en lotes.',
    usage:
      'admin-cli.mjs cleanup preview [--mode compact-reconstruction-events|expired-auth-only] [--out plan.json]\n  admin-cli.mjs cleanup apply plan.json',
    permissions: 'Exclusivamente superadministrador.',
    writes:
      'preview no escribe; apply confirma el token exacto, caduca en 15 minutos y requiere revisión sin cambios. Guarda una copia previa salvo --no-backup.',
    details: [
      'No borra audit, sesiones de reconstrucción ni negocio vigente. La compactación solo retira duplicados comprobados contra audit.',
      'La categoría bytes mide ahorro lógico bruto del lote, no páginas físicas liberadas ni el coste de su nueva auditoría. Solicita otro preview para cada lote.',
    ],
    example: 'node scripts/admin-cli.mjs cleanup preview --mode compact-reconstruction-events --out plan.json',
  },
  get: {
    summary: 'GET /api/<ruta> genérico.',
    usage: 'admin-cli.mjs get <ruta> [--out fichero]',
    permissions: 'Los de la ruta.',
    writes: 'No.',
    example: 'node scripts/admin-cli.mjs get va/census',
  },
  'va-censo': {
    summary: 'Censo anual de VA en el orden explícito de RRHH, con antigüedad y días congelados al abrir.',
    usage:
      'admin-cli.mjs va-censo importar|aplicar fichero.json --year AAAA [--title texto] [--review-token token]\n  admin-cli.mjs va-censo ver --year AAAA',
    permissions:
      'Administrador de VA o superadministrador. La copia completa previa requiere superadministrador; el administrador de VA puede usar --no-backup.',
    writes:
      'importar solo previsualiza. aplicar requiere el token de esa revisión y crea o sustituye el censo en preparación, nunca una campaña ya abierta.',
    details: [
      'JSON: {"year":2027,"people":["id-persona-1","id-persona-2"]}. El orden de people es el de RRHH.',
      'Las fichas deben tener número de empleado y fecha validados. La vista previa muestra las personas con derecho omitidas y las discrepancias con el número de empleado; no reordena.',
      'El contenido exacto del fichero se identifica por SHA-256. Las preferencias solo las edita cada titular.',
    ],
    example: 'node scripts/admin-cli.mjs va-censo importar censo.json --year 2027 --out revision.json',
  },
  'va-personas': {
    summary: 'Altas y correcciones de TCA, jefes de sala y personal de pasillo sin equipo ordinario.',
    usage:
      'admin-cli.mjs va-personas importar|aplicar personas.json [--title texto] [--review-token token]\n  admin-cli.mjs va-personas ver',
    permissions:
      'Administrador de VA o superadministrador. La copia completa previa requiere superadministrador; el administrador de VA puede usar --no-backup.',
    writes:
      'importar previsualiza; aplicar crea o actualiza las fichas revisadas, sin crear equipos ni campañas ordinarias.',
    details: [
      'JSON: {"entries":[{"code":"NICK","label":"Nombre validado","seniority":"2000-01-01","employeeNumber":1234,"category":"tca"}]}',
      'category admite tca, jefe_sala, pasillo u otro. active:false da de baja la ficha para futuros censos; no reescribe campañas ya abiertas.',
      'Para corregir un número de empleado usa el id existente. La vista previa y su token vinculan exactamente los datos revisados.',
      'Tras dar de alta, vincula su acceso en Administración › Antigüedad e incluye su id en va-censo, en el orden de RRHH.',
    ],
    example: 'node scripts/admin-cli.mjs va-personas importar personas-sin-equipo.json --out revision.json',
  },
  post: {
    summary: 'POST /api/<ruta> genérico con un cuerpo JSON.',
    usage: 'admin-cli.mjs post <ruta> <fichero.json|-> [--dry-run] [--no-backup] [--backup-dir dir] [--out fichero]',
    permissions: 'Los de la ruta.',
    writes:
      'Sí, salvo las vistas previas. Antes de escribir guarda una copia previa en ./admin-backups (o --backup-dir).',
    details: [
      'Prefiere las órdenes específicas (va-cupos) cuando existan: validan y explican el resultado.',
      'Sin rol superadmin no podrás obtener una copia global previa; --no-backup permite escrituras autorizadas sin ella, bajo tu responsabilidad.',
      'Importación de plantilla: sin --review-token solo devuelve el informe.',
    ],
    example: 'node scripts/admin-cli.mjs post people/seniority carga.json --dry-run',
  },
  'va-cupos': {
    summary: 'Plazas diarias de vacaciones de antigüedad que publica RRHH. Solo se cargan y corrigen desde aquí.',
    usage: [
      'admin-cli.mjs va-cupos importar <calendario.xlsm|.xlsx|.json> [--year AAAA] [--title texto] [--received AAAA-MM-DD]',
      'admin-cli.mjs va-cupos aplicar <mismo calendario y opciones> --review-token <token>',
      'admin-cli.mjs va-cupos cambiar AAAA-MM-DD PLAZAS [--review-token <token>]',
      'admin-cli.mjs va-cupos ver --year AAAA [--out fichero]',
    ].join('\n  '),
    permissions: 'Administrador de VA o superadministrador.',
    writes:
      'importar y cambiar sin token solo previsualizan. aplicar y cambiar con token sustituyen el calendario completo del año, tras una copia previa.',
    details: [
      'importar lee el Excel de RRHH en local, sin ejecutar macros: un bloque por mes titulado «Mes AAAA», una fila de números de día y, debajo de cada número, sus plazas.',
      'Cada carga sustituye el calendario completo del año. Un día ausente tiene 0 plazas, igual que un 0 explícito; ningún mes recibe trato especial.',
      'La vista previa informa de días con plazas, total de plazas, días sin plazas, días VA reconocidos en el censo y días que cambian. Devuelve reviewToken.',
      'aplicar debe repetir exactamente el mismo calendario y opciones que la vista previa: si algo cambia (archivo, título, fecha de recepción o el calendario del servidor), el token deja de valer y hay que previsualizar de nuevo.',
      'cambiar corrige un día partiendo del calendario cargado y pasa por la misma vista previa y token.',
      'El año se deduce de las fechas del calendario; --year solo es necesario si se quiere comprobarlo o con un JSON vacío.',
      'Códigos de salida: 0 bien; 1 error (el mensaje dice qué falta); 2 aplicado pero no se pudo guardar --out; 3 se perdió la respuesta y puede haberse aplicado: comprueba con «va-cupos ver» antes de repetir.',
    ],
    format: [
      'JSON aceptado por «importar» en lugar del Excel:',
      '{ "days": { "2027-02-01": 3, "2027-02-02": 2 } }',
      'Respuesta de la vista previa (stdout, JSON): { "year", "totalPlaces", "daysWithPlaces", "daysWithoutPlaces", "entitledDays", "changedDays", "changes": [{ "date", "before", "after" }], "reviewToken" }',
    ],
    example: [
      'node scripts/admin-cli.mjs va-cupos importar "Calendario VA 2027.xlsm"',
      'node scripts/admin-cli.mjs va-cupos aplicar "Calendario VA 2027.xlsm" --review-token 3f2a…',
      'node scripts/admin-cli.mjs va-cupos cambiar 2027-09-15 3',
      'node scripts/admin-cli.mjs va-cupos ver --year 2027 --out cupos.json',
    ].join('\n  '),
  },
};

export function helpText(topic, general) {
  if (!topic)
    return general + '\nAyuda de cada orden: admin-cli.mjs help <orden>. Órdenes: ' + Object.keys(HELP).join(', ');
  const h = HELP[topic];
  if (!h) return 'Orden desconocida: ' + topic + '. Órdenes: ' + Object.keys(HELP).join(', ');
  return [
    topic + ': ' + h.summary,
    '',
    'Uso:\n  ' + h.usage,
    'Permisos: ' + h.permissions,
    'Escribe: ' + h.writes,
    ...(h.details ? ['', ...h.details.map((d) => '- ' + d)] : []),
    ...(h.format ? ['', 'Formatos:', ...h.format.map((f) => '  ' + f)] : []),
    '',
    'Ejemplo:\n  ' + h.example,
    '',
    'Entorno: VACACIONES_URL (origen de la aplicación). Sin usuario y contraseña de administrador local usa el acceso guardado con «login».',
  ].join('\n');
}
