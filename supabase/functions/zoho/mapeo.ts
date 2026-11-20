// DGP · Mapeo Zoho ↔ DGP (funciones puras, probadas con deno test en tests/edge).
// Configurable desde integraciones.config del sistema zoho_books / zoho_inventory:
//   { "codigo_cliente": "contact_number" | "contact_id", "unidad_zoho": "caja" | "unidad", "campo_ejecutivo": "cf_ejecutivo" }

export const dominios = (dc = "com") => ({ accounts: `https://accounts.zoho.${dc}`, api: `https://www.zohoapis.${dc}` });

const limpio = (s: unknown) => (s == null ? "" : String(s)).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
const direccion = (a: any) => a ? [a.address, a.street2, a.city, a.state].map(limpio).filter(Boolean).join(", ") : "";
// Detalle de contacto (GET /contacts/{id}): el listado de Zoho no trae direcciones. Envío → facturación → primera dirección adicional.
export function direccionDeContacto(c: any) {
  return direccion(c?.shipping_address) || direccion(c?.billing_address) || (c?.addresses || []).map(direccion).find(Boolean) || null;
}
// Texto comparable: sin tildes, minúsculas, espacios simples ("Dirección Entrega" = "direccion entrega")
export const norm = (s: unknown) => limpio(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Campo personalizado por api_name, etiqueta o placeholder (sin distinguir tildes ni mayúsculas)
export const cf = (obj: any, campo?: string) => {
  if (!campo || !obj) return null;
  if (obj[campo] != null) return obj[campo];
  const n = norm(campo); const api = "cf_" + n.replace(/[^a-z0-9]+/g, "_");
  const l = (obj.custom_fields || []).find((c: any) => c.api_name === campo || c.label === campo || c.placeholder === campo
    || norm(c.label) === n || c.api_name === api || c.placeholder === api);
  if (!l) return null;
  return Array.isArray(l.value) ? l.value : (l.value_formatted ?? l.value);
};

// Ruta preestablecida de la orden (campo «Rutas» de Zoho Books). zonas: [{codigo, zoho_valor, activa}].
// Se reconoce por el texto exacto guardado o, si DGP lo reescribe, por el número: "Ruta 8 …" / "Ruta3 …" → R8 / R3.
export function rutaDeOrden(so: any, zonas: any[], cfg: any = {}) {
  let v: any = cf(so, cfg.campo_ruta || "Rutas");
  const varias = Array.isArray(v) ? v.map(limpio).filter(Boolean) : String(v ?? "").split(/\s*,\s*(?=ruta\s*\d)/i).map(limpio).filter(Boolean);
  const raw = varias[0] || "";
  if (!raw) return { ruta_zoho: null, zona_codigo: null, varias: [] as string[] };
  const n = norm(raw);
  let z = zonas.find((x) => x.zoho_valor && norm(x.zoho_valor) === n);
  if (!z) { const m = n.match(/^ruta\s*(\d+)/); if (m) z = zonas.find((x) => x.codigo === `R${Number(m[1])}`); }
  return { ruta_zoho: raw.slice(0, 200), zona_codigo: z ? z.codigo : null, varias };
}

// Dirección de entrega de la orden: la dirección de envío elegida en la orden (un cliente puede tener varias).
// Respaldo: el campo personalizado «Direccion Entrega» ("Atención: X | País: Panamá | …").
// clave identifica la dirección para no duplicarla: id de dirección de Zoho o el texto normalizado.
export function direccionEntrega(so: any, cfg: any = {}) {
  const sa = so?.shipping_address || {};
  let texto = direccion(sa); let atencion = limpio(sa.attention); const tel = limpio(sa.phone);
  if (!texto) {
    const crudo = limpio(cf(so, cfg.campo_direccion_entrega || "Direccion Entrega"));
    const partes: string[] = [];
    for (const p of crudo.split("|").map(limpio).filter(Boolean)) {
      const m = p.match(/^([^:]{2,25}):\s*(.*)$/); const k = m ? norm(m[1]) : ""; const val = m ? limpio(m[2]) : p;
      if (/^atencion/.test(k)) { atencion = atencion || val; continue; }
      if (/^(pais|telefono|tel|fax|codigo postal|zip)/.test(k) || !val) continue;
      partes.push(val);
    }
    texto = partes.join(", ");
  }
  if (!texto) return null;
  const idZ = limpio(so?.shipping_address_id || sa.address_id);
  const clave = idZ ? `z:${idZ}` : "t:" + norm(texto).replace(/[^a-z0-9]+/g, " ").trim().slice(0, 400);
  return { clave, zoho_address_id: idZ || null, atencion: atencion || null, direccion: texto.slice(0, 500), telefono: tel || null };
}

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
  // Cantidades verificadas por SKU; si el SKU aparece en varias líneas de la orden se reparten línea a línea.
  // Cada línea solo admite lo que le falta por empacar en Zoho (quantity − quantity_packed): si alguien ya empacó
  // la orden en Zoho, empacar la cantidad completa da «La cantidad registrada no puede ser mayor que la cantidad solicitada».
  const verif: Record<string, number> = {};
  for (const l of paquete.lineas || []) verif[limpio(l.sku)] = (verif[limpio(l.sku)] || 0) + (Number(l.mercancia ?? l.paquete ?? l.factura) || 0);
  const tieneVerif = (paquete.lineas || []).length > 0;
  const items = (so.line_items || []).map((li: any) => {
    const sku = limpio(li.sku); const resta = Math.max(0, (Number(li.quantity) || 0) - (Number(li.quantity_packed) || 0));
    let q = resta;
    if (tieneVerif && sku in verif) { q = Math.min(resta, Math.max(0, verif[sku])); verif[sku] -= q; }
    else if (tieneVerif && sku && !(sku in verif)) q = resta;   // línea no verificada (p. ej. servicio): se mantiene el comportamiento anterior
    return { so_line_item_id: li.line_item_id, quantity: q };
  }).filter((x: any) => x.quantity > 0);
  return { package_number: paquete.numero, date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Panama" }).format(new Date()), line_items: items, notes: `Verificado por ${paquete.verificador || ""}. Firmas: conductor y verificador.` };
}
/* Diagnóstico legible de una orden: por línea, pedida / ya empacada / ya enviada en Zoho y lo que DGP verificó. */
export function diagnosticoLineas(so: any, paquete: any) {
  const v: Record<string, number> = {}; for (const l of paquete?.lineas || []) v[limpio(l.sku)] = (v[limpio(l.sku)] || 0) + (Number(l.mercancia ?? l.paquete ?? l.factura) || 0);
  return (so?.line_items || []).map((li: any) => `${limpio(li.sku) || li.name}: pedida ${Number(li.quantity) || 0}, empacada en Zoho ${Number(li.quantity_packed) || 0}, enviada ${Number(li.quantity_shipped) || 0}, verificada DGP ${v[limpio(li.sku)] ?? "—"}`).join(" | ");
}

// ZOH-002 · reconciliación: lo que ya existe en Zoho para un paquete DGP (evita duplicar si se perdió una respuesta o un guardado local)
export function buscarPaquete(previos: any[], pkgId: string | null | undefined, numero: string) {
  return (previos || []).find((x: any) => (pkgId && String(x.package_id) === String(pkgId)) || String(x.package_number) === String(numero)) || null;
}
export function buscarComentarioDespacho(previos: any[], numero: string) {
  const marca = `DESPACHO DGP ${limpio(numero)} ·`;
  return (previos || []).find((x: any) => String(x.description || "").startsWith(marca)) || null;
}
