export type Statement = {
    sql: string;
    args?: unknown[];
};
export interface Repository {
    all<T = any>(sql: string, args?: unknown[]): Promise<T[]>;
    batch(statements: Statement[]): Promise<{
        results: any[];
    }[]>;
}
export class D1Repository implements Repository {
    constructor(private db: D1Database) { }
    async all<T = any>(sql: string, args: unknown[] = []) { return (await this.db.prepare(sql).bind(...args).all<T>()).results; }
    async batch(statements: Statement[]) { return this.db.batch(statements.map(s => this.db.prepare(s.sql).bind(...(s.args ?? [])))); }
}
export function cas(campaignId: string, version: number): Statement[] { const token = crypto.randomUUID(); return [{ sql: 'UPDATE campaigns SET version=version+1 WHERE id=? AND version=?', args: [campaignId, version] }, { sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)', args: [token] }, { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] }]; }
export const tableColumns: Record<string, string[]> = { teams: ['id', 'name', 'version'], people: ['id', 'team_id', 'code', 'label', 'position', 'seniority', 'active', 'version'], users: ['id', 'provider', 'subject', 'role', 'version'], grants: ['id', 'user_id', 'team_id', 'expires_at'], campaigns: ['id', 'team_id', 'year', 'status', 'version', 'published_run_id', 'data_kind', 'scope_key','simulation_name', 'created_at'], parameters: ['campaign_id', 'json', 'version'], campaign_members: ['id', 'campaign_id', 'person_id', 'code', 'label', 'position', 'seniority', 'version'], requests: ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'], runs: ['id', 'campaign_id', 'source_version', 'engine_version', 'result_json', 'created_by', 'created_at'], awards: ['id', 'campaign_id', 'member_id', 'cycle_date', 'version'], audit: ['id', 'actor', 'action', 'team_id', 'campaign_id', 'before_json', 'after_json', 'created_at'] };



// Append dependents after their parent tables so backup restoration preserves foreign keys.
tableColumns.controller_accounts=['person_id','principal_key','version'];
tableColumns.election_states=['campaign_id','json'];
tableColumns.preferences=['member_id','campaign_id','dates_json','automatic','persistent','active'];

