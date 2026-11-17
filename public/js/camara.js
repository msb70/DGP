/* Lector de códigos por cámara (EAN-13, EAN-8, Code 128, Code 39, UPC, QR) para Verificación de salida.
   Usa html5-qrcode (vendor, MIT); en Chrome/Android aprovecha el BarcodeDetector nativo si existe.
   Requiere HTTPS y permiso de cámara (Permissions-Policy camera=(self) lo permite).
   Camara.abrir(cb, contenedor): pinta el visor dentro del elemento `contenedor` (id o nodo). */
const Camara = (() => {
  let lector = null, alLeer = null, caja = null, ultimo = '', ultimoTs = 0;
  const msg = t => { const e = caja && caja.querySelector('[data-cam-msg]'); if (e) e.textContent = t; };
  function formatos() {
    const F = window.Html5QrcodeSupportedFormats; if (!F) return undefined;
    return [F.EAN_13, F.EAN_8, F.CODE_128, F.CODE_39, F.UPC_A, F.UPC_E, F.QR_CODE].filter(x => x !== undefined);
  }
  async function abrir(cb, contenedor) {
    alLeer = cb;
    if (!window.isSecureContext) { toast('La cámara solo funciona con HTTPS.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Este navegador no permite usar la cámara. Usa el campo de texto o un lector USB/Bluetooth.'); return; }
    if (!window.Html5Qrcode) { toast('No se cargó el lector de cámara. Recarga la página (Ctrl+Shift+R).'); return; }
    if (lector) return;
    const host = typeof contenedor === 'string' ? document.getElementById(contenedor) : contenedor; if (!host) return;
    const vid = 'cam-view-' + Date.now();
    host.innerHTML = `<div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:8px;margin-bottom:8px"><div id="${vid}" style="width:100%;max-width:420px;margin:auto"></div><div class="row" style="justify-content:space-between;margin-top:6px"><span class="note" data-cam-msg>Pidiendo permiso de cámara…</span><button type="button" class="btn sec sm" data-cam-stop>Cerrar cámara</button></div></div>`;
    caja = host; host.querySelector('[data-cam-stop]').onclick = () => cerrar();
    try {
      lector = new Html5Qrcode(vid, { formatsToSupport: formatos(), useBarCodeDetectorIfSupported: true, verbose: false });
      await lector.start({ facingMode: 'environment' }, { fps: 10 }, leido, () => { });
      msg('Apunta al código de barras…');
    } catch (e) {
      const n = (e && (e.name || e)) + '';
      const t = /NotAllowed|Permission/i.test(n) ? 'Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones y vuelve a intentar.'
        : /NotFound|Overconstrained|DevicesNotFound/i.test(n) ? 'No se encontró ninguna cámara en este equipo.'
        : /NotReadable|TrackStart/i.test(n) ? 'La cámara está en uso por otra aplicación.' : 'No se pudo abrir la cámara: ' + n;
      toast(t); await cerrar(); 
    }
  }
  function leido(code) {
    const ahora = Date.now(); if (code === ultimo && ahora - ultimoTs < 2500) return; // la misma caja frente a la cámara no cuenta dos veces
    ultimo = code; ultimoTs = ahora; msg('Leído: ' + code);
    try { navigator.vibrate && navigator.vibrate(80); } catch (x) { }
    if (alLeer) alLeer(code);
  }
  async function cerrar() {
    const l = lector; lector = null;
    if (l) { try { await l.stop(); } catch (x) { } try { l.clear(); } catch (x) { } }
    if (caja) { caja.innerHTML = ''; caja = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) cerrar(); });
  return { abrir, cerrar, activa: () => !!lector };
})();
