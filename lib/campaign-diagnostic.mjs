// Shared scope contract. A diagnostic is NOT a full backup or a live restore input.
export const DIAGNOSTIC_FORMAT = 'vacaciones-campaign-diagnostic-v1';
export const DIAGNOSTIC_SCHEMA = 'vacaciones-schema-0023';
export const DIAGNOSTIC_MAX_BYTES = 24_000_000;
export const diagnosticTables = [
  'teams',
  'people',
  'users',
  'grants',
  'campaigns',
  'parameters',
  'campaign_members',
  'requests',
  'awards',
  'runs',
  'audit',
  'controller_accounts',
  'election_states',
  'preferences',
  'reconstruction_sessions',
  'app_state',
  'hr_names',
  'hr_templates',
  'va_campaigns',
];
// All identifiers/SQL are trusted constants; only campaignId is bound by callers.
export function diagnosticScope() {
  const team = "(SELECT team_id FROM campaigns WHERE id=? AND scope_key='live')";
  const year = "(SELECT year FROM campaigns WHERE id=? AND scope_key='live')";
  const people = `SELECT id FROM people WHERE team_id=${team} OR id IN (SELECT person_id FROM campaign_members WHERE campaign_id=?)`;
  const audit = `(campaign_id=? OR (campaign_id IS NULL AND team_id=${team}))`;
  return {
    teams: `id=${team} OR id IN (SELECT team_id FROM people WHERE id IN (${people}))`,
    people: `id IN (${people})`,
    users: `id IN (SELECT user_id FROM grants WHERE team_id=${team}) OR id IN (SELECT created_by FROM runs WHERE campaign_id=?)`,
    grants: `team_id=${team}`,
    campaigns: "id=? AND scope_key='live'",
    parameters: 'campaign_id=?',
    campaign_members: 'campaign_id=?',
    requests: 'campaign_id=?',
    awards: 'campaign_id=?',
    runs: 'campaign_id=?',
    audit,
    controller_accounts: `person_id IN (${people})`,
    election_states: 'campaign_id=?',
    preferences: 'campaign_id=?',
    reconstruction_sessions: 'campaign_id=?',
    app_state: "id='main'",
    hr_names: `year=${year} AND person_id IN (${people})`,
    hr_templates: `year=${year}`,
    // Needed by ordinary-election overlap guards. This is shared context, not another ordinary campaign.
    va_campaigns: `year IN (${year},${year}+1)`,
  };
}
export function diagnosticByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export async function diagnosticHash(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function assertDiagnosticShape(archive) {
  const p = archive?.payload;
  if (
    p?.format !== DIAGNOSTIC_FORMAT ||
    p.schemaVersion !== DIAGNOSTIC_SCHEMA ||
    typeof p.campaignId !== 'string' ||
    !p.campaignId ||
    !p.tables ||
    !p.columns ||
    JSON.stringify(Object.keys(p.tables).sort()) !== JSON.stringify([...diagnosticTables].sort()) ||
    JSON.stringify(Object.keys(p.columns).sort()) !== JSON.stringify([...diagnosticTables].sort())
  )
    throw new Error('Diagnóstico de campaña incompatible');
  for (const name of diagnosticTables) {
    if (
      !Array.isArray(p.tables[name]) ||
      !Array.isArray(p.columns[name]) ||
      p.columns[name].some((c) => typeof c !== 'string') ||
      new Set(p.columns[name]).size !== p.columns[name].length
    )
      throw new Error('Tablas o columnas inválidas');
    let previous = 0;
    for (const row of p.tables[name]) {
      if (
        !row ||
        !Number.isSafeInteger(row._rowid) ||
        row._rowid <= previous ||
        JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(['_rowid', ...p.columns[name]].sort()) ||
        Object.values(row).some(
          (v) => v !== null && (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string'),
        )
      )
        throw new Error('Fila inválida o desordenada: ' + name);
      previous = row._rowid;
    }
  }
  const campaigns = p.tables.campaigns;
  if (
    campaigns.length !== 1 ||
    campaigns[0].id !== p.campaignId ||
    campaigns[0].scope_key !== 'live' ||
    p.team !== campaigns[0].team_id ||
    p.year !== campaigns[0].year
  )
    throw new Error('Se requiere una única campaña real');
  if (p.tables.app_state.length !== 1 || p.tables.app_state[0].id !== 'main')
    throw new Error('Falta la revisión de aplicación');
  return p;
}
