import assert from 'node:assert/strict';
import test from 'node:test';
import { policyFor, occupancyFor } from '../domain/policy.ts';
import { OCCUPANCY_POLICY_2027 } from '../domain/policy-2027.ts';
import { hrCalendar, grantsIndividualEntitlements } from '../domain/hr-calendars.ts';
import { defaultConfig } from '../domain/defaults.ts';

test('years without an occupancy engine use legacy quotas and the configured entitlement', () => {
  assert.equal(occupancyFor(2026), null);
  const config = defaultConfig(2026);
  assert.equal(policyFor(2026).entitlement(config, { code: 'X' }), config.cyclesPerPerson);
  assert.equal(hrCalendar(2026, 'A'), null);
  assert.equal(grantsIndividualEntitlements(2026), false);
});

test('2027 resolves to the LECS occupancy engine and its RRHH calendar', () => {
  const rules = occupancyFor(2027);
  assert.equal(rules?.version, OCCUPANCY_POLICY_2027);
  // Changing a budget changes which proofs finish, so it is a policy decision.
  assert.deepEqual(rules?.budgets, {
    commit: 2000,
    options: { total: 256, perCandidate: 32 },
    review: 500,
    early: { total: 2000, perCandidate: 32, deadlineMs: 1000 },
  });
  const config = {
    ...defaultConfig(2027),
    individualEntitlements: { X: { cycles: 4, authorization: 'Resolución RRHH' } },
  };
  assert.equal(policyFor(2027).entitlement(config, { code: 'X' }), 4);
  assert.equal(policyFor(2027).entitlement(config, { code: 'Y' }), config.cyclesPerPerson);
  assert.equal(rules!.cycleMaximum({ year: 2027, team: 'A', config }, '2027-03-21'), 3);
  assert.equal(rules!.cycleMaximum({ year: 2027, team: 'A', config }, '2027-03-29'), 4);
  assert.equal(hrCalendar(2027, 'A')?.count, 45);
  assert.equal(hrCalendar(2027, 'A')?.period('2027-07-01'), 1);
  assert.equal(grantsIndividualEntitlements(2027), true);
});
