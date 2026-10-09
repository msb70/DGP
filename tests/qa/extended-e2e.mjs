import fs from 'node:fs';
import path from 'node:path';
import { firefox, webkit } from 'playwright';
export async function extended(h) {
  const { prueba, sql, admin, cond, browser, rest, fn, tokenDe, mock, WEB, OUT, login, assert } = h;
  const observations = {};
  const start = Date.now();
  await prueba('QA seguridad: conductor no puede falsificar firma del verificador', async () => {
    const id = sql("select q.id from paquetes q join rutas r on r.id=q.ruta_id where r.conductor='Luis Herrera' limit 1");
    assert(id, 'sin paquete propio para prueba');
    const before = sql(`select coalesce(firma_verificador,'') from paquetes where id='${id}'`);
    const r = await rest(`paquetes?id=eq.${id}`, await tokenDe(cond), { method:'PATCH',body:JSON.stringify({firma_verificador:'QA-FIRMA-FALSA',books_shipment_id:'QA-ENVIO-FALSO',estado:'registrado'}) });
    const after = sql(`select firma_verificador from paquetes where id='${id}'`);
    observations.firma = {status:r.status, changed:after === 'QA-FIRMA-FALSA'};
    sql(`update paquetes set firma_verificador=${before ? "'"+before.replace(/'/g,"''")+"'" : 'null'} where id='${id}'`);
    assert(after !== 'QA-FIRMA-FALSA', 'API aceptó firma de verificador y envío falsificados por conductor');
  });
  await prueba('QA XSS: firma guardada no ejecuta código en impresión de bodega', async () => {
    const id=sql("select q.id from paquetes q join rutas r on r.id=q.ruta_id where r.conductor='Luis Herrera' limit 1");
    const r=await rest(`paquetes?id=eq.${id}`,await tokenDe(cond),{method:'PATCH',body:JSON.stringify({firma_verificador:'x" onerror="window.__qaXss=1'})});
    const marker=await admin.evaluate(async id=>{window.__qaXss=0;const q=(await DB.all('paquetes',{id}))[0];const el=document.createElement('div');el.id='qa-xss';el.style.display='none';el.innerHTML=htmlPaquete(q);document.body.append(el);await new Promise(r=>setTimeout(r,500));el.remove();return window.__qaXss;},id);
    sql(`update paquetes set firma_verificador=null where id='${id}'`);
    observations.xss={writeStatus:r.status,executed:marker===1};
    assert(marker===0,'firma enviada por conductor ejecuta JavaScript en pantalla de administración');
  });
  await prueba('QA Zoho: dos registros simultáneos no duplican envíos', async () => {
    // Fixture: paquete NUEVO (nunca registrado en Zoho). Reutilizar el del paso 7 ya no sirve: la función reconcilia por package_number
    // y no crearía nada, lo que ocultaría la carrera en vez de probarla.
    const pid = sql("select id from pedidos where zoho_salesorder_id='5001' limit 1"); assert(pid, 'sin pedido Zoho');
    const id = sql(`insert into paquetes (pedido_id, numero, estado, lineas, verificador) values ('${pid}', 'PQ-Z-QA-CONC', 'firmado', '[{"sku":"ZSKU-1","factura":20,"paquete":20,"mercancia":20}]', 'QA') returning id`).split('\n')[0];
    const n = mock.zoho.envios.length; const p = mock.zoho.paquetes.length; const tok = await tokenDe(admin);
    const rr = await Promise.all([fn('zoho',tok,{accion:'registrar_envio',paquete_id:id}),fn('zoho',tok,{accion:'registrar_envio',paquete_id:id})]);
    observations.zoho = {statuses:rr.map(r=>r.status),shipments:mock.zoho.envios.length-n,packages:mock.zoho.paquetes.length-p};
    assert(observations.zoho.shipments === 1, `se crearon ${observations.zoho.shipments} envíos para el mismo paquete`);
    assert(observations.zoho.packages === 1, `se crearon ${observations.zoho.packages} paquetes en Zoho para el mismo paquete`);
    assert(sql(`select count(*) from paquetes where id='${id}' and books_shipment_id is not null and zoho_bloqueo_at is null`) === '1', 'el paquete no quedó registrado y desbloqueado');
  });
  await prueba('QA Zoho: respuesta perdida tras crear el paquete en Zoho no duplica al reintentar (reconciliación)', async () => {
    const id = sql("select id from paquetes where numero='PQ-Z-QA-CONC'");
    const antes = sql(`select books_shipment_id from paquetes where id='${id}'`);
    sql(`update paquetes set books_shipment_id=null, zoho_package_id=null where id='${id}'`);   // como si se hubiera perdido la respuesta de Zoho
    const n = mock.zoho.envios.length, p = mock.zoho.paquetes.length;
    const r = await fn('zoho', await tokenDe(admin), { accion: 'registrar_envio', paquete_id: id }); assert(r.ok, 'reintento falló: ' + r.status);
    observations.zohoReconciliacion = { nuevosEnvios: mock.zoho.envios.length - n, nuevosPaquetes: mock.zoho.paquetes.length - p };
    assert(observations.zohoReconciliacion.nuevosEnvios === 0 && observations.zohoReconciliacion.nuevosPaquetes === 0, 'el reintento duplicó en Zoho: ' + JSON.stringify(observations.zohoReconciliacion));
    assert(sql(`select books_shipment_id from paquetes where id='${id}'`) === antes, 'no recuperó el envío existente');
  });
  await prueba('QA offline: respuesta perdida tras commit no duplica evento', async () => {
    const text = 'QA respuesta perdida';
    const n = +sql(`select count(*) from eventos where detalle->>'texto'='${text}'`);
    const r = await cond.evaluate(async text => {
      const old = DB.insert; let once=true;
      DB.insert = async (...args) => { const result=await old(...args);if(once){once=false;throw new Error('QA: respuesta perdida tras commit');}return result; };
      try {await Q.push({fn:'insert',table:'eventos',rows:[{ruta_id:S.ruta.id,tipo:'qa_retry',detalle:{texto:text}}]});await Q.flush();return {queue:Q.list().length};}
      finally {DB.insert=old;}
    }, text);
    const added = +sql(`select count(*) from eventos where detalle->>'texto'='${text}'`)-n;
    observations.retry = {rows:added,...r};
    assert(added === 1, `reintento creó ${added} eventos; esperado 1`);
  }, cond);
  await prueba('QA PWA: arranque offline mantiene operación del conductor', async () => {
    const ctx = await browser.newContext({serviceWorkers:'allow',viewport:{width:390,height:844},geolocation:{latitude:8.98,longitude:-79.52},permissions:['geolocation']});
    await ctx.addInitScript(t=>localStorage.setItem('dgp-auth',t), await cond.evaluate(()=>localStorage.getItem('dgp-auth')));
    await ctx.route(/(openstreetmap|project-osrm|fonts\.g)/, r=>r.abort());
    const page=await ctx.newPage();
    try {
      await page.goto(WEB+'/conductor.html');await page.waitForSelector('[data-open]',{timeout:15000});
      await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
      await page.reload();await page.waitForSelector('[data-open]',{timeout:15000});
      const controlled=await page.evaluate(()=>!!navigator.serviceWorker.controller);
      await ctx.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(2500);
      const body=await page.locator('body').innerText();observations.pwa={controlled,body:body.slice(-1500),operable:await page.locator('[data-open]').count()};
      await page.screenshot({path:path.join(OUT,'pwa-offline.png'),fullPage:true});
      assert(observations.pwa.operable > 0, 'shell cargado pero no aparecen rutas al arrancar offline: '+body.slice(-350));
    } finally {await ctx.close();}
  });
  await prueba('QA datos: cantidades negativas se rechazan en servidor', async () => {
    const p = sql('select id from pedidos limit 1'); const sku=sql('select sku from articulos limit 1');
    const r = await rest('pedido_lineas',await tokenDe(admin),{method:'POST',body:JSON.stringify({pedido_id:p,sku,cantidad_cajas:-1,precio:-5})});
    observations.negative={status:r.status};
    assert(r.status >=400, 'base aceptó cantidad y precio negativos (HTTP '+r.status+')');
  });
  observations.browsers=[];
  for(const [name,engine] of [['Firefox',firefox],['WebKit',webkit]]) await prueba('QA navegador: login y torre en '+name,async()=>{
    const b=await engine.launch();const ctx=await b.newContext({viewport:{width:1360,height:900}});const page=await ctx.newPage();
    await ctx.route(/(openstreetmap|project-osrm|fonts\.g)/,r=>r.abort());
    const t=Date.now();
    try{await login(page,WEB+'/index.html','admin@dgp.test','AdminSegura2026');await page.waitForFunction(()=>/Sincronizado/.test(document.getElementById('ctx-sync')?.textContent||''),null,{timeout:20000});observations.browsers.push({name,ok:true,loginSyncMs:Date.now()-t});await page.screenshot({path:path.join(OUT,'smoke-'+name+'.png')});}
    catch(e){observations.browsers.push({name,ok:false,error:e.message});throw e;}
    finally{await b.close();}
  });
  // Measuring real DB.all against a synthetic load in the isolated database.
  sql("insert into pedidos(numero_so,numero_factura,cliente_id,fecha,valor,peso_kg,volumen_m3,cajas,estado) select 'QA-VOL-'||g,'QA-F-'||g,(select id from clientes limit 1),current_date,100,1,0.01,1,'pendiente_validar' from generate_series(1,25000) g");
  const perf=[];
  for(const n of [40,1000,10000,19999,20000,20001,25000]){
    const sample=await admin.evaluate(async n=>{const t=performance.now();const rows=await DB.all('pedidos',null,'numero_so',{or:`numero_so.like.QA-VOL-*,numero_so.eq.NEVER`,limit:n===25000?undefined:n});return {n,got:rows.length,ms:performance.now()-t};},n);
    perf.push(sample);
  }
  observations.dbAll = perf;
  await prueba('QA rendimiento: DB.all no omite pedidos sobre 20.000',async()=>{
    const total=+sql("select count(*) from pedidos where numero_so like 'QA-VOL-%'");const got=perf.at(-1).got;observations.totalOrders=total;
    assert(got === total, `DB.all devuelve ${got} de ${total} pedidos`);
  });
  const tok=await tokenDe(admin);
  observations.load=[];
  for(const concurrency of [1,10,30]){
    const times=[];let errors=0;const t=Date.now();
    for(let batch=0;batch<10;batch++) await Promise.all(Array.from({length:concurrency},async()=>{const s=performance.now();const r=await rest('pedidos?select=id,numero_so&limit=1000',tok);await r.arrayBuffer();times.push(performance.now()-s);if(!r.ok)errors++;}));
    times.sort((a,b)=>a-b);observations.load.push({concurrency,requests:times.length,elapsed:Date.now()-t,errors,p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],p99:times[Math.min(times.length-1,Math.floor(times.length*.99))]});
  }
  observations.elapsed = Date.now()-start;
  fs.writeFileSync(path.join(OUT,'qa-extended.json'),JSON.stringify(observations,null,2));
}
