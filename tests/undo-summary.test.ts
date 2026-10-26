import test from 'node:test';
import assert from 'node:assert/strict';
import { undoQuestion } from '../app/undo-summary.ts';

const codeFor = (id: string) => (({ a: 'DIEGO', b: 'NURIA' }) as Record<string, string>)[id] ?? '?';
const formatDate = (date: string) => date.slice(8, 10) + '/' + date.slice(5, 7);

test('el aviso de Deshacer nombra el cambio exacto y su hora', () => {
  assert.equal(
    undoQuestion(
      { action: 'choose', memberId: 'a', at: '2026-10-26T14:01:22Z', choices: [{ memberId: 'a', date: '2027-06-01' }] },
      codeFor,
      formatDate,
    ),
    '¿Deshacer la adjudicación de DIEGO (01/06) (15:01)? Se restaurarán la cola y la ocupación anteriores; las listas de preferencias guardadas después se conservan.',
  );
  assert.match(
    undoQuestion(
      {
        action: 'advance',
        memberId: null,
        at: null,
        choices: [
          { memberId: 'a', date: '2027-06-01' },
          { memberId: 'b', date: '2027-06-09' },
        ],
      },
      codeFor,
      formatDate,
    ),
    /^¿Deshacer la adjudicación automática de DIEGO \(01\/06\), NURIA \(09\/06\)\?/,
  );
  assert.match(
    undoQuestion({ action: 'preferences', memberId: 'b', at: null, choices: [] }, codeFor, formatDate),
    /^¿Deshacer la lista de preferencias de NURIA\?/,
  );
  assert.match(
    undoQuestion({ action: 'defer', memberId: 'a', at: null, choices: [] }, codeFor, formatDate),
    /^¿Deshacer el aplazamiento de DIEGO\?/,
  );
  assert.match(undoQuestion(null, codeFor, formatDate), /^¿Deshacer el último cambio de elección/);
});
