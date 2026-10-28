import { requireSuper, type Principal } from './permissions.ts';
import { type Repository, type Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';

const READ_BLOCK = 100;
type Entry = { personId: string; date: string; controllerNumber: number; page: number };
// Untrusted request: every field is validated below before use.
type Body = {
  action?: string;
  reviewToken?: string;
  source?: { title?: string; asOf: string; sha256?: string };
  entries?: (Entry | null)[];
};
const dateOK = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s &&
  s >= '1900-01-01' &&
  s <= new Date().toISOString().slice(0, 10);

/** Enrich master records only. Campaign snapshots and election state are immutable here. */
export async function masterSeniority(repo: Repository, actor: Principal, body: Body) {
  requireSuper(actor);
  if (
    !['preview', 'apply'].includes(body?.action ?? '') ||
    !Array.isArray(body.entries) ||
    !body.entries.length ||
    body.entries.length > 300
  )
    throw new ApiError('Indica entre 1 y 300 fichas para revisar');
  const source = body.source;
  if (
    !source ||
    typeof source.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 160 ||
    typeof source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !dateOK(source.asOf)
  )
    throw new ApiError('Indica título, fecha y SHA-256 de la fuente');
  const entries: Entry[] = body.entries.map((r) => {
    if (
      !r ||
      typeof r.personId !== 'string' ||
      !r.personId ||
      r.personId.length > 100 ||
      !dateOK(r.date) ||
      r.date > source.asOf ||
      !Number.isSafeInteger(r.controllerNumber) ||
      r.controllerNumber < 1 ||
      !Number.isSafeInteger(r.page) ||
      r.page < 1 ||
      r.page > 10000
    )
      throw new ApiError('Ficha, fecha o referencia del escalafón no válida');
    return { personId: r.personId, date: r.date, controllerNumber: r.controllerNumber, page: r.page };
  });
  if (
    new Set(entries.map((r) => r.personId)).size !== entries.length ||
    new Set(entries.map((r) => r.controllerNumber)).size !== entries.length
  )
    throw new ApiError('Hay personas o números CTA duplicados');
  entries.sort((a, b) => a.personId.localeCompare(b.personId));
  // Block reads keep a 300-row load well under D1's per-invocation query limit.
  const people = new Map<string, { seniority: string; version: number; controller_number: number | null }>();
  const owners = new Map<number, string>();
  for (let i = 0; i < entries.length; i += READ_BLOCK) {
    const block = entries.slice(i, i + READ_BLOCK);
    const marks = block.map(() => '?').join(',');
    const [byId, byNumber] = await repo.batch([
      {
        sql: `SELECT id,seniority,version,controller_number FROM people WHERE active=1 AND id IN (${marks})`,
        args: block.map((r) => r.personId),
      },
      {
        sql: `SELECT id,controller_number FROM people WHERE controller_number IN (${marks})`,
        args: block.map((r) => r.controllerNumber),
      },
    ]);
    for (const p of byId.results) people.set(p.id, p);
    for (const p of byNumber.results) owners.set(p.controller_number, p.id);
  }
  const rows = [];
  for (const entry of entries) {
    const person = people.get(entry.personId);
    if (!person) throw new ApiError('Ficha activa no encontrada', 404);
    // This is a fill operation, never an implicit correction of an existing date or number.
    if (person.seniority && person.seniority !== entry.date)
      throw new ApiError('Existe una antigüedad distinta: requiere revisión individual', 409);
    if (person.controller_number !== null && person.controller_number !== entry.controllerNumber)
      throw new ApiError('Existe un número CTA distinto: requiere revisión individual', 409);
    const owner = owners.get(entry.controllerNumber);
    if (owner && owner !== entry.personId)
      throw new ApiError('El número CTA ' + entry.controllerNumber + ' ya pertenece a otra ficha', 409);
    rows.push({
      ...entry,
      previous: person.seniority,
      previousNumber: person.controller_number,
      version: person.version,
    });
  }
  const provenance = { title: source.title.trim(), sha256: source.sha256, asOf: source.asOf };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ provenance, rows })));
  const reviewToken = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const changed = rows.filter((r) => r.previous !== r.date || r.previousNumber !== r.controllerNumber);
  if (body.action === 'preview')
    return {
      kind: 'master-seniority',
      reviewToken,
      changed: changed.length,
      unchanged: rows.length - changed.length,
      rows,
    };
  if (body.reviewToken !== reviewToken) throw new ApiError('Revisa de nuevo las fichas antes de guardar', 409);
  if (!changed.length) return { kind: 'master-seniority', updated: 0, unchanged: rows.length };
  const ops: Statement[] = [];
  for (const row of changed) {
    const token = crypto.randomUUID();
    ops.push(
      {
        sql: 'UPDATE people SET seniority=?,controller_number=?,version=version+1 WHERE id=? AND seniority=? AND controller_number IS ? AND version=? AND active=1',
        args: [row.date, row.controllerNumber, row.personId, row.previous, row.previousNumber, row.version],
      },
      {
        sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
        args: [token],
      },
      { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
    );
  }
  ops.push(
    append({
      id: crypto.randomUUID(),
      actor: actor.id,
      action: 'master_seniority',
      before: {
        format: 'master-seniority-v1',
        rows: changed.map((r) => ({
          personId: r.personId,
          date: r.previous,
          controllerNumber: r.previousNumber,
          version: r.version,
        })),
      },
      after: {
        format: 'master-seniority-v1',
        source: provenance,
        rows: changed.map(({ previous, previousNumber, version, ...r }) => r),
      },
      createdAt: new Date().toISOString(),
    }),
    { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
  );
  try {
    await repo.batch(ops);
  } catch (e) {
    // A concurrent load may have taken a number: the unique index rejects the whole batch.
    if (String(e).includes('transaction_assertions') || String(e).includes('controller_number'))
      throw new ApiError('Las fichas han cambiado; revisa de nuevo', 409);
    throw e;
  }
  return { kind: 'master-seniority', updated: changed.length, unchanged: rows.length - changed.length };
}
