import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { loadVaQuotas, vaQuotas } from '../server/va-quotas.ts';
import { vaCensus } from '../server/va-census.ts';
import { parseVaCalendar, sheetCells } from '../lib/va-calendar.mjs';
import type { Principal } from '../server/permissions.ts';

const superadmin: Principal = { id: 'test-admin', role: 'superadmin', teams: [] };
const vaAdmin: Principal = { id: 'chatgpt:va', role: 'viewer', teams: [], vaAdmin: true };
const teamAdmin: Principal = { id: 'chatgpt:resp', role: 'team_admin', teams: ['A'] };
const source = { title: 'Calendario huecos VA 2026', sha256: 'b'.repeat(64), receivedAt: '2026-10-28' };

async function setup() {
  const repo = new SQLiteRepo();
  await new Service(repo, superadmin).init();
  return repo;
}
const load = (repo: SQLiteRepo, days: Record<string, number>, actor = vaAdmin) =>
  loadVaQuotas(repo, actor, { action: 'preview', year: 2026, source, days });

test('carga el calendario con vista previa, token y auditoría; un día ausente no tiene plazas', async () => {
  const repo = await setup();
  const days = { '2026-02-01': 3, '2026-02-02': 2, '2026-02-03': 0 };
  const preview = await load(repo, days);
  assert.equal(preview.totalPlaces, 5);
  assert.equal(preview.daysWithPlaces, 2);
  assert.equal(preview.daysWithoutPlaces, 363);
  assert.equal(preview.entitledDays, 56);
  assert.equal(preview.changedDays, 2);
  assert.equal((await vaQuotas(repo, vaAdmin, 2026)).version, 0, 'la vista previa no escribe');
  await assert.rejects(loadVaQuotas(repo, vaAdmin, { action: 'apply', year: 2026, source, days }), /Revisa/);
  await loadVaQuotas(repo, vaAdmin, { action: 'apply', year: 2026, source, days, reviewToken: preview.reviewToken });
  const loaded = await vaQuotas(repo, vaAdmin, 2026);
  assert.deepEqual(loaded.days, days);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.source?.title, source.title);
  assert.equal((await vaCensus(repo, vaAdmin)).quotas?.places, 5);
  const audit = await repo.all("SELECT * FROM audit WHERE action='va_quotas'");
  assert.equal(audit.length, 1);
});

test('cada carga sustituye el año completo y un token anterior deja de valer', async () => {
  const repo = await setup();
  const first = await load(repo, { '2026-03-01': 2 });
  const stale = await load(repo, { '2026-03-01': 2, '2026-03-02': 2 });
  await loadVaQuotas(repo, vaAdmin, {
    action: 'apply',
    year: 2026,
    source,
    days: { '2026-03-01': 2 },
    reviewToken: first.reviewToken,
  });
  await assert.rejects(
    loadVaQuotas(repo, vaAdmin, {
      action: 'apply',
      year: 2026,
      source,
      days: { '2026-03-01': 2, '2026-03-02': 2 },
      reviewToken: stale.reviewToken,
    }),
    /Revisa/,
  );
  const replace = await load(repo, { '2026-04-01': 1 });
  assert.deepEqual(replace.changes, [
    { date: '2026-03-01', before: 2, after: 0 },
    { date: '2026-04-01', before: 0, after: 1 },
  ]);
  await loadVaQuotas(repo, vaAdmin, {
    action: 'apply',
    year: 2026,
    source,
    days: { '2026-04-01': 1 },
    reviewToken: replace.reviewToken,
  });
  assert.deepEqual((await vaQuotas(repo, vaAdmin, 2026)).days, { '2026-04-01': 1 });
});

test('rechaza fechas de otro año, imposibles, plazas no válidas y a quien no administra VA', async () => {
  const repo = await setup();
  await assert.rejects(load(repo, { '2027-01-01': 2 }), /fuera del año/);
  await assert.rejects(load(repo, { '2026-02-30': 2 }), /fuera del año/);
  await assert.rejects(load(repo, { '2026-02-01': -1 }), /Plazas no válidas/);
  await assert.rejects(load(repo, { '2026-02-01': 1.5 }), /Plazas no válidas/);
  await assert.rejects(load(repo, { '2026-02-01': 2 }, teamAdmin), /administrador de VA/);
  await assert.rejects(vaQuotas(repo, teamAdmin, 2026), /administrador de VA/);
  await assert.rejects(
    loadVaQuotas(repo, vaAdmin, { action: 'preview', year: 2026, source: { ...source, sha256: 'x' }, days: {} }),
    /SHA-256/,
  );
  assert.ok(await load(repo, { '2026-02-01': 2 }, superadmin));
});

test('lee los bloques «Mes AAAA» del calendario de RRHH: días y, debajo, sus plazas', () => {
  // Febrero 2026 empieza en domingo, como en el ejemplo de RRHH.
  const xml = (cells: [string, string | number][]) =>
    '<sheetData>' +
    cells
      .map(([ref, v]) =>
        typeof v === 'number'
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`,
      )
      .join('') +
    '</sheetData>';
  const cells = sheetCells(
    xml([
      ['B2', 'Febrero 2026'],
      ['H4', 1],
      ['H5', 3],
      ['B6', 2],
      ['C6', 3],
      ['B7', 3],
      ['C7', 2],
      ['B8', 9],
    ]),
  );
  assert.deepEqual(parseVaCalendar(cells), { '2026-02-01': 3, '2026-02-02': 3, '2026-02-03': 2 });
  assert.throws(() => parseVaCalendar(sheetCells(xml([['A1', 'sin meses']]))), /Mes AAAA/);
  assert.throws(
    () =>
      parseVaCalendar(
        sheetCells(
          xml([
            ['B2', 'Marzo 2026'],
            ['B4', 2],
            ['B5', 'dos'],
          ]),
        ),
      ),
    /Plazas no válidas/,
  );
});
