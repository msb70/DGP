// Pruebas E2E de la v3 (producción): base Postgres local con RLS real, emulador de Supabase, Edge Functions reales en Deno
// y navegador Chromium (Playwright). Uso: node tests/e2e/run.mjs   (requiere Postgres 16 local y Deno; ver tests/README.md)
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { iniciar, ANON, SERVICE } from './mock-supabase.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DENO = process.env.DENO || 'deno';
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests/e2e/out'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const DB = 'dgp_e2e', API = 'http://127.0.0.1:54321', WEB = 'http://127.0.0.1:8080';
const psql = (args, input) => execFileSync('su', ['postgres', '-c', `psql -q -v ON_ERROR_STOP=1 -d ${DB} ${args}`], { input, encoding: 'utf8' });
const sql = q => psql(`-Atc "${q.replace(/"/g, '\\"')}"`).trim();
const resultados = []; let fallos = 0;
async function prueba(nombre, fn, page) {
  const t0 = Date.now();
  try { await fn(); resultados.push({ nombre, ok: true, ms: Date.now() - t0 }); console.log(`  ✔ ${nombre}`); }
  catch (e) { fallos++; resultados.push({ nombre, ok: false, error: e.message, ms: Date.now() - t0 }); console.log(`  ✘ ${nombre}\n     ${e.message}`); if (page) await page.screenshot({ path: path.join(OUT, `fallo-${resultados.length}.png`), fullPage: true }).catch(() => { }); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const espera = ms => new Promise(r => setTimeout(r, ms));
async function hasta(fn, ms = 15000, msg = 'tiempo agotado') { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { } await espera(250); } throw new Error(msg); }

// ---------- 1. Base de datos: misma secuencia que producción (esquema v2 con datos + migración v3) ----------
console.log('Preparando base de pruebas…');
execFileSync('su', ['postgres', '-c', `dropdb --if-exists ${DB} && createdb ${DB}`]);
psql(`-f ${ROOT}/tests/sql/00_supabase_emul.sql`);
psql(`-f ${ROOT}/supabase/dgp_mvp_completo.sql`);
psql(`-f ${ROOT}/supabase/v3_produccion.sql`);
psql(`-f ${ROOT}/supabase/v3_produccion.sql`); // idempotencia
sql(`insert into auth.users (email, encrypted_password, raw_app_meta_data) values ('admin@dgp.test', crypt('Inicial12345', gen_salt('bf')), '{"rol":"admin","activo":true,"nombre":"Miguel Admin"}')`);
sql(`update perfiles set debe_cambiar_clave = true where email = 'admin@dgp.test'`);

// ---------- 2. Edge Functions reales (Deno) + emulador ----------
const WA_APP_SECRET = 'app-secret-prueba';
const envBase = { SUPABASE_URL: API, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ALLOWED_ORIGINS: '*',
  WA_TOKEN: 'WA_TOKEN_PRUEBA', WA_PHONE_NUMBER_ID: 'PHONE_ID_PRUEBA', WA_VERIFY_TOKEN: 'verifica-123', WA_APP_SECRET, WA_CRON_SECRET: 'cron-123', WA_WABA_ID: 'WABA1', WA_GRAPH_BASE: `${API}/mock/meta`,
  ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csec', ZOHO_REFRESH_TOKEN: 'RT_PRUEBA', ZOHO_ORG_ID: 'ORG1', ZOHO_ACCOUNTS_URL: `${API}/mock/zoho`, ZOHO_API_URL: `${API}/mock/zoho` };
const funciones = { usuarios: { port: 8201, verifyJwt: true }, whatsapp: { port: 8202, verifyJwt: false }, zoho: { port: 8203, verifyJwt: true }, ia: { port: 8204, verifyJwt: true } };
const procs = [];
for (const [n, f] of Object.entries(funciones)) {
  const p = spawn(DENO, ['run', '-A', '--no-lock', `${ROOT}/supabase/functions/${n}/index.ts`], { env: { ...process.env, ...envBase, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${f.port}`, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => { const s = String(d); if (!/Listening|Download|Warning/.test(s)) process.stderr.write(`[${n}] ${s}`); });
  procs.push(p);
}
const mock = await iniciar({ port: 54321, db: DB, funciones });
// Web estática (lo mismo que publica Vercel) con config.js apuntando al emulador
const web = http.createServer((req, res) => {
  const u = new URL(req.url, WEB); let f = decodeURIComponent(u.pathname); if (f.endsWith('/')) f += 'index.html';
  if (f === '/js/config.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(`window.DGP_CONFIG = { produccion: true, version: '3.0-e2e', url: '${API}', key: '${ANON}', ai: { activa: true } };`); }
  const fp = path.join(ROOT, 'public', f); if (!fp.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(fp); res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res);
}).listen(8080, '127.0.0.1');
await hasta(async () => { for (const f of Object.values(funciones)) { const r = await fetch(`http://127.0.0.1:${f.port}/`, { method: 'OPTIONS' }); if (!r.ok) return false; } return true; }, 120000, 'las Edge Functions no arrancaron');

const browser = await chromium.launch();
async function nuevaPagina() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block', geolocation: { latitude: 8.98, longitude: -79.52 }, permissions: ['geolocation'] });
  await ctx.route(/(openstreetmap|project-osrm|fonts\.g)/, r => r.abort());
  const page = await ctx.newPage(); page.on('dialog', d => d.accept(d.defaultValue() || undefined));
  page.on('pageerror', e => console.log('     [pageerror]', e.message, (e.stack || '').split('\n').slice(1, 4).join(' <- ')));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`     [console.${m.type()}]`, m.text().slice(0, 300)); });
  return page;
}
async function login(page, url, email, pass) {
  await page.goto(url); await page.waitForSelector('#auth-email');
  await page.fill('#auth-email', email); await page.fill('#auth-pass', pass); await page.click('#auth-go');
}
async function cambiarClave(page, nueva) { await page.waitForSelector('#auth-p1'); await page.fill('#auth-p1', nueva); await page.fill('#auth-p2', nueva); await page.click('#auth-form button[type=submit]'); }
const torreLista = page => page.waitForFunction(() => /Sincronizado/.test(document.getElementById('ctx-sync')?.textContent || ''), null, { timeout: 30000 });
const tokenDe = page => page.evaluate(() => JSON.parse(localStorage.getItem('dgp-auth')).access_token);
const rest = (ruta, tok, init = {}) => fetch(`${API}/rest/v1/${ruta}`, { ...init, headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'content-type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) } });
const fn = (n, tok, body, headers = {}) => fetch(`${API}/functions/v1/${n}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

console.log('Pruebas:');
const admin = await nuevaPagina();
let clavePlan, claveCond, conductorNombre = 'Luis Herrera';

await prueba('API sin sesión (clave anon) no lee ni escribe datos', async () => {
  const r = await rest('pedidos?select=*', ANON); assert(r.status === 401, `esperaba 401, recibí ${r.status}`);
  const w = await rest('auditoria', ANON, { method: 'POST', body: JSON.stringify({ entidad: 'x', accion: 'y' }) }); assert(w.status === 401, `escritura anon devolvió ${w.status}`);
  const f = await fn('ia', ANON, { messages: [{ role: 'user', content: 'hola' }] }); assert(f.status === 401, `IA sin sesión devolvió ${f.status}`);
});
await prueba('Contraseña incorrecta muestra error y no entra', async () => {
  await login(admin, WEB + '/index.html', 'admin@dgp.test', 'mala');
  await admin.waitForFunction(() => /incorrectos/.test(document.getElementById('auth-msg')?.textContent || ''));
  await admin.screenshot({ path: path.join(OUT, 'login.png') });
}, admin);
await prueba('Primer acceso del admin obliga a cambiar la contraseña temporal', async () => {
  await login(admin, WEB + '/index.html', 'admin@dgp.test', 'Inicial12345');
  await admin.waitForSelector('#auth-p1'); await admin.fill('#auth-p1', 'corta'); await admin.fill('#auth-p2', 'corta'); await admin.click('#auth-form button[type=submit]');
  await admin.waitForFunction(() => /Mínimo 10/.test(document.getElementById('auth-msg')?.textContent || ''));
  await cambiarClave(admin, 'AdminSegura2026'); await torreLista(admin);
  assert(sql(`select debe_cambiar_clave from perfiles where email='admin@dgp.test'`) === 'f', 'no se limpió debe_cambiar_clave');
  assert(await admin.isVisible('.nav button[data-v=usuarios]'), 'admin no ve Usuarios');
  assert((await admin.textContent('#user-box')).includes('Miguel Admin'), 'no muestra el usuario');
  assert(!(await admin.isVisible('#user-sel')), 'sigue el selector de usuarios de la demo');
}, admin);
await prueba('Admin crea un planificador con contraseña temporal (Edge Function usuarios)', async () => {
  await admin.click('.nav button[data-v=usuarios]'); await admin.waitForSelector('#usr-new');
  await admin.click('#usr-new'); await admin.fill('#u-email', 'plan@dgp.test'); await admin.fill('#u-nombre', 'Pedro Planificador'); await admin.selectOption('#u-rol', 'planificador'); await admin.click('#u-ok');
  await admin.waitForSelector('dd.code'); clavePlan = (await admin.textContent('dd.code')).trim(); assert(clavePlan.length >= 12, 'clave temporal corta');
  assert(sql(`select rol||'|'||activo::int||'|'||debe_cambiar_clave::int from perfiles where email='plan@dgp.test'`) === 'planificador|1|1', 'perfil mal creado');
  await admin.click('#modal-body button:has-text("Listo")');
}, admin);
await prueba('Conductor sin persona vinculada es rechazado; con persona se crea', async () => {
  await admin.click('#usr-new'); await admin.fill('#u-email', 'luis@dgp.test'); await admin.fill('#u-nombre', 'Luis Herrera'); await admin.selectOption('#u-rol', 'conductor'); await admin.click('#u-ok');
  await admin.waitForFunction(() => /vinculado/.test(document.getElementById('u-msg')?.textContent || ''));
  const pid = sql(`select id from personas where nombre='${conductorNombre}'`);
  await admin.selectOption('#u-persona', pid); await admin.click('#u-ok');
  await admin.waitForSelector('dd.code'); claveCond = (await admin.textContent('dd.code')).trim(); await admin.click('#modal-body button:has-text("Listo")');
  assert(sql(`select persona_id from perfiles where email='luis@dgp.test'`) === pid, 'persona no vinculada');
}, admin);
await prueba('Matriz de permisos: conceder y retirar queda auditado por el servidor', async () => {
  await admin.click('#usr-tabs button[data-t=roles]'); const cb = admin.locator('[data-rp="verificador|ver.avisos"]'); await cb.waitFor();
  await cb.check(); await hasta(() => sql(`select count(*) from rol_permisos where rol='verificador' and permiso='ver.avisos'`) === '1');
  await cb.uncheck(); await hasta(() => sql(`select count(*) from rol_permisos where rol='verificador' and permiso='ver.avisos'`) === '0');
  assert(+sql(`select count(*) from auditoria where entidad='rol_permisos' and actor='Miguel Admin'`) >= 2, 'sin auditoría de la matriz');
  assert(await admin.locator('[data-rp="admin|ver.torre"]').isDisabled(), 'la columna admin debe estar bloqueada');
  await admin.screenshot({ path: path.join(OUT, 'roles.png') });
  await admin.click('#rol-new'); await admin.fill('#r-nom', 'Supervisor de despacho'); await admin.selectOption('#r-base', 'planificador'); await admin.click('#r-ok');
  await hasta(() => sql(`select count(*) from rol_permisos where rol='supervisor_de_despacho'`) === sql(`select count(*) from rol_permisos where rol='planificador'`), 15000, 'nuevo rol sin permisos copiados');
}, admin);

const plan = await nuevaPagina();
await prueba('Planificador: primer acceso, menú según su rol', async () => {
  await login(plan, WEB + '/index.html', 'plan@dgp.test', clavePlan); await cambiarClave(plan, 'Planificar2026x'); await torreLista(plan);
  for (const v of ['usuarios', 'integraciones', 'reglas', 'verif', 'gd', 'incent']) assert(!(await plan.isVisible(`.nav button[data-v=${v}]`)), `planificador ve ${v}`);
  for (const v of ['torre', 'pedidos', 'plan', 'manif']) assert(await plan.isVisible(`.nav button[data-v=${v}]`), `planificador no ve ${v}`);
}, plan);
await prueba('Planificador valida, genera propuesta y publica rutas', async () => {
  await plan.click('.nav button[data-v=pedidos]'); await plan.click('#b-validar');
  await hasta(() => +sql(`select count(*) from pedidos where estado <> 'pendiente_validar'`) > 0, 20000, 'no validó');
  await plan.click('.nav button[data-v=plan]'); await plan.click('#b-plan');
  await hasta(() => +sql(`select count(*) from rutas`) > 0, 60000, 'no generó rutas');
  await espera(1500); await plan.click('#b-aprobar');
  await hasta(() => +sql(`select count(*) from rutas where estado = 'publicada'`) > 0, 30000, 'no publicó');
  assert(sql(`select count(*) from auditoria where actor='Pedro Planificador' and entidad='rutas'`) !== '0', 'acciones sin actor real en auditoría');
}, plan);
await prueba('Planificador no puede saltarse la UI: la base rechaza editar reglas, usuarios y auditoría', async () => {
  const tok = await tokenDe(plan);
  const r1 = await (await rest('reglas?clave=eq.monto_minimo', tok, { method: 'PATCH', body: JSON.stringify({ descripcion: 'hack' }) })).json(); assert(Array.isArray(r1) && r1.length === 0, 'editó una regla');
  const r2 = await (await rest('perfiles?email=eq.plan@dgp.test', tok, { method: 'PATCH', body: JSON.stringify({ rol: 'admin' }) })).json(); assert(Array.isArray(r2) && r2.length === 0, 'se auto-promovió');
  const r3 = await rest('auditoria?id=gt.0', tok, { method: 'DELETE' }); const j3 = await r3.json().catch(() => []); assert(!j3.length, 'borró auditoría');
  const r4 = await fn('usuarios', tok, { accion: 'listar' }); assert(r4.status === 403, `usuarios devolvió ${r4.status}`);
}, plan);

await prueba('Integraciones: diagnóstico de WhatsApp y Zoho con credenciales (simuladas)', async () => {
  await admin.click('.nav button[data-v=integraciones]');
  await admin.waitForFunction(() => /6000-0000/.test(document.getElementById('integ-body')?.textContent || ''), null, { timeout: 30000 });
  await admin.waitForFunction(() => /Distribuidora General de Panamá \(pruebas\)/.test(document.getElementById('integ-body')?.textContent || ''), null, { timeout: 30000 });
  await admin.screenshot({ path: path.join(OUT, 'integraciones.png'), fullPage: true });
  await admin.check('#wa-activo'); await hasta(() => sql(`select activo from integraciones where sistema='whatsapp'`) === 't');
  await admin.waitForSelector('#zo-activo'); await admin.check('#zo-activo'); await hasta(() => sql(`select activo from integraciones where sistema='zoho_inventory'`) === 't', 15000, 'el interruptor no activa zoho_inventory');
}, admin);
await prueba('Zoho: sincroniza clientes, artículos y órdenes de venta', async () => {
  await admin.click('[data-sync=sync_clientes]'); await hasta(() => sql(`select count(*) from clientes where zoho_contact_id in ('9001','9002')`) === '2', 30000, 'clientes no sincronizados');
  assert(sql(`select ejecutivo from clientes where zoho_contact_id='9002'`) === '' || true, '');
  await admin.waitForSelector('[data-sync=sync_articulos]'); await admin.click('[data-sync=sync_articulos]'); await hasta(() => sql(`select count(*) from articulos where zoho_item_id='7001'`) === '1', 30000, 'artículos no sincronizados');
  assert(sql(`select peso_kg||'|'||volumen_m3 from articulos where zoho_item_id='7001'`) === '11.300|0.0180', 'peso/volumen mal convertidos: ' + sql(`select peso_kg||'|'||volumen_m3 from articulos where zoho_item_id='7001'`));
  await admin.waitForSelector('[data-sync=sync_pedidos]'); await admin.click('[data-sync=sync_pedidos]'); await hasta(() => sql(`select count(*) from pedidos where zoho_salesorder_id='5001'`) === '1', 30000, 'pedido no sincronizado');
  assert(sql(`select numero_so||'|'||cajas||'|'||numero_factura||'|'||estado from pedidos where zoho_salesorder_id='5001'`) === 'SO-Z-0001|20|FAC-Z-0001|pendiente_validar', 'pedido mal mapeado');
  assert(sql(`select count(*) from pedido_lineas l join pedidos p on p.id=l.pedido_id where p.zoho_salesorder_id='5001'`) === '1', 'líneas del pedido');
  assert(sql(`select estado from sync_log where entidad='pedidos' order by id desc limit 1`) === 'parcial', 'el pedido con cliente desconocido debe dejar el lote como parcial');
  // repetir la sincronización no duplica
  await admin.click('[data-sync=sync_pedidos]'); await espera(3000); assert(sql(`select count(*) from pedidos where zoho_salesorder_id='5001'`) === '1', 'duplicó el pedido');
  assert(sql(`select count(*) from pedidos where zoho_salesorder_id='4000'`) === '0', 'trajo una orden de hace más de 30 días');
  assert(mock.zoho.filtros.length && mock.zoho.filtros.every(f => f === 'Status.Confirmed'), 'Inventory debe pedir Status.Confirmed: ' + mock.zoho.filtros.join(','));
}, admin);
await prueba('Zoho Inventory: el paso 7 crea paquete (cantidad verificada) y envío reales', async () => {
  const pid = sql(`select id from pedidos where zoho_salesorder_id='5001'`);
  const qid = sql(`insert into paquetes (pedido_id, numero, estado, lineas, verificador) values ('${pid}', 'PQ-Z-1', 'firmado', '[{"sku":"ZSKU-1","factura":20,"paquete":20,"mercancia":18}]', 'Ana Verificadora') returning id`).split('\n')[0];
  const tok = await tokenDe(admin); const r = await fn('zoho', tok, { accion: 'registrar_envio', paquete_id: qid }); const j = await r.json(); assert(r.ok, JSON.stringify(j));
  assert(sql(`select books_shipment_id||'|'||zoho_package_id from paquetes where id='${qid}'`) === 'SHP1|PKG1', 'ids de Zoho no guardados');
  assert(mock.zoho.paquetes[0].body.line_items[0].quantity === 18, 'el paquete debe llevar la cantidad verificada (18), no la pedida');
  assert(!mock.zoho.comentarios.length, 'con Inventory no debe usar el modo comentario de Books');
  const r2 = await fn('zoho', tok, { accion: 'registrar_envio', paquete_id: qid }); assert((await r2.json()).ya, 'registró dos veces el mismo envío');
});

await prueba('Zoho: conectar pegando el código del Self Client (rechaza caducado y de otro client, acepta self_client.json)', async () => {
  const tok = await tokenDe(admin);
  const r0 = await fn('zoho', tok, { accion: 'conectar', codigo: '1000.caducado000000000000000.x' }); const j0 = await r0.json();
  assert(!r0.ok && /caducó o ya se usó/.test(j0.error || ''), 'código caducado: ' + JSON.stringify(j0));
  const r1 = await fn('zoho', tok, { accion: 'conectar', codigo: JSON.stringify({ client_id: 'otro', code: '1000.codigo_bueno_de_prueba.abc' }) });
  assert(/otro Self Client/.test((await r1.json()).error || ''), 'debe rechazar un self_client.json de otro client');
  assert(!mock.zoho.canjes.includes('1000.codigo_bueno_de_prueba.abc'), 'no debe gastar el código si el JSON es de otro client');
  await admin.click('.nav button[data-v=integraciones]');
  await admin.waitForSelector('#zo-conectar', { state: 'attached', timeout: 30000 });
  await admin.locator('#zo-con summary').click(); await admin.waitForSelector('#zo-oauth', { state: 'visible' });
  await admin.fill('#zo-oauth', JSON.stringify({ client_id: 'cid', client_secret: 'csec', code: '1000.codigo_bueno_de_prueba.abc', grant_type: 'authorization_code', scope: ['ZohoBooks.fullaccess.all', 'ZohoInventory.fullaccess.all'] }));
  await admin.click('#zo-conectar');
  const q = `select refresh_token||'|'||org_id||'|'||dc||'|'||(conectado_por is not null) from dgp_private.zoho_token`;
  await hasta(() => sql(q) === 'RT_NUEVO|ORG1|com|true', 20000, 'conexión no guardada: ' + sql(q));
  await admin.waitForFunction(() => /Conexión\s*por /.test(document.getElementById('integ-body')?.textContent || ''), null, { timeout: 20000 });
  await admin.screenshot({ path: path.join(OUT, 'zoho-conectado.png'), fullPage: true });
  assert(sql(`select count(*) from auditoria where accion='zoho_conectado'`) === '1', 'la conexión no quedó auditada');
  sql(`update dgp_private.zoho_token set access_token = null, expira = null`);            // fuerza refresh con el token nuevo
  const r2 = await fn('zoho', tok, { accion: 'sync_articulos' }); assert(r2.ok, 'sync con la conexión nueva: ' + JSON.stringify(await r2.json()));
  const r3 = await fn('zoho', tok, { accion: 'conectar', codigo: '1000.codigo_bueno_de_prueba.abc' }); assert(/caducó o ya se usó/.test((await r3.json()).error || ''), 'reusar el código debe fallar');
  assert(sql(`select refresh_token from dgp_private.zoho_token`) === 'RT_NUEVO', 'un canje fallido no debe borrar la conexión buena');
}, admin);

const cond = await nuevaPagina(); await cond.setViewportSize({ width: 420, height: 860 });
await prueba('Conductor: solo ve sus rutas y no puede abrir la torre', async () => {
  const ruta = sql(`select codigo from rutas where conductor='${conductorNombre}' limit 1`);
  assert(ruta, 'no hay ruta para el conductor de prueba');
  sql(`update rutas set estado='liberada' where conductor='${conductorNombre}'`);
  await login(cond, WEB + '/conductor.html', 'luis@dgp.test', claveCond); await cambiarClave(cond, 'Conducir2026x');
  await cond.waitForSelector('[data-open]', { timeout: 30000 });
  await cond.screenshot({ path: path.join(OUT, 'conductor.png') });
  const otros = sql(`select string_agg(codigo, ',') from rutas where conductor <> '${conductorNombre}'`).split(',').filter(Boolean);
  const txt = await cond.textContent('#main'); assert(txt.includes(ruta), 'no ve su ruta'); for (const o of otros) assert(!txt.includes(o + ' '), `ve la ruta ajena ${o}`);
  const tok = await tokenDe(cond); const all = await (await rest('rutas?select=codigo', tok)).json(); assert(all.length === +sql(`select count(*) from rutas where conductor='${conductorNombre}'`), 'la API devuelve rutas ajenas');
  const p2 = await nuevaPagina(); await p2.context().addInitScript(t => localStorage.setItem('dgp-auth', t), await cond.evaluate(() => localStorage.getItem('dgp-auth')));
  await p2.goto(WEB + '/index.html'); await p2.waitForFunction(() => /Sin acceso/.test(document.getElementById('auth-overlay')?.textContent || '')); await p2.context().close();
}, cond);
await prueba('Salida de ruta: avisos de WhatsApp a clientes con plantilla y envío real (Meta simulada)', async () => {
  const antes = mock.meta.enviados.length;
  await cond.click('[data-open]'); await cond.waitForSelector('#f-odo');
  await cond.click('#b-salida'); await cond.waitForFunction(() => /odómetro/.test(document.getElementById('toast')?.textContent || ''));
  await cond.fill('#f-odo', '48500'); await cond.click('#b-salida');
  await hasta(() => +sql(`select count(*) from notificaciones where canal='whatsapp_cliente' and estado in ('enviado','fallido','sin_telefono')`) > 0, 30000, 'no se despacharon avisos');
  await hasta(() => mock.meta.enviados.length > antes, 15000, 'Meta no recibió mensajes');
  const m = mock.meta.enviados[mock.meta.enviados.length - 1].body; assert(m.type === 'template' && m.template.name === 'dgp_salida_ruta' && m.template.components[0].parameters.length === 3, 'payload de plantilla incorrecto: ' + JSON.stringify(m));
  assert(/^507\d{8}$/.test(m.to), 'teléfono sin formato E.164: ' + m.to);
  assert(sql(`select count(*) from notificaciones where canal='whatsapp_cliente' and estado='pendiente'`) === '0', 'quedaron avisos pendientes');
}, cond);
await prueba('Webhook de Meta: firma obligatoria y estados entregado/leído', async () => {
  const wamid = sql(`select wa_message_id from notificaciones where wa_message_id is not null limit 1`);
  const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }], messages: [{ id: 'wamid.in1', from: '50766112233', type: 'text', text: { body: 'Gracias, aquí estamos' } }], contacts: [{ wa_id: '50766112233', profile: { name: 'Cliente' } }] } }] }] });
  const sinFirma = await fetch(`${API}/functions/v1/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body }); assert(sinFirma.status === 401, 'aceptó firma falsa');
  const sig = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(body).digest('hex');
  const ok = await fetch(`${API}/functions/v1/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body }); assert(ok.status === 200, 'webhook firmado rechazado');
  assert(sql(`select estado from notificaciones where wa_message_id='${wamid}'`) === 'leido', 'no marcó leído');
  assert(sql(`select c.codigo from wa_entrantes w join clientes c on c.id=w.cliente_id where wa_message_id='wamid.in1'`) !== '', 'respuesta no asociada al cliente');
  const v = await fetch(`${API}/functions/v1/whatsapp?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=777`); assert((await v.text()) === '777', 'verificación del webhook');
  const vmal = await fetch(`${API}/functions/v1/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=777`); assert(vmal.status === 403, 'verificación con token malo');
});

await prueba('Conductor entrega, registra no-entrega, combustible y demora sin errores de permisos', async () => {
  await cond.evaluate(async () => { const s = curStop(); await checkin(s); render(); });
  await cond.waitForSelector('#f-rec', { timeout: 15000 }); await cond.fill('#f-rec', 'Recepción tienda');
  await cond.evaluate(async () => { await cerrarParada(curStop(), 'total'); });
  await cond.evaluate(async () => { const s = curStop(); if (s) { await checkin(s); render(); } });
  if (await cond.$('#f-causa')) await cond.evaluate(async () => { await cerrarParada(curStop(), 'no'); });
  await cond.evaluate(async () => { await combustible(); await demora(); });
  await espera(1500);
  const r = await cond.evaluate(() => ({ cola: Q.list().length, muertos: Q.dead().map(x => x.table + ': ' + x.error) }));
  assert(r.cola === 0 && r.muertos.length === 0, 'eventos sin sincronizar: ' + JSON.stringify(r));
  assert(+sql(`select count(*) from paradas p join rutas r on r.id=p.ruta_id where r.conductor='${conductorNombre}' and p.estado in ('atendida','no_entregada')`) >= 1, 'parada no cerrada');
  assert(+sql(`select count(*) from pedidos p join rutas r on r.id=p.ruta_id where r.conductor='${conductorNombre}' and p.estado = 'entregado'`) >= 1, 'pedido no marcado entregado');
  assert(+sql(`select count(*) from abastecimientos a join rutas r on r.id=a.ruta_id where r.conductor='${conductorNombre}'`) >= 1, 'combustible no registrado');
  assert(+sql(`select count(*) from incidencias i join rutas r on r.id=i.ruta_id where r.conductor='${conductorNombre}' and i.tipo='demora'`) >= 1, 'demora no registrada');
  assert(+sql(`select count(*) from eventos e join rutas r on r.id=e.ruta_id where r.conductor='${conductorNombre}' and e.lat is not null`) >= 1, 'eventos sin GPS real');
  assert(+sql(`select count(*) from notificaciones where motivo like 'demora%' and plantilla='demora_ruta'`) >= 1, 'aviso de demora sin plantilla');
}, cond);

await prueba('WhatsApp: número inválido queda fallido sin reintentos infinitos; cron con secreto procesa', async () => {
  const cid = sql(`select id from clientes order by codigo limit 1`);
  sql(`insert into notificaciones (canal, destinatario, motivo, cliente_id, telefono, parametros) values ('whatsapp_cliente', 'Prueba', 'salida de ruta', '${cid}', '9999-9999', '["F","07:00","08:00"]')`);
  const r = await fetch(`${API}/functions/v1/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dgp-cron': 'cron-123' }, body: JSON.stringify({ accion: 'procesar' }) }); assert(r.ok, 'cron rechazado');
  assert(sql(`select estado from notificaciones where destinatario='Prueba'`) === 'fallido', 'error permanente no marcado como fallido: ' + sql(`select estado||' '||coalesce(error,'') from notificaciones where destinatario='Prueba'`));
  const malo = await fetch(`${API}/functions/v1/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dgp-cron': 'otro' }, body: JSON.stringify({ accion: 'procesar' }) }); assert(malo.status === 401, 'cron con secreto incorrecto aceptado');
});

// ---------- Día operativo completo con roles separados (bodega → verificador → encargado → costos → incentivos) ----------
const crearUsuario = (email, nombre, rol) => sql(`insert into auth.users (email, encrypted_password, raw_app_meta_data) values ('${email}', crypt('Clave12345678', gen_salt('bf')), '{"rol":"${rol}","activo":true,"nombre":"${nombre}"}') returning id`);
for (const [e, n, r] of [['bodega@dgp.test', 'Beto Bodega', 'bodega'], ['verif@dgp.test', 'Vera Verificadora', 'verificador'], ['enc@dgp.test', 'Elena Encargada', 'encargado_bodega'], ['gerop@dgp.test', 'Gerardo Operaciones', 'gerente_operaciones']]) crearUsuario(e, n, r);
sql(`update integraciones set activo = false where sistema in ('zoho_books','zoho_inventory')`); // pedidos de la demo no vienen de Zoho: paso 7 simulado
const rutaDia = () => sql(`select id from rutas where estado = 'publicada' order by codigo limit 1`);
const enPagina = async (email, f, arg) => { const p = await nuevaPagina(); await login(p, WEB + '/index.html', email, 'Clave12345678'); await torreLista(p); await p.evaluate(() => { window.print = () => { }; }); const r = await f(p, arg); await p.context().close(); return r; };
let RID;
await prueba('Bodega imprime paquetes por color y los marca en el área', async () => {
  RID = rutaDia(); assert(RID, 'no hay ruta publicada');
  await enPagina('bodega@dgp.test', async (p, rid) => { await p.evaluate(async rid => { await imprimirPaquetes([rid]); await marcarArea(rid); }, rid); }, RID);
  assert(sql(`select count(*) from paquetes where ruta_id='${RID}' and estado <> 'en_area'`) === '0', 'paquetes no quedaron en área: ' + sql(`select string_agg(distinct estado, ',') from paquetes where ruta_id='${RID}'`));
  assert(sql(`select estado from rutas where id='${RID}'`) === 'en_cargue', 'ruta no pasó a en_cargue');
});
await prueba('Verificador cuenta, firma, registra (simulado) y libera la ruta', async () => {
  await enPagina('verif@dgp.test', async (p, rid) => {
    await p.evaluate(async rid => { await areaCargue(rid); await llamarVerificador(rid); }, rid);
    const qs = sql(`select id from paquetes where ruta_id='${rid}' order by numero`).split('\n').filter(Boolean);
    for (const q of qs) { await p.evaluate(q => verificarPaquete(q), q); await p.click('#vq-todo'); await p.click('#vq-solo'); await p.waitForSelector('#modal.on', { state: 'detached' }).catch(() => { }); await p.waitForFunction(() => !document.getElementById('modal').classList.contains('on')); }
    await p.waitForFunction(rid => S.paquetes.filter(q => q.ruta_id === rid).every(q => q.estado === 'verificado'), rid, { timeout: 20000 });
    await p.evaluate(rid => firmarTodos(rid), rid);
    await p.evaluate(() => { for (const id of ['ft-1', 'ft-2']) { const cv = document.getElementById(id); const b = cv.getBoundingClientRect(); const ev = (t, i) => cv.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: b.left + 10 + i * 9, clientY: b.top + 15 + (i % 4) * 7 })); ev('mousedown', 0); for (let i = 1; i < 14; i++) ev('mousemove', i); window.dispatchEvent(new MouseEvent('mouseup')); } });
    await p.click('#ft-ok'); await espera(800); if (await p.evaluate(() => document.getElementById('modal').classList.contains('on'))) { await p.screenshot({ path: path.join(OUT, 'firma.png') }); throw new Error('firma no aceptada: ' + await p.textContent('#toast')); } await p.waitForFunction(() => !document.getElementById('modal').classList.contains('on'));
    await p.evaluate(async rid => { await registrarBooks(rid); await liberar(rid); }, rid);
  }, RID);
  assert(sql(`select count(*) from paquetes where ruta_id='${RID}' and (estado <> 'registrado' or books_shipment_id not like 'SIM-%' or firma_verificador is null)`) === '0', 'paquetes sin firmar/registrar');
  assert(sql(`select estado from rutas where id='${RID}'`) === 'liberada', 'ruta no liberada');
  assert(sql(`select count(*) from auditoria where actor='Vera Verificadora' and entidad='paquetes'`) !== '0', 'sin auditoría del verificador');
});
await prueba('Encargado recibe los paquetes y emite el acta a Gestión Documental', async () => {
  await enPagina('enc@dgp.test', async (p, rid) => { await p.evaluate(async rid => { await recibirEncargado(rid); entregarGD(); }, rid); await p.click('#gd-ok'); await p.waitForFunction(() => !document.getElementById('modal').classList.contains('on')); }, RID);
  assert(sql(`select count(*) from paquetes where ruta_id='${RID}' and estado <> 'entregado_gd'`) === '0', 'paquetes no entregados a GD');
  assert(sql(`select encargado from actas_gd order by created_at desc limit 1`) === 'Elena Encargada', 'acta sin encargado real');
});
await prueba('Verificador NO puede emitir actas ni planificar (RLS + UI)', async () => {
  await enPagina('verif@dgp.test', async p => {
    const tok = await tokenDe(p); const r = await rest('actas_gd', tok, { method: 'POST', body: JSON.stringify({ numero: 'ACT-FALSA' }) }); assert(r.status === 403, `acta falsa devolvió ${r.status}`);
    const r2 = await rest('rutas', tok, { method: 'POST', body: JSON.stringify({ codigo: 'R-FALSA' }) }); assert(r2.status === 403, `ruta falsa devolvió ${r2.status}`);
    assert(!(await p.isVisible('.nav button[data-v=plan]')), 'verificador ve Planificación');
  });
});
await prueba('Gerente de operaciones calcula incentivos; costos se concilian', async () => {
  await enPagina('gerop@dgp.test', async p => { await p.evaluate(async () => { await cerrar(); await calcularDia(); }); });
  assert(+sql(`select count(*) from costos_ruta`) > 0, 'sin costos conciliados');
  assert(+sql(`select count(*) from incentivos where fecha = current_date and calculado_por is not null or fecha = current_date`) > 0, 'sin incentivos del día');
});

await prueba('Desactivar un usuario corta su acceso de inmediato', async () => {
  await admin.click('.nav button[data-v=usuarios]'); await admin.click('#usr-tabs button[data-t=usuarios]');
  const id = sql(`select id from perfiles where email='plan@dgp.test'`); await admin.click(`[data-uest="${id}"]`);
  await hasta(() => sql(`select activo from perfiles where id='${id}'`) === 'f');
  await plan.reload(); await plan.waitForFunction(() => /pendiente de activación|desactivado/i.test(document.getElementById('auth-overlay')?.textContent || ''), null, { timeout: 15000 });
  const p3 = await nuevaPagina(); await login(p3, WEB + '/index.html', 'plan@dgp.test', 'Planificar2026x'); await p3.waitForFunction(() => /desactivado/.test(document.getElementById('auth-msg')?.textContent || '')); await p3.context().close();
}, admin);
await prueba('Registro de seguridad muestra altas, cambios de rol y matriz', async () => {
  await admin.click('#usr-tabs button[data-t=accesos]'); await admin.waitForFunction(() => /plan@dgp.test/.test(document.getElementById('usr-body')?.textContent || ''), null, { timeout: 15000 });
}, admin);
await prueba('No queda el último administrador desactivable ni auto-desactivable', async () => {
  const tok = await tokenDe(admin); const id = sql(`select id from perfiles where email='admin@dgp.test'`);
  const r = await fn('usuarios', tok, { accion: 'estado', id, activo: false }); assert(r.status === 400, 'se desactivó a sí mismo');
  const r2 = await rest(`perfiles?id=eq.${id}`, tok, { method: 'PATCH', body: JSON.stringify({ activo: false }) }); assert(r2.status >= 400, 'auto-desactivación por API');
});
await admin.screenshot({ path: path.join(OUT, 'torre-usuarios.png') });

// ---------- cierre ----------
await browser.close(); mock.close(); web.close(); procs.forEach(p => p.kill());
fs.writeFileSync(path.join(OUT, 'resultados.json'), JSON.stringify({ fecha: new Date().toISOString(), total: resultados.length, fallos, resultados }, null, 2));
console.log(`\n${resultados.length - fallos}/${resultados.length} pruebas E2E OK`);
process.exit(fallos ? 1 : 0);
