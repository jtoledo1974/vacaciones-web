import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
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
