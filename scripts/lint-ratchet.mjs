import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'lint-baseline.json');

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, rules]) => [file, Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)))]),
  );
}

export function summarizeResults(results, projectRoot = root) {
  if (!Array.isArray(results)) {
    throw new Error('ESLint no devolvió una lista de resultados JSON.');
  }

  const errors = {};
  for (const result of results) {
    if (result.fatalErrorCount) {
      throw new Error('ESLint encontró un error fatal en ' + result.filePath);
    }
    const file = relative(projectRoot, result.filePath).split(sep).join('/');
    if (!file || file === '..' || file.startsWith('../') || file.startsWith('/')) {
      throw new Error('Ruta fuera del repositorio: ' + result.filePath);
    }
    for (const message of result.messages ?? []) {
      if (message.severity !== 2) continue;
      const rule = message.ruleId ?? '__unattributed__';
      errors[file] ??= {};
      errors[file][rule] = (errors[file][rule] ?? 0) + 1;
    }
  }
  return sortedCounts(errors);
}

export function validateBaseline(data) {
  if (!data || data.version !== 1 || !data.errors || Array.isArray(data.errors)) {
    throw new Error('Formato de lint-baseline.json no válido (versión 1).');
  }
  for (const [file, rules] of Object.entries(data.errors)) {
    if (!file || !rules || typeof rules !== 'object' || Array.isArray(rules)) {
      throw new Error('Archivo o reglas no válidos en lint-baseline.json: ' + file);
    }
    for (const [rule, count] of Object.entries(rules)) {
      if (!rule || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error('Cuenta no válida para ' + file + ' / ' + rule);
      }
    }
  }
  return data.errors;
}

export function compareCounts(previous, current) {
  const regressions = [];
  const improvements = [];
  const files = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const rules = new Set([...Object.keys(previous[file] ?? {}), ...Object.keys(current[file] ?? {})]);
    for (const rule of [...rules].sort()) {
      const before = previous[file]?.[rule] ?? 0;
      const after = current[file]?.[rule] ?? 0;
      if (after > before) regressions.push({ file, rule, before, after });
      if (after < before) improvements.push({ file, rule, before, after });
    }
  }
  return { regressions, improvements };
}

function totalErrors(errors) {
  return Object.values(errors).reduce((sum, rules) => sum + Object.values(rules).reduce((n, count) => n + count, 0), 0);
}

function runEslint() {
  const command = resolve(root, 'node_modules/eslint/bin/eslint.js');
  const result = spawnSync(
    process.execPath,
    [command, '.', '--ignore-pattern', 'dist', '--ignore-pattern', '.next', '--format', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error('ESLint falló (código ' + result.status + '): ' + result.stderr);
  }
  let results;
  try {
    results = JSON.parse(result.stdout);
  } catch {
    throw new Error('No se pudo leer el JSON de ESLint: ' + result.stderr);
  }
  return summarizeResults(results);
}

function report(label, changes) {
  for (const { file, rule, before, after } of changes) {
    console.log(label + ' ' + file + ' [' + rule + ']: ' + before + ' → ' + after);
  }
}

function main(args) {
  if (args.some((arg) => arg !== '--update') || args.length > 1) {
    throw new Error('Uso: node scripts/lint-ratchet.mjs [--update]');
  }
  const current = runEslint();

  if (args.includes('--update')) {
    writeFileSync(baselinePath, JSON.stringify({ version: 1, errors: current }, null, 2) + '\n');
    console.log('Línea base actualizada: ' + totalErrors(current) + ' errores.');
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    throw new Error('No se pudo leer lint-baseline.json. Ejecuta pnpm lint:ratchet:update.');
  }
  const previous = validateBaseline(baseline);
  const { regressions, improvements } = compareCounts(previous, current);
  console.log('Errores ESLint: ' + totalErrors(current) + ' (línea base: ' + totalErrors(previous) + ').');
  report('CORREGIDO', improvements);
  report('REGRESIÓN', regressions);
  if (improvements.length) {
    console.log('Hay mejoras. Actualiza la línea base con pnpm lint:ratchet:update.');
  }
  if (regressions.length) {
    throw new Error('El lint ha empeorado en ' + regressions.length + ' combinaciones archivo/regla.');
  }
  console.log('Trinquete de lint superado.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
