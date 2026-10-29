import { requireVaAdmin, type Principal } from './permissions.ts';
import { type Repository, type Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';
import { vaCensus } from './va-census.ts';

/**
 * RRHH's daily VA places, loaded and corrected by CLI only (no screen edits them).
 * Each load replaces the year's whole calendar after a preview: a missing day has no
 * places, the same as an explicit 0, and no month gets special treatment.
 */
type Source = { title?: unknown; sha256?: unknown; receivedAt?: unknown };
type QuotaBody = {
  action?: string;
  year?: unknown;
  source?: Source;
  days?: unknown;
  reviewToken?: unknown;
};

const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
const daysIn = (year: number) => (new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365);

async function current(repo: Repository, year: number) {
  const [rows, sources] = await repo.batch([
    { sql: 'SELECT date,places FROM va_quotas WHERE year=? ORDER BY date', args: [year] },
    { sql: 'SELECT * FROM va_quota_sources WHERE year=?', args: [year] },
  ]);
  const days: Record<string, number> = Object.fromEntries(rows.results.map((r) => [r.date, r.places]));
  const s = sources.results[0];
  return {
    days,
    version: s?.version ?? 0,
    source: s ? { title: s.title, sha256: s.sha256, receivedAt: s.received_at, updatedAt: s.updated_at } : null,
  };
}

const summary = (year: number, days: Record<string, number>) => {
  const places = Object.values(days);
  return {
    totalPlaces: places.reduce((a, b) => a + b, 0),
    daysWithPlaces: places.filter((p) => p > 0).length,
    daysWithoutPlaces: daysIn(year) - places.filter((p) => p > 0).length,
  };
};

/** The year's calendar as loaded, for the CLI and the VA administrator's panel. */
export async function vaQuotas(repo: Repository, actor: Principal, year: number) {
  requireVaAdmin(actor);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError('Indica un año válido');
  const now = await current(repo, year);
  return { year, ...now, ...summary(year, now.days) };
}

function validate(body: QuotaBody) {
  const year = body.year;
  if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2100)
    throw new ApiError('Indica el año de las VA');
  const source = body.source ?? {};
  if (
    typeof source.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 160 ||
    typeof source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    typeof source.receivedAt !== 'string' ||
    !isoDay(source.receivedAt)
  )
    throw new ApiError('Indica título, SHA-256 y fecha de recepción del calendario de RRHH');
  const raw = body.days;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('Indica los días con sus plazas');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 366) throw new ApiError('Hay más días que en un año');
  const days: Record<string, number> = {};
  for (const [date, places] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!isoDay(date) || !date.startsWith(year + '-')) throw new ApiError('Fecha fuera del año ' + year + ': ' + date);
    if (!Number.isInteger(places) || (places as number) < 0 || (places as number) > 99)
      throw new ApiError('Plazas no válidas el ' + date);
    days[date] = places as number;
  }
  return {
    year: year as number,
    source: { title: source.title.trim(), sha256: source.sha256, receivedAt: source.receivedAt },
    days,
  };
}

/** Preview, then apply with the preview's token, a full replacement of the year's calendar. */
export async function loadVaQuotas(repo: Repository, actor: Principal, body: QuotaBody) {
  requireVaAdmin(actor);
  if (!['preview', 'apply'].includes(body?.action ?? '')) throw new ApiError('Acción no válida: preview o apply');
  const { year, source, days } = validate(body);
  const before = await current(repo, year);
  const dates = new Set([...Object.keys(before.days), ...Object.keys(days)]);
  const changed = [...dates]
    .sort()
    .filter((d) => (before.days[d] ?? 0) !== (days[d] ?? 0))
    .map((date) => ({ date, before: before.days[date] ?? 0, after: days[date] ?? 0 }));
  const census = await vaCensus(repo, actor);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ year, source, days, version: before.version })),
  );
  const reviewToken = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const report = {
    kind: 'va-quotas',
    year,
    source,
    ...summary(year, days),
    // Only comparable when the census is of the same year.
    entitledDays: census.year === year ? census.totalDays : null,
    previous: before.source ? { ...before.source, ...summary(year, before.days) } : null,
    changedDays: changed.length,
    changes: changed.slice(0, 60),
  };
  if (body.action === 'preview') return { ...report, reviewToken };
  if (body.reviewToken !== reviewToken) throw new ApiError('Revisa de nuevo el calendario antes de aplicarlo', 409);
  const token = crypto.randomUUID(),
    at = new Date().toISOString();
  const ops: Statement[] = [
    before.version
      ? {
          sql: 'UPDATE va_quota_sources SET title=?,sha256=?,received_at=?,version=version+1,updated_at=? WHERE year=? AND version=?',
          args: [source.title, source.sha256, source.receivedAt, at, year, before.version],
        }
      : {
          sql: 'INSERT INTO va_quota_sources(year,title,sha256,received_at,version,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(year) DO NOTHING',
          args: [year, source.title, source.sha256, source.receivedAt, at],
        },
    {
      sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
      args: [token],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
    { sql: 'DELETE FROM va_quotas WHERE year=?', args: [year] },
    ...Object.entries(days).map(([date, places]) => ({
      sql: 'INSERT INTO va_quotas(year,date,places) VALUES(?,?,?)',
      args: [year, date, places],
    })),
    // Check the current election inside the transaction, including choices made
    // since this preview: corrections cannot invalidate an already allocated day.
    {
      sql: `INSERT INTO transaction_assertions(id) VALUES(CASE WHEN NOT EXISTS(
        SELECT 1 FROM va_campaigns v JOIN json_each(v.json,'$.choices') j
        WHERE v.year=? GROUP BY json_extract(j.value,'$.date')
        HAVING COUNT(*)>COALESCE((SELECT q.places FROM va_quotas q WHERE q.year=v.year
          AND q.date=json_extract(j.value,'$.date')),0)
      ) THEN ? ELSE NULL END)`,
      args: [year, token],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
    append({
      id: crypto.randomUUID(),
      actor: actor.id,
      action: 'va_quotas',
      before: { source: before.source, version: before.version },
      after: { source, changes: changed },
      createdAt: at,
    }),
    { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
  ];
  try {
    await repo.batch(ops);
  } catch (e) {
    if (String(e).includes('transaction_assertions'))
      throw new ApiError('El calendario cambió mientras tanto; revisa de nuevo', 409);
    throw e;
  }
  return { ...report, applied: true };
}
