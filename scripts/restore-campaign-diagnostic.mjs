#!/usr/bin/env node
// Offline only: trusted migrations, a new private SQLite, no network or archive SQL.
import { DatabaseSync } from 'node:sqlite';
import {
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
  chmodSync,
  linkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  assertDiagnosticShape,
  diagnosticHash,
  diagnosticByteLength,
  diagnosticTables,
  diagnosticScope,
  DIAGNOSTIC_MAX_BYTES,
} from '../lib/campaign-diagnostic.mjs';

export async function restoreCampaignDiagnostic(archive, filename) {
  if (existsSync(filename) || existsSync(filename + '.partial')) throw new Error('El destino ya existe');
  if (diagnosticByteLength(archive) > DIAGNOSTIC_MAX_BYTES) throw new Error('Diagnóstico demasiado grande');
  const p = assertDiagnosticShape(archive);
  if (archive.sha256 !== (await diagnosticHash(p))) throw new Error('Integridad del diagnóstico incorrecta');
  const partial = filename + '.partial';
  closeSync(openSync(partial, 'wx', 0o600));
  let db;
  try {
    chmodSync(partial, 0o600);
    db = new DatabaseSync(partial);
    db.exec('PRAGMA foreign_keys=ON');
    const dir = new URL('../drizzle/', import.meta.url);
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(new URL(f, dir), 'utf8'));
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    for (const name of diagnosticTables) {
      const actual = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((r) => r.name);
      if (JSON.stringify([...actual].sort()) !== JSON.stringify([...p.columns[name]].sort()))
        throw new Error('Columnas incompatibles: ' + name);
      const insert = db.prepare(
        `INSERT INTO "${name}"(rowid,${actual.map((c) => `"${c}"`).join(',')}) VALUES(${Array(actual.length + 1)
          .fill('?')
          .join(',')})`,
      );
      for (const row of p.tables[name]) insert.run(row._rowid, ...actual.map((c) => row[c]));
    }
    const scope = diagnosticScope();
    for (const name of diagnosticTables) {
      const sql = `SELECT count(*) n FROM "${name}" WHERE coalesce((${scope[name]}),0)=0`;
      if (db.prepare(sql).get(...Array((sql.match(/\?/g) ?? []).length).fill(p.campaignId)).n)
        throw new Error('Datos ajenos al alcance: ' + name);
    }
    if (
      db
        .prepare(
          'SELECT count(*) n FROM campaigns c WHERE published_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=c.published_run_id AND r.campaign_id=c.id)',
        )
        .get().n
    )
      throw new Error('Falta la ejecución publicada');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Referencias inválidas');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite no íntegro');
    db.exec('COMMIT');
    db.close();
    db = undefined;
    linkSync(partial, filename);
    rmSync(partial);
    return {
      file: filename,
      campaignId: p.campaignId,
      sha256: archive.sha256,
      scope: 'Diagnóstico parcial; solo para un clon local aislado',
    };
  } catch (e) {
    if (db) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* transaction may not have started */
      }
      try {
        db.close();
      } catch {
        /* preserve the original restore error */
      }
    }
    rmSync(partial, { force: true });
    throw e;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error('Uso: node scripts/restore-campaign-diagnostic.mjs diagnostico.json destino-nuevo.sqlite');
  if (statSync(source).size > DIAGNOSTIC_MAX_BYTES) throw new Error('Diagnóstico demasiado grande');
  console.log(await restoreCampaignDiagnostic(JSON.parse(readFileSync(source, 'utf8')), destination));
}
