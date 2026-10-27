import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');

// Temporary, documented layer exceptions. Remove each one as soon as its task
// moves the shared logic to domain.
const legacyImports: Record<string, string> = {};

// Policy implementation can be imported directly by its own unit/integration tests.
// Production consumers must use domain/policy.ts or domain/hr-calendars.ts.
const policyTestImports: Record<string, string> = {
  'tests/domain.test.ts -> domain/hr-2027': 'Contrasta el calendario con la fuente RRHH.',
  'tests/personal-simulation.test.ts -> domain/policy-2027': 'Ejercita el evaluador real con simulaciones.',
  'tests/personal-simulation.test.ts -> domain/election-2027': 'Construye escenarios de política 2027.',
  'tests/policy-2027.test.ts -> domain/policy-2027': 'Pruebas directas del motor 2027.',
  'tests/policy-2027.test.ts -> domain/election-2027': 'Verifica la adaptación de la elección 2027.',
  'tests/policy-2027.test.ts -> domain/hr-2027': 'Comprueba las cifras originales de RRHH.',
  'tests/definitive-guide-2027.test.ts -> domain/policy-2027': 'Casos de referencia de la guía 2027.',
  'tests/availability-2027.test.ts -> domain/availability-2027': 'Prueba el cálculo de disponibilidad.',
  'tests/availability-2027.test.ts -> domain/policy-2027': 'Contrasta la disponibilidad con el motor.',
  'tests/occupancy-properties.test.ts -> domain/availability-2027':
    'Verifica las claves precalculadas y el aislamiento de las cachés del motor 2027.',
  'tests/policy-2027-service.test.ts -> domain/policy-2027': 'Integración del servicio con el motor.',
  'tests/policy-2027-service.test.ts -> domain/election-2027': 'Prepara los estados de integración.',
  'tests/policy-2027-service.test.ts -> domain/availability-2027': 'Contrasta la disponibilidad integrada.',
  'tests/policy-registry.test.ts -> domain/policy-2027': 'Verifica la selección del motor según el año.',
};
const exceptions = { ...legacyImports, ...policyTestImports };

function runtimeDependencies(source: string, file: string): { specifier: string; typeOnly: boolean }[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: { specifier: string; typeOnly: boolean }[] = [];
  function record(specifier: ts.Expression | undefined, typeOnly: boolean): void {
    if (specifier && ts.isStringLiteralLike(specifier)) result.push({ specifier: specifier.text, typeOnly });
  }
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = Boolean(
        clause?.isTypeOnly ||
          (bindings &&
            ts.isNamedImports(bindings) &&
            !clause?.name &&
            bindings.elements.length > 0 &&
            bindings.elements.every((el) => el.isTypeOnly)),
      );
      record(statement.moduleSpecifier, onlyTypes);
    } else if (ts.isExportDeclaration(statement)) {
      const bindings = statement.exportClause;
      const onlyTypes = Boolean(
        statement.isTypeOnly ||
          (bindings &&
            ts.isNamedExports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((el) => el.isTypeOnly)),
      );
      record(statement.moduleSpecifier, onlyTypes);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      record(node.arguments[0], false);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}

test('se distinguen los imports de ejecución de los import type (incluidos los mixtos y dinámicos)', () => {
  const source = [
    "import type {A} from '../domain/policy-2027.ts';",
    "import {type B} from '../domain/availability-2027.ts';",
    "export type {C} from '../domain/election-2027.ts';",
    "import {type D, real} from '../app/shared.ts';",
    "export {actual} from '../server/x.ts';",
    "async function load(){return import('../app/dynamic.ts')}",
  ].join('\n');
  assert.deepEqual(runtimeDependencies(source, 'example.ts'), [
    { specifier: '../domain/policy-2027.ts', typeOnly: true },
    { specifier: '../domain/availability-2027.ts', typeOnly: true },
    { specifier: '../domain/election-2027.ts', typeOnly: true },
    { specifier: '../app/shared.ts', typeOnly: false },
    { specifier: '../server/x.ts', typeOnly: false },
    { specifier: '../app/dynamic.ts', typeOnly: false },
  ]);
});

test('fronteras de import: dominio aislado, servidor sin UI y política anual encapsulada', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(files.length > 0, 'No se han encontrado archivos versionados');
  const violations: string[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const from = file.replaceAll('\\', '/');
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const { specifier, typeOnly } of runtimeDependencies(text, from)) {
      if (!specifier.startsWith('.')) continue;
      const to = path
        .relative(root, path.resolve(root, path.dirname(file), specifier))
        .replaceAll('\\', '/')
        .replace(/\.(?:tsx?|jsx?)$/, '');
      const key = `${from} -> ${to}`;
      let violation = '';
      if (from.startsWith('domain/') && (to.startsWith('app/') || to.startsWith('server/')))
        violation = 'domain no puede importar app ni server';
      else if (from.startsWith('server/') && to.startsWith('app/')) violation = 'server no puede importar app';
      else if (
        !typeOnly &&
        /^domain\/[^/]+-2027$/.test(to) &&
        !(/^domain\/[^/]+-2027\.ts$/.test(from) || from === 'domain/policy.ts' || from === 'domain/hr-calendars.ts')
      )
        violation = 'los módulos anuales solo se importan en ejecución desde el registro y el propio motor 2027';
      if (violation) {
        if (exceptions[key]) used.add(key);
        else violations.push(`${key}: ${violation}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'Dependencias prohibidas; documentar excepciones temporales de forma explícita');
  for (const key of Object.keys(legacyImports))
    assert.ok(used.has(key), `Excepción obsoleta: ${key}; elimínala de la lista`);
});
