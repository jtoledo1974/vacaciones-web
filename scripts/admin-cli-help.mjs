// Help detailed enough for someone, or an agent, without access to the repository.
// tests/admin-cli.test.ts checks that every order has a purpose, permissions and an example.

export const HELP = {
  login: {
    summary: 'Empareja esta terminal con tu cuenta durante 30 días.',
    usage: 'admin-cli.mjs login [--no-open]',
    permissions: 'Superadministrador o administrador de VA.',
    writes: 'No toca datos de vacaciones; guarda el acceso en ~/.vacaciones-cli/<host>.json.',
    details: [
      'Abre el navegador en /cli: inicia sesión y aprueba el código que muestra la terminal.',
      'Con --no-open, abre tú esa dirección. El emparejamiento caduca a los cinco minutos.',
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
    summary: 'Copia de seguridad completa con su huella SHA-256.',
    usage: 'admin-cli.mjs backup [--out fichero]',
    permissions: 'Superadministrador.',
    writes: 'No. Contiene datos personales: guárdala en un lugar privado.',
    example: 'node scripts/admin-cli.mjs backup --out copia.json',
  },
  get: {
    summary: 'GET /api/<ruta> genérico.',
    usage: 'admin-cli.mjs get <ruta> [--out fichero]',
    permissions: 'Los de la ruta.',
    writes: 'No.',
    example: 'node scripts/admin-cli.mjs get va/census',
  },
  post: {
    summary: 'POST /api/<ruta> genérico con un cuerpo JSON.',
    usage: 'admin-cli.mjs post <ruta> <fichero.json|-> [--dry-run] [--no-backup] [--backup-dir dir] [--out fichero]',
    permissions: 'Los de la ruta.',
    writes:
      'Sí, salvo las vistas previas. Antes de escribir guarda una copia previa en ./admin-backups (o --backup-dir).',
    details: [
      'Prefiere las órdenes específicas (va-cupos) cuando existan: validan y explican el resultado.',
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
