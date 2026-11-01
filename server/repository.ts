import { logServerFailure, type DiagnosticContext } from './database-diagnostics.ts';

export type Statement = {
  sql: string;
  args?: unknown[];
};
export interface Repository {
  all<T = any>(sql: string, args?: unknown[]): Promise<T[]>;
  batch(statements: Statement[]): Promise<
    {
      results: any[];
    }[]
  >;
}
export class D1Repository implements Repository {
  constructor(
    private db: D1Database,
    private diagnostic?: DiagnosticContext,
  ) {}
  async all<T = any>(sql: string, args: unknown[] = []) {
    const started = performance.now();
    try {
      return (
        await this.db
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results;
    } catch (error) {
      if (this.diagnostic) logServerFailure(error, this.diagnostic, 'database_read', performance.now() - started);
      throw error;
    }
  }
  async batch(statements: Statement[]) {
    const started = performance.now();
    try {
      return await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...(s.args ?? []))));
    } catch (error) {
      if (this.diagnostic) logServerFailure(error, this.diagnostic, 'database_batch', performance.now() - started);
      throw error;
    }
  }
}
// D1 rejects any query with more than 100 bound parameters (SQLite allows far more).
export const D1_MAX_PARAMETERS = 100;
// Multi-row INSERTs split so each statement stays within D1's parameter limit.
export function insertRows(table: string, columns: string[], rows: unknown[][]): Statement[] {
  const size = Math.floor(D1_MAX_PARAMETERS / columns.length),
    ops: Statement[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    ops.push({
      sql: `INSERT INTO ${table}(${columns.join(',')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
      args: chunk.flat(),
    });
  }
  return ops;
}
export function cas(campaignId: string, version: number): Statement[] {
  const token = crypto.randomUUID();
  return [
    { sql: 'UPDATE campaigns SET version=version+1 WHERE id=? AND version=?', args: [campaignId, version] },
    { sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
  ];
}
export const tableColumns: Record<string, string[]> = {
  teams: ['id', 'name', 'version', 'kind'],
  people: ['id', 'team_id', 'code', 'label', 'position', 'seniority', 'active', 'version', 'controller_number'],
  users: ['id', 'provider', 'subject', 'role', 'version', 'va_admin'],
  grants: ['id', 'user_id', 'team_id', 'expires_at'],
  campaigns: [
    'id',
    'team_id',
    'year',
    'status',
    'version',
    'published_run_id',
    'data_kind',
    'scope_key',
    'simulation_name',
    'created_at',
  ],
  parameters: ['campaign_id', 'json', 'version'],
  campaign_members: ['id', 'campaign_id', 'person_id', 'code', 'label', 'position', 'seniority', 'version'],
  requests: ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'],
  runs: ['id', 'campaign_id', 'source_version', 'engine_version', 'result_json', 'created_by', 'created_at'],
  awards: ['id', 'campaign_id', 'member_id', 'cycle_date', 'version', 'selection_index', 'selection_round'],
  audit: ['id', 'actor', 'action', 'team_id', 'campaign_id', 'before_json', 'after_json', 'created_at'],
};

// Append dependents after their parent tables so backup restoration preserves foreign keys.
tableColumns.controller_accounts = ['person_id', 'principal_key', 'version'];
tableColumns.election_states = ['campaign_id', 'json'];
tableColumns.preferences = [
  'member_id',
  'campaign_id',
  'dates_json',
  'automatic',
  'persistent',
  'active',
  'mode',
  'wait_minutes',
  'labels_json',
];
tableColumns.reconstruction_sessions = ['campaign_id', 'json'];
tableColumns.hr_names = ['year', 'person_id', 'hr_name'];
tableColumns.va_quotas = ['year', 'date', 'places'];
tableColumns.va_quota_sources = ['year', 'title', 'sha256', 'received_at', 'version', 'updated_at'];
tableColumns.va_campaigns = ['year', 'version', 'json'];
tableColumns.va_election_history = [
  'id',
  'year',
  'action',
  'actor',
  'before_json',
  'after_json',
  'created_at',
  'undone',
];
tableColumns.va_reconstructions = ['year', 'working_json', 'steps_json', 'created_at', 'actor'];
tableColumns.va_external_people = [
  'id',
  'code',
  'label',
  'seniority',
  'controller_number',
  'category',
  'active',
  'version',
];
tableColumns.va_external_accounts = ['person_id', 'principal_key', 'version'];
