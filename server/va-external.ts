import { type Repository, type Statement } from './repository.ts';
import { requireVaAdmin, type Principal } from './permissions.ts';
import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';
import { serial } from '../domain/calendar.ts';

type Entry = {
  id?: string;
  code: string;
  label: string;
  seniority: string;
  employeeNumber?: number;
  /** Legacy API alias for the same employee number, not another identifier. */
  controllerNumber?: number;
  category: 'tca' | 'jefe_sala' | 'pasillo' | 'otro';
  active?: boolean;
};
type Master = {
  id: string;
  code: string;
  label: string;
  seniority: string;
  controller_number: number;
  category: string;
  active: number;
  version: number;
};
type Body = { action?: string; entries?: Entry[]; source?: { title: string; sha256: string }; reviewToken?: string };
const hash = async (v: unknown) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v)))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export async function vaExternalPeople(repo: Repository, actor: Principal) {
  requireVaAdmin(actor);
  return repo.all<Master>('SELECT * FROM va_external_people ORDER BY controller_number');
}
/** Explicitly validated external master records; ordinary teams are never touched. */
export async function importVaExternal(repo: Repository, actor: Principal, body: Body) {
  requireVaAdmin(actor);
  if (
    !['preview', 'apply'].includes(body.action ?? '') ||
    !Array.isArray(body.entries) ||
    !body.entries.length ||
    body.entries.length > 300
  )
    throw new ApiError('Indica entre 1 y 300 personas sin equipo');
  if (
    typeof body.source?.title !== 'string' ||
    !body.source.title.trim() ||
    body.source.title.length > 160 ||
    !/^[a-f0-9]{64}$/.test(body.source.sha256)
  )
    throw new ApiError('Indica título y SHA-256 de la fuente');
  const existing = await vaExternalPeople(repo, actor);
  const ordinary = await repo.all<{ controller_number: number }>(
    'SELECT controller_number FROM people WHERE controller_number IS NOT NULL',
  );
  const rows = body.entries.map((input) => {
    if (
      input?.employeeNumber !== undefined &&
      input.controllerNumber !== undefined &&
      input.employeeNumber !== input.controllerNumber
    )
      throw new ApiError('Los dos nombres del número de empleado no coinciden');
    const entry = input ? { ...input, controllerNumber: input.employeeNumber ?? input.controllerNumber } : input;
    if (
      !entry ||
      typeof entry.code !== 'string' ||
      !/^[A-Z0-9_-]{2,24}$/.test(entry.code) ||
      typeof entry.label !== 'string' ||
      !entry.label.trim() ||
      entry.label.length > 160 ||
      typeof entry.seniority !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.seniority) ||
      entry.seniority < '1900-01-01' ||
      entry.seniority > new Date().toISOString().slice(0, 10) ||
      typeof entry.controllerNumber !== 'number' ||
      !Number.isSafeInteger(entry.controllerNumber) ||
      entry.controllerNumber < 1 ||
      !['tca', 'jefe_sala', 'pasillo', 'otro'].includes(entry.category) ||
      (entry.active !== undefined && typeof entry.active !== 'boolean')
    )
      throw new ApiError('Ficha externa no válida');
    try {
      serial(entry.seniority);
    } catch {
      throw new ApiError('Fecha de antigüedad no válida');
    }
    const previous = entry.id
      ? existing.find((p) => p.id === entry.id)
      : existing.find((p) => p.controller_number === entry.controllerNumber);
    if (entry.id && !previous) throw new ApiError('La persona externa no existe');
    if (
      ordinary.some((p) => p.controller_number === entry.controllerNumber) ||
      existing.some(
        (p) => p.id !== previous?.id && (p.controller_number === entry.controllerNumber || p.code === entry.code),
      )
    )
      throw new ApiError('Número de empleado o nick ya asignado; revisa antes de crear otra ficha', 409);
    const id = previous?.id ?? 'va-external:' + entry.controllerNumber;
    return {
      id,
      code: entry.code,
      label: entry.label.trim(),
      seniority: entry.seniority,
      controllerNumber: entry.controllerNumber,
      category: entry.category,
      active: entry.active !== false,
      previous,
    };
  });
  if (
    new Set(rows.map((p) => p.id)).size !== rows.length ||
    new Set(rows.map((p) => p.code)).size !== rows.length ||
    new Set(rows.map((p) => p.controllerNumber)).size !== rows.length
  )
    throw new ApiError('Hay personas, nicks o números de empleado repetidos');
  const revision =
    (await repo.all<{ revision: number }>("SELECT revision FROM app_state WHERE id='main'"))[0]?.revision ?? 0;
  const report = { rows, source: body.source, revision };
  const reviewToken = await hash(report);
  if (body.action === 'preview') return { ...report, reviewToken };
  if (body.reviewToken !== reviewToken) throw new ApiError('Revisa de nuevo las altas antes de aplicarlas', 409);
  const token = crypto.randomUUID();
  const ops: Statement[] = [
    { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main' AND revision=?", args: [revision] },
    { sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
    ...rows.map((p) => ({
      sql: 'INSERT INTO va_external_people(id,code,label,seniority,controller_number,category,active,version) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET code=excluded.code,label=excluded.label,seniority=excluded.seniority,controller_number=excluded.controller_number,category=excluded.category,active=excluded.active,version=va_external_people.version+1',
      args: [p.id, p.code, p.label, p.seniority, p.controllerNumber, p.category, p.active ? 1 : 0],
    })),
    append({
      id: crypto.randomUUID(),
      actor: actor.id,
      action: 'va_election',
      before: { people: rows.map((p) => p.previous) },
      after: {
        action: 'external_people',
        source: body.source,
        people: rows.map((p) => ({ ...p, previous: undefined })),
      },
      createdAt: new Date().toISOString(),
    }),
  ];
  try {
    await repo.batch(ops);
  } catch (error) {
    if (/transaction_assertions|va_duplicate|UNIQUE/.test(String(error)))
      throw new ApiError('El censo cambió o los identificadores ya están asignados; revisa de nuevo', 409);
    throw error;
  }
  return { ...report, applied: true };
}
