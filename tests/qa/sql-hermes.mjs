// Regresiones SQL de la revisión de Hermes (10-oct-2026). Base aislada dgp_test (después de RLS y sql-audit).
// Cada prueba corre en su transacción y se revierte, salvo OPS-001 que ejecuta la reversión y vuelve a aplicar v3.
import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path';
if (process.env.DGP_QA_ISOLATED !== '1' || process.env.PGPORT !== '55439') throw Error('QA cluster required');
const out = path.resolve('docs/validacion-2026-10-10/evidencias'); fs.mkdirSync(out, { recursive: true });
const c = new pg.Client({ database: 'dgp_test' }); await c.connect(); const q = (s, v) => c.query(s, v);
const results = []; const assert = (x, m) => { if (!x) throw Error(m); };
async function test(name, fn) { try { await q('BEGIN'); await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } finally { await q('ROLLBACK').catch(() => { }); } }
const como = async email => { await q("select set_config('request.jwt.claims',(select json_build_object('sub',id,'role','authenticated')::text from perfiles where email=$1),true)", [email]); await q('SET LOCAL ROLE authenticated'); };
const comoServicio = async () => { await q("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)"); await q('SET LOCAL ROLE service_role'); };
const yo = async () => { await q('RESET ROLE'); await q("select set_config('request.jwt.claims','',true)"); };
// Ejecuta y devuelve el código SQLSTATE si falla (dentro de un savepoint, para seguir usando la transacción)
async function intenta(sql, v) { await q('SAVEPOINT s'); try { const r = await q(sql, v); await q('RELEASE SAVEPOINT s'); return { ok: true, r }; } catch (e) { await q('ROLLBACK TO SAVEPOINT s'); return { ok: false, code: e.code, msg: e.message }; } }
// Fixture: ruta en curso de Luis con un pedido planificado de 2 líneas y la parada en sitio
async function fixtureEntrega() {
  const cli = (await q("select id from clientes order by codigo limit 1")).rows[0].id;
  const arts = (await q("select sku from articulos order by sku limit 2")).rows.map(r => r.sku);
  const rid = (await q("insert into rutas (codigo, conductor, estado) values ('H-LUIS-' || floor(random()*1e6), 'Luis Herrera', 'en_ruta') returning id")).rows[0].id;
  const pid = (await q("insert into pedidos (numero_so, cliente_id, fecha, valor, cajas, peso_kg, volumen_m3, estado, ruta_id) values ('H-SO-' || floor(random()*1e6), $1, current_date, 100, 5, 1, .01, 'planificado', $2) returning id", [cli, rid])).rows[0].id;
  const l1 = (await q("insert into pedido_lineas (pedido_id, sku, cantidad_cajas) values ($1, $2, 3) returning id", [pid, arts[0]])).rows[0].id;
  const l2 = (await q("insert into pedido_lineas (pedido_id, sku, cantidad_cajas) values ($1, $2, 2) returning id", [pid, arts[1]])).rows[0].id;
  const sid = (await q("insert into paradas (ruta_id, secuencia, pedido_id, cliente_id, estado) values ($1, 1, $2, $3, 'en_sitio') returning id", [rid, pid, cli])).rows[0].id;
  const ajena = (await q("select id from pedido_lineas where pedido_id <> $1 limit 1", [pid])).rows[0].id;
  return { cli, rid, pid, l1, l2, sid, ajena };
}
try {
  await test('LOGIC-002: conciliar_ruta rechaza rutas no cerradas y a quien no tiene costos', async () => {
    const r = (await q("insert into rutas (codigo, conductor, estado) values ('H-PUB','Luis Herrera','publicada') returning id")).rows[0].id;
    const a = await intenta('select public.conciliar_ruta($1)', [r]); assert(!a.ok && a.code === '22023', 'concilió una ruta publicada: ' + JSON.stringify(a));
    await q("update rutas set estado='cerrada' where id=$1", [r]);
    await como('cond@test.dgp'); const b = await intenta('select public.conciliar_ruta($1)', [r]); assert(!b.ok && b.code === '42501', 'el conductor pudo conciliar: ' + JSON.stringify(b));
  });
  await test('LOGIC-002: cerrada sin datos queda pendiente; con datos reales concilia exactamente esos valores; repetir no duplica', async () => {
    const v = (await q("select id, km_por_litro from vehiculos where km_por_litro > 0 limit 1")).rows[0];
    const sin = (await q("insert into rutas (codigo, conductor, estado, vehiculo_id) values ('H-SIN','Luis Herrera','cerrada',$1) returning id", [v.id])).rows[0].id;
    const con = (await q("insert into rutas (codigo, conductor, estado, vehiculo_id, odometro_salida, odometro_llegada, valor) values ('H-CON','Luis Herrera','cerrada',$1,1000,1100,3000) returning id", [v.id])).rows[0].id;
    await q("insert into abastecimientos (ruta_id, vehiculo_id, litros, costo) values ($1,$2,20,19.6)", [con, v.id]);
    await q("insert into peajes (ruta_id, punto, monto_real, fuente) values ($1,'Corredor Norte',2.75,'manual')", [con]);
    const peajesAntes = +(await q('select count(*) from peajes')).rows[0].count;
    const a = (await q('select public.conciliar_ruta($1) j', [sin])).rows[0].j; const b = (await q('select public.conciliar_ruta($1) j', [con])).rows[0].j;
    assert(!a.conciliada && a.faltantes.length === 2, 'sin datos debía quedar pendiente con 2 faltantes: ' + JSON.stringify(a));
    assert((await q('select estado from rutas where id=$1', [sin])).rows[0].estado === 'cerrada', 'la ruta sin datos cambió de estado');
    const cs = (await q('select datos_completos, km_real, costo_total from costos_ruta where ruta_id=$1', [sin])).rows[0];
    assert(cs && cs.datos_completos === false && cs.km_real === null && cs.costo_total === null, 'inventó datos para la ruta sin odómetros: ' + JSON.stringify(cs));
    assert(b.conciliada, 'no concilió la ruta con datos: ' + JSON.stringify(b));
    const cc = (await q('select km_real::float, litros_reales::float, costo_combustible::float, costo_peajes::float from costos_ruta where ruta_id=$1', [con])).rows[0];
    assert(cc.km_real === 100 && cc.litros_reales === 20 && cc.costo_combustible === 19.6 && cc.costo_peajes === 2.75, 'valores no son los registrados: ' + JSON.stringify(cc));
    const otra = (await q('select public.conciliar_ruta($1) j', [con])).rows[0].j; assert(otra.ya === true, 'segunda conciliación no fue idempotente');
    assert(+(await q('select count(*) from peajes')).rows[0].count === peajesAntes, 'la conciliación creó peajes');
    assert(+(await q('select count(*) from costos_ruta where ruta_id=$1', [con])).rows[0].count === 1, 'duplicó costos');
  });
  await test('DATA-001: registrar_entrega es atómica (línea ajena → nada cambia)', async () => {
    const f = await fixtureEntrega(); await como('cond@test.dgp');
    const a = await intenta("select public.registrar_entrega($1,'parcial',$2,$3)", [f.sid, { resultado: 'Parcial QA' }, JSON.stringify([{ id: f.l1, entregado: 1 }, { id: f.ajena, entregado: 0 }])]);
    assert(!a.ok && a.code === '42501', 'aceptó una línea de otro pedido: ' + JSON.stringify(a));
    await yo();
    const est = (await q('select (select estado from paradas where id=$1) p, (select estado from pedidos where id=$2) d, (select entregado from pedido_lineas where id=$3) l', [f.sid, f.pid, f.l1])).rows[0];
    assert(est.p === 'en_sitio' && est.d === 'planificado' && est.l === null, 'quedó a medias: ' + JSON.stringify(est));
  });
  await test('DATA-001: registrar_entrega rechaza cantidades negativas o mayores a lo pedido sin efectos parciales', async () => {
    const f = await fixtureEntrega(); await como('cond@test.dgp');
    for (const mal of [-1, 9]) {
      const a = await intenta("select public.registrar_entrega($1,'parcial',$2,$3)", [f.sid, { resultado: 'x' }, JSON.stringify([{ id: f.l1, entregado: 1 }, { id: f.l2, entregado: mal }])]);
      assert(!a.ok && a.code === '23514', `aceptó entregado=${mal}: ` + JSON.stringify(a));
    }
    await yo(); assert((await q('select entregado from pedido_lineas where id=$1', [f.l1])).rows[0].entregado === null, 'guardó la primera línea de una entrega rechazada');
  });
  await test('DATA-001: registrar_entrega válida guarda parada, pedido y líneas; repetirla no cambia nada', async () => {
    const f = await fixtureEntrega(); await como('cond@test.dgp');
    const args = [f.sid, { resultado: 'Parcial QA', receptor: 'QA' }, JSON.stringify([{ id: f.l1, entregado: 2 }, { id: f.l2, entregado: 2 }])];
    const a = await intenta("select public.registrar_entrega($1,'parcial',$2,$3)", args); assert(a.ok, 'entrega válida rechazada: ' + JSON.stringify(a));
    const b = await intenta("select public.registrar_entrega($1,'parcial',$2,$3)", args); assert(b.ok, 'el reintento (cola sin señal) falló: ' + JSON.stringify(b));
    await yo();
    const est = (await q('select (select estado from paradas where id=$1) p, (select estado from pedidos where id=$2) d, (select entregado from pedido_lineas where id=$3) l', [f.sid, f.pid, f.l1])).rows[0];
    assert(est.p === 'parcial' && est.d === 'parcial' && est.l === 2, 'estado final incorrecto: ' + JSON.stringify(est));
  });
  await test('ZOH-001: orden existente con línea inválida queda exactamente igual; orden nueva inválida no crea nada', async () => {
    const cli = (await q("select id from clientes limit 1")).rows[0].id; const sku = (await q("select sku from articulos limit 1")).rows[0].sku;
    await comoServicio();
    const base = { zoho_salesorder_id: 'H-Z-1', numero_so: 'SO-H-1', cliente_id: cli, fecha: '2026-10-10', valor: 50, peso_kg: 1, volumen_m3: .01, cajas: 2, origen: 'zoho' };
    const ok = await intenta('select public.zoho_guardar_pedido($1,$2)', [base, JSON.stringify([{ sku, cantidad_cajas: 2, precio: 25 }])]); assert(ok.ok, 'orden válida rechazada: ' + JSON.stringify(ok));
    const antes = (await q("select json_agg(row_to_json(l) order by sku) j from pedido_lineas l join pedidos p on p.id=l.pedido_id where p.zoho_salesorder_id='H-Z-1'")).rows[0].j;
    const mal = await intenta('select public.zoho_guardar_pedido($1,$2)', [{ ...base, valor: 999 }, JSON.stringify([{ sku, cantidad_cajas: 1, precio: 10 }, { sku, cantidad_cajas: -3, precio: 10 }])]);
    assert(!mal.ok, 'aceptó una línea negativa');
    const despues = (await q("select json_agg(row_to_json(l) order by sku) j from pedido_lineas l join pedidos p on p.id=l.pedido_id where p.zoho_salesorder_id='H-Z-1'")).rows[0].j;
    assert(JSON.stringify(antes) === JSON.stringify(despues), 'las líneas cambiaron tras un fallo');
    assert(+(await q("select valor from pedidos where zoho_salesorder_id='H-Z-1'")).rows[0].valor === 50, 'la cabecera cambió tras un fallo');
    const nueva = await intenta('select public.zoho_guardar_pedido($1,$2)', [{ ...base, zoho_salesorder_id: 'H-Z-2', numero_so: 'SO-H-2' }, JSON.stringify([{ sku, cantidad_cajas: -1 }])]);
    assert(!nueva.ok && +(await q("select count(*) from pedidos where zoho_salesorder_id='H-Z-2'")).rows[0].count === 0, 'creó cabecera huérfana');
    const vacia = await intenta('select public.zoho_guardar_pedido($1,$2)', [{ ...base, zoho_salesorder_id: 'H-Z-3' }, '[]']);
    assert(!vacia.ok && vacia.code === '22023', 'aceptó una orden sin líneas');
  });
  await test('KNOWN-WA-002: aviso atascado en "enviando" se recupera a los 10 min; uno reciente no', async () => {
    const vieja = (await q("insert into notificaciones (canal, estado, intentos, enviando_at, created_at) values ('telegram','enviando',1, now()-interval '20 minutes', now()-interval '25 minutes') returning id")).rows[0].id;
    const nueva = (await q("insert into notificaciones (canal, estado, intentos, enviando_at) values ('telegram','enviando',1, now()-interval '1 minute') returning id")).rows[0].id;
    await comoServicio(); const r = (await q('select id from public.wa_tomar_pendientes(50, $1)', [[vieja, nueva]])).rows.map(x => x.id);
    assert(r.includes(vieja) && !r.includes(nueva), 'recuperación incorrecta: ' + JSON.stringify(r));
  });
  await test('KNOWN-SEC-002: funciones privadas y de servidor no ejecutables por anon/authenticated', async () => {
    const f = ['dgp_private.tomar_pendientes(int, uuid)', 'public.wa_tomar_pendientes(int, uuid[])', 'public.zoho_guardar_pedido(jsonb, jsonb)', 'public.zoho_reclamar_paquete(uuid)'];
    for (const fn of f) for (const rol of ['anon', 'authenticated']) assert(!(await q('select has_function_privilege($1,$2,\'execute\') x', [rol, fn])).rows[0].x, `${rol} puede ejecutar ${fn}`);
  });
  await test('KNOWN-WA-001: el conductor no avisa a clientes fuera de su ruta y no elige teléfono ni plantilla', async () => {
    await q("update integraciones set activo = true where sistema = 'whatsapp'");
    const f = await fixtureEntrega(); await q("update clientes set telefono='6000-1234' where id=$1", [f.cli]);
    const otro = (await q("select id from clientes where id <> $1 limit 1", [f.cli])).rows[0].id;
    await como('cond@test.dgp');
    const mal = await intenta("insert into notificaciones (canal, ruta_id, cliente_id, motivo) values ('whatsapp_cliente',$1,$2,'salida de ruta')", [f.rid, otro]);
    assert(!mal.ok && mal.code === '42501', 'avisó a un cliente que no está en su ruta: ' + JSON.stringify(mal));
    const ok = await intenta("insert into notificaciones (canal, ruta_id, cliente_id, motivo, telefono, plantilla) values ('whatsapp_cliente',$1,$2,'salida de ruta','50799999999','plantilla_inventada') returning id", [f.rid, f.cli]);
    assert(ok.ok, 'aviso legítimo rechazado: ' + JSON.stringify(ok));
    await yo(); const n = (await q('select telefono, plantilla from notificaciones where id=$1', [ok.r.rows[0].id])).rows[0];
    assert(n.telefono === '50760001234' && n.plantilla !== 'plantilla_inventada', 'usó teléfono/plantilla del navegador: ' + JSON.stringify(n));
  });
  // OPS-001: fuera de transacción porque ejecuta archivos completos
  try {
    await q('ROLLBACK').catch(() => { });
    await q(fs.readFileSync('supabase/migraciones/reversion_segura.sql', 'utf8'));
    const tablas = (await q("select tablename from pg_tables where schemaname='public'")).rows.map(r => r.tablename);
    const demo = +(await q("select count(*) from pg_policies where policyname='demo_all'")).rows[0].count;
    const abiertas = [];
    for (const t of tablas) for (const op of [`select 1 from "${t}" limit 1`, `delete from "${t}" where false`, `update "${t}" set ctid = ctid where false`]) {
      await q('BEGIN'); await q('SET LOCAL ROLE anon'); try { await q(op); abiertas.push(`${t}: ${op.split(' ')[0]}`); } catch { } await q('ROLLBACK');
    }
    const insertables = [];
    for (const t of tablas) { await q('BEGIN'); await q('SET LOCAL ROLE anon'); try { await q(`insert into "${t}" default values`); insertables.push(t); } catch (e) { if (e.code !== '42501') insertables.push(`${t} (pasó el permiso, falló por ${e.code})`); } await q('ROLLBACK'); }
    const okRev = demo === 0 && !abiertas.length && !insertables.length;
    results.push({ name: 'OPS-001: la reversión segura no crea demo_all y anon no lee ni escribe ninguna tabla', ok: okRev, error: okRev ? undefined : JSON.stringify({ demo, abiertas, insertables }) });
    await q(fs.readFileSync('supabase/v3_produccion.sql', 'utf8').replace(/^\\set ON_ERROR_STOP 1\s*$/m, ''));
    const back = +(await q("select count(*) from pg_trigger where tgname='tr_guardia_conductor'")).rows[0].count;
    results.push({ name: 'OPS-001: tras la reversión, v3 se vuelve a aplicar y restaura las protecciones', ok: back === 4, error: back === 4 ? undefined : 'triggers=' + back });
  } catch (e) { results.push({ name: 'OPS-001: reversión segura', ok: false, error: e.message }); }
} finally { await c.end(); fs.writeFileSync(path.join(out, 'sql-hermes.json'), JSON.stringify({ total: results.length, failed: results.filter(x => !x.ok).length, results }, null, 2)); }
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.error ? ' — ' + r.error : ''));
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
