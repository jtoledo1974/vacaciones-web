import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRosterRows } from '../app/roster-rows.ts';

const make = (changes: Record<string, unknown> = {}) => ({
  memberId: 'member-1',
  code: 'JUAN',
  label: 'Juan',
  seniority: '',
  previousScore: '',
  provider: '',
  subject: '',
  legacyKey: undefined as string | undefined,
  ...changes,
});

test('confirmed server values clear an autosaved draft without duplicating changes', () => {
  const before = [make()],
    submitted = [make({ previousScore: '0250', subject: 'j@example.org', provider: 'chatgpt' })];
  const server = [make({ previousScore: '250', subject: 'j@example.org', provider: 'chatgpt' })];
  assert.deepEqual(reconcileRosterRows(before, server, submitted, submitted), server);
});

test('edits typed while a request is in flight survive a campaign refresh', () => {
  const before = [make()];
  const submitted = [make({ label: 'Juan A', previousScore: '120' })];
  const draft = [make({ label: 'Juan AB', previousScore: '120', subject: 'j@example.org', provider: 'chatgpt' })];
  const server = [make({ label: 'Juan A', previousScore: '120' })];
  assert.deepEqual(reconcileRosterRows(before, server, draft, submitted), [
    make({ label: 'Juan AB', previousScore: '120', subject: 'j@example.org', provider: 'chatgpt' }),
  ]);
});

test('newly created member gains persisted ID while retaining newer field edits', () => {
  const first = make({ memberId: undefined, code: 'NEW', label: 'First' });
  const submitted = [make(), first];
  const draft = [make(), { ...first, label: 'First updated' }, make({ memberId: undefined, code: '', label: '' })];
  const server = [make(), make({ memberId: 'member-2', code: 'NEW', label: 'First' })];
  assert.deepEqual(reconcileRosterRows([make()], server, draft, submitted), [
    make(),
    make({ memberId: 'member-2', code: 'NEW', label: 'First updated' }),
    draft[2],
  ]);
});

test('unmodified fields take the latest server values; removed members are not restored', () => {
  const before = [make(), make({ memberId: 'member-2', code: 'BOB', label: 'Bob' })];
  const draft = [...before.map((r) => ({ ...r }))];
  assert.deepEqual(reconcileRosterRows(before, [make({ label: 'Juan changed remotely' })], draft), [
    make({ label: 'Juan changed remotely' }),
  ]);
});
