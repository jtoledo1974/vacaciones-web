#!/usr/bin/env node
// Administración por API sin navegador. Inicia sesión como administrador
// local, ejecuta una orden y cierra la sesión (la cookie se revoca al salir).
//
// Variables de entorno:
//   VACACIONES_URL             origen de la aplicación, p. ej. https://vacaciones.example.com
//   VACACIONES_ADMIN_USER      LOCAL_ADMIN_USERNAME del despliegue
//   VACACIONES_ADMIN_PASSWORD  LOCAL_ADMIN_PASSWORD del despliegue
//
// Órdenes:
//   session | index | admin | campaign <id>
//   backup [--out fichero]
//   get <ruta>                         GET /api/<ruta>
//   post <ruta> <fichero.json|->       POST /api/<ruta> con ese cuerpo
//
// Opciones de post:
//   --dry-run          muestra la petición y no la envía
//   --backup-dir dir   carpeta de la copia previa (por defecto ./admin-backups)
//   --no-backup        no guarda copia antes de escribir
//   --out fichero      guarda la respuesta en un fichero
//
// Código de salida 2: el post se aplicó pero no se pudo guardar --out.
// Cada login cuenta para el límite de 5 intentos en 15 minutos.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

class CliError extends Error {}

// Throws instead of exiting so pending finally blocks still revoke the session.
function fail(message) {
  throw new CliError(message);
}

// Backups and responses hold personal data: readable only by the current user.
// A fresh temp file ('wx' refuses existing paths and symlinks) is renamed over
// the target, so data never lands in a file with wider permissions.
function writePrivate(file, data) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

// Same check the server applies on restore: a backup that fails it cannot be restored.
function validBackup(b) {
  return (
    b?.payload?.format === 'vacaciones-backup-v1' &&
    b.payload.tables &&
    typeof b.payload.tables === 'object' &&
    typeof b.sha256 === 'string' &&
    b.sha256 === createHash('sha256').update(JSON.stringify(b.payload)).digest('hex')
  );
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--no-backup') flags[a.slice(2)] = true;
    else if (a === '--out' || a === '--backup-dir') {
      if (i + 1 >= argv.length) fail('Falta el valor de ' + a);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) fail('Opción desconocida: ' + a);
    else positional.push(a);
  }
  return { positional, flags };
}

function readBody(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    fail('El cuerpo no es JSON válido: ' + source);
  }
}

class Client {
  constructor(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      fail('VACACIONES_URL debe usar HTTPS (solo se admite HTTP en localhost)');
    this.origin = url.origin;
    this.cookie = '';
  }
  async request(method, route, body) {
    const r = await fetch(this.origin + '/api/' + route.replace(/^\/+/, ''), {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: this.origin } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // Non-JSON responses (help documents, files) are kept as raw bytes.
    let data;
    if ((r.headers.get('content-type') ?? '').includes('json')) {
      const text = await r.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else data = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, data, headers: r.headers };
  }
  async login(username, password) {
    const r = await this.request('POST', 'local-admin/login', { username, password });
    if (!r.ok) fail('Login rechazado (' + r.status + '): ' + (r.data?.error ?? r.data));
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('__Host-vacaciones-local-admin='));
    if (!cookie) fail('El servidor no devolvió la cookie de sesión');
    this.cookie = cookie;
    const session = await this.request('GET', 'session');
    if (session.data?.principal?.role !== 'superadmin')
      fail('La sesión no tiene rol superadmin: ' + JSON.stringify(session.data));
  }
  async logout() {
    if (!this.cookie) return;
    // A failed logout is only a warning: it must not mask the outcome of the operation.
    try {
      const r = await this.request('POST', 'local-admin/logout', {});
      if (!r.ok) console.error('Aviso: no se pudo cerrar la sesión (' + r.status + '); caduca sola en 8 horas');
    } catch (e) {
      console.error('Aviso: no se pudo cerrar la sesión (' + (e?.message ?? e) + '); caduca sola en 8 horas');
    } finally {
      this.cookie = '';
    }
  }
}

function emit(data, out) {
  if (Buffer.isBuffer(data)) {
    if (out) writePrivate(out, data);
    else process.stdout.write(data);
  } else {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (out) writePrivate(out, text + '\n');
    else console.log(text);
  }
  if (out) console.error('Guardado en ' + out);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const routes = { session: 'session', index: 'index', admin: 'admin', backup: 'backup' };
  let method = 'GET',
    route,
    body;
  if (routes[command]) route = routes[command];
  else if (command === 'campaign' && rest[0]) route = 'campaign/' + encodeURIComponent(rest[0]);
  else if (command === 'get' && rest[0]) route = rest[0];
  else if (command === 'post' && rest[0] && rest[1]) {
    method = 'POST';
    route = rest[0];
    body = readBody(rest[1]);
  } else
    fail(
      readFileSync(new URL(import.meta.url), 'utf8')
        .split('\nimport ')[0]
        .replace(/^#!.*\n/, ''),
    );

  if (method === 'POST' && flags['dry-run']) {
    emit({ method, route: '/api/' + route, body });
    return;
  }
  const { VACACIONES_URL, VACACIONES_ADMIN_USER, VACACIONES_ADMIN_PASSWORD } = process.env;
  if (!VACACIONES_URL || !VACACIONES_ADMIN_USER || !VACACIONES_ADMIN_PASSWORD)
    fail('Define VACACIONES_URL, VACACIONES_ADMIN_USER y VACACIONES_ADMIN_PASSWORD');

  const client = new Client(VACACIONES_URL);
  try {
    // Inside try: a cookie issued before a failed role check is still revoked.
    await client.login(VACACIONES_ADMIN_USER, VACACIONES_ADMIN_PASSWORD);
    if (method === 'POST' && !flags['no-backup']) {
      const backup = await client.request('GET', 'backup');
      if (!backup.ok) fail('No se pudo obtener la copia previa (' + backup.status + '); no se escribe nada');
      if (!validBackup(backup.data))
        fail('La copia previa no supera la comprobación de integridad; no se escribe nada');
      const dir = flags['backup-dir'] ?? 'admin-backups';
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'antes-' + stamp() + '.json');
      writePrivate(file, JSON.stringify(backup.data) + '\n');
      console.error('Copia previa: ' + file + ' (sha256 ' + backup.data.sha256 + ')');
    }
    const r = await client.request(method, route, body);
    if (!r.ok) {
      process.exitCode = 1;
      console.error('Error ' + r.status + ': ' + (r.data?.error ?? JSON.stringify(r.data)));
      return;
    }
    if (method !== 'POST') return emit(r.data, flags.out);
    try {
      emit(r.data, flags.out);
    } catch (e) {
      // The change is already committed: say so, so nobody retries it.
      console.error('La operación SÍ se aplicó, pero no se pudo guardar --out: ' + (e?.message ?? e));
      console.error('Respuesta del servidor a continuación.');
      emit(r.data);
      process.exitCode = 2;
    }
  } finally {
    await client.logout();
  }
}

main().catch((e) => {
  console.error(e instanceof CliError ? e.message : (e?.stack ?? String(e)));
  process.exitCode = 1;
});
