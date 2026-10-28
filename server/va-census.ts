import { canAdminVa, requireVaAdmin, type Principal } from './permissions.ts';
import { type Repository } from './repository.ts';
import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';
import { vaDays, vaFirstYear, vaYears } from '../domain/va-entitlement.ts';

/**
 * Census for vacaciones de antigüedad (VA): the people of the year's live ordinary
 * campaigns, with seniority and access read from their master records. People outside
 * the eight teams are not modelled yet and will be added by CLI.
 */
export type VaStatus = 'entitled' | 'not_entitled' | 'missing_date';
export type VaRow = {
  personId: string;
  team: string;
  code: string;
  label: string;
  hrName: string | null;
  seniority: string | null;
  controllerNumber: number | null;
  years: number | null;
  days: number;
  status: VaStatus;
  account: { provider: 'chatgpt' | 'firebase'; subject: string; version: number } | null;
};

/** Year of the latest live ordinary campaigns: VA are chosen right after them. */
export async function vaYear(repo: Repository): Promise<number | null> {
  const rows = await repo.all("SELECT MAX(year) AS year FROM campaigns WHERE scope_key='live'");
  return rows[0]?.year ?? null;
}

function account(key: string | null | undefined, version: number): VaRow['account'] {
  if (!key) return null;
  if (key.startsWith('chatgpt-email:'))
    return { provider: 'chatgpt', subject: key.slice('chatgpt-email:'.length), version };
  if (key.startsWith('firebase:')) return { provider: 'firebase', subject: key.slice('firebase:'.length), version };
  // Legacy stable-subject links still sign in: show them as linked, not as an email.
  return { provider: 'chatgpt', subject: '', version };
}

async function rows(repo: Repository, year: number): Promise<VaRow[]> {
  const people = await repo.all(
    `SELECT DISTINCT p.id,c.team_id,m.code,m.label,p.seniority,p.controller_number,
       a.principal_key,a.version AS account_version,h.hr_name
     FROM campaigns c
     JOIN campaign_members m ON m.campaign_id=c.id
     JOIN people p ON p.id=m.person_id AND p.active=1
     LEFT JOIN controller_accounts a ON a.person_id=p.id
     LEFT JOIN hr_names h ON h.person_id=p.id AND h.year=c.year
     WHERE c.scope_key='live' AND c.year=?
     ORDER BY c.team_id,m.position,m.code`,
    [year],
  );
  return people.map((p) => {
    const years = vaYears(p.seniority, year),
      days = vaDays(years);
    return {
      personId: p.id,
      team: p.team_id,
      code: p.code,
      label: p.label ?? '',
      hrName: p.hr_name ?? null,
      seniority: p.seniority || null,
      controllerNumber: p.controller_number ?? null,
      years,
      days,
      status: years === null ? 'missing_date' : days ? 'entitled' : 'not_entitled',
      account: account(p.principal_key, p.account_version ?? 0),
    };
  });
}

/** Everyone entitled or with missing data, for the VA administrator; the rest only counted. */
export async function vaCensus(repo: Repository, actor: Principal) {
  requireVaAdmin(actor);
  const year = await vaYear(repo);
  if (!year) return { year: null, people: [], notEntitled: 0, totalDays: 0 };
  const all = await rows(repo, year);
  const people = all.filter((r) => r.status !== 'not_entitled');
  return {
    year,
    people,
    notEntitled: all.length - people.length,
    totalDays: people.reduce((sum, r) => sum + r.days, 0),
  };
}

/** The signed-in controller's own entitlement, read-only. */
export async function myVa(repo: Repository, actor: Principal) {
  const year = await vaYear(repo);
  const keys = [actor.id, actor.emailKey].filter((k): k is string => !!k);
  const admin = canAdminVa(actor);
  if (!year || !keys.length) return { year, admin, me: null };
  const linked = await repo.all(
    `SELECT person_id FROM controller_accounts WHERE principal_key IN (${keys.map(() => '?').join(',')})`,
    keys,
  );
  const ids = new Set(linked.map((r) => r.person_id));
  const me = (await rows(repo, year)).find((r) => ids.has(r.personId)) ?? null;
  return {
    year,
    admin,
    me: me && {
      code: me.code,
      seniority: me.seniority,
      controllerNumber: me.controllerNumber,
      years: me.years,
      days: me.days,
      status: me.status,
      firstYear: me.seniority ? vaFirstYear(me.seniority) : null,
    },
  };
}

/** Link, replace or remove the sign-in account of a census person. */
type LinkBody = { personId?: string; provider?: string; subject?: unknown; accountVersion?: number };
export async function vaLinkAccount(repo: Repository, actor: Principal, body: LinkBody) {
  requireVaAdmin(actor);
  const year = await vaYear(repo);
  const person = year && (await rows(repo, year)).find((r) => r.personId === body?.personId);
  if (!person || person.status === 'not_entitled') throw new ApiError('Esa persona no está en el censo de VA', 404);
  if ((person.account?.version ?? 0) !== body.accountVersion)
    throw new ApiError('La vinculación cambió. Recarga antes de guardar.', 409);
  const subject = String(body.subject ?? '').trim(),
    provider = body.provider ?? 'chatgpt',
    email = subject.toLowerCase();
  const isEmail =
    provider === 'chatgpt' &&
    /^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(email) &&
    email.length <= 250;
  const isFirebaseUid =
    provider === 'firebase' && subject.length <= 250 && subject.length > 0 && !/[\s\r\n:]/.test(subject);
  if ((subject && !isEmail && !isFirebaseUid) || !['chatgpt', 'firebase'].includes(provider))
    throw new ApiError('Introduce un correo válido de ChatGPT Sites o un UID de Firebase');
  const key = subject ? (provider === 'chatgpt' ? 'chatgpt-email:' + email : 'firebase:' + subject) : null;
  const token = crypto.randomUUID();
  const expected = body.accountVersion;
  const write = key
    ? expected
      ? {
          sql: 'UPDATE controller_accounts SET principal_key=?,version=version+1 WHERE person_id=? AND version=?',
          args: [key, person.personId, expected],
        }
      : {
          sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1) ON CONFLICT(person_id) DO NOTHING',
          args: [person.personId, key],
        }
    : { sql: 'DELETE FROM controller_accounts WHERE person_id=? AND version=?', args: [person.personId, expected] };
  try {
    await repo.batch([
      write,
      {
        sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
        args: [token],
      },
      { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
      append({
        id: crypto.randomUUID(),
        actor: actor.id,
        action: 'va_account',
        teamId: person.team,
        before: { personId: person.personId, account: person.account },
        after: { personId: person.personId, account: key },
        createdAt: new Date().toISOString(),
      }),
      { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
    ]);
  } catch (e) {
    if (String(e).includes('transaction_assertions'))
      throw new ApiError('La vinculación cambió. Recarga antes de guardar.', 409);
    throw e;
  }
  return { ok: true };
}

/** The «Antigüedad» menu entry: entitled participants and VA administrators only. */
export async function vaVisibility(repo: Repository, actor: Principal) {
  if (!actor.id) return { year: null, entry: false, admin: false };
  const { year, admin, me } = await myVa(repo, actor);
  return { year, entry: !!year && (admin || me?.status === 'entitled'), admin };
}
