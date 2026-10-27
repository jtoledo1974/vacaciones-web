#!/usr/bin/env node
// Administración por API sin navegador. Inicia sesión como administrador
// local o mediante el navegador, ejecuta una orden y revoca solo su propia sesión.
//
// Variables de entorno:
//   VACACIONES_URL             origen de la aplicación, p. ej. https://vacaciones.example.com
//   VACACIONES_ADMIN_USER      LOCAL_ADMIN_USERNAME del despliegue
//   VACACIONES_ADMIN_PASSWORD  LOCAL_ADMIN_PASSWORD del despliegue
// Sin usuario/contraseña, abre el navegador y usa tu cuenta actual de ChatGPT.
//   --browser         fuerza la autorización mediante el navegador
//   --no-open         no abre el navegador; abre /cli manualmente
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
// Código de salida 3: se perdió la respuesta del post; puede haberse aplicado.
// Código de salida 130: cancelado con Ctrl+C o SIGTERM.
// Cada login cuenta para el límite de 5 intentos en 15 minutos.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cliHash, CLI_TOKEN_HEADER } from '../lib/cli-protocol.mjs';

class CliError extends Error {}

// Throws instead of exiting so pending finally blocks still revoke the session.
function fail(message) {
  throw new CliError(message);
}

// Cancellation covers the whole run: login, backup and the command. The handler
// only aborts pending reads and stops new steps; finally blocks still revoke.
const cancel = new AbortController();
function onSignal() {
  if (cancel.signal.aborted) return;
  console.error('Cancelando…');
  cancel.abort();
}
function checkCancelled() {
  if (cancel.signal.aborted) fail('Orden cancelada');
}
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
const transient = (status) => status === 429 || status >= 500;

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
    if (['--dry-run', '--no-backup', '--browser', '--no-open'].includes(a)) flags[a.slice(2)] = true;
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
    this.cliToken = '';
    this.cliCode = '';
  }
  url(route) {
    return new URL(this.origin + '/api/' + route.replace(/^\/+/, ''));
  }
  // mode 'read': 30 s timeout and Ctrl+C abort it; 'cleanup' (revocation): timeout only;
  // 'write': never aborted once sent, since the server may apply it after any client deadline.
  async request(method, route, body, mode = 'read') {
    const timeout = mode === 'write' ? undefined : AbortSignal.timeout(30000);
    const r = await fetch(this.url(route), {
      method,
      redirect: 'manual',
      signal: mode === 'read' ? AbortSignal.any([timeout, cancel.signal]) : timeout,
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.cliToken ? { [CLI_TOKEN_HEADER]: this.cliToken } : {}),
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
    if (this.cliToken) {
      // Always revoked, approved or not: it also fences a late approval in the browser.
      // Best effort: if the network keeps failing, the session expires in at most 15 minutes.
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await this.request('POST', 'cli-auth/logout', { code: this.cliCode }, 'cleanup');
            if (r.ok) return;
            if (!transient(r.status) || attempt === 3) throw new Error(String(r.status));
          } catch (e) {
            if (attempt === 3) throw e;
          }
          await sleep(500 * attempt);
        }
      } catch {
        console.error('Aviso: no se pudo revocar el acceso CLI; caduca en un máximo de 15 minutos');
      } finally {
        this.cliToken = '';
      }
      return;
    }
    if (!this.cookie) return;
    // A failed logout is only a warning: it must not mask the outcome of the operation.
    try {
      const r = await this.request('POST', 'local-admin/logout', {}, 'cleanup');
      if (!r.ok) console.error('Aviso: no se pudo cerrar la sesión (' + r.status + '); caduca sola en 8 horas');
    } catch (e) {
      console.error('Aviso: no se pudo cerrar la sesión (' + (e?.message ?? e) + '); caduca sola en 8 horas');
    } finally {
      this.cookie = '';
    }
  }
  /** The authorization covers exactly this request and, for writes, the previous backup. */
  async operation(method, route, body, backup) {
    const url = this.url(route);
    return {
      method,
      path: url.pathname + url.search,
      ...(method === 'POST' ? { bodyHash: await cliHash(JSON.stringify(body)), backup } : {}),
    };
  }
  async loginBrowser(noOpen, operation) {
    this.cliToken = randomBytes(32).toString('hex');
    // Independent of the token: the code typed in the browser never reveals the credential.
    this.cliCode = randomBytes(8).toString('hex').toUpperCase();
    const url = this.origin + '/cli';
    console.error('Código de la terminal: ' + this.cliCode.match(/.{4}/g).join('-'));
    console.error('Introdúcelo en: ' + url);
    console.error('Operación solicitada: ' + operation.method + ' ' + operation.path);
    if (!noOpen) {
      // Fixed executable and arguments, never a shell command containing the URL.
      const [exe, args] =
        process.platform === 'win32'
          ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
          : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];
      const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', () => console.error('Abre el enlace anterior en tu navegador.'));
      child.unref();
    }
    const deadline = Date.now() + 5 * 60 * 1000;
    let delay = 1500;
    while (Date.now() < deadline) {
      checkCancelled();
      let r = null;
      try {
        r = await this.request('POST', 'cli-auth/join', { code: this.cliCode, operation });
      } catch {
        checkCancelled(); // otherwise a network error or timeout: retry until the deadline
      }
      if (r?.ok && r.data?.status === 'approved') return;
      if (r && !r.ok && !transient(r.status))
        fail('No se pudo autorizar el CLI (' + r.status + '): ' + (r.data?.error ?? 'respuesta inesperada'));
      delay = r?.ok ? 1500 : Math.min(delay * 2, 15000);
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), cancel.signal);
    }
    checkCancelled();
    fail('La autorización del navegador ha agotado sus cinco minutos');
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
  if (!VACACIONES_URL) fail('Define VACACIONES_URL con el origen de la aplicación');
  if (!flags.browser && !!VACACIONES_ADMIN_USER !== !!VACACIONES_ADMIN_PASSWORD)
    fail('Define usuario y contraseña juntos, o usa --browser');

  const client = new Client(VACACIONES_URL);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // Inside try: a cookie issued before a failed role check is still revoked.
    if (flags.browser || !VACACIONES_ADMIN_USER)
      await client.loginBrowser(
        flags['no-open'],
        await client.operation(method, route, body, method === 'POST' && !flags['no-backup']),
      );
    else await client.login(VACACIONES_ADMIN_USER, VACACIONES_ADMIN_PASSWORD);
    checkCancelled();
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
    checkCancelled();
    // Never retried, and not aborted once sent: the write may already be applied.
    let r;
    try {
      r = await client.request(method, route, body, method === 'POST' ? 'write' : 'read');
    } catch (e) {
      if (method !== 'POST') throw e;
      console.error(
        'Resultado DESCONOCIDO: se perdió la conexión tras enviar la escritura (' + (e?.message ?? e) + ').',
      );
      console.error('Puede haberse aplicado. Comprueba el estado antes de repetirla con una orden nueva.');
      process.exitCode = 3;
      return;
    }
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
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().catch((e) => {
  if (cancel.signal.aborted) {
    console.error('Orden cancelada');
    process.exitCode = 130;
    return;
  }
  console.error(e instanceof CliError ? e.message : (e?.stack ?? String(e)));
  process.exitCode = 1;
});
