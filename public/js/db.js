/* DGP MVP · capa de datos. Un solo API para dos backends:
   - supabase: cuando hay URL + anon key (config.js o localStorage 'dgp_cfg')
   - local: localStorage del navegador, con datos semilla (seed.js)
   Todas las filas llevan id uuid generado en cliente para que ambos modos sean idénticos. */
window.DB = (function () {
  const TABLES = ['bodegas','zonas','clientes','articulos','vehiculos','personas','reglas','pedidos','pedido_lineas','rutas','paradas','manifiestos','manifiesto_lineas','eventos','incidencias','alertas','auditoria','abastecimientos','peajes','costos_ruta','posiciones','paquetes','actas_gd','incentivos','notificaciones'];
  const SCHEMA_V = 2;
  const OPERATIVAS = ['notificaciones','actas_gd','paquetes','eventos','incidencias','alertas','abastecimientos','peajes','costos_ruta','posiciones','manifiesto_lineas','manifiestos','paradas','pedido_lineas','pedidos','rutas'];
  let mode = 'local', sb = null, local = null, cfg = {};
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16) }));
  const now = () => new Date().toISOString();

  function readCfg() {
    let c = Object.assign({}, window.DGP_CONFIG || {});
    try { const s = JSON.parse(localStorage.getItem('dgp_cfg') || 'null'); if (s) c = Object.assign(c, s); } catch (e) { }
    return c;
  }
  function saveCfg(c) { try { localStorage.setItem('dgp_cfg', JSON.stringify(c)); } catch (e) { } }

  // ---------- LOCAL ----------
  function seedLocal() {
    const S = window.DGP_SEED; const db = {}; TABLES.forEach(t => db[t] = []);
    (S.bodegas || [S.bodega]).forEach(b => db.bodegas.push(Object.assign({ id: uuid() }, b)));
    db.__v = SCHEMA_V;
    S.zonas.forEach(z => db.zonas.push(Object.assign({ id: uuid() }, z)));
    const cli = {}; S.clientes.forEach(c => { const r = Object.assign({ id: uuid() }, c); cli[c.codigo] = r; db.clientes.push(r); });
    S.articulos.forEach(a => db.articulos.push(Object.assign({ id: uuid() }, a)));
    S.vehiculos.forEach(v => db.vehiculos.push(Object.assign({ id: uuid() }, v)));
    S.personas.forEach(p => db.personas.push(Object.assign({ id: uuid() }, p)));
    S.reglas.forEach(r => db.reglas.push(Object.assign({ id: uuid(), actualizado_por: 'seed', updated_at: now() }, r)));
    const ped = {}; S.pedidos.forEach(p => { const r = { id: uuid(), numero_so: p.numero_so, numero_factura: p.numero_factura, cliente_id: cli[p.cliente_codigo].id, fecha: p.fecha, prioridad: p.prioridad, valor: p.valor, peso_kg: p.peso_kg, volumen_m3: p.volumen_m3, cajas: p.cajas, estado: 'pendiente_validar', causa: null, grupo: null, ruta_id: null, zoho_salesorder_id: p.zoho_salesorder_id, created_at: now() }; ped[p.numero_so] = r; db.pedidos.push(r); });
    S.pedido_lineas.forEach(l => db.pedido_lineas.push({ id: uuid(), pedido_id: ped[l.numero_so].id, sku: l.sku, cantidad_cajas: l.cantidad_cajas, precio: l.precio }));
    db.auditoria.push({ id: 1, entidad: 'sistema', accion: 'seed', detalle: 'Datos semilla cargados en modo local (navegador)', actor: 'sistema', automatico: true, created_at: now() });
    return db;
  }
  function loadLocal() { try { const s = JSON.parse(localStorage.getItem('dgp_db') || 'null'); if (s && s.pedidos && s.__v === SCHEMA_V) return s; } catch (e) { } const db = seedLocal(); persist(db); return db; } // datos v1 en el navegador: se recargan con la semilla v2
  function persist(db) { try { localStorage.setItem('dgp_db', JSON.stringify(db)); } catch (e) { console.warn('localStorage lleno', e); } }
  const matches = (row, m) => Object.keys(m).every(k => Array.isArray(m[k]) ? m[k].includes(row[k]) : row[k] === m[k]);

  // ---------- API ----------
  const PROD = () => !!(window.DGP_CONFIG && window.DGP_CONFIG.produccion);
  async function init() {
    cfg = readCfg();
    if (PROD()) cfg = Object.assign({}, window.DGP_CONFIG); // en producción la conexión no se cambia desde el navegador
    if (cfg.url && cfg.key && window.supabase) {
      try {
        sb = (window.Auth && Auth.sb) || window.supabase.createClient(cfg.url, cfg.key);
        const { error } = await sb.from('reglas').select('clave').limit(1);
        if (error) throw error;
        const v2 = await sb.from('paquetes').select('id').limit(1);
        if (v2.error) throw new Error('La base de Supabase no tiene el esquema v2 (paquetes, incentivos, notificaciones). Ejecuta supabase/schema.sql y supabase/v3_produccion.sql.');
        mode = 'supabase';
      } catch (e) {
        if (PROD()) { DB.lastError = e.message || String(e); throw e; } // producción: nunca se trabaja en el navegador sin base de datos
        console.warn('Supabase no disponible, modo local', e); sb = null; mode = 'local'; DB.lastError = e.message || String(e);
      }
    } else if (PROD()) { throw new Error('Producción sin configuración de Supabase'); }
    if (mode === 'local') local = loadLocal();
    return mode;
  }
  const fresh = () => { if (mode === 'local') local = loadLocal(); }; // varias pestañas comparten localStorage: releer siempre
  const SIN_ID = ['auditoria', 'posiciones', 'sync_log'];
  const SIN_RETORNO = ['auditoria', 'alertas']; // tablas de solo-agregar: insertar no exige permiso de lectura
  const PK = { costos_ruta: 'ruta_id', rol_permisos: 'rol', roles: 'codigo', permisos: 'codigo', integraciones: 'sistema', wa_plantillas: 'codigo' };
  /* opts: { desc, limit, gte: {col: valor}, or: 'filtro PostgREST' }. Pagina de 1000 en 1000 (tope por defecto de PostgREST en Supabase). */
  async function all(table, match, order, opts = {}) {
    if (mode === 'local') { fresh(); let rows = local[table].filter(r => !match || matches(r, match)); if (opts.gte) rows = rows.filter(r => Object.keys(opts.gte).every(k => !r[k] || r[k] >= opts.gte[k])); if (order) rows = rows.slice().sort((a, b) => (a[order] > b[order] ? 1 : a[order] < b[order] ? -1 : 0)); if (opts.desc) rows.reverse(); if (opts.limit) rows = rows.slice(0, opts.limit); return rows.map(r => Object.assign({}, r)); }
    const max = opts.limit || 20000, page = 1000; let out = [];
    for (let from = 0; from < max; from += page) {
      let q = sb.from(table).select('*'); if (match) Object.keys(match).forEach(k => { q = Array.isArray(match[k]) ? q.in(k, match[k]) : q.eq(k, match[k]); });
      if (opts.gte) Object.keys(opts.gte).forEach(k => { q = q.gte(k, opts.gte[k]); });
      if (opts.or) q = q.or(opts.or);
      if (order) q = q.order(order, { ascending: !opts.desc }); else q = q.order(PK[table] || 'id');
      q = q.range(from, Math.min(from + page, max) - 1);
      const { data, error } = await q; if (error) throw error; out = out.concat(data || []);
      if (!data || data.length < page) break;
    }
    return out;
  }
  /* Últimos n registros en orden ascendente (historiales: auditoría, eventos, avisos, posiciones). */
  async function recent(table, order, n, gte) { const rows = await all(table, null, order, { desc: true, limit: n, gte }); return rows.reverse(); }
  async function insert(table, rows) {
    rows = (Array.isArray(rows) ? rows : [rows]).map(r => Object.assign(SIN_ID.includes(table) || PK[table] ? {} : { id: uuid() }, r)); // tablas con id numérico o clave natural: la genera la base
    if (mode === 'local') { fresh(); rows.forEach(r => { if (!r.id) r.id = (local[table].length + 1); if (!r.created_at) r.created_at = now(); local[table].push(r); }); persist(local); return rows; }
    if (SIN_RETORNO.includes(table)) { const { error } = await sb.from(table).insert(rows); if (error) throw error; return rows; } // quien inserta no siempre puede leer (RLS)
    const { data, error } = await sb.from(table).insert(rows).select(); if (error) throw error; return data;
  }
  async function upsert(table, rows, onConflict = 'id') {
    rows = (Array.isArray(rows) ? rows : [rows]).map(r => Object.assign(r.id || onConflict !== 'id' ? {} : { id: uuid() }, r));
    if (mode === 'local') { fresh(); rows.forEach(r => { const i = local[table].findIndex(x => x[onConflict] === r[onConflict]); if (i >= 0) Object.assign(local[table][i], r); else { if (!r.id) r.id = uuid(); local[table].push(r); } }); persist(local); return rows; }
    const { data, error } = await sb.from(table).upsert(rows, { onConflict }).select(); if (error) throw error; return data;
  }
  async function update(table, match, patch) {
    if (mode === 'local') { fresh(); const out = []; local[table].forEach(r => { if (matches(r, match)) { Object.assign(r, patch); out.push(r); } }); persist(local); return out; }
    let q = sb.from(table).update(patch); Object.keys(match).forEach(k => { q = Array.isArray(match[k]) ? q.in(k, match[k]) : q.eq(k, match[k]); });
    const { data, error } = await q.select(); if (error) throw error; return data;
  }
  async function remove(table, match) {
    if (mode === 'local') { fresh(); local[table] = local[table].filter(r => !matches(r, match)); persist(local); return; }
    let q = sb.from(table).delete(); Object.keys(match).forEach(k => { q = Array.isArray(match[k]) ? q.in(k, match[k]) : q.eq(k, match[k]); });
    const { error } = await q; if (error) throw error;
  }
  async function audit(entidad, accion, detalle, actor = 'sistema', automatico = false, entidad_id = null) {
    return insert('auditoria', { entidad, entidad_id, accion, detalle, actor, automatico, created_at: now() });
  }
  async function alerta(tipo, severidad, titulo, detalle, entidad = null, destinatario = null) {
    return insert('alertas', { tipo, severidad, titulo, detalle, entidad, destinatario, leida: false, cerrada: false, created_at: now() });
  }
  /* Reinicia la operación del día: borra rutas, paradas, eventos… y recarga los pedidos semilla. Mantiene maestros. */
  async function resetOperacion() {
    if (mode === 'local') { const inc = (local && local.incentivos) || []; local = seedLocal(); local.incentivos = inc; persist(local); return; } // el histórico de incentivos se conserva
    for (const t of OPERATIVAS) { const num = t === 'auditoria' || t === 'posiciones'; const col = t === 'costos_ruta' ? 'ruta_id' : 'id'; const { error } = await sb.from(t).delete().neq(col, num ? -1 : '00000000-0000-0000-0000-000000000000'); if (error) throw error; }
    const S = window.DGP_SEED; const clientes = await all('clientes'); const byCod = {}; clientes.forEach(c => byCod[c.codigo] = c.id);
    const ped = S.pedidos.map(p => ({ id: uuid(), numero_so: p.numero_so, numero_factura: p.numero_factura, cliente_id: byCod[p.cliente_codigo], fecha: new Date().toISOString().slice(0, 10), prioridad: p.prioridad, valor: p.valor, peso_kg: p.peso_kg, volumen_m3: p.volumen_m3, cajas: p.cajas, estado: 'pendiente_validar', zoho_salesorder_id: p.zoho_salesorder_id }));
    const byso = {}; ped.forEach(p => byso[p.numero_so] = p.id);
    await insert('pedidos', ped);
    await insert('pedido_lineas', S.pedido_lineas.map(l => ({ pedido_id: byso[l.numero_so], sku: l.sku, cantidad_cajas: l.cantidad_cajas, precio: l.precio })));
    await audit('sistema', 'reset', 'Operación del día reiniciada con pedidos semilla', 'Admin DGP', false);
  }
  /* Bandeja de salida (WhatsApp cliente, Telegram interno, correo).
     Con WhatsApp activo (regla "whatsapp") el servidor marca los avisos a clientes como "pendiente" y la Edge Function los envía.
     extra: { plantilla, parametros:[...], cliente_id, telefono } */
  async function notificar(canal, destinatario, rol, asunto, mensaje, motivo, ruta_id = null, entidad = null, entidad_id = null, extra = {}) {
    const rows = await insert('notificaciones', Object.assign({ canal, destinatario, rol, asunto, mensaje, motivo, ruta_id, entidad, entidad_id, estado: 'simulado', created_at: now() }, extra));
    despachar(rows);
    return rows;
  }
  /* Pide a la Edge Function que envíe ya los avisos pendientes recién creados (si falla, los recoge la tarea programada). */
  function despachar(rows) {
    if (mode !== 'supabase' || !rows) return;
    const ids = rows.filter(r => r && r.estado === 'pendiente').map(r => r.id);
    if (ids.length) fn('whatsapp', { accion: 'procesar', ids }).catch(e => console.warn('despacho WhatsApp', e));
  }
  async function fn(nombre, body) {
    if (mode !== 'supabase') throw new Error('Requiere conexión a Supabase');
    const { data, error } = await sb.functions.invoke(nombre, { body });
    if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || j.message || m; } catch (e) { } throw new Error(m); }
    return data;
  }
  async function rpc(nombre, args) { if (mode !== 'supabase') throw new Error('Requiere conexión a Supabase'); const { data, error } = await sb.rpc(nombre, args || {}); if (error) throw error; return data; }
  function getMode() { return mode; } function getCfg() { return cfg; }
  return { init, all, recent, insert, upsert, update, remove, audit, alerta, notificar, despachar, fn, rpc, resetOperacion, getMode, getCfg, saveCfg, uuid, TABLES, client: () => sb };
})();
