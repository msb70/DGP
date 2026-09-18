# DGP · Torre de Control Logística — MVP

MVP de la Plataforma Integral de Bodegas, Despacho y Optimización de Rutas para Distribuidora General de Panamá.
Aplicación web estática (sin build) + PWA del conductor + base de datos Supabase. **Costo de infraestructura: 0** en los planes gratuitos.

## Stack (todo gratuito)

| Pieza | Producto | Plan | Notas |
|---|---|---|---|
| Base de datos, API REST, tiempo real | [Supabase](https://supabase.com) | Free (500 MB, 2 proyectos) | Postgres. Se pausa tras 7 días sin uso: abrir el panel lo reactiva. |
| Hosting web + PWA | [Vercel](https://vercel.com) Hobby, [Netlify](https://netlify.com) Free, [Cloudflare Pages](https://pages.cloudflare.com) o [GitHub Pages](https://pages.github.com) | Free | HTTPS incluido (obligatorio para PWA y GPS). Vercel Hobby es solo para uso no comercial. |
| Mapa | [Leaflet](https://leafletjs.com) + teselas [OpenStreetMap](https://www.openstreetmap.org) | Libre | Uso moderado según la política de OSM. Para producción: MapTiler/Stadia (planes gratuitos con clave) o Google Maps con crédito mensual. |
| Rutas por calle y tiempos | [OSRM](http://project-osrm.org) servidor demo | Libre, sin SLA | Para producción: OSRM propio en contenedor (gratis) o Google Routes API. |
| Geocodificación | [Nominatim](https://nominatim.org) | Libre, 1 req/s | Para producción: geocodificador propio o Google Geocoding. |
| Optimización de secuencia y capacidades | Heurística en la app (JS) | — | Para producción: VROOM (open source) o Google Route Optimization. |
| Librerías | supabase-js, Leaflet, PapaParse, qrcode.js | MIT | Desde CDN, sin instalación. |

## Estructura

```
public/               ← sitio estático (esto es lo que se despliega)
  index.html          torre de control
  conductor.html      app del conductor (PWA instalable, offline-first)
  js/app.js           lógica torre (elegibilidad, planificación, manifiesto, costos, reglas, catálogo)
  js/conductor.js     lógica conductor (check-in GPS, evidencias, cola offline)
  js/db.js            capa de datos: Supabase o modo local (localStorage)
  js/geo.js           OSRM + Nominatim
  js/seed.js          datos semilla (clientes reales de Panamá, artículos, vehículos, pedidos)
  js/config.js        URL y anon key de Supabase (opcional; también desde la UI)
  sw.js, manifest.webmanifest, icons/
supabase/
  dgp_mvp_completo.sql   ← esquema + datos semilla, pegar en SQL Editor (idempotente)
  schema.sql / seed.sql  partes por separado
data/*.csv            plantillas y catálogo inicial (clientes, artículos, vehículos, personas, pedidos, líneas)
```

## Puesta en marcha (10 minutos)

1. **Supabase** → New project (Free, región East US). En *SQL Editor* pega `supabase/dgp_mvp_completo.sql` y ejecuta. Copia *Project URL* y *anon key* (Settings → API).
2. **Hosting**: sube la carpeta `public/` (o conecta este repo con *Root Directory = public*). Sin build.
3. Abre la torre de control → **Conexión y app móvil** → pega URL y anon key → *Guardar y reconectar*. (O edita `public/js/config.js` antes de desplegar.)
4. En el teléfono abre `…/conductor.html` (QR en la pantalla de Conexión) → *Añadir a pantalla de inicio*.

Sin Supabase la app funciona en **modo local** (datos en el navegador) para verla de inmediato.

## Recorrido de demostración

Pedidos → *Validar elegibilidad* → Planificación → *Generar propuesta* → autorizar el pedido que excede B/.2,500 → *Aprobar y publicar* → Manifiesto → *Escanear* (prueba un artículo de otra ruta) → *Liberar ruta* → app del conductor: salida, check-in, entrega parcial, sin señal, demora → Seguimiento en vivo → Costos → *Conciliar rutas del día*. En **Reglas** cambia el mínimo de B/.40 o el límite de B/.2,500 y vuelve a validar.

## Datos de demostración

Clientes: cadenas y empresas reales de Panamá (Súper 99, El Rey, Riba Smith, Xtra, El Machetazo, Arrocha, Metro, Novey, Do It Center, Cochez, Felipe Motta, hospitales, hoteles y centros comerciales) con coordenadas obtenidas de OpenStreetMap y marcadas como `automatica`/`aproximada` para validar. Los pedidos, precios, ventanas y flags (crédito bloqueado, dirección dudosa) son ficticios y solo sirven para ejercitar las reglas.

## Seguridad (léelo)

Las políticas RLS del SQL permiten acceso total con la clave anon. Es correcto para una demo privada; **no** publiques la URL a terceros con datos reales. Para producción: autenticación (Supabase Auth) y políticas por rol.
