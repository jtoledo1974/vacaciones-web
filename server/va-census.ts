import { VA_TEAM, ordinaryCampaign } from './teams.ts';
import { canAdminVa, canWrite, requireVaAdmin, type Principal } from './permissions.ts';
import { type Repository } from './repository.ts';
import { ApiError } from './errors.ts';
import { append } from './audit-context.ts';
import { vaDays, vaFirstYear, vaYears } from '../domain/va-entitlement.ts';
import type { VaElection } from '../domain/va-election.ts';

/**
 * Census for vacaciones de antigüedad (VA): the people of the year's live ordinary
 * campaigns plus external people added by CLI, with seniority and access read from
 * their master records. Open elections use their frozen participants for myVa.
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
  const rows = await repo.all(
    `SELECT MAX(year) AS year FROM (SELECT year FROM campaigns WHERE scope_key='live' AND ${ordinaryCampaign()} UNION SELECT year FROM va_campaigns)`,
  );
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

/** Everyone in the year's census, entitled or not, from the master records. */
export async function vaCensusRows(repo: Repository, year: number): Promise<VaRow[]> {
  const people = await repo.all(
    `SELECT DISTINCT p.id,c.team_id,m.code,m.label,p.seniority,p.controller_number,
       a.principal_key,a.version AS account_version,h.hr_name
     FROM campaigns c
     JOIN campaign_members m ON m.campaign_id=c.id
     JOIN people p ON p.id=m.person_id AND p.active=1
     LEFT JOIN controller_accounts a ON a.person_id=p.id
     LEFT JOIN hr_names h ON h.person_id=p.id AND h.year=c.year
     WHERE c.scope_key='live' AND c.year=? AND ${ordinaryCampaign('c')}
     ORDER BY c.team_id,m.position,m.code`,
    [year],
  );
  people.push(
    ...(await repo.all(
      `SELECT p.id,'' AS team_id,p.code,p.label,p.seniority,p.controller_number,
    a.principal_key,a.version AS account_version,NULL AS hr_name
    FROM people p LEFT JOIN controller_accounts a ON a.person_id=p.id WHERE p.team_id=? AND p.active=1 ORDER BY p.controller_number`,
      [VA_TEAM],
    )),
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
  if (!year) return { year: null, people: [], notEntitled: 0, totalDays: 0, quotas: null };
  const all = await vaCensusRows(repo, year);
  const people = all.filter((r) => r.status !== 'not_entitled');
  // RRHH's places are loaded by CLI (server/va-quotas.ts); the panel only shows them.
  const [source] = await repo.all(
    `SELECT s.title,s.received_at,s.updated_at,
       (SELECT COALESCE(SUM(places),0) FROM va_quotas q WHERE q.year=s.year) AS places,
       (SELECT COUNT(*) FROM va_quotas q WHERE q.year=s.year AND q.places>0) AS days
     FROM va_quota_sources s WHERE s.year=?`,
    [year],
  );
  return {
    year,
    people,
    notEntitled: all.length - people.length,
    totalDays: people.reduce((sum, r) => sum + r.days, 0),
    quotas: source
      ? {
          title: source.title as string,
          receivedAt: source.received_at as string,
          updatedAt: source.updated_at as string,
          places: Number(source.places),
          days: Number(source.days),
        }
      : null,
  };
}

/** The signed-in controller's own entitlement, read-only. */
export async function myVa(repo: Repository, actor: Principal, viewAs?: { team: string; code: string }) {
  const year = await vaYear(repo);
  const keys = [actor.id, actor.emailKey].filter((k): k is string => !!k);
  const admin = canAdminVa(actor);
  // «Ver como»: VA administrators for anyone, team administrators for their own team.
  if (viewAs && !admin && !canWrite(actor, viewAs.team))
    throw new ApiError('Solo la administración puede ver los días de VA de otra persona', 403);
  if (!year || (!keys.length && !viewAs)) return { year, admin, me: null };
  let census = await vaCensusRows(repo, year);
  const [campaign] = await repo.all<{ json: string }>('SELECT json FROM va_campaigns WHERE year=?', [year]);
  const frozen = campaign ? (JSON.parse(campaign.json) as VaElection) : null;
  if (frozen && frozen.status !== 'preparation') {
    // Identity links remain current, but a changed/inactive master record must not
    // change the entitlement or hide an already admitted participant.
    census = frozen.people.map(
      (p): VaRow => ({
        personId: p.id,
        team: p.team,
        code: p.code,
        label: p.label,
        hrName: null,
        seniority: p.seniority,
        controllerNumber: p.controllerNumber,
        years: vaYears(p.seniority, year),
        days: p.days,
        status: p.days > 0 ? 'entitled' : 'not_entitled',
        account: null,
      }),
    );
  }
  let me: VaRow | null;
  if (viewAs) me = census.find((r) => r.team === viewAs.team && r.code === viewAs.code) ?? null;
  else {
    const linked = await repo.all(
      `SELECT person_id FROM controller_accounts WHERE principal_key IN (${keys.map(() => '?').join(',')})`,
      keys,
    );
    const ids = new Set(linked.map((r) => r.person_id));
    me = census.find((r) => ids.has(r.personId)) ?? null;
  }
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
  const person = year && (await vaCensusRows(repo, year)).find((r) => r.personId === body?.personId);
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
          sql: `UPDATE controller_accounts SET principal_key=?,version=version+1 WHERE person_id=? AND version=?`,
          args: [key, person.personId, expected],
        }
      : {
          sql: `INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1) ON CONFLICT(person_id) DO NOTHING`,
          args: [person.personId, key],
        }
    : { sql: `DELETE FROM controller_accounts WHERE person_id=? AND version=?`, args: [person.personId, expected] };
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
        teamId: person.team || null,
        before: { personId: person.personId, account: person.account },
        after: { personId: person.personId, account: key },
        createdAt: new Date().toISOString(),
      }),
      { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
    ]);
  } catch (e) {
    if (/va_duplicate_account|UNIQUE/.test(String(e)))
      throw new ApiError('Esta cuenta ya está vinculada a otra persona', 409);
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
