// Emulador local de Supabase para pruebas E2E (NO es código de producción).
// Implementa el subconjunto que usan la app y las Edge Functions:
//   /rest/v1  → PostgREST (select, filtros eq/neq/gt/gte/lt/lte/like/ilike/in/is/not.in, or, order, offset/limit,
//               insert, upsert on_conflict, update, delete, rpc) ejecutado con SET ROLE + request.jwt.claims (RLS real)
//   /auth/v1  → GoTrue (password, refresh, user, logout, recover, admin users, invite)
//   /functions/v1/<nombre> → proxy a las Edge Functions reales corriendo en Deno
//   /mock/meta, /mock/zoho → API de WhatsApp Cloud y Zoho simuladas (registran lo que reciben)
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

export const JWT_SECRET = 'secreto-de-pruebas-dgp-local-0123456789';
const b64u = b => Buffer.from(b).toString('base64url');
export function firmar(payload) { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64u(JSON.stringify(payload)); const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url'); return `${h}.${p}.${s}`; }
function verificar(tok) { try { const [h, p, s] = tok.split('.'); const ok = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url'); if (ok !== s) return null; const c = JSON.parse(Buffer.from(p, 'base64url')); if (c.exp && c.exp < Date.now() / 1000) return null; return c; } catch { return null; } }
// App de Meta simulada para la conexión desde la plataforma (token de usuario del sistema + clave secreta de la app)
export const META_APP = { id: 'APP1', nombre: 'DGP Torre (pruebas)', secreto: '0123456789abcdef0123456789abcdef',
  token: 'EAA' + 'DGPpruebaUsuarioDelSistema'.repeat(5), sinPermisos: 'EAA' + 'SinPermisosDeWhatsApp00'.repeat(5) };
export const ANON = firmar({ role: 'anon', iss: 'supabase', iat: 1, exp: 4102444800 });
export const SERVICE = firmar({ role: 'service_role', iss: 'supabase', iat: 1, exp: 4102444800 });

export function iniciar({ port = 54321, db = 'dgp', funciones = {} } = {}) {
  const pool = new pg.Pool({ host: process.env.PGHOST || '127.0.0.1', port: +(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres', database: db, max: 10 });
  const colTipos = {}; // tabla → {col: data_type}
  const refresh = new Map();
  const meta = { suscripciones: [], wabaSuscritas: [], proofs: 0, enviados: [], plantillas: [{ name: 'dgp_salida_ruta', status: 'APPROVED', language: 'es' }, { name: 'dgp_demora_ruta', status: 'APPROVED', language: 'es' }] };
  const zoho = { canjes: [], llamadas: [], paquetes: [], envios: [], comentarios: [], campos: [], filtros: [] };

  async function tipos(t) {
    if (colTipos[t]) return colTipos[t];
    const r = await pool.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1`, [t]);
    colTipos[t] = Object.fromEntries(r.rows.map(x => [x.column_name, x.data_type])); return colTipos[t];
  }
  const qi = s => '"' + String(s).replace(/"/g, '""') + '"';

  // ---------- filtros PostgREST ----------
  function splitTop(s) { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; }
  function cond(col, expr, params) {
    let neg = false; if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
    const i = expr.indexOf('.'); const op = expr.slice(0, i); let val = expr.slice(i + 1);
    let sql;
    const p = v => { params.push(v); return '$' + params.length; };
    if (op === 'in') { const items = splitTop(val.replace(/^\(|\)$/g, '')).map(x => x.replace(/^"|"$/g, '')); sql = `${qi(col)}::text = any(${p(items)}::text[])`; }
    else if (op === 'is') sql = `${qi(col)} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
    else if (op === 'like' || op === 'ilike') sql = `${qi(col)}::text ${op} ${p(val.replace(/\*/g, '%'))}`;
    else { const m = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]; if (!m) throw Object.assign(new Error('operador no soportado ' + op), { code: 'PGRST100' }); sql = `${qi(col)} ${m} ${p(val)}`; }
    return neg ? `not (${sql})` : sql;
  }
  function orExpr(s, params) { return '(' + splitTop(s.replace(/^\(|\)$/g, '')).map(part => { const i = part.indexOf('.'); return cond(part.slice(0, i), part.slice(i + 1), params); }).join(' or ') + ')'; }
  function where(q, params) {
    const w = []; const skip = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
    for (const [k, v] of q) { if (skip.has(k)) continue; if (k === 'or') w.push(orExpr(v, params)); else w.push(cond(k, v, params)); }
    return w.length ? ' where ' + w.join(' and ') : '';
  }
  function orderBy(q) { const o = q.get('order'); if (!o) return ''; return ' order by ' + o.split(',').map(x => { const [c, d, n] = x.split('.'); return `${qi(c)} ${d === 'desc' ? 'desc' : 'asc'}${n === 'nullsfirst' ? ' nulls first' : n === 'nullslast' ? ' nulls last' : ''}`; }).join(', '); }
  const sel = q => { const s = q.get('select') || '*'; return s === '*' ? '*' : s.split(',').map(qi).join(', '); };
  async function valor(t, c, v) { const ty = (await tipos(t))[c]; if (v !== null && typeof v === 'object' && (ty === 'jsonb' || ty === 'json')) return JSON.stringify(v); return v; }

  async function conRol(claims, fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const rol = claims.role === 'service_role' ? 'service_role' : claims.role === 'authenticated' ? 'authenticated' : 'anon';
      await c.query(`set local role ${rol}`); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const r = await fn(c); await c.query('commit'); return r;
    } catch (e) { await c.query('rollback').catch(() => { }); throw e; } finally { c.release(); }
  }
  function pgErr(res, e, claims) {
    const code = e.code || 'XX000';
    const status = code === '42501' ? (claims.role === 'anon' ? 401 : 403) : code === 'PGRST116' ? 406 : code.startsWith('23') ? 409 : 400;
    send(res, status, { code, message: e.message, details: e.detail || null, hint: e.hint || null });
  }

  async function rest(req, res, url, claims, body) {
    const parts = url.pathname.replace('/rest/v1/', '').split('/'); const q = url.searchParams;
    const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
    const prefer = req.headers.prefer || '';
    const devolver = rows => { if (single) { if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned`, details: `The result contains ${rows.length} rows` }); return send(res, 200, rows[0]); } send(res, req.method === 'POST' && !parts[0].startsWith('rpc') ? 201 : 200, rows); };
    try {
      if (parts[0] === 'rpc') {
        const fn = parts[1]; const args = body || {};
        const info = await pool.query(`select p.proretset, pg_get_function_result(p.oid) r from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [fn]);
        if (!info.rows.length) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
        const keys = Object.keys(args); const params = keys.map(k => args[k] !== null && typeof args[k] === 'object' && (!Array.isArray(args[k]) || args[k].some(x => x !== null && typeof x === 'object')) ? JSON.stringify(args[k]) : args[k]);
        const call = `public.${qi(fn)}(${keys.map((k, i) => `${qi(k)} => $${i + 1}`).join(', ')})`;
        const r = await conRol(claims, c => c.query(info.rows[0].proretset ? `select * from ${call}` : `select ${call} as v`, params));
        if (info.rows[0].proretset) return devolver(r.rows);
        return send(res, 200, r.rows[0].v === undefined ? null : r.rows[0].v);
      }
      const t = parts[0];
      if (req.method === 'GET') {
        const params = []; let sql = `select ${sel(q)} from public.${qi(t)}${where(q, params)}${orderBy(q)}`;
        if (q.get('limit')) sql += ` limit ${+q.get('limit')}`; if (q.get('offset')) sql += ` offset ${+q.get('offset')}`;
        const r = await conRol(claims, c => c.query(sql, params)); return devolver(r.rows);
      }
      if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body]; const out = [];
        const onc = q.get('on_conflict'); const merge = /resolution=merge-duplicates/.test(prefer); const ignore = /resolution=ignore-duplicates/.test(prefer);
        await conRol(claims, async c => {
          for (const r0 of rows) {
            const cols = Object.keys(r0); const vals = []; for (const k of cols) vals.push(await valor(t, k, r0[k]));
            let sql = `insert into public.${qi(t)} (${cols.map(qi).join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`;
            if (merge || ignore) { const conf = onc || 'id'; const upd = cols.filter(k => !conf.split(',').includes(k)); sql += ` on conflict (${conf.split(',').map(qi).join(',')}) ` + (ignore || !upd.length ? 'do nothing' : 'do update set ' + upd.map(k => `${qi(k)} = excluded.${qi(k)}`).join(', ')); }
            if (!cols.length) sql = `insert into public.${qi(t)} default values`;
            const rep = /return=representation/.test(prefer); const r = await c.query(sql + (rep ? ' returning *' : ''), vals); if (rep) out.push(...r.rows); // como PostgREST: sin RETURNING en return=minimal (no exige política SELECT)
          }
        });
        return /return=representation/.test(prefer) ? devolver(out) : send(res, 201, null);
      }
      if (req.method === 'PATCH') {
        const cols = Object.keys(body || {}); const params = []; for (const k of cols) params.push(await valor(t, k, body[k]));
        const set = cols.map((k, i) => `${qi(k)} = $${i + 1}`).join(', ');
        const rep = /return=representation/.test(prefer); const r = await conRol(claims, c => c.query(`update public.${qi(t)} set ${set}${where(q, params)}${rep ? ' returning *' : ''}`, params));
        return /return=representation/.test(prefer) ? devolver(r.rows) : send(res, 204, null);
      }
      if (req.method === 'DELETE') {
        const params = []; const rep = /return=representation/.test(prefer); const r = await conRol(claims, c => c.query(`delete from public.${qi(t)}${where(q, params)}${rep ? ' returning *' : ''}`, params));
        return /return=representation/.test(prefer) ? devolver(r.rows) : send(res, 204, null);
      }
      send(res, 405, { message: 'método' });
    } catch (e) { pgErr(res, e, claims); }
  }

  // ---------- GoTrue ----------
  const userJson = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, last_sign_in_at: u.last_sign_in_at, app_metadata: u.raw_app_meta_data || {}, user_metadata: u.raw_user_meta_data || {}, banned_until: u.banned_until, created_at: u.created_at, updated_at: u.created_at, identities: [] });
  function sesion(u) {
    const now = Math.floor(Date.now() / 1000), exp = now + 3600;
    const access_token = firmar({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp, iat: now, app_metadata: u.raw_app_meta_data || {}, user_metadata: u.raw_user_meta_data || {} });
    const rt = crypto.randomBytes(16).toString('hex'); refresh.set(rt, u.id);
    return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user: userJson(u) };
  }
  async function auth(req, res, url, claims, body) {
    const p = url.pathname.replace('/auth/v1', '');
    const err = (s, m, code) => send(res, s, { error: code || 'invalid_grant', error_description: m, msg: m, code: s });
    if (p === '/token' && url.searchParams.get('grant_type') === 'password') {
      const r = await pool.query(`select * from auth.users where lower(email)=lower($1) and encrypted_password is not null and encrypted_password = crypt($2, encrypted_password)`, [body.email, body.password]);
      const u = r.rows[0]; if (!u) return err(400, 'Invalid login credentials');
      if (u.banned_until && new Date(u.banned_until) > new Date()) return err(400, 'User is banned', 'user_banned');
      await pool.query('update auth.users set last_sign_in_at = now() where id=$1', [u.id]);
      return send(res, 200, sesion(u));
    }
    if (p === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = refresh.get(body.refresh_token); if (!id) return err(400, 'Invalid Refresh Token');
      const u = (await pool.query('select * from auth.users where id=$1', [id])).rows[0]; return send(res, 200, sesion(u));
    }
    if (p === '/user' && req.method === 'GET') { if (!claims.sub) return err(401, 'invalid JWT', 'bad_jwt'); const u = (await pool.query('select * from auth.users where id=$1', [claims.sub])).rows[0]; return u ? send(res, 200, userJson(u)) : err(404, 'User not found'); }
    if (p === '/user' && req.method === 'PUT') { if (!claims.sub) return err(401, 'invalid JWT'); if (body.password) { if (String(body.password).length < 8) return err(422, 'Password should be at least 8 characters', 'weak_password'); await pool.query(`update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id=$1`, [claims.sub, body.password]); } const u = (await pool.query('select * from auth.users where id=$1', [claims.sub])).rows[0]; return send(res, 200, userJson(u)); }
    if (p === '/logout') return send(res, 204, null);
    if (p === '/recover') return send(res, 200, {});
    // admin (solo service_role)
    if (p.startsWith('/admin/') || p === '/invite') {
      if (claims.role !== 'service_role') return err(403, 'User not allowed', 'not_admin');
      if (p === '/admin/users' && req.method === 'GET') { const r = await pool.query('select * from auth.users order by created_at'); return send(res, 200, { users: r.rows.map(userJson), aud: 'authenticated' }); }
      if ((p === '/admin/users' && req.method === 'POST') || p === '/invite') {
        const ex = await pool.query('select 1 from auth.users where lower(email)=lower($1)', [body.email]); if (ex.rows.length) return err(422, 'A user with this email address has already been registered', 'email_exists');
        const r = await pool.query(`insert into auth.users (email, encrypted_password, raw_app_meta_data, raw_user_meta_data) values ($1, case when $2::text is null then null else crypt($2, gen_salt('bf')) end, $3, $4) returning *`, [body.email, body.password || null, JSON.stringify(body.app_metadata || {}), JSON.stringify(body.user_metadata || body.data || {})]);
        return send(res, 200, userJson(r.rows[0]));
      }
      const m = p.match(/^\/admin\/users\/([0-9a-f-]+)$/);
      if (m && req.method === 'PUT') {
        if (body.password) await pool.query(`update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id=$1`, [m[1], body.password]);
        if (body.ban_duration) await pool.query(`update auth.users set banned_until = case when $2='none' then null else now() + interval '100 years' end where id=$1`, [m[1], body.ban_duration]);
        if (body.app_metadata) await pool.query(`update auth.users set raw_app_meta_data = raw_app_meta_data || $2::jsonb where id=$1`, [m[1], JSON.stringify(body.app_metadata)]);
        const u = (await pool.query('select * from auth.users where id=$1', [m[1]])).rows[0]; return send(res, 200, userJson(u));
      }
    }
    err(404, 'no implementado ' + p);
  }

  // ---------- Meta y Zoho simulados ----------
  function mockMeta(req, res, url, body) {
    const p = url.pathname; const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const appTok = `${META_APP.id}|${META_APP.secreto}`;
    const validos = ['WA_TOKEN_PRUEBA', META_APP.token, META_APP.sinPermisos];
    const proof = url.searchParams.get('appsecret_proof');
    if (proof && validos.includes(bearer)) { if (proof !== crypto.createHmac('sha256', META_APP.secreto).update(bearer).digest('hex')) return send(res, 400, { error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } }); meta.proofs++; }
    if (/\/app$/.test(p)) return [META_APP.token, META_APP.sinPermisos].includes(bearer) ? send(res, 200, { id: META_APP.id, name: META_APP.nombre }) : send(res, 400, { error: { code: 190, message: 'Invalid OAuth access token - Cannot parse access token' } });
    if (/\/debug_token$/.test(p)) {
      if (bearer !== appTok) return send(res, 400, { error: { code: 101, message: 'Error validating client secret.' } });
      const it = url.searchParams.get('input_token'); const sin = it === META_APP.sinPermisos;
      return send(res, 200, { data: { app_id: META_APP.id, type: 'SYSTEM_USER', is_valid: [META_APP.token, META_APP.sinPermisos].includes(it), expires_at: 0,
        scopes: sin ? ['business_management'] : ['business_management', 'whatsapp_business_messaging', 'whatsapp_business_management'],
        granular_scopes: sin ? [] : [{ scope: 'whatsapp_business_messaging', target_ids: ['WABA1'] }, { scope: 'whatsapp_business_management', target_ids: ['WABA1'] }] } });
    }
    if (/\/WABA1\/phone_numbers$/.test(p)) return send(res, 200, { data: [{ id: 'PHONE_ID_PRUEBA', display_phone_number: '+507 6000-0000', verified_name: 'DGP Pruebas', quality_rating: 'GREEN' }] });
    if (/\/APP1\/subscriptions$/.test(p) && req.method === 'POST') {
      if (bearer !== appTok) return send(res, 400, { error: { code: 190, message: 'Invalid OAuth access token' } });
      // Como Meta: comprueba la URL al instante pidiendo el reto con el token de verificación
      const reto = String(Date.now());
      return fetch(`${body.callback_url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(body.verify_token)}&hub.challenge=${reto}`).then(r => r.text()).then(t => {
        if (t !== reto) return send(res, 400, { error: { code: 2200, message: 'Callback verification failed with the following errors: HTTP Status Code = 403' } });
        meta.suscripciones.push(body); send(res, 200, { success: true });
      }, e => send(res, 400, { error: { code: 2200, message: 'Callback no alcanzable: ' + e.message } }));
    }
    if (/\/WABA1\/subscribed_apps$/.test(p) && req.method === 'POST') { if (bearer !== META_APP.token) return send(res, 400, { error: { code: 190, message: 'Invalid OAuth access token' } }); meta.wabaSuscritas.push('WABA1'); return send(res, 200, { success: true }); }
    if (!['WA_TOKEN_PRUEBA', META_APP.token].includes(bearer)) return send(res, 401, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (/\/messages$/.test(p)) {
      if (String(body.to).startsWith('5079')) return send(res, 400, { error: { code: 131026, message: 'Message undeliverable', error_data: { details: 'Número no está en WhatsApp' } } });
      if (body.type === 'template' && !meta.plantillas.some(t => t.name === body.template.name)) return send(res, 404, { error: { code: 132001, message: 'Template name does not exist in the translation' } });
      const id = 'wamid.' + crypto.randomBytes(8).toString('hex'); meta.enviados.push({ id, body, token: bearer }); return send(res, 200, { messaging_product: 'whatsapp', contacts: [{ wa_id: body.to }], messages: [{ id }] });
    }
    if (/\/message_templates$/.test(p)) return send(res, 200, { data: meta.plantillas });
    if (/\/PHONE_ID_PRUEBA$/.test(p)) return send(res, 200, { display_phone_number: '+507 6000-0000', verified_name: 'DGP Pruebas', quality_rating: 'GREEN', id: 'PHONE_ID_PRUEBA' });
    send(res, 404, { error: { message: 'no simulado ' + p } });
  }
  function mockZoho(req, res, url, body) {
    const p = url.pathname.replace('/mock/zoho', ''); zoho.llamadas.push(req.method + ' ' + p);
    if (p === '/oauth/v2/token' && url.searchParams.get('grant_type') === 'authorization_code') {
      zoho.canjes.push(url.searchParams.get('code'));
      if (url.searchParams.get('client_id') !== 'cid' || url.searchParams.get('client_secret') !== 'csec') return send(res, 200, { error: 'invalid_client' });
      return url.searchParams.get('code') === '1000.codigo_bueno_de_prueba.abc' && zoho.canjes.filter(c => c === '1000.codigo_bueno_de_prueba.abc').length === 1
        ? send(res, 200, { access_token: 'AT_' + Date.now(), refresh_token: 'RT_NUEVO', api_domain: `http://127.0.0.1:${port}/mock/zoho`, expires_in: 3600 }) : send(res, 200, { error: 'invalid_code' });
    }
    if (p === '/oauth/v2/token') return ['RT_PRUEBA', 'RT_NUEVO'].includes(url.searchParams.get('refresh_token')) ? send(res, 200, { access_token: 'AT_' + Date.now(), api_domain: `http://127.0.0.1:${port}/mock/zoho`, expires_in: 3600 }) : send(res, 400, { error: 'invalid_code' });
    if (!/^Zoho-oauthtoken AT_/.test(req.headers.authorization || '')) return send(res, 401, { code: 57, message: 'You are not authorized to perform this operation' });
    const pc = { page: 1, per_page: 200, has_more_page: false };
    if (p === '/inventory/v1/organizations') return send(res, 200, { code: 0, organizations: [{ organization_id: 'ORG1', name: 'Distribuidora General de Panamá (pruebas)', currency_code: 'USD' }] });
    if (p === '/books/v3/organizations') return send(res, 200, { code: 0, organizations: [{ organization_id: 'ORG1', name: 'Distribuidora General de Panamá (pruebas)', currency_code: 'USD' }] });
    if (p === '/books/v3/contacts') return send(res, 200, { code: 0, page_context: pc, contacts: [
      { contact_id: '9001', contact_number: 'ZC-001', contact_name: 'Supermercado Zoho Uno', mobile: '6611-2233', shipping_address: { address: 'Vía España', city: 'Panamá' }, status: 'active', last_modified_time: '2026-10-08T10:00:00-0500' },
      { contact_id: '9002', contact_number: 'ZC-002', contact_name: 'Farmacia Zoho Dos', phone: '223-4455', billing_address: { address: 'Calle 50', city: 'Panamá' }, status: 'active', custom_fields: [{ api_name: 'cf_ejecutivo', value: 'Ana Morales' }], last_modified_time: '2026-10-08T10:00:00-0500' }] });
    const SO_LISTA = [{ salesorder_id: '5001', salesorder_number: 'SO-Z-0001', customer_id: '9001', customer_name: 'Supermercado Zoho Uno', date: new Date().toISOString().slice(0, 10), total: 370, last_modified_time: '2026-10-09T08:00:00-0500' }, { salesorder_id: '5002', salesorder_number: 'SO-Z-0002', customer_id: '9999', customer_name: 'Cliente no sincronizado', date: new Date().toISOString().slice(0, 10), total: 10 }, { salesorder_id: '4000', salesorder_number: 'SO-VIEJA', customer_id: '9001', customer_name: 'Supermercado Zoho Uno', date: '2025-01-15', total: 99 }];
    const SO_5001 = { salesorder_id: '5001', salesorder_number: 'SO-Z-0001', customer_id: '9001', date: '2026-10-09', shipment_date: '2026-10-10', total: 370, line_items: [{ line_item_id: 'L1', item_id: '7001', sku: 'ZSKU-1', quantity: 20, rate: 18.5 }], invoices: [{ invoice_id: 'INV1', invoice_number: 'FAC-Z-0001' }] };
    if (p === '/books/v3/items') return send(res, 200, { code: 0, page_context: pc, items: [{ item_id: '7001', sku: 'ZSKU-1', name: 'Arroz Zoho 25 lb', rate: 18.5, ean: '7451234567890', category_name: 'Granos', package_details: { weight: 11.3, weight_unit: 'kg', length: 40, width: 30, height: 15, dimension_unit: 'cm' } }] });
    if (p === '/books/v3/salesorders') { zoho.filtros.push(url.searchParams.get('filter_by')); return send(res, 200, { code: 0, page_context: pc, salesorders: url.searchParams.get('filter_by') === 'Status.Open' ? SO_LISTA : [] }); }
    if (p === '/books/v3/salesorders/5001') return send(res, 200, { code: 0, salesorder: SO_5001 });
    if (p === '/books/v3/salesorders/5001/comments' && req.method === 'GET') return send(res, 200, { code: 0, comments: zoho.comentarios.map((c, i) => ({ comment_id: 'CM' + (i + 1), description: c.description })) });
    if (p === '/books/v3/salesorders/5001/comments' && req.method === 'POST') { zoho.comentarios.push(body); return send(res, 201, { code: 0, comment: { comment_id: 'CM' + zoho.comentarios.length } }); }
    if (p === '/books/v3/salesorder/5001/customfields' && req.method === 'PUT') { zoho.campos.push(body); return send(res, 200, { code: 0, message: 'Custom Fields Updated Successfully' }); }
    if (p === '/inventory/v1/items') return send(res, 200, { code: 0, page_context: pc, items: [{ item_id: '7001', sku: 'ZSKU-1', name: 'Arroz Zoho 25 lb', rate: 18.5, ean: '7451234567890', category_name: 'Granos', package_details: { weight: 11.3, weight_unit: 'kg', length: 40, width: 30, height: 15, dimension_unit: 'cm' } }] });
    if (p === '/inventory/v1/salesorders') { zoho.filtros.push(url.searchParams.get('filter_by')); return send(res, 200, { code: 0, page_context: pc, salesorders: url.searchParams.get('filter_by') === 'Status.Confirmed' ? SO_LISTA : [] }); }
    if (p === '/inventory/v1/salesorders/5001') return send(res, 200, { code: 0, salesorder: SO_5001 });
    if (p === '/inventory/v1/packages' && req.method === 'GET') { const so = url.searchParams.get('salesorder_id'); return send(res, 200, { code: 0, packages: zoho.paquetes.map((x, i) => ({ ...x, package_id: 'PKG' + (i + 1) })).filter(x => x.so === so).map(x => ({ package_id: x.package_id, package_number: x.body.package_number, shipment_id: (zoho.envios.find(e => e.pkg === x.package_id) ? 'SHP' + (zoho.envios.findIndex(e => e.pkg === x.package_id) + 1) : '') })) }); }
    if (p === '/inventory/v1/packages' && req.method === 'POST') { zoho.paquetes.push({ so: url.searchParams.get('salesorder_id'), body }); return send(res, 201, { code: 0, package: { package_id: 'PKG' + zoho.paquetes.length } }); }
    if (p === '/inventory/v1/shipmentorders' && req.method === 'POST') { zoho.envios.push({ pkg: url.searchParams.get('package_ids'), body }); return send(res, 201, { code: 0, shipmentorder: { shipment_id: 'SHP' + zoho.envios.length } }); }
    send(res, 404, { code: 1, message: 'no simulado ' + p });
  }

  function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' }); res.end(body === null || status === 204 ? '' : JSON.stringify(body)); }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString();
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers.apikey || '';
    const claims = verificar(tok) || (req.headers.apikey ? verificar(req.headers.apikey) : null) || { role: 'anon' };
    try {
      if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, claims, body);
      if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, claims, body);
      if (url.pathname.startsWith('/mock/meta')) return mockMeta(req, res, url, body);
      if (url.pathname.startsWith('/mock/zoho')) return mockZoho(req, res, url, body);
      if (url.pathname.startsWith('/functions/v1/')) {
        const name = url.pathname.split('/')[3]; const f = funciones[name];
        if (!f) return send(res, 404, { error: 'función no desplegada' });
        if (f.verifyJwt && !verificar((req.headers.authorization || '').replace(/^Bearer /, ''))) return send(res, 401, { msg: 'Invalid JWT' });
        const h = { ...req.headers }; delete h.host; delete h['content-length'];
        const r = await fetch(`http://127.0.0.1:${f.port}${url.pathname.replace('/functions/v1/' + name, '') || '/'}${url.search}`, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
        const txt = await r.text(); res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); return res.end(txt);
      }
      send(res, 404, { message: 'ruta' });
    } catch (e) { console.error('[mock]', e); send(res, 500, { message: e.message }); }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, pool, meta, zoho, close: () => { server.close(); pool.end(); } })));
}
