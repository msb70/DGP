// DGP · Mapeo Zoho ↔ DGP (funciones puras, probadas con deno test en tests/edge).
// Configurable desde integraciones.config del sistema zoho_books / zoho_inventory:
//   { "codigo_cliente": "contact_number" | "contact_id", "unidad_zoho": "caja" | "unidad", "campo_ejecutivo": "cf_ejecutivo" }

export const dominios = (dc = "com") => ({ accounts: `https://accounts.zoho.${dc}`, api: `https://www.zohoapis.${dc}` });

const limpio = (s: unknown) => (s == null ? "" : String(s)).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
const direccion = (a: any) => a ? [a.address, a.street2, a.city, a.state].map(limpio).filter(Boolean).join(", ") : "";
const cf = (obj: any, campo?: string) => {
  if (!campo || !obj) return null;
  if (obj[campo] != null) return obj[campo];
  const l = (obj.custom_fields || []).find((c: any) => c.api_name === campo || c.label === campo || c.placeholder === campo);
  return l ? (l.value_formatted ?? l.value) : null;
};

export function mapCliente(c: any, cfg: any = {}) {
  const codigo = cfg.codigo_cliente === "contact_id" || !c.contact_number ? `Z${c.contact_id}` : limpio(c.contact_number);
  const out: Record<string, unknown> = {
    zoho_contact_id: String(c.contact_id), codigo, nombre: limpio(c.contact_name || c.company_name),
    telefono: limpio(c.mobile || c.phone) || null,
    direccion: direccion(c.shipping_address) || direccion(c.billing_address) || null,
    contacto: limpio([c.first_name, c.last_name].filter(Boolean).join(" ")) || null,
    origen: "zoho",
  };
  const ej = cf(c, cfg.campo_ejecutivo); if (ej) out.ejecutivo = limpio(ej);
  if (c.status === "inactive") out.credito_bloqueado = true;
  return out;
}

const kg = (w: any, unidad: string) => { const n = Number(w); if (!n) return null; const u = (unidad || "kg").toLowerCase(); return +(u === "g" ? n / 1000 : u === "lb" ? n * 0.453592 : u === "oz" ? n * 0.0283495 : n).toFixed(3); };
export function mapArticulo(i: any) {
  const pd = i.package_details || {};
  const dims = [pd.length, pd.width, pd.height].map(Number);
  const m = (pd.dimension_unit || "cm").toLowerCase() === "in" ? 0.0254 : 0.01;
  const vol = dims.every((x) => x > 0) ? +(dims[0] * dims[1] * dims[2] * m * m * m).toFixed(4) : null;
  return {
    zoho_item_id: String(i.item_id), sku: limpio(i.sku) || `Z${i.item_id}`, nombre: limpio(i.name),
    precio: i.rate != null ? Number(i.rate) : null, categoria: limpio(i.category_name) || null,
    codigo_barras: limpio(i.ean || i.upc || i.isbn) || null,
    peso_kg: kg(pd.weight ?? i.weight, pd.weight_unit || i.weight_unit), volumen_m3: vol,
    origen: "zoho",
  };
}

// Pedido de venta → pedido DGP + líneas. arts: { [sku]: articulo local } para peso, volumen y cajas.
export function mapPedido(so: any, clienteId: string, arts: Record<string, any>, cfg: any = {}) {
  let peso = 0, vol = 0, cajas = 0; const lineas: any[] = [];
  for (const li of so.line_items || []) {
    const sku = limpio(li.sku) || (li.item_id ? `Z${li.item_id}` : "");
    const a = arts[sku] || {}; const q = Number(li.quantity) || 0;
    const nCajas = cfg.unidad_zoho === "unidad" && a.unidades_por_caja ? Math.ceil(q / a.unidades_por_caja) : Math.ceil(q);
    peso += (Number(a.peso_kg) || 0) * nCajas; vol += (Number(a.volumen_m3) || 0) * nCajas; cajas += nCajas;
    lineas.push({ sku, cantidad_cajas: nCajas, precio: li.rate != null ? Number(li.rate) : null, zoho_line_item_id: li.line_item_id ? String(li.line_item_id) : null, conocido: !!arts[sku] });
  }
  return {
    pedido: {
      zoho_salesorder_id: String(so.salesorder_id), numero_so: limpio(so.salesorder_number), cliente_id: clienteId,
      fecha: so.shipment_date || so.date, valor: Number(so.total) || 0, peso_kg: +peso.toFixed(2), volumen_m3: +vol.toFixed(4), cajas,
      numero_factura: limpio((so.invoices || [])[0]?.invoice_number) || null, zoho_invoice_id: (so.invoices || [])[0]?.invoice_id ? String(so.invoices[0].invoice_id) : null,
      zoho_customer_id: so.customer_id ? String(so.customer_id) : null, origen: "zoho",
    },
    lineas,
    desconocidos: lineas.filter((l) => !l.conocido).map((l) => l.sku),
  };
}

// Estados de pedido DGP que todavía se pueden actualizar desde Zoho (después de planificar, manda la operación)
export const ACTUALIZABLE = new Set(["pendiente_validar", "elegible", "en_excepcion", "diferido"]);

// Paquete verificado → comentario en la orden de venta de Zoho Books (Books no tiene paquetes ni envíos por API).
// Deja constancia legible del despacho y de cada diferencia entre lo pedido y lo verificado.
export function comentarioEnvio(so: any, paquete: any, extra: { conductor?: string; ruta?: string; actor?: string } = {}) {
  const verif: Record<string, number> = {};
  for (const l of paquete.lineas || []) verif[limpio(l.sku)] = Number(l.mercancia ?? l.paquete ?? l.factura) || 0;
  const difs: string[] = []; let total = 0;
  for (const li of so.line_items || []) {
    const sku = limpio(li.sku) || `Z${li.item_id}`; const pedido = Number(li.quantity) || 0;
    const q = sku in verif ? verif[sku] : pedido; total += q;
    if (q !== pedido) difs.push(`${sku}: pedido ${pedido}, despachado ${q}`);
  }
  const partes = [
    `DESPACHO DGP ${limpio(paquete.numero)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    extra.ruta ? `Ruta ${limpio(extra.ruta)}` : "", extra.conductor ? `Conductor ${limpio(extra.conductor)}` : "",
    `Verificó ${limpio(paquete.verificador || extra.actor || "")}`, `Cantidad total despachada: ${total}`,
    difs.length ? `DIFERENCIAS: ${difs.join("; ")}` : "Sin diferencias con la orden",
  ].filter(Boolean);
  return partes.join(" · ").slice(0, 2000);
}

// Paquete verificado → cuerpo del paquete de Zoho Inventory (cantidades verificadas por línea)
export function paqueteZoho(so: any, paquete: any) {
  const verif: Record<string, number> = {};
  for (const l of paquete.lineas || []) verif[l.sku] = Number(l.mercancia ?? l.paquete ?? l.factura) || 0;
  const items = (so.line_items || []).map((li: any) => {
    const sku = limpio(li.sku); const q = sku in verif ? verif[sku] : Number(li.quantity);
    return { so_line_item_id: li.line_item_id, quantity: Math.min(Number(li.quantity), Math.max(0, q)) };
  }).filter((x: any) => x.quantity > 0);
  return { package_number: paquete.numero, date: new Date().toISOString().slice(0, 10), line_items: items, notes: `Verificado por ${paquete.verificador || ""}. Firmas: conductor y verificador.` };
}
