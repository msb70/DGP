-- DGP · Reversión SEGURA de las migraciones 10b y 10c (OPS-001)
-- Quita triggers, CHECK y funciones añadidos el 10-oct-2026. NO toca autenticación, RLS ni crea demo_all.
-- La política de paquetes queda como en 10b (el conductor sigue sin escribir paquetes: no se reabre SEG-01).
-- Idempotente. Volver a aplicar: supabase/migraciones/2026-10-10_qa_10b.sql + sección 10c de v3_produccion.sql.
drop trigger if exists tr_guardia_conductor on rutas;
drop trigger if exists tr_guardia_conductor on paradas;
drop trigger if exists tr_guardia_conductor on pedidos;
drop trigger if exists tr_guardia_conductor on pedido_lineas;
drop trigger if exists tr_00_restringir_notificacion on notificaciones;
alter table rutas drop constraint if exists ck_rutas_estado;
alter table rutas drop constraint if exists ck_rutas_odometro;
alter table pedidos drop constraint if exists ck_pedidos_estado;
alter table pedidos drop constraint if exists ck_pedidos_no_negativos;
alter table paradas drop constraint if exists ck_paradas_estado;
alter table paquetes drop constraint if exists ck_paquetes_estado;
alter table paquetes drop constraint if exists ck_paquetes_firmas;
alter table pedido_lineas drop constraint if exists ck_lineas_no_negativas;
alter table vehiculos drop constraint if exists ck_vehiculos_capacidad;
drop function if exists public.conciliar_ruta(uuid);
drop function if exists public.registrar_entrega(uuid, text, jsonb, jsonb);
drop function if exists public.zoho_guardar_pedido(jsonb, jsonb);
-- (zoho_reclamar_paquete y wa_tomar_pendientes se mantienen: las usan las Edge Functions anteriores y actuales)
select 'reversion segura aplicada: RLS y autenticación intactas' as resultado;
