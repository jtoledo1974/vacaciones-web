import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { compareCounts, summarizeResults, validateBaseline } from '../scripts/lint-ratchet.mjs';

const projectRoot = process.cwd();

test('cuenta únicamente errores ESLint por archivo y regla', () => {
  const counts = summarizeResults(
    [
      {
        filePath: join(projectRoot, 'app', 'a.ts'),
        fatalErrorCount: 0,
        messages: [
          { severity: 2, ruleId: '@typescript-eslint/no-explicit-any' },
          { severity: 2, ruleId: '@typescript-eslint/no-explicit-any' },
          { severity: 1, ruleId: '@typescript-eslint/no-unused-vars' },
          { severity: 2, ruleId: 'prefer-const' },
        ],
      },
      {
        filePath: join(projectRoot, 'server', 'b.ts'),
        fatalErrorCount: 0,
        messages: [{ severity: 2, ruleId: 'prefer-const' }],
      },
    ],
    projectRoot,
  );

  assert.deepEqual(counts, {
    'app/a.ts': { '@typescript-eslint/no-explicit-any': 2, 'prefer-const': 1 },
    'server/b.ts': { 'prefer-const': 1 },
  });
});

test('bloquea empeorar un archivo aunque el total de errores no cambie', () => {
  const { regressions, improvements } = compareCounts(
    { 'app/a.ts': { 'prefer-const': 2 }, 'app/b.ts': { 'prefer-const': 1 } },
    { 'app/a.ts': { 'prefer-const': 1 }, 'app/b.ts': { 'prefer-const': 2 } },
  );
  assert.deepEqual(regressions, [{ file: 'app/b.ts', rule: 'prefer-const', before: 1, after: 2 }]);
  assert.equal(improvements.length, 1);
});

test('bloquea nuevas reglas y archivos, sin bloquear las correcciones', () => {
  const { regressions, improvements } = compareCounts(
    { 'app/a.ts': { 'prefer-const': 3 } },
    {
      'app/a.ts': { 'prefer-const': 1, 'react-hooks/refs': 1 },
      'app/new.ts': { 'prefer-const': 1 },
    },
  );
  assert.equal(regressions.length, 2);
  assert.deepEqual(improvements, [{ file: 'app/a.ts', rule: 'prefer-const', before: 3, after: 1 }]);
});

test('acepta eliminar por completo un archivo con deuda', () => {
  assert.deepEqual(compareCounts({ 'app/old.ts': { 'prefer-const': 1 } }, {}), {
    regressions: [],
    improvements: [{ file: 'app/old.ts', rule: 'prefer-const', before: 1, after: 0 }],
  });
});

test('rechaza líneas base corruptas y errores fatales', () => {
  assert.throws(() => validateBaseline({ version: 1, errors: { 'a.ts': { rule: -1 } } }));
  assert.throws(() => validateBaseline({ version: 2, errors: {} }));
  assert.throws(() =>
    summarizeResults(
      [
        {
          filePath: join(projectRoot, 'a.ts'),
          fatalErrorCount: 1,
          messages: [],
        },
      ],
      projectRoot,
    ),
  );
  assert.throws(() =>
    summarizeResults([{ filePath: join(projectRoot, '..', 'outside.ts'), messages: [] }], projectRoot),
  );
});
