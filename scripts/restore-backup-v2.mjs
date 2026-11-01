#!/usr/bin/env node
// Offline restore into a NEW SQLite file; never contacts production.
import { DatabaseSync } from 'node:sqlite';
import {
  createReadStream,
  readdirSync,
  readFileSync,
  existsSync,
  linkSync,
  rmSync,
  chmodSync,
  openSync,
  closeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ArchiveVerifier } from '../lib/backup-v2.mjs';

export async function restoreArchive(records, filename) {
  if (existsSync(filename) || existsSync(filename + '.partial')) throw new Error('El destino ya existe');
  const partial = filename + '.partial';
  closeSync(openSync(partial, 'wx', 0o600));
  const db = new DatabaseSync(partial);
  chmodSync(partial, 0o600);
  const verifier = new ArchiveVerifier();
  let pending = null;
  try {
    // Never execute SQL supplied by the archive. Only trusted repository migrations.
    db.exec('PRAGMA foreign_keys=ON; PRAGMA cache_size=-4096;');
    const dir = new URL('../drizzle/', import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(new URL(file, dir), 'utf8'));
    db.exec(
      "BEGIN; PRAGMA defer_foreign_keys=ON; CREATE TEMP TABLE fragment(data TEXT NOT NULL); INSERT INTO fragment VALUES('');",
    );
    for await (const record of records) {
      await verifier.accept(record);
      if (record.kind === 'manifest') {
        // 0020 copies predate teams.kind (migration 0021); its default applies on insert.
        const legacy = verifier.manifest.schemaVersion === 'vacaciones-schema-0020';
        if (!legacy && verifier.manifest.schemaVersion !== 'vacaciones-schema-0021')
          throw new Error('Versión de esquema incompatible; utiliza un restaurador compatible con esta copia');
        const excluded = new Set([
          'backup_clock',
          'cleanup_clock',
          'transaction_assertions',
          'va_integrity_assertions',
          'local_admin_sessions',
          'local_admin_attempts',
          'cli_sessions',
          'cli_attempts',
        ]);
        const expected = db
          .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((r) => r.name)
          .filter((n) => !excluded.has(n));
        if (JSON.stringify(expected.sort()) !== JSON.stringify(Object.keys(verifier.manifest.tables).sort()))
          throw new Error('Manifiesto de tablas incompatible');
        for (const [name, columns] of Object.entries(verifier.manifest.tables)) {
          const actual = db
            .prepare(`PRAGMA table_info("${name}")`)
            .all()
            .map((r) => r.name)
            .filter((c) => !(legacy && name === 'teams' && c === 'kind'))
            .sort();
          if (JSON.stringify(actual) !== JSON.stringify([...columns].sort()))
            throw new Error('Columnas incompatibles: ' + name);
        }
      }
      if (record.kind !== 'page') continue;
      const p = record.payload,
        names = Object.keys(verifier.manifest.tables),
        name = names[p.cursor.table];
      for (const chunk of p.chunks) {
        if (
          !name ||
          !Number.isSafeInteger(chunk.row) ||
          chunk.row < 1 ||
          typeof chunk.data !== 'string' ||
          [...chunk.data].length > 8192
        )
          throw new Error('Fragmento inválido');
        if (!pending) {
          if (chunk.offset !== 1) throw new Error('Falta el inicio de una fila');
          pending = { table: name, row: chunk.row, offset: 1 };
        }
        if (pending.table !== name || pending.row !== chunk.row || pending.offset !== chunk.offset)
          throw new Error('Fila incompleta o repetida');
        db.prepare('UPDATE fragment SET data=data||?').run(chunk.data);
        pending.offset += [...chunk.data].length;
        if (chunk.complete) {
          const cols = verifier.manifest.tables[name];
          // SQL JSON extraction avoids materializing a large row in JavaScript.
          db.prepare(
            `INSERT INTO "${name}"(rowid,${cols.map((c) => `"${c}"`).join(',')}) SELECT ?,${cols.map((c) => `json_extract(data,'$.${c}')`).join(',')} FROM fragment`,
          ).run(chunk.row);
          db.exec("UPDATE fragment SET data=''");
          pending = null;
        }
      }
    }
    verifier.finish();
    if (pending) throw new Error('Última fila incompleta');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Referencias inválidas');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite no íntegro');
    db.exec('COMMIT');
    db.close();
    // Atomic no-clobber publication, including a destination created during restore.
    linkSync(partial, filename);
    rmSync(partial);
    return { file: filename, pages: verifier.pages, chain: verifier.chain };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no transaction yet */
    }
    try {
      db.close();
    } catch {
      /* may already be closed before publication */
    }
    rmSync(partial, { force: true });
    throw e;
  }
}
async function* records(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length > 1_000_000) throw new Error('Línea demasiado grande');
    yield JSON.parse(line);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error('Uso: node scripts/restore-backup-v2.mjs copia.ndjson destino-nuevo.sqlite');
  console.log(await restoreArchive(records(source), destination));
}
