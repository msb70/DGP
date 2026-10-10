-- DGP · Migración 10d (conexión de WhatsApp desde la plataforma, 10-oct-2026). Idempotente: se puede ejecutar más de una vez.
-- Pegar completo en Supabase → SQL Editor → Run. Requiere 10c ya aplicada. Equivale a la sección 10d de v3_produccion.sql.
-- Activa pg_net y pg_cron si el plan las tiene y programa el barrido de avisos cada 5 minutos.
-- ---------------------------------------------------------------------
-- 10d. Conexión de WhatsApp desde la plataforma (igual que Zoho): DGP pega en Integraciones el token permanente del
--      usuario del sistema y la clave secreta de la app de Meta. La función detecta la app, la cuenta (WABA) y el número,
--      registra el webhook y suscribe la cuenta. El token de verificación del webhook y el secreto del despacho los genera
--      la base: nadie tiene que inventarlos ni copiarlos. Solo service_role ve esta tabla. Los secretos WA_* de la función
--      siguen valiendo como respaldo mientras no haya conexión guardada.
-- ---------------------------------------------------------------------
create table if not exists dgp_private.wa_conexion (
  id int primary key default 1 check (id = 1),
  token text, app_secret text, app_id text, waba_id text, phone_number_id text, numeros jsonb, token_expira timestamptz,
  verify_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  cron_secret  text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  dispatch_url text, webhook_ok boolean not null default false,
  conectado_por text, conectado_at timestamptz, updated_at timestamptz default now()
);
insert into dgp_private.wa_conexion (id) values (1) on conflict (id) do nothing;
revoke all on dgp_private.wa_conexion from public, authenticated, anon;
grant all on dgp_private.wa_conexion to service_role;

create or replace function public.wa_conexion_get() returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select to_jsonb(c) from dgp_private.wa_conexion c where id = 1 $$;
-- Conexión nueva completa (los secretos generados se conservan)
create or replace function public.wa_conexion_set(d jsonb, actor text) returns void language sql security definer set search_path = public, pg_temp as $$
  update dgp_private.wa_conexion set token = d->>'token', app_secret = d->>'app_secret', app_id = d->>'app_id', waba_id = d->>'waba_id',
    phone_number_id = d->>'phone_number_id', numeros = d->'numeros', token_expira = (d->>'token_expira')::timestamptz,
    dispatch_url = d->>'dispatch_url', webhook_ok = coalesce((d->>'webhook_ok')::boolean, false),
    conectado_por = actor, conectado_at = now(), updated_at = now()
  where id = 1 $$;
-- Cambios parciales: número elegido, resultado del registro del webhook
create or replace function public.wa_conexion_patch(d jsonb) returns void language sql security definer set search_path = public, pg_temp as $$
  update dgp_private.wa_conexion set phone_number_id = coalesce(d->>'phone_number_id', phone_number_id), waba_id = coalesce(d->>'waba_id', waba_id),
    webhook_ok = coalesce((d->>'webhook_ok')::boolean, webhook_ok), updated_at = now()
  where id = 1 $$;
revoke execute on function public.wa_conexion_get() from public, anon, authenticated;
revoke execute on function public.wa_conexion_set(jsonb, text) from public, anon, authenticated;
revoke execute on function public.wa_conexion_patch(jsonb) from public, anon, authenticated;
grant execute on function public.wa_conexion_get() to service_role;
grant execute on function public.wa_conexion_set(jsonb, text) to service_role;
grant execute on function public.wa_conexion_patch(jsonb) to service_role;

-- Despacho inmediato al crear un aviso: usa la conexión guardada; si no hay, los secretos del Vault (configuración antigua)
create or replace function dgp_private.despachar_whatsapp() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare u text; s text;
begin
  if new.estado <> 'pendiente' then return new; end if;
  begin
    select dispatch_url, cron_secret into u, s from dgp_private.wa_conexion where id = 1 and token is not null and phone_number_id is not null;
    if u is null then
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into u using 'wa_dispatch_url';
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into s using 'wa_dispatch_secret';
    end if;
    if u is not null then
      execute 'select net.http_post(url := $1, body := $2, headers := $3)'
        using u, jsonb_build_object('accion','procesar','id',new.id), jsonb_build_object('Content-Type','application/json','x-dgp-cron', coalesce(s,''));
    end if;
  exception when others then null;  -- sin pg_net: lo recoge el barrido programado o el botón "Procesar pendientes"
  end;
  return new;
end $$;

-- Barrido cada 5 minutos: reintentos y avisos que el despacho inmediato no llegó a enviar. Solo llama si hay trabajo.
create or replace function dgp_private.wa_barrido() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u text; s text;
begin
  select dispatch_url, cron_secret into u, s from dgp_private.wa_conexion where id = 1 and token is not null and phone_number_id is not null;
  if u is null then return; end if;
  if not exists (select 1 from notificaciones where estado = 'pendiente' or (estado = 'error' and coalesce(intentos,0) < 3)
                 or (estado = 'enviando' and wa_message_id is null and coalesce(intentos,0) < 3 and coalesce(enviando_at, created_at) < now() - interval '10 minutes')) then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using u, '{"accion":"procesar"}'::jsonb, jsonb_build_object('Content-Type','application/json','x-dgp-cron', s);
end $$;
revoke execute on function dgp_private.wa_barrido() from public, anon, authenticated;

-- pg_net (llamadas HTTP desde la base) y pg_cron (tarea cada 5 min). Si el plan no las tiene, todo sigue funcionando
-- con el botón "Procesar pendientes"; el aviso sale en Integraciones.
do $$ begin
  begin create extension if not exists pg_net; exception when others then raise notice 'pg_net no disponible: %', sqlerrm; end;
  begin create extension if not exists pg_cron; exception when others then raise notice 'pg_cron no disponible: %', sqlerrm; end;
end $$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'dgp-whatsapp'$q$;
    execute $q$select cron.schedule('dgp-whatsapp', '*/5 * * * *', 'select dgp_private.wa_barrido()')$q$;
  end if;
exception when others then raise notice 'No se pudo programar el barrido de WhatsApp: %', sqlerrm;
end $$;
-- Diagnóstico para la pantalla (solo service_role): ¿hay despacho inmediato y barrido?
create or replace function public.wa_infra() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b boolean := false;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin execute $q$select exists (select 1 from cron.job where jobname = 'dgp-whatsapp' and active)$q$ into b; exception when others then b := false; end;
  end if;
  return jsonb_build_object('pg_net', exists (select 1 from pg_extension where extname = 'pg_net'), 'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'), 'barrido', coalesce(b, false));
end $$;
revoke execute on function public.wa_infra() from public, anon, authenticated;
grant execute on function public.wa_infra() to service_role;

