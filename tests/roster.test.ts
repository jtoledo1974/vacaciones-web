import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoster } from '../server/roster.ts';
import { defaultConfig } from '../domain/defaults.ts';
test('nicks Unicode y antigüedad desconocida no se inventan', () => {
  const r = validateRoster(
    [{ code: 'PEÑA', label: 'Nombre de prueba', seniority: '' }],
    2026,
    'C',
    defaultConfig(2026),
  );
  assert.equal(r[0].code, 'PEÑA');
  assert.equal(r[0].seniority, '');
});
test('plantilla rechaza duplicados y fechas fuera de los ciclos', () => {
  assert.throws(
    () =>
      validateRoster(
        [
          { code: 'A', label: '' },
          { code: 'a', label: '' },
        ],
        2026,
        'C',
        defaultConfig(2026),
      ),
    /repetido/,
  );
  assert.throws(
    () => validateRoster([{ code: 'A', label: '', dates: ['2026-01-01'] }], 2026, 'C', defaultConfig(2026)),
    /ciclo/,
  );
});
