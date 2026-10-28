import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { defaultConfig } from '../domain/defaults.ts';
import { policyFor, registerPolicy } from '../domain/policy.ts';
import { scoringVersion } from '../domain/scoring.ts';
import reference from './fixtures/scoring-2027-final2.json' with { type: 'json' };

for (const status of ['open', 'closed'])
  test(`existing ${status} campaign recalculates all 20 FINAL2 totals on read without rewriting its data`, async () => {
    const repo = new SQLiteRepo();
    try {
      const service = new Service(repo, { id: 'chatgpt:owner', role: 'superadmin', teams: [] });
      await service.init();
      await service.createCampaigns(2027, 2026);
      const campaign = (await service.list()).campaigns.find((c) => c.year === 2027 && c.team_id === 'B');
      const cid = campaign.id;
      for (let i = 16; i < 20; i++) {
        await repo.batch([
          {
            sql: "INSERT INTO people(id,team_id,code,seniority) VALUES(?,'B',?,'')",
            args: [`extra-person-${i}`, `EXTRA-${i}`],
          },
          {
            sql: "INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority,position) VALUES(?,?,?,?,'',?)",
            args: [`extra-member-${i}`, cid, `extra-person-${i}`, `EXTRA-${i}`, i],
          },
        ]);
      }
      const members = await repo.all('SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position,id', [cid]);
      assert.equal(members.length, reference.controllers.length);
      const legacy = defaultConfig(2026);
      const config = {
        ...defaultConfig(2027),
        baseScores: legacy.baseScores,
        holidays: legacy.holidays,
        weights: [2, 3, 4, 5, 6, 7],
      };
      await repo.batch([
        { sql: 'UPDATE parameters SET json=? WHERE campaign_id=?', args: [JSON.stringify(config), cid] },
        { sql: 'UPDATE campaigns SET status=? WHERE id=?', args: [status, cid] },
        ...reference.controllers.flatMap((c, i) =>
          c.dates.map((date, slot) => ({
            sql: 'INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version) VALUES(?,?,?,?,?,1)',
            args: [`test-${i}-${slot}`, cid, members[i].id, slot + 1, date],
          })),
        ),
        ...reference.controllers.flatMap((c, i) =>
          c.dates.map((date, slot) => ({
            sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
            args: [`award-${i}-${slot}`, cid, members[i].id, date],
          })),
        ),
      ]);
      const before = await repo.all('SELECT * FROM requests WHERE campaign_id=? ORDER BY id', [cid]);
      const awardsBefore = await repo.all('SELECT * FROM awards WHERE campaign_id=? ORDER BY id', [cid]);
      const view = await service.view(cid);
      for (const [i, c] of reference.controllers.entries()) {
        assert.equal(view.result.ordering.find((m) => m.id === members[i].id)?.score, c.score, `Fila ${c.sourceRow}`);
      }
      assert.equal(view.result.cycles.find((c) => c.date === '2027-05-01')?.score, 43);
      assert.deepEqual(view.config?.baseScores, defaultConfig(2027).baseScores);
      assert.deepEqual(view.config?.holidays, defaultConfig(2027).holidays);
      assert.equal(view.result.scoringVersion, scoringVersion(2027));
      assert.deepEqual(view.config?.weights, reference.weights);
      if (status === 'open') {
        for (const field of ['baseScores', 'holidays'] as const) {
          const edited = structuredClone(view.config!);
          edited[field][0].score += 1;
          await assert.rejects(
            service.mutate(cid, { action: 'config', version: view.campaign.version, config: edited }),
            /baremo oficial.*solo lectura/,
          );
        }
      }
      assert.deepEqual(await repo.all('SELECT * FROM requests WHERE campaign_id=? ORDER BY id', [cid]), before);
      assert.equal(
        (await repo.all('SELECT json FROM parameters WHERE campaign_id=?', [cid]))[0].json,
        JSON.stringify(config),
      );
      assert.deepEqual(await repo.all('SELECT * FROM awards WHERE campaign_id=? ORDER BY id', [cid]), awardsBefore);
      if (status === 'open') {
        for (let i = 0; i < 6; i++) {
          const edited = structuredClone(view.config!);
          edited.weights[i] = 2;
          await assert.rejects(
            service.mutate(cid, { action: 'config', version: view.campaign.version, config: edited }),
            /baremo oficial.*solo lectura/,
          );
        }
      }
      // Old snapshots remain readable, but cannot be published under the new engine.
      await repo.batch([
        {
          sql: 'INSERT INTO runs(id,campaign_id,source_version,engine_version,result_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
          args: [
            'old-review',
            cid,
            view.campaign.version,
            'excel-v21.1.3x-port-1',
            JSON.stringify({ result: { ...view.result, engineVersion: 'excel-v21.1.3x-port-1' } }),
            'chatgpt:owner',
            new Date().toISOString(),
          ],
        },
      ]);
      await assert.rejects(
        service.mutate(cid, { action: 'publish', version: view.campaign.version, runId: 'old-review' }),
        /otro baremo o versión del motor/,
      );
      if (status === 'open') {
        const calculated = await service.mutate(cid, { action: 'calculate', version: view.campaign.version });
        const runs = await repo.all('SELECT * FROM runs WHERE campaign_id=? AND id<>?', [cid, 'old-review']);
        assert.equal(runs.length, 1);
        const snapshot = JSON.parse(runs[0].result_json);
        assert.equal(snapshot.result.scoringVersion, scoringVersion(2027));
        assert.deepEqual(snapshot.config.baseScores, defaultConfig(2027).baseScores);
        assert.deepEqual(snapshot.config.holidays, defaultConfig(2027).holidays);
        assert.deepEqual(snapshot.config.weights, reference.weights);
        const current = policyFor(2027);
        const restore = registerPolicy(2027, {
          ...current,
          scoring: { ...current.scoring!, version: 'next-annual-scoring' },
        });
        try {
          // Same global engine and campaign version, different annual scoring authority.
          await assert.rejects(
            service.mutate(cid, { action: 'publish', version: calculated.campaign.version, runId: runs[0].id }),
            /otra versión del baremo anual/,
          );
        } finally {
          restore();
        }
        const missing = { ...snapshot, result: { ...snapshot.result } };
        delete missing.result.scoringVersion;
        await repo.batch([
          { sql: 'UPDATE runs SET result_json=? WHERE id=?', args: [JSON.stringify(missing), runs[0].id] },
        ]);
        await assert.rejects(
          service.mutate(cid, { action: 'publish', version: calculated.campaign.version, runId: runs[0].id }),
          /otra versión del baremo anual/,
        );
      }
    } finally {
      repo.db.close();
    }
  });
