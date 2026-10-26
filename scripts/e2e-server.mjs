import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// Fixed loopback port and separate storage: never reuse a developer or production DB.
process.env.VACACIONES_E2E = '1';
// Each run gets fresh sessions/throttles as well as fresh business fixtures.
const statePath = '.sites-runtime/e2e-state/run-' + randomUUID();
process.env.VACACIONES_E2E_STATE = statePath;
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
process.env.WRANGLER_WRITE_LOGS = 'false';
process.env.WRANGLER_LOG_PATH = '.sites-runtime/e2e-logs';
process.env.WRANGLER_REGISTRY_PATH = '.sites-runtime/e2e-registry';
const config = '.sites-runtime/e2e-wrangler.json';
mkdirSync('.sites-runtime', { recursive: true });
writeFileSync(
  config,
  JSON.stringify({
    name: 'vacaciones-e2e',
    compatibility_date: '2026-05-15',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'e2e',
        database_id: '00000000-0000-4000-8000-000000000000',
        migrations_dir: '../drizzle',
      },
    ],
  }),
);
writeFileSync('.sites-runtime/e2e-latest-state.txt', statePath);
const result = spawnSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    config,
    '--persist-to',
    statePath,
  ],
  { stdio: 'inherit', env: process.env },
);
if (result.status !== 0) process.exit(result.status ?? 1);
process.argv = [
  process.execPath,
  'node_modules/vinext/dist/cli.js',
  'dev',
  '--host',
  '127.0.0.1',
  '--port',
  '5199',
  '--strictPort',
];
await import('../node_modules/vinext/dist/cli.js');
