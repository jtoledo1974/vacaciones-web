import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpDocuments, type HelpDocument } from '../server/docs-policy.ts';
const documents: HelpDocument[] = [
  { id: 'public', title: 'Consulta', audience: 'public', filename: 'CONSULTA.md', content: 'público' },
  { id: 'admin', title: 'Gestión', audience: 'admin', filename: 'GESTION.md', content: 'reservado' },
];
test('documentación pública no contiene texto reservado y admins reciben las dos guías', () => {
  for (const role of ['viewer', '', 'unexpected']) assert.deepEqual(helpDocuments(role, documents), [documents[0]]);
  for (const role of ['superadmin', 'team_admin']) assert.deepEqual(helpDocuments(role, documents), documents);
});
