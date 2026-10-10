// Regresiones E2E de la revisión de Hermes (10-oct-2026). Corren en el mismo emulador que tests/e2e/run.mjs.
export async function hermes(h) {
  const { prueba, sql, admin, cond, fn, tokenDe, mock, assert, conductorNombre, API, WA_APP_SECRET, crypto, OUT, fs, path } = h;
  const obs = {};
  const uno = s => String(s).split('\n')[0];

  await prueba('LOGIC-001: la promesa de pago solo levanta el crédito (no omite dirección ni mínimo)', async () => {
    sql(`insert into clientes (codigo, nombre, lat, lng, geo_estado, credito_bloqueado, ejecutivo) values
      ('QA-PR1','QA Promesa Dirección',null,null,'dudosa',true,'QA Ejecutivo'),
      ('QA-PR2','QA Promesa Correcta',8.98,-79.52,'validada',true,'QA Ejecutivo'),
      ('QA-PR3','QA Promesa Mínimo',8.98,-79.52,'validada',true,'QA Ejecutivo')`);
    const mk = (so, cod, val) => uno(sql(`insert into pedidos (numero_so, numero_factura, cliente_id, fecha, valor, cajas, peso_kg, volumen_m3, estado) select '${so}', 'F-${so}', id, current_date, ${val}, 1, 1, .01, 'en_excepcion' from clientes where codigo='${cod}' returning id`));
    const ids = [mk('QA-PR-1', 'QA-PR1', 100), mk('QA-PR-2', 'QA-PR2', 100), mk('QA-PR-3', 'QA-PR3', 1)];
    await admin.evaluate(async () => { await loadAll(); });
    for (const id of ids) {
      await admin.evaluate(id => promesaPago(id), id); await admin.click('#pp-ok');
      await admin.waitForFunction(() => !document.getElementById('modal').classList.contains('on'), null, { timeout: 20000 });
    }
    const est = so => sql(`select estado || '|' || (promesa_pago is not null) from pedidos where numero_so='${so}'`);
    obs.promesa = { dir: est('QA-PR-1'), ok: est('QA-PR-2'), min: est('QA-PR-3') };
    assert(obs.promesa.dir === 'en_excepcion|true', 'la promesa liberó un pedido con dirección dudosa: ' + obs.promesa.dir);
    assert(obs.promesa.ok === 'elegible|true', 'la promesa no liberó un pedido que solo tenía bloqueo de crédito: ' + obs.promesa.ok);
    assert(obs.promesa.min === 'en_excepcion|true', 'la promesa liberó un pedido de B/. 1: ' + obs.promesa.min);
  });

  await prueba('LOGIC-002: conciliar solo toca rutas cerradas, con datos reales, y repetir no duplica', async () => {
    const vid = uno(sql('select id from vehiculos where km_por_litro > 0 limit 1'));
    sql(`insert into rutas (codigo, conductor, estado, vehiculo_id) values ('Q-PUB','QA','publicada','${vid}'), ('Q-ENR','QA','en_ruta','${vid}'), ('Q-CSD','QA','cerrada','${vid}')`);
    const cok = uno(sql(`insert into rutas (codigo, conductor, estado, vehiculo_id, odometro_salida, odometro_llegada, valor) values ('Q-COK','QA','cerrada','${vid}',2000,2080,3000) returning id`));
    sql(`insert into abastecimientos (ruta_id, vehiculo_id, litros, costo) values ('${cok}','${vid}',15,14.7)`);
    const peajes0 = sql('select count(*) from peajes'); const aud0 = +sql("select count(*) from auditoria where accion='conciliacion'");
    await admin.evaluate(async () => { await loadAll(); await conciliarReal(); closeModal(); });
    const st = c => sql(`select estado from rutas where codigo='${c}'`);
    obs.conciliacion = { pub: st('Q-PUB'), enr: st('Q-ENR'), csd: st('Q-CSD'), cok: st('Q-COK'), costosActivas: sql("select count(*) from costos_ruta c join rutas r on r.id=c.ruta_id where r.codigo in ('Q-PUB','Q-ENR')"),
      csdDatos: sql("select datos_completos::text || '|' || coalesce(array_to_string(faltantes, ','), '') from costos_ruta c join rutas r on r.id=c.ruta_id where r.codigo='Q-CSD'"),
      cokValores: sql("select c.km_real::float || '|' || c.litros_reales::float || '|' || c.costo_combustible::float from costos_ruta c join rutas r on r.id=c.ruta_id where r.codigo='Q-COK'") };
    assert(obs.conciliacion.pub === 'publicada' && obs.conciliacion.enr === 'en_ruta', 'conciliar cambió rutas activas: ' + JSON.stringify(obs.conciliacion));
    assert(obs.conciliacion.costosActivas === '0', 'generó costos para rutas activas');
    assert(obs.conciliacion.csd === 'cerrada' && obs.conciliacion.csdDatos.startsWith('false|'), 'ruta sin datos no quedó pendiente: ' + obs.conciliacion.csdDatos);
    assert(obs.conciliacion.cok === 'conciliada' && obs.conciliacion.cokValores === '80|15|14.7', 'no concilió con los datos reales: ' + obs.conciliacion.cokValores);
    assert(sql('select count(*) from peajes') === peajes0, 'la conciliación inventó peajes');
    const aud1 = +sql("select count(*) from auditoria where accion='conciliacion'");
    await admin.evaluate(async () => { await loadAll(); await conciliarReal(); closeModal(); });
    assert(sql('select count(*) from peajes') === peajes0, 'la segunda conciliación creó peajes');
    assert(+sql("select count(*) from auditoria where accion='conciliacion'") === aud1 && aud1 >= aud0, 'la segunda conciliación duplicó auditoría');
  });

  // ---------- DATA-001: rechazo de la base en cada paso del conductor ----------
  const vid = uno(sql('select id from vehiculos limit 1')); const sku = uno(sql('select sku from articulos order by sku limit 1'));
  const cli = uno(sql("select id from clientes where lat is not null order by codigo limit 1"));
  const rid = uno(sql(`insert into rutas (codigo, conductor, estado, vehiculo_id, hora_fin_prevista) values ('Q-COND','${conductorNombre}','liberada','${vid}','17:00') returning id`));
  const pid = uno(sql(`insert into pedidos (numero_so, numero_factura, cliente_id, fecha, valor, cajas, peso_kg, volumen_m3, estado, ruta_id) values ('QA-COND-1','F-QA-COND-1','${cli}',current_date,200,3,3,.03,'planificado','${rid}') returning id`));
  sql(`insert into pedido_lineas (pedido_id, sku, cantidad_cajas) values ('${pid}','${sku}',3)`);
  const sid = uno(sql(`insert into paradas (ruta_id, secuencia, pedido_id, cliente_id, tipo, lat, lng, eta, estado) select '${rid}', 1, '${pid}', id, 'entrega', lat, lng, '09:00', 'pendiente' from clientes where id='${cli}' returning id`));
  await cond.evaluate(async rid => {
    window.qaCampos = html => { let d = document.getElementById('qa-campos'); if (d) d.remove(); d = document.createElement('div'); d.id = 'qa-campos'; d.style.display = 'none'; d.innerHTML = html; document.body.prepend(d); };
    window.qaRomper = (fname, pred) => { const old = DB[fname]; DB[fname] = async (...a) => { if (pred(...a)) { const e = new Error('QA: rechazo simulado'); e.code = '42501'; throw e; } return old.apply(DB, a); }; return () => { DB[fname] = old; }; };
    S.ruta = { id: rid }; await load(); S.ruta = S.todas.find(r => r.id === rid); S.paradas = S.paradasTodas.filter(p => p.ruta_id === rid);
  }, rid);
  const evs = tipo => +sql(`select count(*) from eventos where ruta_id='${rid}' and tipo='${tipo}'`);
  const toastNoGuardo = async () => /No se pudo guardar/.test(await cond.evaluate(() => document.getElementById('toast').textContent));

  await prueba('DATA-001: salida rechazada no avisa a clientes ni registra el evento', async () => {
    await cond.evaluate(async () => { qaCampos('<input id="f-odo" value="1000"><input id="f-comb" value="lleno">'); const fix = qaRomper('update', t => t === 'rutas'); try { await salida(); } finally { fix(); } });
    assert(sql(`select estado from rutas where id='${rid}'`) === 'liberada', 'la ruta cambió pese al rechazo');
    assert(evs('salida') === 0 && sql(`select count(*) from notificaciones where ruta_id='${rid}'`) === '0', 'siguió con los pasos siguientes tras el rechazo');
    assert(await toastNoGuardo(), 'no mostró el error al conductor');
    await cond.evaluate(async () => { qaCampos('<input id="f-odo" value="1000"><input id="f-comb" value="lleno">'); await salida(); });
    assert(sql(`select estado from rutas where id='${rid}'`) === 'en_ruta', 'la salida legítima no se guardó');
  }, cond);
  await prueba('DATA-001: check-in rechazado no deja la parada en sitio ni registra evento', async () => {
    await cond.evaluate(async sid => { const fix = qaRomper('update', t => t === 'paradas'); try { await checkin(S.paradas.find(s => s.id === sid)); } finally { fix(); } }, sid);
    assert(sql(`select estado from paradas where id='${sid}'`) === 'pendiente' && evs('checkin') === 0, 'el check-in siguió tras el rechazo');
    assert(await toastNoGuardo(), 'no mostró el error');
    await cond.evaluate(async sid => { await checkin(S.paradas.find(s => s.id === sid)); }, sid);
    assert(sql(`select estado from paradas where id='${sid}'`) === 'en_sitio', 'check-in legítimo no guardado');
  }, cond);
  await prueba('DATA-001: entrega parcial con cantidades negativas o mayores no envía nada', async () => {
    const r = await cond.evaluate(async ({ sid, sku }) => {
      let llamadas = 0; const old = DB.rpc; DB.rpc = async (...a) => { llamadas++; return old.apply(DB, a); };
      const msgs = [];
      try { for (const v of ['-1', '4', '1.5', '']) { qaCampos(`<input id="f-rec" value="QA"><select id="f-causa"><option>Cliente cerrado</option></select><input data-q="${sku}" data-req="3" value="${v}">`); await cerrarParada(S.paradas.find(s => s.id === sid), 'parcial'); msgs.push(document.getElementById('toast').textContent); } }
      finally { DB.rpc = old; } return { llamadas, msgs };
    }, { sid, sku });
    obs.parcialInvalida = r;
    assert(r.llamadas === 0, 'envió una entrega con cantidades inválidas');
    assert(r.msgs.every(m => /Revisa las cantidades/.test(m)), 'no avisó del error: ' + JSON.stringify(r.msgs));
    assert(sql(`select estado from paradas where id='${sid}'`) === 'en_sitio' && sql(`select estado from pedidos where id='${pid}'`) === 'planificado', 'cambió el estado con datos inválidos');
  }, cond);
  await prueba('DATA-001: entrega rechazada por la base no marca la parada ni el pedido y no anuncia éxito', async () => {
    await cond.evaluate(async sid => { qaCampos('<input id="f-rec" value="QA">'); const fix = qaRomper('rpc', n => n === 'registrar_entrega'); try { await cerrarParada(S.paradas.find(s => s.id === sid), 'total'); } finally { fix(); } }, sid);
    assert(sql(`select estado from paradas where id='${sid}'`) === 'en_sitio' && sql(`select estado from pedidos where id='${pid}'`) === 'planificado', 'quedó marcada pese al rechazo');
    assert(evs('entrega') === 0 && await toastNoGuardo(), 'registró evento o no avisó');
    const ok = await cond.evaluate(async sid => { qaCampos('<input id="f-rec" value="QA">'); await cerrarParada(S.paradas.find(s => s.id === sid), 'total'); return document.getElementById('toast').textContent; }, sid);
    assert(sql(`select estado from paradas where id='${sid}'`) === 'atendida' && sql(`select estado from pedidos where id='${pid}'`) === 'entregado', 'la entrega legítima no se guardó: ' + ok);
  }, cond);
  await prueba('DATA-001: cierre de ruta rechazado no la cierra ni registra la llegada', async () => {
    await cond.evaluate(async () => { qaCampos('<input id="f-odo2" value="1100">'); const fix = qaRomper('update', t => t === 'rutas'); try { await llegada(); } finally { fix(); } });
    assert(sql(`select estado from rutas where id='${rid}'`) === 'en_ruta' && evs('llegada') === 0, 'cerró la ruta pese al rechazo');
    assert(await toastNoGuardo(), 'no avisó');
    await cond.evaluate(async () => { qaCampos('<input id="f-odo2" value="1100">'); await llegada(); try { localStorage.removeItem(Q.key + '_err'); } catch (e) { } });
    assert(sql(`select estado || '|' || odometro_llegada::int from rutas where id='${rid}'`) === 'cerrada|1100', 'cierre legítimo no guardado');
  }, cond);

  await prueba('ZOH-002: si Zoho registra pero DGP no guarda, responde error y el reintento no duplica en Zoho', async () => {
    const pz = uno(sql("select id from pedidos where zoho_salesorder_id='5001' limit 1"));
    const qid = uno(sql(`insert into paquetes (pedido_id, numero, estado, lineas, verificador) values ('${pz}','PQ-Z-QA-LOCAL','firmado','[{"sku":"ZSKU-1","factura":20,"paquete":20,"mercancia":20}]','QA') returning id`));
    sql(`create or replace function public.qa_falla_local() returns trigger language plpgsql as $f$ begin if new.numero = 'PQ-Z-QA-LOCAL' and new.books_shipment_id is not null then raise exception 'QA: fallo local simulado'; end if; return new; end $f$`);
    sql('create trigger qa_falla_local before update on paquetes for each row execute function public.qa_falla_local()');
    const e0 = mock.zoho.envios.length, p0 = mock.zoho.paquetes.length; const tok = await tokenDe(admin);
    let r1, j1;
    try { r1 = await fn('zoho', tok, { accion: 'registrar_envio', paquete_id: qid }); j1 = await r1.json(); }
    finally { sql('drop trigger if exists qa_falla_local on paquetes'); sql('drop function if exists public.qa_falla_local()'); }
    assert(r1.status === 500 && /no se pudo guardar en DGP/.test(j1.error || ''), 'no informó el fallo local: ' + r1.status + ' ' + JSON.stringify(j1));
    assert(sql(`select (zoho_bloqueo_at is null)::text from paquetes where id='${qid}'`) === 'true', 'el paquete quedó bloqueado');
    const r2 = await fn('zoho', tok, { accion: 'registrar_envio', paquete_id: qid }); const j2 = await r2.json();
    obs.zohoLocal = { primero: r1.status, segundo: r2.status, nuevosEnvios: mock.zoho.envios.length - e0, nuevosPaquetes: mock.zoho.paquetes.length - p0 };
    assert(r2.ok, 'el reintento falló: ' + JSON.stringify(j2));
    assert(obs.zohoLocal.nuevosEnvios === 1 && obs.zohoLocal.nuevosPaquetes === 1, 'el reintento duplicó en Zoho: ' + JSON.stringify(obs.zohoLocal));
    assert(sql(`select (books_shipment_id is not null)::text from paquetes where id='${qid}'`) === 'true', 'el reintento no guardó el envío');
  });

  await prueba('WA-001: webhook no persistido responde 5xx y al reintentar se aplica una sola vez', async () => {
    sql("insert into notificaciones (canal, estado, wa_message_id) values ('telegram','enviado','wamid.QA-H1')");
    sql(`create or replace function public.qa_falla_wa() returns trigger language plpgsql as $f$ begin if new.wa_message_id = 'wamid.QA-H1' then raise exception 'QA: base caída'; end if; return new; end $f$`);
    sql('create trigger qa_falla_wa before update on notificaciones for each row execute function public.qa_falla_wa()');
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.QA-H1', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(body).digest('hex');
    const post = () => fetch(`${API}/functions/v1/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    let r1; try { r1 = await post(); } finally { sql('drop trigger if exists qa_falla_wa on notificaciones'); sql('drop function if exists public.qa_falla_wa()'); }
    assert(r1.status >= 500, 'respondió ' + r1.status + ' aunque no guardó: Meta no reintentaría');
    const r2 = await post(); const r3 = await post();
    assert(r2.status === 200 && r3.status === 200, 'el reintento no fue aceptado');
    assert(sql("select count(*) || '|' || max(estado) from notificaciones where wa_message_id='wamid.QA-H1'") === '1|entregado', 'no quedó aplicado una sola vez');
  });

  await prueba('KNOWN-WA-001: un conductor no puede disparar el envío masivo ni avisos ajenos', async () => {
    const tok = await tokenDe(cond);
    const r1 = await fn('whatsapp', tok, { accion: 'procesar' }); assert(r1.status === 403, 'el conductor disparó el envío masivo: ' + r1.status);
    const ajeno = uno(sql("insert into notificaciones (canal, estado, mensaje) values ('telegram','pendiente','QA ajeno') returning id"));
    const r2 = await fn('whatsapp', tok, { accion: 'procesar', ids: [ajeno] }); const j2 = await r2.json();
    assert(r2.ok && j2.procesados === 0, 'procesó un aviso que no creó: ' + JSON.stringify(j2));
  });

  fs.writeFileSync(path.join(OUT, 'qa-hermes.json'), JSON.stringify(obs, null, 2));
}
