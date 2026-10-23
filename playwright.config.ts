import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,retries:0,
  timeout:45_000,expect:{timeout:10_000},
  // En CI los resultados quedan en la consola: sin HTML, vídeos, trazas ni capturas automáticas.
  reporter:process.env.CI?[['list']]:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:5199',...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),trace:process.env.CI?'off':'retain-on-failure',screenshot:process.env.CI?'off':'only-on-failure',video:'off'},
  // Core flows run once on desktop. Only tagged mobile-specific and cross-device regressions run on mobile.
  projects:[{name:'chromium',grepInvert:/@mobile-only/,use:{...devices['Desktop Chrome']}},{name:'mobile',grep:/@mobile-only|@both/,use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
  webServer:{command:'node scripts/e2e-server.mjs',url:'http://127.0.0.1:5199',reuseExistingServer:false,timeout:120_000},
});
