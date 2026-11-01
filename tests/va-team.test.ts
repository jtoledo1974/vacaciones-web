import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service, principal } from '../server/service.ts';
import { canAdminVa, canWrite } from '../server/permissions.ts';
import { VA_TEAM } from '../server/teams.ts';
import type { Principal } from '../server/permissions.ts';

const admin: Principal = { id: 'admin', role: 'superadmin', teams: [] };

test('el equipo reservado va y su campaña no alteran las vistas ni operaciones de ordinarias', async () => {
  const repo = new SQLiteRepo();
  const service = new Service(repo, admin);
  await service.init();
  const initial = await service.list();
  const before = { list: initial.teams, campaigns: initial.campaigns, stats: await service.stats() };
  // A VA campaign of a later year, as phase 4 will create it.
  await repo.batch([
    {
      sql: "INSERT OR IGNORE INTO teams(id,name,version,kind) VALUES(?,'Vacaciones de antigüedad',1,'va')",
      args: [VA_TEAM],
    },
    {
      sql: "INSERT INTO campaigns(id,team_id,year,status,version,created_at) VALUES('va-2099',?,2099,'open',1,'2099-01-01')",
      args: [VA_TEAM],
    },
    { sql: "INSERT INTO parameters(campaign_id,json,version) VALUES('va-2099','{}',1)" },
  ]);
  const after = await service.list();
  assert.deepEqual(after.teams, before.list, 'la lista de equipos no incluye va');
  // The landing year and the next-year proposal are derived from list().campaigns.
  assert.deepEqual(after.campaigns, before.campaigns, 'ni sus campañas, que desviarían el año inicial');
  assert.deepEqual(await service.stats(), before.stats, 'ni el año ni las campañas de las estadísticas cambian');
  await assert.rejects(service.init(), /ya está inicializado/);
  await service.createCampaigns(2027, null, null);
  const created = await repo.all('SELECT team_id FROM campaigns WHERE year=2027 ORDER BY team_id');
  assert.deepEqual(
    created.map((c) => c.team_id),
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  );
  assert.equal((await repo.all("SELECT kind FROM teams WHERE id='A'"))[0].kind, 'ordinary');
});

test('un administrador de VA administra solo el equipo va, y puede quedarse sin ninguno', async () => {
  const repo = new SQLiteRepo();
  const service = new Service(repo, admin);
  await service.init();
  await service.configureUser({ subject: 'va@ejemplo.es', role: 'team_admin', teams: [VA_TEAM], version: 0 });
  const identity = { provider: 'chatgpt', subject: 'sub-va', email: 'va@ejemplo.es', emailVerified: true };
  const va = await principal(repo, identity, '');
  assert.equal(canAdminVa(va), true);
  assert.equal(canWrite(va, 'A'), false, 'no administra equipos ordinarios');
  await assert.rejects(
    new Service(repo, va).configureTeamUser({ teamId: 'A', subject: 'x@y.es', role: 'team_admin', teams: ['A'] }),
    /fuera de tus permisos/,
  );
  // Unlike ordinary teams, VA needs no administrator of its own: superadmins administer it.
  const user = (await repo.all("SELECT * FROM users WHERE subject='email:va@ejemplo.es'"))[0];
  await service.deleteUser({ id: user.id, version: user.version });
  assert.equal(canAdminVa(await principal(repo, identity, '')), false);
});

test('un administrador de VA puede retirarse o caducar siendo el último; en un equipo ordinario no', async () => {
  const repo = new SQLiteRepo();
  const service = new Service(repo, admin);
  await service.init();
  const identity = (subject: string) => ({ provider: 'chatgpt', subject, email: subject, emailVerified: true });
  const user = async (subject: string) =>
    (await repo.all('SELECT * FROM users WHERE subject=?', ['email:' + subject]))[0];
  for (const team of [VA_TEAM, 'A']) {
    const subject = `ultimo-${team.toLowerCase()}@ejemplo.es`;
    await service.configureUser({ subject, role: 'team_admin', teams: [team], version: 0 });
    const self = new Service(repo, await principal(repo, identity(subject), ''));
    const expiring = {
      teamId: team,
      id: (await user(subject)).id,
      subject,
      role: 'team_admin',
      teams: [team],
      version: (await user(subject)).version,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const remove = async () => {
      const u = await user(subject);
      return self.deleteTeamUser({ teamId: team, id: u.id, version: u.version });
    };
    if (team === VA_TEAM) {
      await self.configureTeamUser(expiring);
      await remove();
      assert.equal(canAdminVa(await principal(repo, identity(subject), '')), false);
    } else {
      await assert.rejects(self.configureTeamUser(expiring), /último administrador/);
      await assert.rejects(remove(), /último administrador/);
    }
  }
});
