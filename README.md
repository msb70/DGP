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

## v2 · 9-oct-2026: ajustes del cuestionario de DGP e infografías operativas

**Lista de picking masivo por ruta** (Picking por ruta): total de cajas por artículo × ruta, con los totales por ruta y las facturas, ordenada por ubicación. Se imprime (lista masiva y separación por color de ruta) y se exporta a Excel (CSV).

**¡Cada pedido sale verificado!** (Verificación de salida), los 8 pasos de la infografía:
1. Paquete impreso por factura con el **color de la ruta** (banda de color, QR, EAN-13, casillas y firmas). 2. Mercancía y paquete en el área del color.
3. El conductor confirma desde su app que llevó la mercancía al área de cargue. 4. Llama al verificador (Telegram + alerta).
5. El verificador cuenta línea por línea (escaneo EAN-13 o conteo): **factura = paquete = mercancía**. Si falta algo, se registra el faltante con nota y se avisa a Facturación y al ejecutivo.
6. Firma digital del conductor y del verificador (por paquete o todos a la vez). 7. El verificador registra el envío en Zoho Books (simulado hasta conectar la API).
8. El encargado de bodega recibe los paquetes firmados y los entrega a Gestión Documental con un **acta** imprimible.
La ruta solo se libera al conductor cuando todos sus paquetes están firmados y registrados.

**Programa de incentivos** (Incentivos): Paneles (diario) y Camiones / Fuso (por viaje) con los indicadores, metas y puntos de la infografía; datos tomados de la operación registrada; devoluciones, faltantes y reclamos justificables; corrección manual con motivo y auditoría; anulación de bono; **bono semanal por equipo** (conductor + ayudante) con tramos; metas editables; exportación CSV.

**Respuestas del cuestionario aplicadas**
| # | Respuesta de DGP | Cambio en la plataforma |
|---|---|---|
| D1/D2 | B/. 2.500 no es un tope: es el mínimo de la ruta (panel 2.500, camión 5.000); limitan espacio y peso | El motor llena por cajas, peso y volumen; ruta bajo el mínimo → sugerencia de anexarla a otra |
| K6 | Avisar a los dueños de las cuentas si la ruta no cumple el mínimo; hora de salida; nueva hora por demora | Avisos segmentados por ejecutivo + gerente comercial; WhatsApp al cliente al salir y al reportar demora |
| B6/A1/A3 | Panel capota alta 5 m³/1.000 kg/120 cajas; capota baja 4 m³/86 cajas; camión 9 m³/3 t/620 cajas; 8 camiones, 8 conductores, 6 ayudantes | Flota y personas semilla |
| B1 | Bodega principal + sucursales Giral y Bejuco | Tres bodegas en el maestro (la planificación del MVP es desde la principal) |
| B8 | Una ruta cambia hasta 7 veces al día | Mover pedido, anexar pedido o ruta completa; versiona, reimprime paquetes, avisa al conductor y alerta al pasar de 7 cambios |
| D3 | Crédito por antigüedad o límite; lo libera el ejecutivo con promesa de pago | Botón "Registrar promesa de pago" en la excepción |
| D4 | Prioridad por horario y urgencia | Urgentes primero sin romper ventanas estrictas |
| A5 | Administración, Facturación y Bodega modifican reglas | Roles y permisos (selector de usuario de demostración; en producción, inicio de sesión con Google Workspace) |
| B9 / H4 | Incidencias: cliente cerrado por horario, devolución por mal empacado; 3 fotos, 12 meses | Causas en la app del conductor; hasta 3 fotos por entrega; regla de retención |
| E1 | EAN-13 | Escaneo EAN-13 en la verificación |
| E4 | Se imprime cada paquete por color de ruta | Paquete impreso por factura con el color de la ruta |

**Actualizar la base de Supabase:** ejecuta de nuevo `supabase/dgp_mvp_completo.sql` en el SQL Editor (idempotente; agrega tablas `paquetes`, `actas_gd`, `incentivos`, `notificaciones` y recarga la semilla v2). Si la base no tiene el esquema v2, la app avisa y trabaja en modo local.
Los datos semilla se generan con `python3 tools/gen_seed.py`.

**Pendiente para producción:** API real de Zoho (Books, CRM, Inventory), WhatsApp Business API y bot de Telegram (hoy los avisos quedan como *simulados*), Supabase Auth con Google y políticas RLS por rol y por cliente, motor VROOM + OSRM propio, planificación desde las sucursales.

## Recorrido de demostración

Pedidos → *Validar elegibilidad* (registra la promesa de pago del cliente con crédito bloqueado) → Planificación → *Generar propuesta* → anexa una ruta bajo el mínimo → *Aprobar y publicar* → **Picking por ruta**: lista masiva e impresión de paquetes → *Mercancía y paquetes en área* → app del conductor: *Mercancía en el área de cargue* y *Llamar al verificador* → **Verificación de salida** (usuario: un verificador): verificar, firmar, registrar en Books, liberar → app del conductor: salida, entregas, demora → **Avisos** → **Gestión documental** (usuario: encargado de bodega) → Costos → *Conciliar* → **Incentivos**.

## Datos de demostración

Clientes: cadenas y empresas reales de Panamá (Súper 99, El Rey, Riba Smith, Xtra, El Machetazo, Arrocha, Metro, Novey, Do It Center, Cochez, Felipe Motta, hospitales, hoteles y centros comerciales) con coordenadas obtenidas de OpenStreetMap y marcadas como `automatica`/`aproximada` para validar. Los pedidos, precios, ventanas y flags (crédito bloqueado, dirección dudosa) son ficticios y solo sirven para ejercitar las reglas.

## Inteligencia artificial (la IA propone, el humano aprueba)

Dos capacidades incluidas en el MVP, ambas con aprobación humana y auditoría:

- **Normalización de direcciones** (Catálogo → *Normalizar direcciones con IA*): para clientes con coordenada aproximada/dudosa/pendiente, el modelo estructura la dirección panameña (corregimiento, distrito, referencia), genera una consulta de geocodificación, se verifica en OpenStreetMap y se propone con nivel de confianza. Se aprueba o rechaza por cliente.
- **Triage de excepciones** (Pedidos → *Triage de excepciones con IA* o botón por fila): clasifica la causa, recomienda la acción (agrupar, diferir, liberar crédito, corregir dirección…), y redacta el WhatsApp al ejecutivo y al cliente. Al aprobar, aplica la acción y registra las notificaciones.

Configuración en *Conexión y app móvil*:

| Modo | Cómo | Uso |
|---|---|---|
| Simulado | Sin configurar nada | Demo sin costo; resultados por reglas, marcados como simulados. |
| Proxy (recomendado) | Desplegar `supabase/functions/ia` con el secreto `ANTHROPIC_API_KEY` y pegar la URL `https://<proyecto>.supabase.co/functions/v1/ia` | La clave nunca sale del servidor. Gratis en Supabase Free. |
| Directo (solo demo) | Pegar la clave de Anthropic en el navegador | Rápido para probar; la clave queda en ese navegador. |

## Seguridad (léelo)

Las políticas RLS del SQL permiten acceso total con la clave anon. Es correcto para una demo privada; **no** publiques la URL a terceros con datos reales. Para producción: autenticación (Supabase Auth) y políticas por rol.
