import {winterExtraExceeded} from '../domain/winter-extras.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationQuotas } from '../domain/quotas.ts';
const params = { people: 16, necessary: 96, baseTotal: 90, minimum: 1, base: 2, maximum: 3, graceJanuary: 0, graceOctober: 0 };
test('S crece con el tercer cupo y revierte al base cuando se agotan los extras', () => { const periods = [...Array(19).fill(0), ...Array(14).fill(1), ...Array(12).fill(2)]; let u = Array(45).fill(2); u[0] = 3; let q = relationQuotas(periods, u, params); assert.equal(q[0].max, 3); assert.ok(q[1].available); for (let i = 0; i < 7; i++)
    u[i] = 3; q = relationQuotas(periods, u, params); assert.equal(q[0].max, 2); assert.ok(!q[7].available); });
test('Verano aplica G3 y Z3 del original', () => { const periods = [...Array(19).fill(0), ...Array(14).fill(1), ...Array(12).fill(2)], u = Array(45).fill(2); for (let i = 19; i < 23; i++)
    u[i] = 3; const q = relationQuotas(periods, u, params); assert.ok(!q[23].available); assert.ok(q[23].max === 2); });
test('AA1 conserva el límite U5:U49, también si se habilita N50', () => { const periods = Array(46).fill(0), u = Array(46).fill(0); u[45] = 200; assert.ok(relationQuotas(periods, u, params)[0].available); });

test('convenio compartido no permite gastar graciables de octubre en enero',()=>{
 const setup={commonConvention:true,commonGrace:false,grace:[1,0,1]};
 const convention=[20,8,20];
 const invalid=(jan:number,oct:number)=>winterExtraExceeded(setup,20,convention,[jan,0,oct]);
 assert.equal(invalid(20,0),false);
 assert.equal(invalid(21,0),false);
 assert.equal(invalid(22,0),true);
 assert.equal(invalid(20,2),false); // One grace from each period.
 assert.equal(invalid(21,1),false);
 assert.equal(invalid(21,2),true);
 // Only when grace is also explicitly common can both allowances be
 // consumed in the first period.
 assert.equal(winterExtraExceeded({...setup,commonGrace:true},20,convention,[22,0,0]),false);
});

test('graciables compartidos con convenio separado and ambos límites separados',()=>{
 const convention=[8,8,12],grace=[1,0,1];
 const common={commonConvention:false,commonGrace:true,grace};
 assert.equal(winterExtraExceeded(common,20,convention,[9,0,13]),false);
 assert.equal(winterExtraExceeded(common,20,convention,[10,0,13]),true);
 const separated={...common,commonGrace:false};
 assert.equal(winterExtraExceeded(separated,20,convention,[9,0,13]),false);
 assert.equal(winterExtraExceeded(separated,20,convention,[10,0,12]),true);
});
