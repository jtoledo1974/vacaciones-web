// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
import { sqliteTable, text, integer, uniqueIndex, primaryKey, index } from 'drizzle-orm/sqlite-core';
export const teams = sqliteTable('teams', { id: text('id').primaryKey(), name: text('name').notNull(), version: integer('version').notNull().default(1) });
export const people = sqliteTable('people', { id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), code: text('code').notNull(),label:text('label').notNull().default(''),position:integer('position').notNull().default(0), seniority: text('seniority').notNull(), active:integer('active').notNull().default(1),version: integer('version').notNull().default(1), controllerNumber: integer('controller_number') }, t => [uniqueIndex('person_team_code').on(t.teamId, t.code), uniqueIndex('person_controller_number').on(t.controllerNumber)]);
export const users = sqliteTable('users', { id: text('id').primaryKey(), provider: text('provider').notNull(), subject: text('subject').notNull(), role: text('role').notNull(), version: integer('version').notNull().default(1), vaAdmin: integer('va_admin').notNull().default(0) }, t => [uniqueIndex('identity_unique').on(t.provider, t.subject)]);
export const grants = sqliteTable('grants', { id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), teamId: text('team_id').notNull().references(() => teams.id), expiresAt: text('expires_at') }, t => [uniqueIndex('grant_unique').on(t.userId, t.teamId)]);
export const campaigns = sqliteTable('campaigns', { id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), year: integer('year').notNull(),scopeKey:text('scope_key').notNull().default('live'),simulationName:text('simulation_name').notNull().default(''), status: text('status').notNull().default('open'), version: integer('version').notNull().default(1), publishedRunId: text('published_run_id'),dataKind:text('data_kind').notNull().default('demo'), createdAt: text('created_at').notNull() }, t => [uniqueIndex('campaign_team_year_scope').on(t.teamId, t.year,t.scopeKey)]);
export const parameters = sqliteTable('parameters', { campaignId: text('campaign_id').primaryKey().references(() => campaigns.id), json: text('json').notNull(), version: integer('version').notNull().default(1) });
export const members = sqliteTable('campaign_members', { id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id), personId: text('person_id').notNull().references(() => people.id), code: text('code').notNull(),label:text('label').notNull().default(''),position:integer('position').notNull().default(0), seniority: text('seniority').notNull(), version: integer('version').notNull().default(1) }, t => [uniqueIndex('campaign_person').on(t.campaignId, t.personId)]);
export const requests = sqliteTable('requests', { id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id), memberId: text('member_id').notNull().references(() => members.id), slot: integer('slot').notNull(), cycleDate: text('cycle_date').notNull(), version: integer('version').notNull().default(1) }, t => [uniqueIndex('request_slot').on(t.campaignId, t.memberId, t.slot)]);
export const runs = sqliteTable('runs', { id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id), sourceVersion: integer('source_version').notNull(), engineVersion: text('engine_version').notNull(), resultJson: text('result_json').notNull(), createdBy: text('created_by').notNull(), createdAt: text('created_at').notNull() });
export const awards = sqliteTable('awards', { id: text('id').primaryKey(), campaignId: text('campaign_id').notNull().references(() => campaigns.id), memberId: text('member_id').notNull().references(() => members.id), cycleDate: text('cycle_date').notNull(), version: integer('version').notNull().default(1), selectionIndex: integer('selection_index'), selectionRound: integer('selection_round') }, t => [uniqueIndex('award_unique').on(t.campaignId, t.memberId, t.cycleDate)]);
export const audit = sqliteTable('audit', { id: text('id').primaryKey(), actor: text('actor').notNull(), action: text('action').notNull(), teamId: text('team_id'), campaignId: text('campaign_id'), beforeJson: text('before_json'), afterJson: text('after_json'), createdAt: text('created_at').notNull() }, t => [index('audit_campaign').on(t.campaignId)]);
export const assertions = sqliteTable('transaction_assertions', { id: text('id').primaryKey() });
export const state = sqliteTable('app_state', { id: text('id').primaryKey(), revision: integer('revision').notNull().default(0) });
export const electionStates=sqliteTable('election_states',{campaignId:text('campaign_id').primaryKey().references(()=>campaigns.id),json:text('json').notNull()});
export const preferences=sqliteTable('preferences',{memberId:text('member_id').primaryKey().references(()=>members.id),campaignId:text('campaign_id').notNull().references(()=>campaigns.id),datesJson:text('dates_json').notNull(),automatic:integer('automatic').notNull().default(0),persistent:integer('persistent').notNull().default(0),active:integer('active').notNull().default(1),mode:text('mode').notNull().default('immediate'),waitMinutes:integer('wait_minutes').notNull().default(0),labelsJson:text('labels_json').notNull().default('{}')});
export const controllerAccounts=sqliteTable('controller_accounts',{personId:text('person_id').primaryKey().references(()=>people.id),principalKey:text('principal_key').notNull(),version:integer('version').notNull().default(1)},t=>[uniqueIndex('controller_account_identity').on(t.principalKey)]);



export const pushSubscriptions=sqliteTable('push_subscriptions',{endpoint:text('endpoint').primaryKey(),ownerKey:text('owner_key').notNull(),p256dh:text('p256dh').notNull(),auth:text('auth').notNull(),createdAt:text('created_at').notNull()});
export const turnNotifications=sqliteTable('turn_notifications',{id:text('id').primaryKey(),ownerKey:text('owner_key').notNull(),campaignId:text('campaign_id').notNull(),memberId:text('member_id').notNull(),round:integer('round').notNull(),createdAt:text('created_at').notNull(),pushStatus:text('push_status').notNull().default('pending')});

export const pushDeliveries=sqliteTable('push_deliveries',{eventId:text('event_id').notNull(),endpoint:text('endpoint').notNull(),status:text('status').notNull().default('pending'),leaseToken:text('lease_token'),leaseExpiresAt:integer('lease_expires_at').notNull().default(0),attempts:integer('attempts').notNull().default(0)},t=>[primaryKey({columns:[t.eventId,t.endpoint]})]);

// A controller's private what-if: readable only by its owner, never by the election engine.
export const personalSimulations=sqliteTable('personal_simulations',{ownerKey:text('owner_key').notNull(),campaignId:text('campaign_id').notNull(),memberId:text('member_id').notNull(),json:text('json').notNull(),updatedAt:text('updated_at').notNull()},t=>[primaryKey({columns:[t.ownerKey,t.campaignId]})]);

// Administrative reconstruction state is never part of publicly readable election data.
export const reconstructionSessions=sqliteTable('reconstruction_sessions',{campaignId:text('campaign_id').primaryKey().references(()=>campaigns.id),json:text('json').notNull()});

// Local admin sessions and throttled login attempts: expiring security state, never backed up.
export const localAdminSessions=sqliteTable('local_admin_sessions',{id:text('id').primaryKey(),actor:text('actor').notNull(),createdAt:text('created_at').notNull(),expiresAt:integer('expires_at').notNull(),revokedAt:text('revoked_at')});
export const localAdminAttempts=sqliteTable('local_admin_attempts',{id:text('id').primaryKey(),attemptKey:text('attempt_key').notNull(),createdAt:text('created_at').notNull()},t=>[index('local_admin_attempt_key').on(t.attemptKey,t.createdAt)]);

export const cliSessions = sqliteTable('cli_sessions', {
  pairingHash: text('pairing_hash').primaryKey(), tokenHash: text('token_hash').unique(), ownerKey: text('owner_key'),
  identityJson: text('identity_json'), scopeJson: text('scope_json'), status: text('status').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => [index('cli_sessions_expiry').on(t.expiresAt)]);
export const cliAttempts = sqliteTable('cli_attempts', {
  attemptKey: text('attempt_key').primaryKey(), attempts: integer('attempts').notNull(), expiresAt: integer('expires_at').notNull(),
});

// RRHH's yearly workbook, kept out of the repository (it lists real employees); see server/hr-xlsx.ts.
export const hrTemplates=sqliteTable('hr_templates',{year:integer('year').primaryKey(),data:text('data').notNull(),sha256:text('sha256').notNull(),uploadedBy:text('uploaded_by').notNull(),uploadedAt:text('uploaded_at').notNull()});
// Each person's name exactly as column J of their team sheet spells it.
export const hrNames=sqliteTable('hr_names',{year:integer('year').notNull(),personId:text('person_id').notNull().references(()=>people.id),hrName:text('hr_name').notNull()},t=>[primaryKey({columns:[t.year,t.personId]})]);
