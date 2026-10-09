# DGP · Pase a producción (v3)

Orden exacto. Cada paso dice quién lo hace y cómo se verifica. Tiempo total: ~45 min sin contar la aprobación de plantillas de Meta.

## 0. Antes de empezar
- La v3 vive en la rama `v3-produccion`. `main` sigue sirviendo la demo v2 en https://dgp-liard.vercel.app.
- **El paso 2 corta la demo v2**: elimina el acceso con la clave anon. A partir de ahí solo entra quien tenga usuario.
- Respaldo: Supabase → Database → Backups (o `pg_dump`) antes del paso 2.

## 1. Edge Functions (hecho el 9-oct-2026)
| Función | verify_jwt | Para qué |
|---|---|---|
| `usuarios` | sí | alta, contraseña temporal, activar/desactivar (usa service_role en el servidor) |
| `whatsapp` | **no** (el webhook de Meta no trae JWT; valida firma HMAC, sesión o secreto de cron) | envío de avisos, webhook de estados, pruebas |
| `zoho` | sí | clientes desde Books; artículos, órdenes de venta, paquetes y envíos en Inventory |
| `ia` | sí | proxy de Anthropic con permiso `ia.usar` (antes era un proxy abierto) |

## 2. Base de datos
SQL Editor → pegar `supabase/v3_produccion.sql` → Run. Idempotente (se puede repetir).
Verificación: `select count(*) from pg_policies where policyname = 'demo_all';` → 0.

## 3. Configuración de Supabase Auth (panel)
- Authentication → Providers → Email: **desactivar "Allow new users to sign up"** (los usuarios los crea Administración).
- Authentication → URL Configuration: Site URL = URL de producción; Redirect URLs = la misma + `/conductor.html`.
- Authentication → Policies: longitud mínima de contraseña 10.
- SMTP propio (Settings → Auth → SMTP) si se usarán invitaciones o "Olvidé mi contraseña" (el SMTP de Supabase es solo para pruebas, ~2 correos/hora).
- Opcional Google Workspace: activar proveedor Google y en `public/js/config.js` poner `google: true`.

## 4. Primer administrador
1. Authentication → Users → Add user → correo + contraseña, **Auto Confirm User**.
2. SQL Editor:
   ```sql
   update perfiles set rol = 'admin', activo = true, nombre = 'Miguel Spina' where email = 'CORREO';
   ```
3. Entrar a la torre → Usuarios y permisos → crear el resto (contraseña temporal; se cambia al primer acceso).
   Conductores: vincular siempre su persona del maestro (si no, no ven rutas).

## 5. WhatsApp Business (Cloud API)
1. Meta Business → WhatsApp Manager: número verificado de DGP y **usuario del sistema** con token permanente (permisos `whatsapp_business_messaging`, `whatsapp_business_management`).
2. Crear y enviar a aprobación las plantillas (categoría Utilidad, español):
   - `dgp_salida_ruta`: `DGP: su pedido {{1}} salió de nuestra bodega a las {{2}}. Llegada estimada: {{3}}.`
   - `dgp_demora_ruta`: `DGP: su pedido {{1}} llegará con retraso por {{2}}. Nueva hora estimada: {{3}}. Disculpe la molestia.`
3. Supabase → Edge Functions → Secrets: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_APP_SECRET` (secreto de la app de Meta), `WA_VERIFY_TOKEN` (inventado), `WA_CRON_SECRET` (inventado).
4. Meta → WhatsApp → Configuración → Webhook: URL `https://zeejqutxvpmbozlkkfpe.supabase.co/functions/v1/whatsapp`, token = `WA_VERIFY_TOKEN`, suscribir `messages`.
5. Envío inmediato desde la base (opcional, recomendado): habilitar extensión `pg_net` y en SQL Editor
   ```sql
   select vault.create_secret('https://zeejqutxvpmbozlkkfpe.supabase.co/functions/v1/whatsapp', 'wa_dispatch_url');
   select vault.create_secret('<WA_CRON_SECRET>', 'wa_dispatch_secret');
   ```
6. Barrido de reintentos cada 5 min (extensión `pg_cron`):
   ```sql
   select cron.schedule('dgp-whatsapp', '*/5 * * * *', $$
     select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name='wa_dispatch_url'),
       body := '{"accion":"procesar"}'::jsonb,
       headers := jsonb_build_object('Content-Type','application/json','x-dgp-cron',(select decrypted_secret from vault.decrypted_secrets where name='wa_dispatch_secret')))
   $$);
   ```
7. Torre → Integraciones → "Probar conexión" → "Comparar con Meta" (plantillas APPROVED) → "Mensaje de prueba" → activar "Envío real".

## 6. Zoho (cuando se entreguen las credenciales)
Secretos de la función `zoho`: solo `ZOHO_CLIENT_ID` y `ZOHO_CLIENT_SECRET` (Self Client creado en api-console.zoho.com **con la cuenta de Zoho de DGP**).
Conexión sin carreras contra el reloj: un administrador de Zoho de DGP genera el código (Self Client → Generate Code, scope `ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all`, 10 min, organización de DGP) y lo pega —o pega el self_client.json completo— en **Integraciones → Conectar con Zoho**. La función lo canjea al instante, detecta el centro de datos y la organización, comprueba el acceso a Books e Inventory y guarda el refresh token en `dgp_private.zoho_token` (solo service_role). Queda auditado (`zoho_conectado`). Si la cuenta ve varias organizaciones, se elige en la misma pantalla. El refresh token pertenece al usuario que generó el código: usad un usuario de integración, no el de una persona que pueda irse. `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID` y `ZOHO_DC` siguen valiendo como respaldo por secretos. DGP tiene **Zoho Inventory** (modo por defecto): el paso 7 crea el paquete con las cantidades verificadas y el envío. Modo de respaldo solo Books (`ZOHO_PRODUCTO=books`): el despacho queda como comentario en la orden con las diferencias, más un campo personalizado opcional (`campo_despacho_id`).
Torre → Integraciones → Probar → Sincronizar clientes → artículos → órdenes de venta. Revisar el mapeo (código de cliente, unidad caja/unidad, campo del ejecutivo) antes de activar "Registrar envíos reales".

## 7. IA (opcional)
Secreto `ANTHROPIC_API_KEY` en la función `ia`. Sin él, la app usa el modo simulado por reglas.

## 8. Publicar el frontend
Merge `v3-produccion` → `main`. Vercel publica `public/`. Verificar: login, una ruta completa con usuarios de cada rol, app del conductor en un teléfono real (GPS y cámara con HTTPS).
Plan Vercel: Hobby es solo para uso no comercial → pasar a Pro o mover a Cloudflare Pages/Netlify antes de operar con DGP.

## Reversión
- Frontend: Vercel → Deployments → promover el despliegue anterior.
- Base: las políticas v2 se recrean ejecutando de nuevo `supabase/schema.sql` (vuelve `demo_all`); las tablas nuevas no estorban a la v2.
