import pg from 'pg';
import fs from 'node:fs';

// Narrow SQL client for these QA suites, not a general replacement for psql.
const args = process.argv.slice(2);
if (process.env.DGP_QA_ISOLATED !== '1' || process.env.PGHOST !== '127.0.0.1' || process.env.PGPORT !== '55439') {
  throw new Error('Only the isolated QA cluster on 127.0.0.1:55439 is allowed');
}
const get = key => args[args.indexOf(key) + 1];
const database = args.includes('-d') ? get('-d') : 'postgres';
const c = new pg.Client({ database });
await c.connect();
try {
  if (args.includes('--reset')) {
    const db = get('--reset');
    if (!/^dgp_(test|e2e|qa)$/.test(db)) throw new Error('Not an allowed QA database');
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${db}"`);
  } else {
    const sql = args.includes('-f') ? fs.readFileSync(get('-f'), 'utf8').replace(/^\\set ON_ERROR_STOP 1\s*$/m, '') : get('-c');
    if (!sql) throw new Error('Expected -f or -c');
    const result = await c.query(sql);
    for (const r of Array.isArray(result) ? result : [result]) {
      for (const row of r.rows || []) console.log(Object.values(row).map(v => v == null ? '' : typeof v === 'boolean' ? (v ? 't' : 'f') : typeof v === 'object' ? JSON.stringify(v) : v).join('|'));
    }
  }
} finally { await c.end(); }
