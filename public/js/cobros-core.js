/* DGP · Cobros en ruta — lógica común de la torre y de la app del conductor (20-nov-2026).
   En producción las reglas viven en la base (registrar_cobro, liquidar_cobros y el trigger guardia_cobros);
   aquí están las mismas reglas para el modo demo, los estados y la firma. */
const CB_EST = { pendiente: ['Pendiente', 'p-warn'], recibido: ['Recibido por el conductor', 'p-info'], no_recibido: ['No recibido', 'p-crit'], entregado: ['Entregado en oficina', 'p-ok'], anulado: ['Anulado', 'p-mut'] };
const CB_FORMA = { efectivo: 'Efectivo', cheque: 'Cheque' };
const CB_CAUSAS_DEF = [
  ['ausente', 'No estaba el cliente o la persona autorizada a pagar', false, 1], ['sin_fondos', 'Cliente sin efectivo o sin fondos para pagar', false, 2],
  ['cheque_no_listo', 'Cheque no estaba listo o faltaba la firma', false, 3], ['cheque_errores', 'Cheque con errores (monto, fecha, beneficiario o firma)', true, 4],
  ['disputa', 'Cliente no está de acuerdo con el monto o la factura', true, 5], ['ya_pago', 'Cliente indica que ya pagó (transferencia o depósito)', false, 6],
  ['transferencia', 'Pagará por transferencia o depósito', false, 7], ['otro_dia', 'Cliente pide que se pase otro día', false, 8], ['cerrado', 'Local cerrado', false, 9],
  ['no_visitado', 'No se visitó al cliente (tiempo, ruta o incidente)', false, 10], ['otra', 'Otra (explicar en la nota)', true, 99]
].map(([codigo, nombre, requiere_nota, orden]) => ({ codigo, nombre, requiere_nota, orden, activa: true }));
/* Causas activas del catálogo; si el catálogo está vacío (demo) se usan las de fábrica. */
const cbCausas = rows => { const t = (rows && rows.length ? rows : CB_CAUSAS_DEF); return t.filter(c => c.activa !== false).sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.nombre.localeCompare(b.nombre)); };
const cbForma = c => c.forma === 'cheque' ? `Cheque ${c.banco || ''} nº ${c.numero_cheque || ''}` : 'Efectivo';
const cbPill = e => { const x = CB_EST[e] || [e, 'p-mut']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };

/* Firma en un canvas. Devuelve { get(): dataURL|null, limpiar() }. Exige un trazo mínimo para no aceptar firmas vacías. */
function cbFirma(canvas) {
  const ctx = canvas.getContext('2d'); const w = canvas.offsetWidth || 400; canvas.width = w * 2; canvas.height = 300; ctx.scale(2, 2);
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A'; let d = false, puntos = 0;
  const pos = e => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => { d = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => { if (!d) return; ctx.lineTo(...pos(e)); ctx.stroke(); puntos++; e.preventDefault(); });
  window.addEventListener('pointerup', () => { d = false; });
  return { get: () => puntos >= 8 ? canvas.toDataURL('image/png') : null, limpiar: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); puntos = 0; } };
}

/* ---- modo demo: mismas reglas que la base ---- */
async function cbRegistrarLocal(c, ruta, a, causasRows, actor) {
  if (!['pendiente', 'recibido', 'no_recibido'].includes(c.estado)) throw new Error(`El cobro ya está ${c.estado}`);
  if (!ruta || !['en_ruta', 'cerrada'].includes(ruta.estado)) throw new Error(`El viaje ${ruta ? ruta.codigo : ''} aún no ha salido: registra el cobro cuando estés en ruta`);
  const nota = String(a.nota || '').trim(); let patch;
  if (a.recibido) {
    const m = a.monto_recibido == null || a.monto_recibido === '' ? +c.monto : +a.monto_recibido;
    if (!(m > 0)) throw new Error('El monto recibido debe ser mayor que cero');
    if (Math.abs(m - +c.monto) > 0.004 && nota.length < 3) throw new Error(`El monto recibido (${m}) es distinto del monto a cobrar (${c.monto}): explica la diferencia en la nota`);
    patch = { estado: 'recibido', monto_recibido: m, causa_codigo: null, causa_nombre: null };
  } else {
    const ca = cbCausas(causasRows).find(x => x.codigo === a.causa); if (!ca) throw new Error('Elige la causa por la que no se recibió el pago');
    if (ca.requiere_nota && nota.length < 3) throw new Error(`La causa «${ca.nombre}» requiere una nota`);
    patch = { estado: 'no_recibido', monto_recibido: null, causa_codigo: ca.codigo, causa_nombre: ca.nombre };
  }
  Object.assign(patch, { conductor: ruta.conductor || actor, gestion_at: new Date().toISOString(), gestion_lat: a.lat ?? null, gestion_lng: a.lng ?? null, nota_conductor: nota || null, updated_at: new Date().toISOString() });
  await DB.update('cobros', { id: c.id }, patch); Object.assign(c, patch);
  try { await DB.audit('cobros', a.recibido ? 'cobro_recibido' : 'cobro_no_recibido', `${ruta.codigo} · B/. ${(+(patch.monto_recibido || c.monto)).toFixed(2)} ${c.forma}${patch.causa_nombre ? ' · causa: ' + patch.causa_nombre : ''}${nota ? ' · nota: ' + nota : ''}`, actor, false, c.id); } catch (e) { }
  return { ok: true, estado: patch.estado };
}
async function cbLiquidarLocal(cobros, ruta, recibe, firma, actor) {
  if (!cobros.length) throw new Error('Elige los cobros que se entregan');
  if (String(recibe || '').trim().length < 3) throw new Error('Escribe el nombre de quien recibe el dinero');
  if (!firma) throw new Error('Falta la firma de quien recibe');
  const malos = cobros.filter(c => c.estado !== 'recibido'); if (malos.length) throw new Error('Solo se entregan cobros recibidos por el conductor: ' + malos.map(c => `${c.documento || c.id} (${c.estado})`).join(', '));
  if (new Set(cobros.map(c => c.ruta_id)).size !== 1) throw new Error('El acta es por viaje: elige cobros de un solo viaje');
  const sum = f => cobros.filter(f).reduce((s, c) => s + +(c.monto_recibido || 0), 0); const now = new Date().toISOString();
  const acta = { id: DB.uuid(), created_at: now, ruta_id: ruta.id, ruta_codigo: ruta.codigo, ruta_fecha: ruta.fecha, conductor: [...new Set(cobros.map(c => c.conductor).filter(Boolean))].join(', ') || ruta.conductor, recibe: recibe.trim(), firma, liquidado_por: actor,
    n_cobros: cobros.length, total: sum(() => true), total_efectivo: sum(c => c.forma === 'efectivo'), total_cheques: sum(c => c.forma === 'cheque'), n_cheques: cobros.filter(c => c.forma === 'cheque').length };
  await DB.insert('cobros_liquidaciones', [acta]);
  for (const c of cobros) { const p = { estado: 'entregado', entregado_at: now, entregado_a: acta.recibe, entregado_conductor: c.conductor, liquidado_por: actor, liquidacion_id: acta.id }; await DB.update('cobros', { id: c.id }, p); Object.assign(c, p); }
  try { await DB.audit('cobros_liquidaciones', 'cobros_entregados', `${ruta.codigo} · ${acta.n_cobros} cobros · B/. ${acta.total.toFixed(2)} · entrega ${acta.conductor || '—'} · recibe ${acta.recibe}`, actor, false, acta.id); } catch (e) { }
  return { ok: true, acta: acta.id, entregados: cobros.length, total: acta.total, efectivo: acta.total_efectivo, cheques: acta.total_cheques, n_cheques: acta.n_cheques };
}
