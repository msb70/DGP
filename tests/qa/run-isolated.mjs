import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'docs/validacion-2026-10-10/evidencias');
fs.mkdirSync(out, { recursive: true });
const runtime = path.join(root, 'tests/qa/.runtime');
fs.mkdirSync(runtime, { recursive: true });
const databaseDir = fs.mkdtempSync(path.join(runtime, 'postgres-'));
const cluster = new EmbeddedPostgres({ databaseDir, port: 55439,
  user: 'postgres', password: 'qa-local-only', persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'timezone=America/Panama'],
  onLog: () => {}, onError: () => {} });
const env = { ...process.env, DGP_QA_ISOLATED: '1', PGHOST: '127.0.0.1', PGPORT: '55439',
  PGUSER: 'postgres', PGPASSWORD: 'qa-local-only',
  DENO: path.join(root, 'tests/node_modules/.bin/deno'),
  PATH: path.join(root, 'tests/node_modules/.bin') + path.delimiter + process.env.PATH,
  E2E_OUT: path.join(out, 'e2e') };
const results = [];
async function run(name, cmd, args) {
  console.log(`Ejecutando ${name}…`);
  const log = fs.createWriteStream(path.join(out, `${name}.log`));
  const t = Date.now();
  const child = spawn(cmd, args, { cwd: root, env });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { log.write(b); process.stdout.write(b); });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise(resolve => log.end(resolve));
  results.push({ name, code, ms: Date.now() - t });
  return code;
}
try {
  fs.mkdirSync(runtime, { recursive: true });
  await cluster.initialise(); await cluster.start();
  await run('code-data', process.execPath, ['tests/qa/code-data.mjs']);
  await run('edge', env.DENO, ['test', 'tests/edge']);
  await run('typecheck', env.DENO, ['check', ...['usuarios', 'whatsapp', 'zoho', 'ia'].map(n => `supabase/functions/${n}/index.ts`)]);
  await run('sql', 'bash', ['tests/run-sql-tests.sh']);
  await run('sql-audit', process.execPath, ['tests/qa/sql-audit.mjs']);
  await run('sql-hermes', process.execPath, ['tests/qa/sql-hermes.mjs']);
  await run('e2e', process.execPath, ['tests/e2e/run.mjs']);
} finally {
  fs.writeFileSync(path.join(out, 'ejecucion.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  await cluster.stop();
  // Retain the isolated, ignored cluster files; deletion during shutdown can race WAL cleanup.
}
// async-exit-hook (dependencia de embedded-postgres) llama a process.exit(0) en beforeExit y pisaba process.exitCode:
// la suite terminaba con 0 aunque hubiera fallos. Salida explícita.
const codigo = results.length < 7 || results.some(r => r.code !== 0) ? 1 : 0;
console.log(`\nResumen: ${results.map(r => `${r.name}=${r.code === 0 ? 'ok' : 'FALLA'}`).join(' · ')}`);
process.exit(codigo);
