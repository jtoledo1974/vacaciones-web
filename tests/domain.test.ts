import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar, easter, iso, leap, serial, holidayDates,rotationCode } from '../domain/calendar.ts';
import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { calculate } from '../domain/vacations.ts';
import ref from './excel-reference.json' with { type: 'json' };
test('45 fechas y baremos contra valores guardados del Excel original', () => { const actual = calendar(2026, 'C', defaultConfig(2026)).map(({ date, score }) => ({ date, score })); assert.deepEqual(actual, ref.cycles); });
test('Pascua y regla +18 de Feria conservadas', () => { assert.equal(iso(easter(2026)), '2026-04-05'); assert.equal(holidayDates(2026, defaultConfig(2026)).find(h => h.label.startsWith('Miércoles'))?.date, '2026-04-23'); });
test('Bisiestos, siglos y UTC', () => { assert.ok(leap(2028)); assert.ok(!leap(2100)); assert.ok(leap(2000)); assert.throws(() => serial('2026-02-29')); assert.equal(iso(serial('2028-02-29')), '2028-02-29'); });
test('8 equipos por 15 ejercicios, sin ciclos duplicados', () => { for (let y = 2026; y <= 2040; y++)
    for (const t of 'ABCDEFGH') {
        const cycles = calendar(y, t, defaultConfig(y));
        assert.equal(cycles.length, 45);
        assert.equal(new Set(cycles.map(c => c.date)).size, 45);
        for (let i = 1; i < 45; i++)
            assert.ok(serial(cycles[i].date) - serial(cycles[i - 1].date) === 8 || serial(cycles[i].date) - serial(cycles[i - 1].date) === 9);
    } });
test('copiar parámetros no altera el original ni copia adjudicaciones', () => { const c = defaultConfig(2026), before = JSON.stringify(c), n = copyConfig(c, 2026, 2027); assert.equal(JSON.stringify(c), before); assert.equal(n.summerStart, '2027-06-01'); assert.ok(!('awards' in n)); });
test('Baremo ponderado, menor puntuación y antigüedad primero', () => { const c = defaultConfig(2026); const members = [{ id: 'a', code: 'A01', seniority: '2010-01-01' }, { id: 'b', code: 'A02', seniority: '2000-01-01' }]; const r = calculate(2026, 'C', c, members, [{ id: '1', member_id: 'a', slot: 1, cycle_date: '2026-01-07' }, { id: '2', member_id: 'b', slot: 1, cycle_date: '2026-01-07' }], []); assert.equal(r.ordering[0].id, 'b'); assert.equal(r.ordering[0].score, 24); });
test('Frontera de rotación bisiesta usa el ciclo CT del original',()=>{for(const y of [2028,2032])for(const t of 'ABCDEFGH'){const c=defaultConfig(y);c.correturnos=String(y)+'-01-01';const ct=calendar(y,t,c).find(s=>s.correturnos);assert.ok(ct);const boundary=serial(ct.date)+7,after=(Math.floor(y/4)%8+'ABCDEFGH'.indexOf(t))%8,before=(after+7)%8;assert.equal(rotationCode(boundary-1,y,t,c),c.rotation[(boundary-1)%8][before]);assert.equal(rotationCode(boundary,y,t,c),c.rotation[boundary%8][after]);}});
