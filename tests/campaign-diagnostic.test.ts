import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRepo } from './sqlite-repo.ts';
import { exportCampaignDiagnostic } from '../server/campaign-diagnostic.ts';
import { restoreCampaignDiagnostic } from '../scripts/restore-campaign-diagnostic.mjs';
import { diagnosticHash, diagnosticByteLength, DIAGNOSTIC_MAX_BYTES } from '../lib/campaign-diagnostic.mjs';
import type { Principal } from '../server/permissions.ts';
import type { Repository } from '../server/repository.ts';
const actor: Principal = { id: 'qa', role: 'superadmin', teams: [] };
function fixture() {
  const repo = new SQLiteRepo();
  repo.db.exec(`INSERT INTO app_state VALUES('main',10);
 INSERT INTO teams(id,name) VALUES('A','A'),('B','B');
 INSERT INTO people(id,team_id,code,seniority) VALUES('pa','A','QA_A','2000-01-01'),('pb','B','QA_B','2000-01-01');
 INSERT INTO users(id,provider,subject,role) VALUES('qa','test','qa','superadmin');
 INSERT INTO grants(id,user_id,team_id) VALUES('ga','qa','A');
 INSERT INTO campaigns(id,team_id,year,scope_key,created_at) VALUES('a','A',2027,'live','2026-01-01'),('b','B',2027,'live','2026-01-01'),('sim','A',2027,'private','2026-01-01');
 INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority) VALUES('ma','a','pa','QA_A','2000-01-01'),('mb','b','pb','QA_B','2000-01-01'),('ms','sim','pa','QA_A','2000-01-01');
 INSERT INTO parameters(campaign_id,json) VALUES('a','{}'),('b','{}'),('sim','{}');
 INSERT INTO controller_accounts VALUES('pa','test:qa',1);
 INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES('aa','a','ma','2027-01-08'),('ab','b','mb','2027-01-08');
 INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date) VALUES('ra','a','ma',1,'2027-01-08');
 INSERT INTO election_states VALUES('a','{"status":"paused"}');
 INSERT INTO reconstruction_sessions VALUES('a','{"status":"completed","originalAuditIds":["old","new"],"applied":[],"undone":[]}');
 INSERT INTO audit(rowid,id,actor,action,campaign_id,team_id,before_json,after_json,created_at) VALUES
 (11,'old','qa','choose','a','A','{}','{}','2026-01-01'),
 (41,'new','qa','election_undo','a','A','{}','{"undoTargetId":"old"}','2026-01-02'),
 (42,'other','qa','choose','b','B','{}','{}','2026-01-03'),
 (43,'simulation','qa','choose','sim','A','{}','{}','2026-01-04'),
 (50,'team','qa','import_roster',NULL,'A','{}','{}','2026-01-05'),
 (51,'global','qa','permissions',NULL,NULL,'{}','{}','2026-01-06');`);
  for (let i = 0; i < 25; i++)
    repo.db
      .prepare(
        "INSERT INTO runs(id,campaign_id,source_version,engine_version,result_json,created_by,created_at) VALUES(?,'a',1,'qa','{}','qa','2026-01-01')",
      )
      .run('run-' + i);
  repo.db.exec("UPDATE campaigns SET published_run_id='run-0' WHERE id='a'");
  return repo;
}

test('diagnostic round trip preserves full history, rowid gaps, all runs and shared dependencies, no simulations/auth/queues', async () => {
  const repo = fixture(),
    dir = mkdtempSync(path.join(tmpdir(), 'vac-diagnostic-'));
  try {
    const archive = await exportCampaignDiagnostic(repo, actor, 'a');
    assert.deepEqual(
      archive.payload.tables.campaigns.map((r) => r.id),
      ['a'],
    );
    assert.deepEqual(
      archive.payload.tables.audit.map((r) => [r._rowid, r.id]),
      [
        [11, 'old'],
        [41, 'new'],
        [50, 'team'],
      ],
    );
    assert.equal(archive.payload.tables.runs.length, 25);
    assert.equal(archive.payload.tables.people.length, 1);
    const file = path.join(dir, 'new.sqlite');
    await restoreCampaignDiagnostic(archive, file);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [name, rows] of Object.entries(archive.payload.tables)) {
        assert.deepEqual(
          db
            .prepare(`SELECT rowid AS _rowid,* FROM "${name}" ORDER BY rowid`)
            .all()
            .map((r) => ({ ...r })),
          rows.map((r) => ({ ...r })),
          name,
        );
      }
      assert.equal(db.prepare('SELECT count(*) n FROM local_admin_sessions').get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM push_subscriptions').get()!.n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
    assert.equal(existsSync(file + '.partial'), false);
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostic requires superadmin before any query and rejects simulation/missing campaigns', async () => {
  const repo = fixture();
  try {
    for (const role of ['viewer', 'team_admin'] as const) {
      let queried = false;
      const deny: Repository = {
        all: async () => {
          queried = true;
          return [];
        },
        batch: async () => {
          queried = true;
          return [];
        },
      };
      await assert.rejects(exportCampaignDiagnostic(deny, { id: 'qa', role, teams: ['A'] }, 'a'), { status: 403 });
      assert.equal(queried, false);
    }
    await assert.rejects(exportCampaignDiagnostic(repo, actor, 'sim'), { status: 404 });
    await assert.rejects(exportCampaignDiagnostic(repo, actor, 'missing'), { status: 404 });
    await assert.rejects(exportCampaignDiagnostic(repo, actor, "a' OR 1=1 --"), { status: 404 });
  } finally {
    repo.db.close();
  }
});

test('capture is one read batch: same-sized concurrent edits are captured together, not checked against a later revision', async () => {
  const repo = fixture();
  let batches = 0;
  const bridge: Repository = {
    all: (...a) => repo.all(...a),
    batch: async (s) => {
      if (++batches === 2)
        repo.db.exec(
          "BEGIN; UPDATE campaigns SET version=2 WHERE id='a'; UPDATE app_state SET revision=11 WHERE id='main'; UPDATE parameters SET json='{\"n\":2}' WHERE campaign_id='a'; COMMIT;",
        );
      return repo.batch(s);
    },
  };
  // Keep size fixed for the snapshot comparison.
  repo.db.exec("UPDATE parameters SET json='{\"n\":1}' WHERE campaign_id='a'");
  try {
    const a = await exportCampaignDiagnostic(bridge, actor, 'a');
    assert.equal(batches, 2);
    assert.equal(a.payload.tables.campaigns[0].version, 2);
    assert.equal(a.payload.tables.app_state[0].revision, 11);
    assert.equal(a.payload.tables.parameters[0].json, '{"n":2}');
  } finally {
    repo.db.close();
  }
});

test('growth after preflight fails closed in SQL, with no oversized rows returned', async () => {
  const repo = fixture();
  let batches = 0;
  const bridge: Repository = {
    all: (...a) => repo.all(...a),
    batch: async (s) => {
      if (++batches === 2) repo.db.prepare("UPDATE audit SET before_json=? WHERE id='old'").run('x'.repeat(1_900_000));
      const r = await repo.batch(s);
      if (batches === 2) assert.equal(r[10 * 3 + 2].results.length, 0);
      return r;
    },
  };
  try {
    await assert.rejects(exportCampaignDiagnostic(bridge, actor, 'a'), { status: 409 });
  } finally {
    repo.db.close();
  }
});

test('size preflight rejects >24 MB without fetching row payloads', async () => {
  const repo = fixture();
  let batches = 0;
  const put = repo.db.prepare(
    "INSERT INTO audit(id,actor,action,campaign_id,before_json,created_at) VALUES(?,'qa','choose','a',?,'2026-01-01')",
  );
  const text = 'x'.repeat(80_000);
  repo.db.exec('BEGIN');
  for (let i = 0; i < 310; i++) put.run('bulk' + i, text);
  repo.db.exec('COMMIT');
  const bridge: Repository = {
    all: (...a) => repo.all(...a),
    batch: async (s) => {
      batches++;
      return repo.batch(s);
    },
  };
  try {
    await assert.rejects(exportCampaignDiagnostic(bridge, actor, 'a'), { status: 413 });
    assert.equal(batches, 1);
  } finally {
    repo.db.close();
  }
});

test('synthetic >20 MB, giant reconstruction and Unicode round trip', { timeout: 120000 }, async () => {
  const repo = fixture(),
    dir = mkdtempSync(path.join(tmpdir(), 'vac-diagnostic-volume-'));
  try {
    const put = repo.db.prepare(
      "INSERT INTO audit(id,actor,action,campaign_id,before_json,created_at) VALUES(?,'qa','choose','a',?,'2026-01-01')",
    );
    const text = JSON.stringify({ text: 'x'.repeat(80_000) + 'ñ🦉"\\' });
    repo.db.exec('BEGIN');
    for (let i = 0; i < 250; i++) put.run('bulk' + i, text);
    repo.db.exec('COMMIT');
    const recon = JSON.stringify({
      originalEvents: [],
      origin: { text: 'x'.repeat(1_800_000) + 'ñ🦉' },
      applied: [],
      undone: [],
    });
    repo.db.prepare("UPDATE reconstruction_sessions SET json=? WHERE campaign_id='a'").run(recon);
    const archive = await exportCampaignDiagnostic(repo, actor, 'a');
    const n = diagnosticByteLength(archive);
    assert.ok(n > 20_000_000 && n < DIAGNOSTIC_MAX_BYTES);
    const file = path.join(dir, 'volume.sqlite');
    await restoreCampaignDiagnostic(archive, file);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT before_json FROM audit WHERE id='bulk249'").get()!.before_json, text);
      assert.equal(db.prepare("SELECT json FROM reconstruction_sessions WHERE campaign_id='a'").get()!.json, recon);
    } finally {
      db.close();
    }
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore rejects corruption, mismatched scope/schema/FKs, and never clobbers a destination', async () => {
  const repo = fixture(),
    dir = mkdtempSync(path.join(tmpdir(), 'vac-diagnostic-invalid-'));
  try {
    const good = await exportCampaignDiagnostic(repo, actor, 'a');
    const mutations: ((a: typeof good) => void)[] = [
      (a) => {
        a.payload.tables.audit[0].before_json = 'corrupt';
      },
      (a) => {
        a.payload.tables.campaigns[0].scope_key = 'sim';
      },
      (a) => {
        a.payload.columns.people.push('extra');
      },
      (a) => {
        a.payload.tables.awards[0].member_id = 'missing';
      },
      (a) => {
        a.payload.tables.audit[0].campaign_id = 'b';
      },
      (a) => {
        a.payload.tables.people[0]._rowid = 0;
      },
      (a) => {
        a.payload.tables.app_state = [];
      },
      (a) => {
        a.payload.schemaVersion = 'future';
      },
    ];
    for (const [i, mutate] of mutations.entries()) {
      const bad = structuredClone(good);
      mutate(bad);
      if (i !== 0) bad.sha256 = await diagnosticHash(bad.payload);
      const file = path.join(dir, 'bad' + i + '.sqlite');
      await assert.rejects(restoreCampaignDiagnostic(bad, file));
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(file + '.partial'), false);
    }
    const existing = path.join(dir, 'existing.sqlite');
    writeFileSync(existing, 'keep');
    await assert.rejects(restoreCampaignDiagnostic(good, existing), /ya existe/);
    assert.equal(readFileSync(existing, 'utf8'), 'keep');
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema drift fails closed', async () => {
  const repo = fixture();
  try {
    repo.db.exec('ALTER TABLE parameters ADD COLUMN unknown TEXT');
    await assert.rejects(exportCampaignDiagnostic(repo, actor, 'a'), { status: 409 });
  } finally {
    repo.db.close();
  }
});
