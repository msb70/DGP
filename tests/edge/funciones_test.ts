// deno test tests/edge  · funciones puras de las Edge Functions (mapeo Zoho y mensajes de WhatsApp)
import { mapArticulo, mapCliente, mapPedido, paqueteZoho, ACTUALIZABLE, buscarPaquete, buscarComentarioDespacho, comentarioEnvio } from "../../supabase/functions/zoho/mapeo.ts";
import { analizarToken, payload, validarEntrada } from "../../supabase/functions/whatsapp/lib.ts";
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

Deno.test("cliente: código, teléfono, dirección y ejecutivo", () => {
  const c = mapCliente({ contact_id: 1, contact_number: " ZC-1 ", contact_name: "Súper  <b>Uno</b>", mobile: "6611-2233", shipping_address: { address: "Vía España", city: "Panamá" }, custom_fields: [{ api_name: "cf_ejecutivo", value: "Ana" }] }, { campo_ejecutivo: "cf_ejecutivo" });
  eq([c.codigo, c.nombre, c.telefono, c.direccion, c.ejecutivo], ["ZC-1", "Súper bUno/b", "6611-2233", "Vía España, Panamá", "Ana"], "cliente");
  eq(mapCliente({ contact_id: 7, contact_name: "X" }).codigo, "Z7", "sin número usa id");
  eq(mapCliente({ contact_id: 7, contact_name: "X", status: "inactive" }).credito_bloqueado, true, "inactivo bloquea crédito");
});
Deno.test("artículo: conversión de peso y volumen", () => {
  const a = mapArticulo({ item_id: 9, sku: "A", name: "Arroz", rate: 10, upc: "123", package_details: { weight: 2, weight_unit: "lb", length: 10, width: 10, height: 10, dimension_unit: "in" } });
  eq([a.peso_kg, a.volumen_m3, a.codigo_barras], [0.907, 0.0164, "123"], "unidades imperiales");
  eq(mapArticulo({ item_id: 9, name: "Sin datos" }).peso_kg, null, "sin peso → null (no pisa el dato local)");
});
Deno.test("pedido: cajas por unidad y artículos desconocidos", () => {
  const so = { salesorder_id: 5, salesorder_number: "SO-1", total: 100, date: "2026-10-09", line_items: [{ sku: "A", quantity: 25, rate: 4, line_item_id: "L1" }, { sku: "B", quantity: 1 }] };
  const m = mapPedido(so, "cli", { A: { peso_kg: 2, volumen_m3: 0.01, unidades_por_caja: 12 } }, { unidad_zoho: "unidad" });
  eq([m.pedido.cajas, m.pedido.peso_kg, m.desconocidos], [4, 6, ["B"]], "3 cajas de A + 1 de B; B desconocido");
  eq(ACTUALIZABLE.has("planificado"), false, "pedido planificado no se pisa");
});
Deno.test("paquete Zoho usa cantidades verificadas y omite líneas en cero", () => {
  const p = paqueteZoho({ line_items: [{ sku: "A", quantity: 10, line_item_id: "L1" }, { sku: "B", quantity: 5, line_item_id: "L2" }] }, { numero: "PQ-1", lineas: [{ sku: "A", mercancia: 8 }, { sku: "B", mercancia: 0 }] });
  eq(p.line_items, [{ so_line_item_id: "L1", quantity: 8 }], "solo lo verificado");
});
Deno.test("WhatsApp: plantilla con parámetros limpios y texto libre", () => {
  const t: any = payload({ telefono: "+507 6123-4567", parametros: ["FAC 1", "07:30\n", ""] }, { nombre_meta: "dgp_salida_ruta", idioma: "es" });
  eq([t.to, t.template.name, t.template.components[0].parameters.map((x: any) => x.text)], ["50761234567", "dgp_salida_ruta", ["FAC 1", "07:30", "-"]], "plantilla");
  const l: any = payload({ telefono: "50761234567", mensaje: "hola" }, null); eq([l.type, l.text.body], ["text", "hola"], "texto");
});

Deno.test("comentario de despacho Books: diferencias y totales", async () => {
  const { comentarioEnvio } = await import("../../supabase/functions/zoho/mapeo.ts");
  const so = { line_items: [{ sku: "A", quantity: 10 }, { sku: "B", quantity: 5 }] };
  const t = comentarioEnvio(so, { numero: "PQ-1", verificador: "Ana", lineas: [{ sku: "A", mercancia: 8 }, { sku: "B", mercancia: 5 }] }, { ruta: "R-01", conductor: "Luis" });
  if (!/PQ-1/.test(t) || !/R-01/.test(t) || !/Luis/.test(t) || !/A: pedido 10, despachado 8/.test(t) || /B: pedido/.test(t) || !/total despachada: 13/.test(t)) throw new Error(t);
  const t2 = comentarioEnvio(so, { numero: "PQ-2", lineas: [{ sku: "A", mercancia: 10 }, { sku: "B", mercancia: 5 }] });
  if (!/Sin diferencias/.test(t2)) throw new Error(t2);
});

// ZOH-002: reconciliación — un reintento encuentra lo que ya se creó en Zoho
Deno.test("Zoho: reconciliación encuentra el paquete por id o por número y su envío", () => {
  const previos = [{ package_id: "P1", package_number: "PQ-1", shipment_id: "S1" }, { package_id: "P2", package_number: "PQ-2", shipment_id: "" }];
  eq(buscarPaquete(previos, "P1", "otro")?.shipment_id, "S1", "por id");
  eq(buscarPaquete(previos, null, "PQ-2")?.package_id, "P2", "por número");
  eq(buscarPaquete(previos, null, "PQ-9"), null, "inexistente");
});
Deno.test("Zoho Books: reconciliación encuentra el comentario de despacho del mismo paquete y no el de otro", () => {
  const so = { line_items: [{ sku: "A", quantity: 2 }] };
  const c1 = comentarioEnvio(so, { numero: "PQ-10", lineas: [{ sku: "A", mercancia: 2 }] }, {});
  const previos = [{ comment_id: "C1", description: c1 }, { comment_id: "C2", description: "Nota cualquiera" }];
  eq(buscarComentarioDespacho(previos, "PQ-10")?.comment_id, "C1", "mismo paquete");
  eq(buscarComentarioDespacho(previos, "PQ-1"), null, "PQ-1 no debe coincidir con PQ-10");
});

Deno.test("whatsapp: analizarToken detecta app, cuentas, permisos que faltan y caducidad", () => {
  const ok = analizarToken({ data: { app_id: 77, is_valid: true, expires_at: 0, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"], granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: ["W1", "W2"] }, { scope: "whatsapp_business_management", target_ids: ["W1"] }, { scope: "business_management", target_ids: ["B9"] }] } });
  eq([ok.valido, ok.app_id, ok.wabas, ok.faltan, ok.expira], [true, "77", ["W1", "W2"], [], null], "wa");
  const tmp = analizarToken({ data: { is_valid: true, expires_at: 1767225600, scopes: ["whatsapp_business_messaging"], granular_scopes: [] } });
  eq([tmp.faltan, tmp.wabas, tmp.expira], [["whatsapp_business_management"], [], "2026-01-01T00:00:00.000Z"], "wa");
  eq(analizarToken({}).valido, false, "wa");
});
Deno.test("whatsapp: validarEntrada filtra token y clave secreta antes de llamar a Meta", () => {
  const t = "EAA" + "a".repeat(60);
  eq(validarEntrada("Bearer " + t + "  ", " ABCDEF0123456789abcdef0123456789 "), { token: t, secreto: "abcdef0123456789abcdef0123456789" }, "wa");
  eq(!!validarEntrada("", "a".repeat(32)).error, true, "wa");
  eq(!!validarEntrada("hola", "a".repeat(32)).error, true, "wa");
  eq(!!validarEntrada(t, "g".repeat(32)).error, true, "wa");
  eq(!!validarEntrada(t, "a".repeat(31)).error, true, "wa");
});

Deno.test("geo: consulta limpia y clasificación de resultados de Google", async () => {
  const { consultaPlaces, clasificarPlace, clasificarGeocoding } = await import("../../supabase/functions/geo/lib.ts");
  const q = consultaPlaces("Ana María Sánchez (Colaborador)", "Ana María Sánchez (Colaborador), Arraiján");
  if (q !== "Ana María Sánchez (Colaborador), Arraiján, Panamá" && q !== "Ana María Sánchez, Ana María Sánchez (Colaborador), Arraiján, Panamá") throw new Error(q);
  const q2 = consultaPlaces("Artemis Medical", "Marbella Royal Center Torre A HE 8:00 A 12:00, Marbella");
  if (/HE 8/.test(q2) || !/Artemis Medical, Marbella Royal Center/.test(q2)) throw new Error(q2);
  const neg = clasificarPlace({ location: { latitude: 8.98, longitude: -79.52 }, types: ["restaurant", "food"], displayName: { text: "Tinajas" }, formattedAddress: "Calle 51" });
  if (neg?.estado !== "automatica") throw new Error(JSON.stringify(neg));
  const barrio = clasificarPlace({ location: { latitude: 8.98, longitude: -79.52 }, types: ["neighborhood", "political"] });
  if (barrio?.estado !== "aproximada") throw new Error("barrio debe ser aproximada");
  if (clasificarPlace({ location: { latitude: 40.4, longitude: -3.7 }, types: ["restaurant"] }) !== null) throw new Error("fuera de Panamá debe descartarse");
  const g = clasificarGeocoding({ geometry: { location: { lat: 9.0, lng: -79.5 }, location_type: "ROOFTOP" }, types: ["street_address"], formatted_address: "X" });
  if (g?.estado !== "automatica") throw new Error("rooftop debe ser automatica");
  const g2 = clasificarGeocoding({ geometry: { location: { lat: 9.0, lng: -79.5 }, location_type: "APPROXIMATE" }, types: ["locality", "political"] });
  if (g2?.estado !== "aproximada") throw new Error("approximate debe ser aproximada");
});

// 16-nov-2026 · rutas preestablecidas y dirección de entrega por orden
import { rutaDeOrden, direccionEntrega } from "../../supabase/functions/zoho/mapeo.ts";
const ZONAS = [1, 2, 3, 8, 9].map((n) => ({ codigo: `R${n}`, zoho_valor: n === 8 ? "Ruta 8 Viernes Penonomé Antón Rio Hato" : null }));
Deno.test("ruta: texto exacto, número sin espacio, multiselección y desconocida", () => {
  const so = (v: unknown, label = "Rutas") => ({ custom_fields: [{ label, api_name: "cf_rutas", value: v }] });
  eq(rutaDeOrden(so("Ruta 8  Viernes  Penonome Anton Rio Hato"), ZONAS).zona_codigo, "R8", "texto con dobles espacios y sin tildes");
  eq(rutaDeOrden(so("Ruta3 Jueves Panama Norte San Miguelito -Colon"), ZONAS).zona_codigo, "R3", "Ruta3 pegado");
  const multi = rutaDeOrden(so(["Ruta 1 Lunes a Miércoles Panamá Centro", "Ruta 2 Miércoles Panamá Este"]), ZONAS);
  eq([multi.zona_codigo, multi.varias.length], ["R1", 2], "multiselección: primera");
  eq(rutaDeOrden(so("Ruta 14 Nueva"), ZONAS).zona_codigo, null, "ruta que no existe");
  eq(rutaDeOrden({ custom_fields: [] }, ZONAS), { ruta_zoho: null, zona_codigo: null, varias: [] }, "sin campo");
  eq(rutaDeOrden(so("Ruta 9 Mates Encomiendas", "RUTAS"), ZONAS).zona_codigo, "R9", "etiqueta en mayúsculas");
});
Deno.test("dirección de entrega: envío de la orden, respaldo en el campo y clave estable", () => {
  const a = direccionEntrega({ shipping_address_id: "5393", shipping_address: { attention: "Instituto Justo Arosemena", address: "Brisas del Golf", street2: "Carretera hacia el Club de Golf", city: "San Miguelito", state: "Panamá" } });
  eq([a?.clave, a?.atencion, a?.direccion], ["z:5393", "Instituto Justo Arosemena", "Brisas del Golf, Carretera hacia el Club de Golf, San Miguelito, Panamá"], "dirección de envío");
  const b = direccionEntrega({ shipping_address: { address: "" }, custom_fields: [{ label: "Direccion Entrega", value: "Atención: Laboratorio Clínico Caceres | Dirección: Calle 2, Penonomé | País: Panamá | Teléfono: 997-1234" }] });
  eq([b?.atencion, b?.direccion, b?.clave], ["Laboratorio Clínico Caceres", "Calle 2, Penonomé", "t:calle 2 penonome"], "respaldo desde el campo");
  const c1 = direccionEntrega({ shipping_address: { address: "Vía España  #12", city: "Panamá" } }), c2 = direccionEntrega({ shipping_address: { address: "VIA ESPAÑA #12", city: "panama" } });
  eq(c1?.clave, c2?.clave, "misma dirección escrita distinto → misma clave");
  eq(direccionEntrega({ shipping_address: {} }), null, "sin dirección");
});

// 16-nov-2026 · proveedor gratuito Apps Script (sin GOOGLE_MAPS_API_KEY)
import { esCorte, proveedor, resolver } from "../../supabase/functions/geo/google.ts";
Deno.test("Apps Script: proveedor, reintento con el nombre y corte por cuota", async () => {
  const prev = globalThis.fetch; const pedidas: string[] = [];
  Deno.env.delete("GOOGLE_MAPS_API_KEY"); Deno.env.set("APPS_SCRIPT_GEO_URL", "https://script.google.com/macros/s/X/exec"); Deno.env.set("APPS_SCRIPT_GEO_CLAVE", "k");
  try {
    eq(proveedor(), "apps_script", "sin clave de Google usa Apps Script");
    globalThis.fetch = (async (u: URL) => {
      const q = u.searchParams.get("q") || ""; pedidas.push(q);
      eq(u.searchParams.get("clave"), "k", "envía la clave");
      if (/Cuota/.test(q)) return new Response(JSON.stringify({ status: "OVER_DAILY_LIMIT", error_message: "Service invoked too many times" }));
      if (/^Brisas/.test(q)) return new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }));
      return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Instituto Justo Arosemena, Panamá", types: ["establishment", "school"], partial_match: false, geometry: { location: { lat: 9.05, lng: -79.47 }, location_type: "ROOFTOP" } }] }));
    }) as typeof fetch;
    const r = await resolver("Instituto Justo Arosemena", "Brisas del Golf");
    eq([r?.estado, r?.fuente, r?.lat, pedidas.length], ["automatica", "apps_script", 9.05, 2], "dirección sola falla, con el nombre la encuentra");
    let msg = ""; try { await resolver("", "Cuota agotada"); } catch (e) { msg = (e as Error).message; }
    eq([/OVER_DAILY_LIMIT/.test(msg), esCorte(msg)], [true, true], "cuota agotada detiene el lote");
  } finally { globalThis.fetch = prev; Deno.env.delete("APPS_SCRIPT_GEO_URL"); Deno.env.delete("APPS_SCRIPT_GEO_CLAVE"); }
});
