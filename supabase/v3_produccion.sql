-- =====================================================================
-- DGP · Torre de Control Logística — v3 PRODUCCIÓN
-- Usuarios, roles, permisos, RLS por rol, auditoría inmutable,
-- WhatsApp Business (Cloud API) y estructura de integración con Zoho.
--
-- Orden de ejecución en Supabase (SQL Editor):
--   1) supabase/schema.sql          (esquema base v2; idempotente)
--   2) supabase/v3_produccion.sql   (este archivo; idempotente)
-- NO ejecutar seed.sql ni dgp_mvp_completo.sql en producción: cargan pedidos ficticios.
--
-- Efecto principal: elimina las políticas "demo_all" (acceso total con la
-- clave anon). Después de ejecutarlo, la app SOLO funciona con sesión
-- iniciada y un perfil activo con rol. Crear el primer administrador con
-- la sección 12 de este archivo antes de abrir la app.
-- =====================================================================
create extension if not exists pgcrypto;
create schema if not exists dgp_private;
revoke all on schema dgp_private from public;
grant usage on schema dgp_private to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. Catálogo de roles y permisos
-- ---------------------------------------------------------------------
create table if not exists roles (
  codigo text primary key, nombre text not null, descripcion text,
  sistema boolean default false, orden int default 100, created_at timestamptz default now()
);
create table if not exists permisos (
  codigo text primary key, modulo text not null, nombre text not null, descripcion text, orden int default 100
);
create table if not exists rol_permisos (
  rol text references roles(codigo) on update cascade on delete cascade,
  permiso text references permisos(codigo) on update cascade on delete cascade,
  primary key (rol, permiso)
);

insert into roles (codigo, nombre, descripcion, sistema, orden) values
 ('admin','Administración','Acceso total, gestiona usuarios, roles e integraciones',true,1),
 ('gerente_operaciones','Gerente de operaciones','Supervisa la operación completa e incentivos',false,2),
 ('planificador','Planificación','Valida pedidos, genera y publica rutas',false,3),
 ('encargado_bodega','Encargado de bodega','Cargue, verificación, gestión documental y reglas',false,4),
 ('bodega','Bodega','Picking y cargue',false,5),
 ('verificador','Verificador','Verificación de salida y firmas',false,6),
 ('gestion_documental','Gestión documental','Recibe paquetes firmados y actas',false,7),
 ('facturacion','Facturación','Reglas, costos y faltantes',false,8),
 ('cxc','Cuentas por cobrar','Crédito y promesas de pago',false,9),
 ('ejecutivo','Ejecutivo de cuenta','Sus clientes, promesas de pago y avisos',false,10),
 ('gerente_comercial','Gerente comercial','Ventas, rutas bajo mínimo y avisos',false,11),
 ('mantenimiento','Mantenimiento','Flota y costos',false,12),
 ('conductor','Conductor','App del conductor (solo sus rutas)',true,13),
 ('ayudante','Ayudante','Sin acceso a la plataforma (incentivos por equipo)',false,14),
 ('sin_rol','Sin rol','Usuario pendiente de activación: sin acceso',true,99)
on conflict (codigo) do update set nombre = excluded.nombre, descripcion = excluded.descripcion, sistema = excluded.sistema, orden = excluded.orden;

insert into permisos (codigo, modulo, nombre, orden) values
 ('ver.torre','Vistas','Torre de control',1), ('ver.pedidos','Vistas','Pedidos y elegibilidad',2), ('ver.plan','Vistas','Planificación',3),
 ('ver.manif','Vistas','Manifiesto y cargue',4), ('ver.seguimiento','Vistas','Seguimiento en vivo',5), ('ver.picking','Vistas','Picking por ruta',6),
 ('ver.verif','Vistas','Verificación de salida',7), ('ver.gd','Vistas','Gestión documental',8), ('ver.incent','Vistas','Incentivos',9),
 ('ver.avisos','Vistas','Avisos',10), ('ver.costos','Vistas','Costos y flota',11), ('ver.reglas','Vistas','Reglas y auditoría',12),
 ('ver.catalogo','Vistas','Catálogo de maestros',13), ('ver.config','Vistas','App móvil y sistema',14),
 ('ver.usuarios','Vistas','Usuarios y permisos',15), ('ver.integraciones','Vistas','Integraciones (WhatsApp, Zoho)',16),
 ('pedidos.validar','Operación','Validar elegibilidad y triage de excepciones',20),
 ('pedidos.promesa','Operación','Registrar promesa de pago / liberar crédito',21),
 ('planificar','Operación','Generar, aprobar, publicar y modificar rutas',22),
 ('manifiesto.cargar','Operación','Escanear y cargar manifiestos, liberar rutas',23),
 ('verificar','Operación','Verificar salida, firmar y registrar envío',24),
 ('gd','Operación','Recibir paquetes y emitir actas a gestión documental',25),
 ('seguimiento.incidencias','Operación','Cerrar incidencias desde la torre',26),
 ('incentivos.gestionar','Operación','Calcular, corregir y anular incentivos; editar metas',27),
 ('costos.gestionar','Operación','Cerrar y conciliar rutas, peajes y combustible',28),
 ('notificaciones.enviar','Operación','Enviar y reintentar avisos (WhatsApp)',29),
 ('ia.usar','Operación','Usar las propuestas de IA',30),
 ('app.conductor','Operación','Usar la app del conductor (solo rutas propias)',31),
 ('reglas.editar','Administración','Modificar reglas de negocio',40),
 ('catalogo.editar','Administración','Editar maestros, importar CSV y geocodificar',41),
 ('usuarios.gestionar','Administración','Crear, activar y desactivar usuarios',42),
 ('roles.gestionar','Administración','Editar la matriz de roles y permisos',43),
 ('integraciones.gestionar','Administración','Configurar WhatsApp y Zoho, lanzar sincronizaciones',44),
 ('sistema.reset','Administración','Reiniciar la operación del día (solo pruebas)',45)
on conflict (codigo) do update set modulo = excluded.modulo, nombre = excluded.nombre, orden = excluded.orden;

-- Matriz por defecto. Solo se inserta si el rol aún no tiene permisos, para no pisar cambios hechos desde la app.
do $$
declare m jsonb := '{
 "gerente_operaciones": ["ver.torre","ver.pedidos","ver.plan","ver.manif","ver.seguimiento","ver.picking","ver.verif","ver.gd","ver.incent","ver.avisos","ver.costos","ver.reglas","ver.catalogo","pedidos.validar","planificar","manifiesto.cargar","seguimiento.incidencias","incentivos.gestionar","costos.gestionar","notificaciones.enviar","ia.usar"],
 "planificador": ["ver.torre","ver.pedidos","ver.plan","ver.manif","ver.seguimiento","ver.picking","ver.avisos","ver.costos","ver.catalogo","pedidos.validar","planificar","manifiesto.cargar","seguimiento.incidencias","costos.gestionar","notificaciones.enviar","ia.usar"],
 "encargado_bodega": ["ver.torre","ver.pedidos","ver.plan","ver.manif","ver.seguimiento","ver.picking","ver.verif","ver.gd","ver.incent","ver.avisos","ver.costos","ver.reglas","ver.catalogo","planificar","manifiesto.cargar","verificar","gd","seguimiento.incidencias","incentivos.gestionar","costos.gestionar","reglas.editar"],
 "bodega": ["ver.torre","ver.manif","ver.picking","ver.costos","ver.reglas","manifiesto.cargar","costos.gestionar","reglas.editar"],
 "verificador": ["ver.torre","ver.manif","ver.picking","ver.verif","verificar"],
 "gestion_documental": ["ver.torre","ver.gd","gd"],
 "facturacion": ["ver.torre","ver.pedidos","ver.verif","ver.avisos","ver.costos","ver.reglas","ver.catalogo","costos.gestionar","reglas.editar"],
 "cxc": ["ver.torre","ver.pedidos","ver.avisos","pedidos.promesa"],
 "ejecutivo": ["ver.torre","ver.pedidos","ver.seguimiento","ver.avisos","pedidos.promesa"],
 "gerente_comercial": ["ver.torre","ver.pedidos","ver.seguimiento","ver.avisos","ver.costos","ver.incent","pedidos.promesa","costos.gestionar"],
 "mantenimiento": ["ver.torre","ver.costos","ver.catalogo"],
 "conductor": ["app.conductor"]
}'::jsonb; r text;
begin
  for r in select jsonb_object_keys(m) loop
    if not exists (select 1 from rol_permisos where rol = r) then
      insert into rol_permisos (rol, permiso) select r, jsonb_array_elements_text(m->r) on conflict do nothing;
    end if;
  end loop;
  -- admin siempre tiene todos los permisos (también los que se agreguen en el futuro)
  insert into rol_permisos (rol, permiso) select 'admin', codigo from permisos on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------
-- 2. Perfiles de usuario (1:1 con auth.users)
-- ---------------------------------------------------------------------
create table if not exists perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, nombre text not null default '', rol text not null default 'sin_rol' references roles(codigo) on update cascade,
  persona_id uuid references personas(id) on delete set null,   -- conductor / verificador / ejecutivo del maestro de personas
  bodega_codigo text, telefono text,
  activo boolean not null default false,
  ultimo_acceso timestamptz, creado_por text, debe_cambiar_clave boolean not null default false,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table perfiles add column if not exists debe_cambiar_clave boolean not null default false;
create index if not exists ix_perfiles_rol on perfiles(rol);
create unique index if not exists ux_perfiles_persona on perfiles(persona_id) where persona_id is not null;

-- Alta automática del perfil al crear el usuario en Auth.
-- El rol y la activación SOLO se toman de raw_app_meta_data (lo escribe la Edge Function "usuarios" con service_role).
-- raw_user_meta_data lo controla el propio usuario al registrarse: nunca se usa para el rol.
create or replace function dgp_private.alta_perfil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare app jsonb := coalesce(new.raw_app_meta_data, '{}'); r text := coalesce(app->>'rol', 'sin_rol');
begin
  if not exists (select 1 from public.roles where codigo = r) then r := 'sin_rol'; end if;
  insert into public.perfiles (id, email, nombre, rol, persona_id, bodega_codigo, activo, creado_por)
  values (new.id, new.email,
          coalesce(nullif(app->>'nombre',''), nullif(new.raw_user_meta_data->>'full_name',''), split_part(coalesce(new.email,''),'@',1)),
          r, nullif(app->>'persona_id','')::uuid, nullif(app->>'bodega_codigo',''),
          coalesce((app->>'activo')::boolean, false) and r <> 'sin_rol', app->>'creado_por')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists tr_alta_perfil on auth.users;
create trigger tr_alta_perfil after insert on auth.users for each row execute function dgp_private.alta_perfil();

-- ---------------------------------------------------------------------
-- 3. Funciones de autorización (usadas por las políticas RLS)
-- ---------------------------------------------------------------------
create or replace function dgp_private.perfil_activo() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select activo and rol <> 'sin_rol' from perfiles where id = auth.uid()), false) $$;

create or replace function dgp_private.tiene(p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from perfiles f join rol_permisos rp on rp.rol = f.rol
                 where f.id = auth.uid() and f.activo and f.rol <> 'sin_rol' and rp.permiso = p) $$;

create or replace function dgp_private.tiene_alguno(ps text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from perfiles f join rol_permisos rp on rp.rol = f.rol
                 where f.id = auth.uid() and f.activo and f.rol <> 'sin_rol' and rp.permiso = any(ps)) $$;

-- Usuario de oficina: puede ver la operación completa (cualquier vista de la torre).
create or replace function dgp_private.oficina() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from perfiles f join rol_permisos rp on rp.rol = f.rol
                 where f.id = auth.uid() and f.activo and f.rol <> 'sin_rol' and rp.permiso like 'ver.%') $$;

create or replace function dgp_private.mi_nombre() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p.nombre, f.nombre) from perfiles f left join personas p on p.id = f.persona_id where f.id = auth.uid() $$;

-- ¿La ruta es del conductor que tiene la sesión? (rutas.conductor guarda el nombre de la persona)
create or replace function dgp_private.ruta_propia(rid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select rid is not null and dgp_private.tiene('app.conductor')
     and exists (select 1 from rutas r where r.id = rid and r.conductor = dgp_private.mi_nombre()) $$;

create or replace function dgp_private.pedido_propio(pid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from pedidos p where p.id = pid and dgp_private.ruta_propia(p.ruta_id)) $$;

grant execute on all functions in schema dgp_private to authenticated, service_role;
revoke execute on function dgp_private.alta_perfil() from authenticated;

-- RPC para el frontend: perfil + permisos del usuario con sesión
create or replace function public.mi_perfil() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when f.id is null then null else jsonb_build_object(
    'id', f.id, 'email', f.email, 'nombre', coalesce(nullif(f.nombre,''), p.nombre), 'rol', f.rol,
    'rol_nombre', r.nombre, 'activo', f.activo, 'persona_id', f.persona_id, 'persona_nombre', p.nombre,
    'bodega_codigo', f.bodega_codigo, 'debe_cambiar_clave', f.debe_cambiar_clave,
    'permisos', coalesce((select jsonb_agg(rp.permiso order by rp.permiso) from rol_permisos rp where rp.rol = f.rol and f.activo), '[]'::jsonb)) end
  from (select auth.uid() as uid) u
  left join perfiles f on f.id = u.uid left join personas p on p.id = f.persona_id left join roles r on r.codigo = f.rol $$;
revoke execute on function public.mi_perfil() from public, anon;
grant execute on function public.mi_perfil() to authenticated;

create or replace function public.clave_cambiada() returns void
language sql security definer set search_path = public, pg_temp as $$
  update perfiles set debe_cambiar_clave = false where id = auth.uid() $$;
revoke execute on function public.clave_cambiada() from public, anon;
grant execute on function public.clave_cambiada() to authenticated;

create or replace function public.registrar_acceso() returns void
language sql security definer set search_path = public, pg_temp as $$
  update perfiles set ultimo_acceso = now() where id = auth.uid() $$;
revoke execute on function public.registrar_acceso() from public, anon;
grant execute on function public.registrar_acceso() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Protección de perfiles: sin auto-escalada y siempre un admin activo
-- ---------------------------------------------------------------------
create or replace function dgp_private.proteger_perfil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  if auth.uid() is not null and new.id = auth.uid() and (new.rol is distinct from old.rol or new.activo is distinct from old.activo) then
    raise exception 'No puedes cambiar tu propio rol ni desactivarte' using errcode = '42501';
  end if;
  if old.rol = 'admin' and old.activo and (new.rol <> 'admin' or not new.activo)
     and not exists (select 1 from perfiles where rol = 'admin' and activo and id <> old.id) then
    raise exception 'Debe quedar al menos un administrador activo' using errcode = '42501';
  end if;
  if new.rol = 'admin' and old.rol is distinct from 'admin' and auth.uid() is not null and not dgp_private.tiene('roles.gestionar') then
    raise exception 'Solo quien gestiona roles puede asignar el rol Administración' using errcode = '42501';
  end if;
  if new.activo and new.rol = 'sin_rol' then
    raise exception 'Asigna un rol antes de activar el usuario' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists tr_proteger_perfil on perfiles;
create trigger tr_proteger_perfil before update on perfiles for each row execute function dgp_private.proteger_perfil();

-- ---------------------------------------------------------------------
-- 5. Auditoría inmutable: actor real, sin UPDATE ni DELETE
-- ---------------------------------------------------------------------
alter table auditoria add column if not exists user_id uuid;
alter table auditoria add column if not exists actor_email text;
alter table auditoria add column if not exists ip text;
create index if not exists ix_auditoria_user on auditoria(user_id, created_at desc);

create or replace function dgp_private.sellar_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_at := now();
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select coalesce(nullif(f.nombre,''), f.email), f.email into new.actor, new.actor_email from perfiles f where f.id = auth.uid();
    new.automatico := coalesce(new.automatico, false);
  end if;
  return new;
end $$;
drop trigger if exists tr_sellar_auditoria on auditoria;
create trigger tr_sellar_auditoria before insert on auditoria for each row execute function dgp_private.sellar_auditoria();

create or replace function dgp_private.auditoria_inmutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'La auditoría no se puede modificar ni borrar' using errcode = '42501'; end $$;
drop trigger if exists tr_auditoria_inmutable on auditoria;
create trigger tr_auditoria_inmutable before update or delete on auditoria for each row execute function dgp_private.auditoria_inmutable();

-- Cambios de seguridad auditados en el servidor (no dependen del frontend)
create or replace function dgp_private.auditar_cambio() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ent text := tg_table_name; eid text; ant jsonb; nue jsonb;
begin
  if tg_op = 'DELETE' then ant := to_jsonb(old); eid := coalesce(ant->>'id', ant->>'clave', (ant->>'rol') || ':' || (ant->>'permiso'));
  else nue := to_jsonb(new); eid := coalesce(nue->>'id', nue->>'clave', (nue->>'rol') || ':' || (nue->>'permiso')); if tg_op = 'UPDATE' then ant := to_jsonb(old); end if; end if;
  if tg_op = 'UPDATE' and ant = nue then return new; end if;
  insert into auditoria (entidad, entidad_id, accion, detalle, valor_anterior, valor_nuevo, actor, automatico)
  values (ent, eid, lower(tg_op), 'Cambio registrado por el servidor', ant - 'updated_at', nue - 'updated_at', coalesce(dgp_private.mi_nombre(), 'sistema'), auth.uid() is null);
  return coalesce(new, old);
end $$;
drop trigger if exists tr_audit_perfiles on perfiles;
create trigger tr_audit_perfiles after insert or update or delete on perfiles for each row execute function dgp_private.auditar_cambio();
drop trigger if exists tr_audit_rol_permisos on rol_permisos;
create trigger tr_audit_rol_permisos after insert or delete on rol_permisos for each row execute function dgp_private.auditar_cambio();
drop trigger if exists tr_audit_reglas on reglas;
create trigger tr_audit_reglas after update on reglas for each row execute function dgp_private.auditar_cambio();

-- Sello de actor en reglas (antes lo escribía el navegador)
create or replace function dgp_private.sellar_regla() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then new.actualizado_por := coalesce(dgp_private.mi_nombre(), new.actualizado_por); end if;
  new.updated_at := now(); return new;
end $$;
drop trigger if exists tr_sellar_regla on reglas;
create trigger tr_sellar_regla before update on reglas for each row execute function dgp_private.sellar_regla();

-- ---------------------------------------------------------------------
-- 6. WhatsApp Business (Cloud API)
-- ---------------------------------------------------------------------
alter table notificaciones add column if not exists telefono text;          -- E.164 sin '+', p. ej. 50761234567
alter table notificaciones add column if not exists plantilla text;          -- código en wa_plantillas
alter table notificaciones add column if not exists parametros jsonb;        -- ["FAC-001","07:45","09:30"]
alter table notificaciones add column if not exists cliente_id uuid;
alter table notificaciones add column if not exists wa_message_id text;
alter table notificaciones add column if not exists error text;
alter table notificaciones add column if not exists intentos int default 0;
alter table notificaciones add column if not exists enviado_at timestamptz;
alter table notificaciones add column if not exists entregado_at timestamptz;
alter table notificaciones add column if not exists leido_at timestamptz;
alter table notificaciones add column if not exists creado_por uuid;
create index if not exists ix_notif_pend on notificaciones(estado) where estado in ('pendiente','enviando');
create unique index if not exists ux_notif_wamid on notificaciones(wa_message_id) where wa_message_id is not null;

create table if not exists wa_plantillas (
  codigo text primary key,                 -- referencia interna
  nombre_meta text not null,               -- nombre de la plantilla aprobada en WhatsApp Manager
  idioma text not null default 'es',
  categoria text default 'UTILITY',
  cuerpo text not null,                    -- texto con {{1}}, {{2}}… (debe coincidir con la plantilla aprobada)
  variables text[] default '{}',           -- descripción de cada variable
  motivos text[] default '{}',             -- prefijos de "motivo" de la notificación que usan esta plantilla
  activa boolean default true,
  updated_at timestamptz default now()
);
insert into wa_plantillas (codigo, nombre_meta, idioma, cuerpo, variables, motivos) values
 ('salida_ruta','dgp_salida_ruta','es','DGP: su pedido {{1}} salió de nuestra bodega a las {{2}}. Llegada estimada: {{3}}.', '{factura,hora salida,hora estimada}', '{salida de ruta}'),
 ('demora_ruta','dgp_demora_ruta','es','DGP: su pedido {{1}} llegará con retraso por {{2}}. Nueva hora estimada: {{3}}. Disculpe la molestia.', '{factura,motivo,nueva hora}', '{demora}')
on conflict (codigo) do nothing;

create table if not exists wa_entrantes (            -- mensajes recibidos por el webhook (respuestas de clientes)
  id uuid primary key default gen_random_uuid(),
  wa_message_id text unique, telefono text, nombre text, tipo text, texto text, payload jsonb,
  cliente_id uuid, leido boolean default false, created_at timestamptz default now()
);

-- Normaliza un teléfono panameño a E.164 sin '+'. 8 dígitos (móvil 6xxx-xxxx) o 7 (fijo) → antepone el prefijo del país.
create or replace function dgp_private.tel_e164(t text, pais text default '507') returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when d is null or d = '' then null
    when length(d) in (7, 8) then pais || d
    when length(d) between 10 and 15 then d
    else null end
  from (select regexp_replace(coalesce(t,''), '\D', '', 'g') as d) x $$;

-- Antes de insertar un aviso de WhatsApp: resuelve teléfono y plantilla y decide si se envía de verdad.
create or replace function dgp_private.preparar_notificacion() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg jsonb; tel text;
begin
  new.creado_por := coalesce(new.creado_por, auth.uid());
  if coalesce(new.canal,'') not like 'whatsapp%' then return new; end if;
  select config || jsonb_build_object('activo', activo) into cfg from integraciones where sistema = 'whatsapp';
  if new.telefono is null then
    if new.cliente_id is not null then select telefono into tel from clientes where id = new.cliente_id; end if;
    if tel is null and position('·' in coalesce(new.destinatario,'')) > 0 then tel := split_part(new.destinatario, '·', 2); end if;
    if tel is null then select telefono into tel from clientes where nombre = trim(split_part(coalesce(new.destinatario,''), '·', 1)) limit 1; end if;
    new.telefono := dgp_private.tel_e164(tel, coalesce(cfg->>'prefijo_pais', '507'));
  else
    new.telefono := dgp_private.tel_e164(new.telefono, coalesce(cfg->>'prefijo_pais', '507'));
  end if;
  if new.plantilla is null then
    select codigo into new.plantilla from wa_plantillas w
     where w.activa and exists (select 1 from unnest(w.motivos) m where lower(coalesce(new.motivo,'')) like lower(m) || '%') limit 1;
  end if;
  if coalesce((cfg->>'activo')::boolean, false) then
    if new.telefono is null then new.estado := 'sin_telefono'; new.error := 'Cliente sin teléfono válido';
    elsif new.plantilla is null and coalesce((cfg->>'solo_plantillas')::boolean, true) then new.estado := 'sin_plantilla'; new.error := 'No hay plantilla aprobada para este motivo';
    else new.estado := 'pendiente'; end if;
  else
    new.estado := 'simulado';
  end if;
  return new;
end $$;
drop trigger if exists tr_preparar_notificacion on notificaciones;
create trigger tr_preparar_notificacion before insert on notificaciones for each row execute function dgp_private.preparar_notificacion();

-- Toma un lote de avisos pendientes de forma atómica (evita dobles envíos entre ejecuciones concurrentes).
create or replace function dgp_private.tomar_pendientes(n int default 20, solo uuid default null) returns setof notificaciones
language sql security definer set search_path = public, pg_temp as $$
  update notificaciones set estado = 'enviando', intentos = coalesce(intentos,0) + 1
   where id in (select id from notificaciones
                 where (estado = 'pendiente' or (estado = 'error' and coalesce(intentos,0) < 3)) and (solo is null or id = solo)
                 order by created_at limit n for update skip locked)
  returning * $$;
revoke execute on function dgp_private.tomar_pendientes(int, uuid) from authenticated;
-- Envoltorio expuesto solo a service_role (la Edge Function whatsapp); nadie más puede reclamar avisos.
create or replace function public.wa_tomar_pendientes(n int default 20, ids uuid[] default null) returns setof notificaciones
language sql security definer set search_path = public, pg_temp as $$
  update notificaciones set estado = 'enviando', intentos = coalesce(intentos,0) + 1
   where id in (select id from notificaciones
                 where (estado = 'pendiente' or (estado = 'error' and coalesce(intentos,0) < 3)) and (ids is null or id = any(ids))
                 order by created_at limit n for update skip locked)
  returning * $$;
revoke execute on function public.wa_tomar_pendientes(int, uuid[]) from public, anon, authenticated;
grant execute on function public.wa_tomar_pendientes(int, uuid[]) to service_role;

-- Despacho inmediato desde la base (pg_net), si la extensión está disponible.
-- Configurar una vez:  select vault.create_secret('https://<proyecto>.supabase.co/functions/v1/whatsapp', 'wa_dispatch_url');
--                      select vault.create_secret('<WA_CRON_SECRET>', 'wa_dispatch_secret');
create or replace function dgp_private.despachar_whatsapp() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare u text; s text;
begin
  if new.estado <> 'pendiente' then return new; end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into u using 'wa_dispatch_url';
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into s using 'wa_dispatch_secret';
    if u is not null then
      execute 'select net.http_post(url := $1, body := $2, headers := $3)'
        using u, jsonb_build_object('accion','procesar','id',new.id), jsonb_build_object('Content-Type','application/json','x-dgp-cron', coalesce(s,''));
    end if;
  exception when others then null;  -- sin pg_net/vault: lo recoge la tarea programada o el botón "Procesar pendientes"
  end;
  return new;
end $$;
drop trigger if exists tr_despachar_whatsapp on notificaciones;
create trigger tr_despachar_whatsapp after insert on notificaciones for each row execute function dgp_private.despachar_whatsapp();

-- ---------------------------------------------------------------------
-- 7. Integración Zoho (estructura; credenciales como secretos de la Edge Function "zoho")
-- ---------------------------------------------------------------------
alter table pedidos add column if not exists zoho_invoice_id text;
alter table pedidos add column if not exists zoho_customer_id text;
alter table pedidos add column if not exists origen text default 'manual';     -- manual|csv|zoho
alter table clientes add column if not exists zoho_contact_id text;            -- Books/Inventory
alter table clientes add column if not exists origen text default 'manual';
alter table articulos add column if not exists origen text default 'manual';
alter table paquetes add column if not exists books_error text;
alter table paquetes add column if not exists zoho_package_id text;
alter table pedido_lineas add column if not exists zoho_line_item_id text;
create unique index if not exists ux_pedidos_zoho_so on pedidos(zoho_salesorder_id) where zoho_salesorder_id is not null;
create unique index if not exists ux_clientes_zoho on clientes(zoho_contact_id) where zoho_contact_id is not null;
create unique index if not exists ux_articulos_zoho on articulos(zoho_item_id) where zoho_item_id is not null;

create table if not exists integraciones (
  sistema text primary key,          -- zoho_books|zoho_inventory|zoho_crm|whatsapp
  activo boolean default false, estado text default 'sin_configurar', detalle text,
  config jsonb default '{}'::jsonb,  -- sin secretos: organization_id, región, mapeos
  ultimo_ok timestamptz, ultimo_error timestamptz, updated_at timestamptz default now()
);
insert into integraciones (sistema, config) values
 ('zoho_books', '{"region":"com","organization_id":null}'::jsonb), ('zoho_inventory', '{"region":"com","organization_id":null}'::jsonb),
 ('zoho_crm', '{"region":"com"}'::jsonb), ('whatsapp', '{"prefijo_pais":"507","solo_plantillas":true}'::jsonb)
on conflict (sistema) do nothing;

create table if not exists sync_log (
  id bigint generated always as identity primary key,
  sistema text not null, entidad text not null, direccion text not null,   -- entrada (Zoho→DGP) | salida (DGP→Zoho)
  estado text not null default 'en_curso',                                  -- en_curso|ok|parcial|error
  leidos int default 0, creados int default 0, actualizados int default 0, errores int default 0,
  detalle jsonb, mensaje text, actor text, inicio timestamptz default now(), fin timestamptz
);
create index if not exists ix_sync_log on sync_log(sistema, inicio desc);

-- Caché del access token de Zoho: solo service_role (sin políticas = nadie más la ve)
create table if not exists dgp_private.zoho_token (
  id int primary key default 1 check (id = 1), access_token text, expira timestamptz, api_domain text, updated_at timestamptz default now()
);
revoke all on dgp_private.zoho_token from authenticated, anon;
grant all on dgp_private.zoho_token to service_role;
create or replace function public.zoho_token_get() returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select to_jsonb(t) from dgp_private.zoho_token t where id = 1 $$;
create or replace function public.zoho_token_set(tok text, exp timestamptz, dom text) returns void language sql security definer set search_path = public, pg_temp as $$
  insert into dgp_private.zoho_token (id, access_token, expira, api_domain, updated_at) values (1, tok, exp, dom, now())
  on conflict (id) do update set access_token = excluded.access_token, expira = excluded.expira, api_domain = excluded.api_domain, updated_at = now() $$;
revoke execute on function public.zoho_token_get() from public, anon, authenticated;
revoke execute on function public.zoho_token_set(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.zoho_token_get() to service_role;
grant execute on function public.zoho_token_set(text, timestamptz, text) to service_role;

-- Conexión con Zoho desde la plataforma (v3.1): el administrador pega el código del Self Client en Integraciones y la
-- función lo canjea al instante. El refresh token, el centro de datos y la organización quedan aquí (solo service_role);
-- los secretos ZOHO_REFRESH_TOKEN / ZOHO_ORG_ID / ZOHO_DC siguen funcionando como respaldo si no hay conexión guardada.
alter table dgp_private.zoho_token add column if not exists refresh_token text;
alter table dgp_private.zoho_token add column if not exists dc text;
alter table dgp_private.zoho_token add column if not exists org_id text;
alter table dgp_private.zoho_token add column if not exists organizaciones jsonb;
alter table dgp_private.zoho_token add column if not exists conectado_por text;
alter table dgp_private.zoho_token add column if not exists conectado_at timestamptz;
create or replace function public.zoho_conexion_set(rt text, dcx text, orgs jsonb, org text, actor text) returns void language sql security definer set search_path = public, pg_temp as $$
  insert into dgp_private.zoho_token (id, refresh_token, dc, organizaciones, org_id, conectado_por, conectado_at, access_token, expira, api_domain, updated_at)
  values (1, rt, dcx, orgs, org, actor, now(), null, null, null, now())
  on conflict (id) do update set refresh_token = excluded.refresh_token, dc = excluded.dc, organizaciones = excluded.organizaciones, org_id = excluded.org_id,
    conectado_por = excluded.conectado_por, conectado_at = now(), access_token = null, expira = null, api_domain = null, updated_at = now() $$;
create or replace function public.zoho_org_set(org text) returns void language sql security definer set search_path = public, pg_temp as $$
  update dgp_private.zoho_token set org_id = org, updated_at = now() where id = 1 $$;
revoke execute on function public.zoho_conexion_set(text, text, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.zoho_org_set(text) from public, anon, authenticated;
grant execute on function public.zoho_conexion_set(text, text, jsonb, text, text) to service_role;
grant execute on function public.zoho_org_set(text) to service_role;

-- ---------------------------------------------------------------------
-- 8. Datos sensibles del maestro de personas
-- ---------------------------------------------------------------------
update personas set pin = null where pin is not null;   -- los PIN de la demo eran texto plano; el acceso ahora es con Supabase Auth


-- ---------------------------------------------------------------------
-- 8b. Defensa contra HTML inyectado en datos maestros (Zoho, CSV, edición manual).
--     La interfaz construye tablas con innerHTML; quitar < y > en origen evita XSS almacenado.
-- ---------------------------------------------------------------------
create or replace function dgp_private.sin_html() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare j jsonb := to_jsonb(new); k text; v jsonb; cambios jsonb := '{}'::jsonb;
begin
  for k, v in select * from jsonb_each(j) loop
    if jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '[<>]' then cambios := cambios || jsonb_build_object(k, regexp_replace(v #>> '{}', '[<>]', '', 'g')); end if;
  end loop;
  if cambios <> '{}'::jsonb then new := jsonb_populate_record(new, cambios); end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['clientes','articulos','pedidos','personas','vehiculos','zonas','bodegas','rutas','paquetes','incidencias','perfiles','roles'] loop
    execute format('drop trigger if exists tr_sin_html on %I', t);
    execute format('create trigger tr_sin_html before insert or update on %I for each row execute function dgp_private.sin_html()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Vistas con los permisos de quien consulta
-- ---------------------------------------------------------------------
do $$ begin execute 'alter view v_torre set (security_invoker = true)'; exception when others then null; end $$;

-- ---------------------------------------------------------------------
-- 10. RLS por rol. Elimina "demo_all" y crea políticas por tabla.
--     Lectura: usuarios de oficina activos ven la operación; el conductor solo sus rutas.
--     Escritura: según el permiso operativo de cada tabla; borrar además con sistema.reset.
-- ---------------------------------------------------------------------
create table if not exists dgp_private.tabla_permisos (tabla text primary key, permisos text[] not null);
truncate dgp_private.tabla_permisos;
insert into dgp_private.tabla_permisos values
 ('bodegas', '{catalogo.editar}'), ('zonas', '{catalogo.editar}'), ('articulos', '{catalogo.editar}'),
 ('vehiculos', '{catalogo.editar}'), ('personas', '{catalogo.editar}'),
 ('clientes', '{catalogo.editar}'),
 ('reglas', '{reglas.editar,incentivos.gestionar}'),
 ('pedidos', '{pedidos.validar,pedidos.promesa,planificar,catalogo.editar}'),
 ('pedido_lineas', '{planificar,catalogo.editar}'),
 ('rutas', '{planificar,manifiesto.cargar,verificar,gd,costos.gestionar,incentivos.gestionar}'),
 ('paradas', '{planificar,manifiesto.cargar,costos.gestionar}'),
 ('manifiestos', '{planificar,manifiesto.cargar}'), ('manifiesto_lineas', '{planificar,manifiesto.cargar}'),
 ('paquetes', '{planificar,manifiesto.cargar,verificar,gd}'),
 ('actas_gd', '{gd}'),
 ('incidencias', '{seguimiento.incidencias,incentivos.gestionar,verificar}'),
 ('alertas', '{ver.torre}'),
 ('abastecimientos', '{costos.gestionar}'), ('peajes', '{costos.gestionar}'), ('costos_ruta', '{costos.gestionar}'),
 ('incentivos', '{incentivos.gestionar}'),
 ('notificaciones', '{notificaciones.enviar}'),
 ('eventos', '{planificar,manifiesto.cargar}'), ('posiciones', '{planificar}'),
 ('wa_plantillas', '{integraciones.gestionar}'), ('wa_entrantes', '{notificaciones.enviar}'),
 ('integraciones', '{integraciones.gestionar}'), ('sync_log', '{integraciones.gestionar}');
grant select on dgp_private.tabla_permisos to authenticated;

create or replace function dgp_private.escribe(t text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select dgp_private.tiene_alguno((select permisos from dgp_private.tabla_permisos where tabla = t)) $$;

do $$
declare t text; pol record;
  todas text[] := array['bodegas','zonas','clientes','articulos','vehiculos','personas','reglas','pedidos','pedido_lineas','rutas','paradas','manifiestos','manifiesto_lineas','eventos','incidencias','alertas','auditoria','abastecimientos','peajes','costos_ruta','posiciones','paquetes','actas_gd','incentivos','notificaciones','roles','permisos','rol_permisos','perfiles','wa_plantillas','wa_entrantes','integraciones','sync_log'];
begin
  foreach t in array todas loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
    execute format('revoke all on %I from anon', t);
  end loop;

  -- Maestros: lectura para cualquier usuario activo (también el conductor); escritura con catalogo.editar
  foreach t in array array['bodegas','zonas','clientes','articulos','vehiculos','personas','reglas','roles','permisos','wa_plantillas'] loop
    execute format('create policy p_sel on %I for select to authenticated using (dgp_private.perfil_activo())', t);
  end loop;
  foreach t in array array['bodegas','zonas','clientes','articulos','vehiculos','personas','reglas','wa_plantillas'] loop
    execute format('create policy p_ins on %I for insert to authenticated with check (dgp_private.escribe(%L))', t, t);
    execute format('create policy p_upd on %I for update to authenticated using (dgp_private.escribe(%L)) with check (dgp_private.escribe(%L))', t, t, t);
    execute format('create policy p_del on %I for delete to authenticated using (dgp_private.escribe(%L) and dgp_private.tiene(''catalogo.editar''))', t, t);
  end loop;

  -- Operación de oficina: leer y escribir según permiso
  foreach t in array array['manifiestos','manifiesto_lineas','peajes','costos_ruta','actas_gd','incentivos','integraciones','sync_log','wa_entrantes'] loop
    execute format('create policy p_sel on %I for select to authenticated using (dgp_private.oficina())', t);
    execute format('create policy p_ins on %I for insert to authenticated with check (dgp_private.escribe(%L))', t, t);
    execute format('create policy p_upd on %I for update to authenticated using (dgp_private.escribe(%L)) with check (dgp_private.escribe(%L))', t, t, t);
    execute format('create policy p_del on %I for delete to authenticated using (dgp_private.escribe(%L) or dgp_private.tiene(''sistema.reset''))', t, t);
  end loop;

  -- Tablas de ruta: oficina según permiso; conductor solo en sus rutas
  foreach t in array array['paradas','paquetes','eventos','incidencias','abastecimientos','posiciones'] loop
    execute format('create policy p_sel on %I for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id))', t);
    execute format('create policy p_del on %I for delete to authenticated using (dgp_private.escribe(%L) or dgp_private.tiene(''sistema.reset''))', t, t);
  end loop;
  foreach t in array array['paradas','paquetes'] loop
    execute format('create policy p_ins on %I for insert to authenticated with check (dgp_private.escribe(%L))', t, t);
  end loop;
  -- paradas: el conductor registra check-in, entrega y demoras de sus rutas (columnas limitadas por tr_guardia_conductor)
  execute 'create policy p_upd on paradas for update to authenticated using (dgp_private.escribe(''paradas'') or dgp_private.ruta_propia(ruta_id)) with check (dgp_private.escribe(''paradas'') or dgp_private.ruta_propia(ruta_id))';
  -- paquetes: verificación, firmas y registro en Zoho son de bodega/verificador. El conductor NO modifica paquetes (QA SEG-01/06).
  execute 'create policy p_upd on paquetes for update to authenticated using (dgp_private.escribe(''paquetes'')) with check (dgp_private.escribe(''paquetes''))';
  -- eventos y posiciones: cualquier usuario de oficina activo registra eventos; conductor en sus rutas. Sin modificación posterior.
  execute 'create policy p_ins on eventos for insert to authenticated with check (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_ins on posiciones for insert to authenticated with check (dgp_private.escribe(''posiciones'') or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_ins on incidencias for insert to authenticated with check (dgp_private.escribe(''incidencias'') or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_upd on incidencias for update to authenticated using (dgp_private.escribe(''incidencias'')) with check (dgp_private.escribe(''incidencias''))';
  execute 'create policy p_ins on abastecimientos for insert to authenticated with check (dgp_private.escribe(''abastecimientos'') or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_upd on abastecimientos for update to authenticated using (dgp_private.escribe(''abastecimientos'')) with check (dgp_private.escribe(''abastecimientos''))';

  -- rutas
  execute 'create policy p_sel on rutas for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(id))';
  execute 'create policy p_ins on rutas for insert to authenticated with check (dgp_private.tiene(''planificar''))';
  execute 'create policy p_upd on rutas for update to authenticated using (dgp_private.escribe(''rutas'') or dgp_private.ruta_propia(id)) with check (dgp_private.escribe(''rutas'') or dgp_private.ruta_propia(id))';
  execute 'create policy p_del on rutas for delete to authenticated using (dgp_private.tiene(''planificar'') or dgp_private.tiene(''sistema.reset''))';

  -- pedidos y líneas
  execute 'create policy p_sel on pedidos for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_ins on pedidos for insert to authenticated with check (dgp_private.escribe(''pedidos''))';
  execute 'create policy p_upd on pedidos for update to authenticated using (dgp_private.escribe(''pedidos'') or dgp_private.ruta_propia(ruta_id)) with check (dgp_private.escribe(''pedidos'') or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_del on pedidos for delete to authenticated using (dgp_private.tiene(''sistema.reset''))';
  execute 'create policy p_sel on pedido_lineas for select to authenticated using (dgp_private.oficina() or dgp_private.pedido_propio(pedido_id))';
  execute 'create policy p_ins on pedido_lineas for insert to authenticated with check (dgp_private.escribe(''pedido_lineas''))';
  execute 'create policy p_upd on pedido_lineas for update to authenticated using (dgp_private.escribe(''pedido_lineas'') or dgp_private.pedido_propio(pedido_id)) with check (dgp_private.escribe(''pedido_lineas'') or dgp_private.pedido_propio(pedido_id))';
  execute 'create policy p_del on pedido_lineas for delete to authenticated using (dgp_private.tiene(''sistema.reset''))';

  -- alertas: cualquiera activo genera alertas; oficina las ve y las cierra
  execute 'create policy p_sel on alertas for select to authenticated using (dgp_private.oficina())';
  execute 'create policy p_ins on alertas for insert to authenticated with check (dgp_private.perfil_activo())';
  execute 'create policy p_upd on alertas for update to authenticated using (dgp_private.oficina()) with check (dgp_private.oficina())';
  execute 'create policy p_del on alertas for delete to authenticated using (dgp_private.oficina())';

  -- notificaciones: las genera la operación (incluido el conductor); envío y reintento con notificaciones.enviar
  execute 'create policy p_sel on notificaciones for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id))';
  execute 'create policy p_ins on notificaciones for insert to authenticated with check (dgp_private.perfil_activo())';
  execute 'create policy p_upd on notificaciones for update to authenticated using (dgp_private.escribe(''notificaciones'')) with check (dgp_private.escribe(''notificaciones''))';
  execute 'create policy p_del on notificaciones for delete to authenticated using (dgp_private.tiene(''sistema.reset''))';

  -- auditoría: insertar cualquiera activo (actor sellado por el servidor); leer con ver.reglas o ver.usuarios; nunca modificar
  execute 'create policy p_sel on auditoria for select to authenticated using (dgp_private.tiene_alguno(array[''ver.reglas'',''ver.usuarios'',''ver.incent'']))';
  execute 'create policy p_ins on auditoria for insert to authenticated with check (dgp_private.perfil_activo())';

  -- seguridad
  execute 'create policy p_sel on perfiles for select to authenticated using (id = auth.uid() or dgp_private.tiene(''usuarios.gestionar'') or dgp_private.oficina())';
  execute 'create policy p_upd on perfiles for update to authenticated using (dgp_private.tiene(''usuarios.gestionar'')) with check (dgp_private.tiene(''usuarios.gestionar''))';
  execute 'create policy p_sel on rol_permisos for select to authenticated using (dgp_private.perfil_activo())';
  execute 'create policy p_ins on rol_permisos for insert to authenticated with check (dgp_private.tiene(''roles.gestionar''))';
  execute 'create policy p_del on rol_permisos for delete to authenticated using (dgp_private.tiene(''roles.gestionar'') and not (rol = ''admin''))';
  execute 'create policy p_ins on roles for insert to authenticated with check (dgp_private.tiene(''roles.gestionar''))';
  execute 'create policy p_upd on roles for update to authenticated using (dgp_private.tiene(''roles.gestionar'') and not sistema) with check (dgp_private.tiene(''roles.gestionar''))';
end $$;

-- Columnas de perfiles que un gestor de usuarios puede cambiar (email e id los gestiona Auth)
revoke update on perfiles from authenticated;
grant update (nombre, rol, persona_id, bodega_codigo, telefono, activo) on perfiles to authenticated;
revoke insert, delete on perfiles from authenticated;   -- alta/baja solo vía Edge Function "usuarios"

-- ---------------------------------------------------------------------
-- 10b. Endurecimiento tras la validación QA del 10-oct-2026 (docs/validacion-2026-10-10)
-- ---------------------------------------------------------------------
-- SEG-01/05: el conductor solo cambia, en sus rutas, las columnas que usa la app y con transiciones válidas.
--   La RLS decide QUÉ filas; este trigger decide QUÉ columnas y QUÉ estados. Oficina (escribe(tabla)) y el
--   servidor (service_role / SQL Editor, sin auth.uid()) no pasan por aquí.
--   TG_ARGV[0] = columnas permitidas (coma) · TG_ARGV[1] = transiciones de estado permitidas 'a>b,c>d' ('' = ninguna).
create or replace function dgp_private.guardia_conductor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare libres text[] := string_to_array(TG_ARGV[0], ','); trans text[] := string_to_array(coalesce(TG_ARGV[1], ''), ',');
begin
  if auth.uid() is null or dgp_private.escribe(TG_TABLE_NAME) then return new; end if;
  if (to_jsonb(new) - libres) is distinct from (to_jsonb(old) - libres) then
    raise exception 'El conductor no puede modificar esos datos de %', TG_TABLE_NAME using errcode = '42501';
  end if;
  if 'estado' = any(libres) and new.estado is distinct from old.estado
     and not (old.estado || '>' || new.estado) = any(trans) then
    raise exception 'Cambio de estado no permitido para el conductor en %: % → %', TG_TABLE_NAME, old.estado, new.estado using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists tr_guardia_conductor on rutas;
create trigger tr_guardia_conductor before update on rutas for each row execute function dgp_private.guardia_conductor(
  'estado,area_cargue_at,verificador_llamado_at,salida_at,odometro_salida,pallets_salida,version,hora_fin_prevista,pallets_retorno,pallets_buen_estado,llegada_at,odometro_llegada,km_real,updated_at',
  'liberada>en_ruta,en_ruta>cerrada');
drop trigger if exists tr_guardia_conductor on paradas;
create trigger tr_guardia_conductor before update on paradas for each row execute function dgp_private.guardia_conductor(
  'estado,checkin_at,checkin_lat,checkin_lng,distancia_checkin_m,checkout_at,fotos,foto,receptor,firma,resultado,eta,updated_at',
  'pendiente>en_sitio,pendiente>atendida,en_sitio>atendida,en_sitio>parcial,en_sitio>no_entregada,pendiente>parcial,pendiente>no_entregada');
drop trigger if exists tr_guardia_conductor on pedidos;
create trigger tr_guardia_conductor before update on pedidos for each row execute function dgp_private.guardia_conductor(
  'estado,updated_at', 'planificado>entregado,planificado>parcial,planificado>no_entregado');
drop trigger if exists tr_guardia_conductor on pedido_lineas;
create trigger tr_guardia_conductor before update on pedido_lineas for each row execute function dgp_private.guardia_conductor('entregado', '');

-- DAT-03: dominio cerrado de estados (los mismos que documenta el esquema y usa la aplicación)
do $$ begin
  alter table rutas drop constraint if exists ck_rutas_estado;
  alter table rutas add constraint ck_rutas_estado check (estado in ('simulada','aprobada','publicada','en_cargue','liberada','en_ruta','cerrada','conciliada'));
  alter table pedidos drop constraint if exists ck_pedidos_estado;
  alter table pedidos add constraint ck_pedidos_estado check (estado in ('pendiente_validar','elegible','en_excepcion','planificado','pendiente_autorizacion','diferido','entregado','parcial','no_entregado','cancelado'));
  alter table paradas drop constraint if exists ck_paradas_estado;
  alter table paradas add constraint ck_paradas_estado check (estado in ('pendiente','en_sitio','atendida','parcial','no_entregada','reprogramada'));
  alter table paquetes drop constraint if exists ck_paquetes_estado;
  alter table paquetes add constraint ck_paquetes_estado check (estado in ('pendiente','impreso','en_area','verificado','firmado','registrado','en_bodega','entregado_gd'));
end $$;

-- DAT-02: cantidades, importes y capacidades no negativos (las devoluciones se expresan con "entregado" < cantidad, no con negativos)
do $$ begin
  alter table pedido_lineas drop constraint if exists ck_lineas_no_negativas;
  alter table pedido_lineas add constraint ck_lineas_no_negativas check (cantidad_cajas >= 0 and (precio is null or precio >= 0) and (entregado is null or (entregado >= 0 and entregado <= cantidad_cajas)));
  alter table pedidos drop constraint if exists ck_pedidos_no_negativos;
  alter table pedidos add constraint ck_pedidos_no_negativos check (coalesce(valor,0) >= 0 and coalesce(cajas,0) >= 0 and coalesce(peso_kg,0) >= 0 and coalesce(volumen_m3,0) >= 0);
  alter table vehiculos drop constraint if exists ck_vehiculos_capacidad;
  alter table vehiculos add constraint ck_vehiculos_capacidad check (coalesce(cap_cajas,0) >= 0 and coalesce(cap_peso_kg,0) >= 0 and coalesce(cap_volumen_m3,0) >= 0);
  alter table rutas drop constraint if exists ck_rutas_odometro;
  alter table rutas add constraint ck_rutas_odometro check (odometro_llegada is null or odometro_salida is null or odometro_llegada >= odometro_salida);
end $$;

-- SEG-06: las firmas solo pueden ser imágenes PNG/JPEG en data URL (nada de texto que rompa el atributo src)
do $$ begin
  alter table paquetes drop constraint if exists ck_paquetes_firmas;
  alter table paquetes add constraint ck_paquetes_firmas check (
    (firma_conductor is null or firma_conductor ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$') and
    (firma_verificador is null or firma_verificador ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$'));
end $$;

-- FUN-05: un solo registro en Zoho a la vez por paquete (la Edge Function "zoho" reclama el paquete antes de llamar a Zoho)
alter table paquetes add column if not exists zoho_bloqueo_at timestamptz;
create or replace function public.zoho_reclamar_paquete(pid uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with c as (update paquetes set zoho_bloqueo_at = now() where id = pid
               and (books_shipment_id is null or books_shipment_id like 'SIM-%')
               and (zoho_bloqueo_at is null or zoho_bloqueo_at < now() - interval '2 minutes') returning 1)
  select exists (select 1 from c) $$;
revoke execute on function public.zoho_reclamar_paquete(uuid) from public, anon, authenticated;
grant execute on function public.zoho_reclamar_paquete(uuid) to service_role;

-- COD-06 (servidor): la base de Supabase corre en UTC; las fechas operativas por defecto se toman en hora de Panamá
alter table pedidos alter column fecha set default ((now() at time zone 'America/Panama')::date);
alter table rutas alter column fecha set default ((now() at time zone 'America/Panama')::date);
alter table actas_gd alter column fecha set default ((now() at time zone 'America/Panama')::date);

-- ---------------------------------------------------------------------
-- 11. Realtime (sin cambios de comportamiento; RLS se aplica a las suscripciones)
-- ---------------------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table notificaciones; exception when others then null; end;
  begin alter publication supabase_realtime add table alertas; exception when others then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 12. PRIMER ADMINISTRADOR (ejecutar una sola vez, después de crear el usuario en
--     Authentication → Users → Add user, con "Auto Confirm User"):
--
--   update perfiles set rol = 'admin', activo = true, nombre = 'Nombre Apellido'
--    where email = 'correo@dgp.com.pa';
--
-- Desde el SQL Editor (sin sesión) el trigger lo permite. A partir de ahí,
-- el resto de usuarios se crea desde la app: Usuarios y permisos → Nuevo usuario.
-- ---------------------------------------------------------------------
