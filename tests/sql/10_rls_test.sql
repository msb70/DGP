-- Pruebas de seguridad (RLS, roles, auditoría, WhatsApp). Se ejecutan sobre la base local de pruebas.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/10_rls_test.sql   → termina con "TODAS LAS PRUEBAS RLS OK"
\set ON_ERROR_STOP 1
set client_min_messages = warning;
reset role;
create schema if not exists tests;
grant usage on schema tests to authenticated, anon;
create or replace function tests.como(mail text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', coalesce((select jsonb_build_object('sub', id, 'role', 'authenticated', 'email', email)::text from auth.users where email = mail), '{}'), false);
end $$;
grant execute on function tests.como(text) to authenticated, anon;

-- ---------- Datos de prueba (como superusuario) ----------
delete from auth.users where email like '%@test.dgp';
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','admin@test.dgp',  '{"rol":"admin","activo":true,"nombre":"Admin Pruebas"}', '{}'),
 ('00000000-0000-0000-0000-0000000000a2','plan@test.dgp',   '{"rol":"planificador","activo":true,"nombre":"Plan Pruebas"}', '{}'),
 ('00000000-0000-0000-0000-0000000000a3','verif@test.dgp',  '{"rol":"verificador","activo":true}', '{}'),
 ('00000000-0000-0000-0000-0000000000a4','cond@test.dgp',   '{"rol":"conductor","activo":true}', '{}'),
 ('00000000-0000-0000-0000-0000000000a5','cond2@test.dgp',  '{"rol":"conductor","activo":true}', '{}'),
 ('00000000-0000-0000-0000-0000000000a6','intruso@test.dgp','{}', '{"rol":"admin"}'),                       -- se registra solo e intenta darse admin por user_meta
 ('00000000-0000-0000-0000-0000000000a7','baja@test.dgp',   '{"rol":"planificador","activo":true}', '{}'),
 ('00000000-0000-0000-0000-0000000000a8','ejec@test.dgp',   '{"rol":"ejecutivo","activo":true}', '{}');
update perfiles set persona_id = (select id from personas where nombre = 'Luis Herrera') where email = 'cond@test.dgp';
update perfiles set persona_id = (select id from personas where nombre = 'Carlos Pinzón') where email = 'cond2@test.dgp';
update perfiles set activo = false where email = 'baja@test.dgp';
delete from rutas where codigo like 'T-%';
insert into rutas (id, codigo, conductor, estado) values
 ('10000000-0000-0000-0000-000000000001', 'T-LUIS', 'Luis Herrera', 'liberada'),
 ('10000000-0000-0000-0000-000000000002', 'T-CARLOS', 'Carlos Pinzón', 'liberada');
-- un pedido asignado a una ruta está planificado (realismo del fixture: el conductor solo puede pasar planificado → entregado/parcial/no_entregado)
update pedidos set ruta_id = '10000000-0000-0000-0000-000000000001', estado = 'planificado' where numero_so = (select min(numero_so) from pedidos);
update pedidos set ruta_id = '10000000-0000-0000-0000-000000000002', estado = 'planificado' where numero_so = (select max(numero_so) from pedidos);
insert into paradas (ruta_id, secuencia, pedido_id, cliente_id) select ruta_id, 1, id, cliente_id from pedidos where ruta_id in ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002');
update clientes set telefono = '6123-4567' where id = (select cliente_id from pedidos where ruta_id = '10000000-0000-0000-0000-000000000001' limit 1);
update integraciones set activo = true where sistema = 'whatsapp';

do $$ begin
  assert (select rol from perfiles where email = 'intruso@test.dgp') = 'sin_rol', 'El auto-registro no debe heredar rol de user_meta';
  assert not (select activo from perfiles where email = 'intruso@test.dgp'), 'El auto-registro debe quedar inactivo';
  assert (select nombre from perfiles where email = 'admin@test.dgp') = 'Admin Pruebas', 'nombre desde app_meta';
end $$;

-- ---------- 1. anon no ve nada ----------
set role anon;
do $$ begin
  begin perform 1 from reglas limit 1; raise exception 'anon pudo leer reglas'; exception when insufficient_privilege then null; end;
  begin insert into auditoria (entidad, accion) values ('x','y'); raise exception 'anon pudo escribir auditoría'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------- 2. usuario sin rol / inactivo ----------
select tests.como('intruso@test.dgp'); set role authenticated;
do $$ begin
  assert (select count(*) from pedidos) = 0, 'sin_rol no debe ver pedidos';
  assert (select count(*) from reglas) = 0, 'sin_rol no debe ver reglas';
  assert (select count(*) from perfiles) = 1, 'sin_rol solo ve su propio perfil';
  assert (public.mi_perfil()->>'rol') = 'sin_rol', 'mi_perfil devuelve sin_rol';
  assert jsonb_array_length(public.mi_perfil()->'permisos') = 0, 'sin_rol sin permisos';
  begin update perfiles set rol = 'admin', activo = true where id = auth.uid(); exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert (select rol from perfiles where email = 'intruso@test.dgp') = 'sin_rol', 'sin_rol no se puede auto-promover'; end $$;

select tests.como('baja@test.dgp'); set role authenticated;
do $$ begin assert (select count(*) from pedidos) = 0, 'usuario desactivado no ve pedidos'; end $$;
reset role;

-- ---------- 3. planificador ----------
select tests.como('plan@test.dgp'); set role authenticated;
do $$ declare n int; begin
  assert (select count(*) from pedidos) > 0, 'planificador ve pedidos';
  update pedidos set causa = 'prueba planificador' where numero_so = (select min(numero_so) from pedidos);
  get diagnostics n = row_count; assert n = 1, 'planificador actualiza pedidos';
  update reglas set descripcion = descripcion || '' where clave = 'monto_minimo';
  get diagnostics n = row_count; assert n = 0, 'planificador NO edita reglas';
  update clientes set nombre = nombre where true; get diagnostics n = row_count; assert n = 0, 'planificador NO edita clientes';
  update paquetes set nota = 'x' where true; -- puede (planificar), sin filas no falla
  begin insert into actas_gd (numero) values ('A-1'); raise exception 'planificador creó acta GD'; exception when insufficient_privilege then null; end;
  delete from auditoria; get diagnostics n = row_count; assert n = 0, 'nadie borra auditoría vía RLS';
  insert into auditoria (entidad, accion, detalle, actor) values ('prueba', 'test', 'actor falsificado', 'Otro Usuario');
  assert (select count(*) from perfiles) >= 8, 'oficina ve la lista de perfiles (nombres)';
end $$;
reset role;
do $$ begin
  assert (select actor from auditoria where entidad = 'prueba' order by id desc limit 1) = 'Plan Pruebas', 'el servidor sella el actor real';
  assert (select user_id from auditoria where entidad = 'prueba' order by id desc limit 1) = '00000000-0000-0000-0000-0000000000a2', 'user_id sellado';
  begin update auditoria set detalle = 'x' where entidad = 'prueba'; raise exception 'auditoría modificable'; exception when insufficient_privilege then null; end;
  begin delete from auditoria where entidad = 'prueba'; raise exception 'auditoría borrable'; exception when insufficient_privilege then null; end;
end $$;

-- ---------- 4. verificador ----------
select tests.como('verif@test.dgp'); set role authenticated;
do $$ declare n int; begin
  insert into paquetes (ruta_id, numero) values ('10000000-0000-0000-0000-000000000001', 'PQ-T1') ;
  update paquetes set estado = 'verificado' where numero = 'PQ-T1'; get diagnostics n = row_count; assert n = 1, 'verificador verifica paquetes';
  update pedidos set causa = 'x'; get diagnostics n = row_count; assert n = 0, 'verificador no toca pedidos';
  begin insert into rutas (codigo) values ('T-X'); raise exception 'verificador creó ruta'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------- 5. conductor: solo sus rutas ----------
select tests.como('cond@test.dgp'); set role authenticated;
do $$ declare n int; begin
  assert (select count(*) from rutas) = 1 and (select codigo from rutas) = 'T-LUIS', 'conductor ve solo su ruta';
  assert (select count(*) from pedidos) = 1, 'conductor ve solo pedidos de su ruta';
  assert (select count(*) from paradas) = 1, 'conductor ve solo sus paradas';
  assert (select count(*) from paquetes) = 1, 'conductor ve paquetes de su ruta';
  assert (select count(*) from clientes) > 0, 'conductor lee clientes (nombres y direcciones de entrega)';
  assert (select count(*) from auditoria) = 0, 'conductor no lee auditoría';
  assert (select count(*) from incentivos) = 0, 'conductor no lee incentivos';
  update rutas set estado = 'en_ruta' where true; get diagnostics n = row_count; assert n = 1, 'conductor actualiza solo su ruta';
  update paradas set estado = 'atendida' where true; get diagnostics n = row_count; assert n = 1, 'conductor actualiza solo su parada';
  update pedidos set estado = 'entregado' where true; get diagnostics n = row_count; assert n = 1, 'conductor actualiza solo su pedido';
  insert into eventos (ruta_id, tipo) values ('10000000-0000-0000-0000-000000000001', 'salida');
  insert into posiciones (ruta_id, lat, lng) values ('10000000-0000-0000-0000-000000000001', 9, -79.5);
  insert into incidencias (ruta_id, tipo) values ('10000000-0000-0000-0000-000000000001', 'demora');
  begin insert into eventos (ruta_id, tipo) values ('10000000-0000-0000-0000-000000000002', 'falso'); raise exception 'conductor escribió en ruta ajena'; exception when insufficient_privilege then null; end;
  begin insert into posiciones (ruta_id, lat, lng) values ('10000000-0000-0000-0000-000000000002', 9, -79); raise exception 'conductor posición en ruta ajena'; exception when insufficient_privilege then null; end;
  update reglas set valor = valor where true; get diagnostics n = row_count; assert n = 0, 'conductor no edita reglas';
  update integraciones set activo = true where true; get diagnostics n = row_count; assert n = 0, 'conductor no toca integraciones';
  -- KNOWN-WA-001: el conductor solo avisa a clientes de SU ruta; el teléfono sale de la ficha del cliente, no del texto
  begin insert into notificaciones (canal, destinatario, rol, motivo, parametros, ruta_id) values ('whatsapp_cliente', 'Cliente Prueba · 6123-4567', 'cliente', 'salida de ruta (K6)', '["FAC-1","07:30","09:00"]', '10000000-0000-0000-0000-000000000001'); raise exception 'conductor avisó con un teléfono escrito a mano y sin cliente'; exception when insufficient_privilege then null; end;
  insert into notificaciones (canal, destinatario, rol, motivo, parametros, ruta_id, cliente_id) select 'whatsapp_cliente', 'Otro nombre · 6999-9999', 'cliente', 'salida de ruta (K6)', '["FAC-1","07:30","09:00"]', '10000000-0000-0000-0000-000000000001', cliente_id from paradas where ruta_id = '10000000-0000-0000-0000-000000000001' limit 1;
end $$;
reset role;
do $$ begin
  assert (select estado from rutas where codigo = 'T-CARLOS') = 'liberada', 'la ruta ajena no cambió';
  assert (select telefono from notificaciones where ruta_id = '10000000-0000-0000-0000-000000000001' and canal = 'whatsapp_cliente' order by created_at desc limit 1) = '50761234567', 'teléfono normalizado a E.164 desde la ficha del cliente (no del texto)';
  assert (select plantilla from notificaciones where ruta_id = '10000000-0000-0000-0000-000000000001' and canal = 'whatsapp_cliente' order by created_at desc limit 1) = 'salida_ruta', 'plantilla por motivo';
  assert (select estado from notificaciones where ruta_id = '10000000-0000-0000-0000-000000000001' and canal = 'whatsapp_cliente' order by created_at desc limit 1) = 'pendiente', 'WhatsApp activo → pendiente';
  assert (select count(*) from notificaciones where destinatario like '%6999-9999%') = 0, 'el teléfono escrito por el conductor no se guarda';
end $$;
insert into notificaciones (canal, destinatario, motivo) values ('whatsapp_cliente', 'Sin Teléfono SA', 'salida de ruta');
insert into notificaciones (canal, destinatario, motivo) values ('whatsapp_cliente', 'X · 6000-0000', 'otra cosa');
insert into notificaciones (canal, destinatario, motivo) values ('telegram', 'Ana', 'demora');
do $$ begin
  assert (select estado from notificaciones where destinatario = 'Sin Teléfono SA' order by created_at desc limit 1) = 'sin_telefono', 'sin teléfono detectado';
  assert (select estado from notificaciones where destinatario = 'X · 6000-0000' order by created_at desc limit 1) = 'sin_plantilla', 'sin plantilla detectado';
  assert (select estado from notificaciones where destinatario = 'Ana' order by created_at desc limit 1) = 'simulado', 'telegram sigue simulado';
  assert (select count(*) from dgp_private.tomar_pendientes(50)) >= 1, 'tomar_pendientes reclama avisos';
  assert (select count(*) from dgp_private.tomar_pendientes(50)) = 0, 'no se reclaman dos veces';
end $$;
update integraciones set activo = false where sistema = 'whatsapp';
insert into notificaciones (canal, destinatario, motivo) values ('whatsapp_cliente', 'Y · 6111-1111', 'salida de ruta');
do $$ begin assert (select estado from notificaciones where destinatario = 'Y · 6111-1111') = 'simulado', 'WhatsApp inactivo → simulado'; end $$;

-- ---------- 6. ejecutivo ----------
select tests.como('ejec@test.dgp'); set role authenticated;
do $$ declare n int; begin
  update pedidos set promesa_pago = '{"monto":1}' where numero_so = (select min(numero_so) from pedidos); get diagnostics n = row_count; assert n = 1, 'ejecutivo registra promesa';
  begin delete from pedidos; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert (select count(*) from pedidos) >= 40, 'ejecutivo no borró pedidos'; end $$;

-- ---------- 7. administración de usuarios ----------
select tests.como('admin@test.dgp'); set role authenticated;
do $$ declare n int; begin
  update perfiles set rol = 'verificador', activo = true where email = 'intruso@test.dgp'; get diagnostics n = row_count; assert n = 1, 'admin activa y asigna rol';
  begin update perfiles set activo = false where id = auth.uid(); raise exception 'admin se desactivó a sí mismo'; exception when insufficient_privilege then null; end;
  begin update perfiles set email = 'otro@x' where email = 'plan@test.dgp'; raise exception 'email editable'; exception when insufficient_privilege then null; end;
  insert into rol_permisos values ('verificador', 'ver.avisos');
  delete from rol_permisos where rol = 'verificador' and permiso = 'ver.avisos';
  delete from rol_permisos where rol = 'admin' and permiso = 'ver.torre'; get diagnostics n = row_count; assert n = 0, 'no se quitan permisos al rol admin';
  update reglas set descripcion = descripcion where clave = 'monto_minimo'; get diagnostics n = row_count; assert n = 1, 'admin edita reglas';
  update integraciones set config = config where sistema = 'whatsapp'; get diagnostics n = row_count; assert n = 1, 'admin configura integraciones';
end $$;
reset role;
do $$ begin
  assert (select actualizado_por from reglas where clave = 'monto_minimo') = 'Admin Pruebas', 'regla sellada con actor real';
  assert exists (select 1 from auditoria where entidad = 'perfiles' and accion = 'update' and actor = 'Admin Pruebas'), 'cambio de perfil auditado por el servidor';
  assert exists (select 1 from auditoria where entidad = 'rol_permisos' and accion = 'delete'), 'cambio de matriz auditado';
end $$;
select tests.como('plan@test.dgp'); set role authenticated;
do $$ declare n int; begin
  update perfiles set rol = 'admin' where email = 'plan@test.dgp'; get diagnostics n = row_count; assert n = 0, 'planificador no gestiona usuarios';
  begin insert into rol_permisos values ('planificador', 'usuarios.gestionar'); raise exception 'planificador editó la matriz'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- último admin
do $$ begin
  begin update perfiles set activo = false where email = 'admin@test.dgp'; raise exception 'se desactivó el último admin'; exception when insufficient_privilege then null; end;
end $$;

-- ---------- 8. HTML inyectado en maestros ----------
insert into clientes (codigo, nombre) values ('T-XSS', 'Cliente <script>alert(1)</script>');
do $$ begin assert (select nombre from clientes where codigo = 'T-XSS') = 'Cliente scriptalert(1)/script', 'el servidor debe quitar < y >'; end $$;
delete from clientes where codigo = 'T-XSS';

-- limpieza
delete from notificaciones where destinatario in ('Cliente Prueba · 6123-4567','Sin Teléfono SA','X · 6000-0000','Ana','Y · 6111-1111');
delete from paquetes where numero = 'PQ-T1';
update pedidos set ruta_id = null, causa = null, promesa_pago = null, estado = 'pendiente_validar' where ruta_id in ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002') or causa = 'prueba planificador';
delete from rutas where codigo like 'T-%';
update perfiles set rol = 'verificador' where false;
select 'TODAS LAS PRUEBAS RLS OK' as resultado;
