import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationQuotas } from '../domain/quotas.ts';
const params = {
  people: 16,
  necessary: 96,
  baseTotal: 90,
  minimum: 1,
  base: 2,
  maximum: 3,
  graceJanuary: 0,
  graceOctober: 0,
};
test('S crece con el tercer cupo y revierte al base cuando se agotan los extras', () => {
  const periods = [...Array(19).fill(0), ...Array(14).fill(1), ...Array(12).fill(2)];
  let u = Array(45).fill(2);
  u[0] = 3;
  let q = relationQuotas(periods, u, params);
  assert.equal(q[0].max, 3);
  assert.ok(q[1].available);
  for (let i = 0; i < 7; i++) u[i] = 3;
  q = relationQuotas(periods, u, params);
  assert.equal(q[0].max, 2);
  assert.ok(!q[7].available);
});
test('Verano aplica G3 y Z3 del original', () => {
  const periods = [...Array(19).fill(0), ...Array(14).fill(1), ...Array(12).fill(2)],
    u = Array(45).fill(2);
  for (let i = 19; i < 23; i++) u[i] = 3;
  const q = relationQuotas(periods, u, params);
  assert.ok(!q[23].available);
  assert.ok(q[23].max === 2);
});
test('AA1 conserva el límite U5:U49, también si se habilita N50', () => {
  const periods = Array(46).fill(0),
    u = Array(46).fill(0);
  u[45] = 200;
  assert.ok(relationQuotas(periods, u, params)[0].available);
});
