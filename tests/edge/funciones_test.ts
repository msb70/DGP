// deno test tests/edge  · funciones puras de las Edge Functions (mapeo Zoho y mensajes de WhatsApp)
import { mapArticulo, mapCliente, mapPedido, paqueteZoho, ACTUALIZABLE } from "../../supabase/functions/zoho/mapeo.ts";
import { payload } from "../../supabase/functions/whatsapp/lib.ts";
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
