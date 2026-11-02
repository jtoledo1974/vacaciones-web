// Shared streaming archive protocol. No whole-database JSON is built in memory.
export const firstCursor = () => ({ table: 0, row: 0, offset: 1 });
export async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function downloadBackup(request, write) {
  const manifest = await request('GET', 'backup-v2');
  if (
    manifest.payload?.format !== 'vacaciones-backup-v2' ||
    !manifest.payload.tables ||
    !Array.isArray(manifest.payload.schema) ||
    manifest.sha256 !== (await hash(manifest.payload))
  )
    throw new Error('Fallo de integridad del manifiesto');
  const verifier = new ArchiveVerifier();
  await verifier.accept({ kind: 'manifest', ...manifest });
  await write(JSON.stringify({ kind: 'manifest', ...manifest }) + '\n');
  let chain = manifest.sha256,
    cursor = firstCursor(),
    pages = 0;
  do {
    const page = await request('POST', 'backup-v2/page', { revision: manifest.payload.revision, cursor });
    if (
      page.sha256 !== (await hash(page.payload)) ||
      JSON.stringify(page.payload.cursor) !== JSON.stringify(cursor) ||
      page.payload.revision !== manifest.payload.revision
    )
      throw new Error('Página de copia corrupta');
    if (page.payload.next === null && page.payload.schemaSha256 !== (await hash(manifest.payload.schema)))
      throw new Error('El esquema cambió durante la copia');
    chain = await hash([chain, page.sha256]);
    await verifier.accept({ kind: 'page', ...page });
    await write(JSON.stringify({ kind: 'page', ...page }) + '\n');
    cursor = page.payload.next;
    pages++;
  } while (cursor !== null);
  await verifier.accept({ kind: 'complete', chain, pages });
  verifier.finish();
  await write(JSON.stringify({ kind: 'complete', chain, pages }) + '\n');
  return { chain, pages, revision: manifest.payload.revision };
}

// Used by offline restoration; a truncated archive is never accepted as a backup.
export class ArchiveVerifier {
  manifest;
  cursor = firstCursor();
  chain;
  pages = 0;
  complete = false;
  rows = [];
  async accept(record) {
    if (this.complete) throw new Error('Contenido posterior al cierre');
    if (!this.manifest) {
      if (
        record.kind !== 'manifest' ||
        record.payload?.format !== 'vacaciones-backup-v2' ||
        record.sha256 !== (await hash(record.payload))
      )
        throw new Error('Manifiesto inválido');
      if (
        !record.payload.tables ||
        !Array.isArray(record.payload.schema) ||
        !Array.isArray(record.payload.inventory) ||
        !Number.isSafeInteger(record.payload.revision)
      )
        throw new Error('Manifiesto incompleto');
      const names = Object.keys(record.payload.tables);
      if (
        record.payload.inventory.length !== names.length ||
        record.payload.inventory.some(
          (row, i) => row.table !== names[i] || !Number.isSafeInteger(row.rows) || row.rows < 0,
        )
      )
        throw new Error('Inventario inválido');
      this.rows = names.map(() => 0);
      this.manifest = record.payload;
      this.chain = record.sha256;
      return;
    }
    if (record.kind === 'complete') {
      if (this.cursor !== null || record.chain !== this.chain || record.pages !== this.pages)
        throw new Error('Cierre inválido o copia incompleta');
      if (this.manifest.inventory.some((row, i) => row.rows !== this.rows[i]))
        throw new Error('El recuento restaurable no coincide con el inventario');
      this.complete = true;
      return;
    }
    const p = record.payload;
    if (
      record.kind !== 'page' ||
      this.cursor === null ||
      record.sha256 !== (await hash(p)) ||
      JSON.stringify(p.cursor) !== JSON.stringify(this.cursor) ||
      p.revision !== this.manifest.revision
    )
      throw new Error('Página inválida');
    const names = Object.keys(this.manifest.tables);
    if (!Array.isArray(p.chunks) || p.chunks.length > 64) throw new Error('Fragmentos inválidos');
    let expected;
    if (this.cursor.table === names.length) {
      if (p.chunks.length || p.schemaSha256 !== (await hash(this.manifest.schema)))
        throw new Error('Cierre o esquema cambiado');
      expected = null;
    } else {
      expected = { table: this.cursor.table + 1, row: 0, offset: 1 };
      let seek = this.cursor;
      for (let i = 0; i < p.chunks.length; i++) {
        const c = p.chunks[i];
        if (
          !Number.isSafeInteger(c.row) ||
          c.row < Math.max(1, seek.row) ||
          c.offset !== (c.row === seek.row ? seek.offset : 1) ||
          (seek.offset > 1 && c.row !== seek.row) ||
          typeof c.data !== 'string' ||
          typeof c.complete !== 'boolean'
        )
          throw new Error('Secuencia de fila inválida');
        const size = [...c.data].length;
        // Up to 64 fragments of 8 KB: 32 KB-aligned budget plus a short tail per row; a row may continue within the page or on the next.
        if (size < 1 || size > 8192 || (!c.complete && size !== 8192)) throw new Error('Tamaño de fragmento inválido');
        if (c.complete) this.rows[this.cursor.table]++;
        expected = {
          table: this.cursor.table,
          row: c.row + (c.complete ? 1 : 0),
          offset: c.complete ? 1 : c.offset + size,
        };
        seek = expected;
      }
    }
    if (JSON.stringify(p.next) !== JSON.stringify(expected)) throw new Error('Continuación inválida');
    this.chain = await hash([this.chain, record.sha256]);
    this.pages++;
    this.cursor = p.next;
  }
  finish() {
    if (!this.complete) throw new Error('Copia interrumpida: falta cierre verificado');
  }
}
