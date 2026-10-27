import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeMs, electionTiming, formatActive } from '../domain/turn-timing.ts';
import { Service, principal } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const H = 3_600_000;

test('el tiempo de espera no cuenta de 23:00 a 9:00 en Madrid', () => {
  // 2026-01-12 (invierno, UTC+1): 22:00 → 10:00 del día siguiente cuenta 1 h + 1 h.
  assert.equal(activeMs(Date.parse('2026-01-12T21:00:00Z'), Date.parse('2026-01-13T09:00:00Z')), 2 * H);
  // Verano (UTC+2): de 9:00 a 23:00 son 14 h.
  assert.equal(activeMs(Date.parse('2026-07-01T07:00:00Z'), Date.parse('2026-07-01T21:00:00Z')), 14 * H);
  // Toda la noche no cuenta.
  assert.equal(activeMs(Date.parse('2026-07-01T21:30:00Z'), Date.parse('2026-07-02T06:59:00Z')), 0);
  // Fin de semana cuenta igual: viernes 12:00 → lunes 12:00 = 3 días de 14 h.
  assert.equal(activeMs(Date.parse('2026-10-09T10:00:00Z'), Date.parse('2026-10-12T10:00:00Z')), 3 * 14 * H);
  // Cambio de hora (25 oct 2026): el día sigue teniendo 14 h útiles.
  assert.equal(activeMs(Date.parse('2026-10-24T21:00:00Z'), Date.parse('2026-10-25T22:00:00Z')), 14 * H);
  assert.equal(formatActive(45 * 60_000), '45 min');
  assert.equal(formatActive(3 * H + 20 * 60_000), '3 h 20 min');
  assert.equal(formatActive(26 * H + 5 * 60_000), '26 h');
});

test('cada turno se abre al cerrarse el anterior o al reiniciarse el reloj, y todo turno promedia', () => {
  const timing = electionTiming({
    items: [
      { id: 'c', kind: 'choice', round: 1, createdAt: '2026-07-01T12:00:00Z', memberIds: ['b'] },
      { id: 'x', kind: 'choice', round: 1, createdAt: '2026-07-01T11:00:00Z', memberIds: ['z'], anticipated: true },
      { id: 'b', kind: 'defer', round: 1, createdAt: '2026-07-01T10:00:00Z', memberIds: ['a'] },
      { id: 'a', kind: 'choice', round: 1, createdAt: '2026-07-01T08:00:00Z', memberIds: ['a', 'b'] },
      { id: 't', kind: 'tie', round: 1, createdAt: '2026-07-01T07:30:00Z', memberIds: [] },
    ],
    clockRestarts: ['2026-07-01T07:00:00Z', '2026-07-01T11:00:00Z'],
    turnSince: { at: '2026-07-01T12:00:00Z' },
    active: true,
    now: Date.parse('2026-07-01T13:00:00Z'),
  });
  assert.deepEqual(
    timing.turns.map((t) => [t.id, t.activeMs]),
    [
      ['a', H],
      ['b', 2 * H],
      ['c', H],
    ],
  );
  assert.deepEqual(Object.fromEntries(timing.averages.map((a) => [a.memberId, [a.turns, a.meanMs]])), {
    a: [2, 1.5 * H],
    b: [2, H],
  });
  assert.deepEqual(timing.waiting, { since: '2026-07-01T12:00:00Z', activeMs: H });
});

test('las estadísticas exigen sesión y muestran el tiempo de los turnos', async () => {
  const repo = new SQLiteRepo();
  const admin = new Service(repo, { id: 'chatgpt:admin', role: 'superadmin', teams: [] });
  await admin.init();
  await assert.rejects(new Service(repo, { id: null, role: 'viewer', teams: [] }).stats(), { status: 401 });
  const viewer = await principal(
    repo,
    { provider: 'chatgpt', subject: 'x', email: 'x@e.test', emailVerified: true },
    '',
  );
  const stats = await new Service(repo, viewer).stats();
  assert.ok(stats.campaigns.length > 0);
  for (const c of stats.campaigns) {
    assert.equal(c.year, stats.year);
    assert.ok(c.total >= c.awarded);
  }
});

test('un responsable de equipo puede sustituir el correo, y el controlador el suyo', async () => {
  const repo = new SQLiteRepo();
  const root = new Service(repo, { id: 'chatgpt:admin', role: 'superadmin', teams: [] });
  await root.init();
  const live = (await root.list()).campaigns.find((c) => c.scope_key === 'live' && c.team_id === 'B');
  const teamAdmin = new Service(repo, { id: 'chatgpt:resp', role: 'team_admin', teams: ['B'] });
  let view = await teamAdmin.view(live.id);
  const memberId = view.members[0].id;
  const link = (service: Service, subject: string, accountVersion: number, version: number, provider = 'chatgpt') =>
    service
      .election()
      .mutate(live.id, { action: 'link_account', memberId, provider, subject, accountVersion, version });
  await link(teamAdmin, 'uno@example.test', 0, view.campaign.version);
  view = await teamAdmin.view(live.id);
  await link(teamAdmin, 'dos@example.test', 1, view.campaign.version);

  const controller = await principal(
    repo,
    { provider: 'chatgpt', subject: 'c', email: 'dos@example.test', emailVerified: true },
    '',
  );
  const own = new Service(repo, controller);
  let mine = await own.view(live.id);
  assert.equal(mine.election.myAccountVersion, 2);
  await assert.rejects(link(own, '', 2, mine.campaign.version), { status: 403 });
  await assert.rejects(link(own, 'uid', 2, mine.campaign.version, 'firebase'), { status: 403 });
  await link(own, 'tres@example.test', 2, mine.campaign.version);
  const rows = await repo.all('SELECT principal_key FROM controller_accounts');
  assert.deepEqual(
    rows.map((r) => r.principal_key),
    ['chatgpt-email:tres@example.test'],
  );
  // The old login no longer controls anyone, so it cannot change anything else.
  mine = await own.view(live.id);
  await assert.rejects(link(own, 'cuatro@example.test', 3, mine.campaign.version), { status: 403 });
});

test('el historial reinicia el reloj tras un sorteo o una reconstrucción, no tras un sorteo anticipado', async () => {
  const { timingOf } = await import('../server/election-timeline.ts');
  const row = (id: string, action: string, created_at: string, after: unknown = null) => ({
    id,
    action,
    created_at,
    after_json: after === null ? null : JSON.stringify(after),
  });
  const item = (id: string, createdAt: string) => ({
    id,
    kind: 'choice' as const,
    round: 1,
    createdAt,
    memberIds: ['a'],
    choices: [],
    deferredTurns: 0,
    ties: [],
  });
  const rows = [
    row('s', 'start', '2026-07-01T07:00:00Z'),
    row('t', 'resolve_tie', '2026-07-01T10:00:00Z', { resolution: {} }),
    row('x', 'resolve_tie', '2026-07-01T11:30:00Z', { resolution: { anticipated: true } }),
    row('r', 'reconstruction_cancel', '2026-07-01T13:00:00Z'),
  ];
  const timing = timingOf(rows, [item('c1', '2026-07-01T12:00:00Z'), item('c2', '2026-07-01T14:00:00Z')], null);
  assert.deepEqual(
    timing.turns.map((t) => t.activeMs),
    [2 * H, H],
  );
});
