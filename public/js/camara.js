/* Lector de códigos por cámara para el cargue (EAN-13, EAN-8, Code 128, Code 39, UPC, QR).
   Usa html5-qrcode (vendor, MIT); en Chrome/Android aprovecha el BarcodeDetector nativo si existe.
   Requiere HTTPS y permiso de cámara del navegador (Permissions-Policy camera=(self) ya lo permite). */
const Camara = (() => {
  let lector = null, alLeer = null, ultimo = '', ultimoTs = 0;
  const $c = id => document.getElementById(id);
  const msg = t => { const e = $c('cam-msg'); if (e) e.textContent = t; };
  function formatos() {
    const F = window.Html5QrcodeSupportedFormats; if (!F) return undefined;
    return [F.EAN_13, F.EAN_8, F.CODE_128, F.CODE_39, F.UPC_A, F.UPC_E, F.QR_CODE].filter(x => x !== undefined);
  }
  async function abrir(cb) {
    alLeer = cb;
    if (!window.isSecureContext) { toast('La cámara solo funciona con HTTPS.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Este navegador no permite usar la cámara. Usa el campo de texto o un lector USB/Bluetooth.'); return; }
    if (!window.Html5Qrcode) { toast('No se cargó el lector de cámara. Recarga la página (Ctrl+Shift+R).'); return; }
    if (lector) return; // ya abierta
    $c('cam-box').style.display = ''; msg('Pidiendo permiso de cámara…');
    try {
      lector = new Html5Qrcode('cam-view', { formatsToSupport: formatos(), useBarCodeDetectorIfSupported: true, verbose: false });
      await lector.start({ facingMode: 'environment' }, { fps: 10 }, leido, () => { });
      msg('Apunta al código de barras…');
    } catch (e) {
      const n = (e && (e.name || e)) + '';
      const t = /NotAllowed|Permission/i.test(n) ? 'Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones y vuelve a intentar.'
        : /NotFound|Overconstrained|DevicesNotFound/i.test(n) ? 'No se encontró ninguna cámara en este equipo.'
        : /NotReadable|TrackStart/i.test(n) ? 'La cámara está en uso por otra aplicación.' : 'No se pudo abrir la cámara: ' + n;
      toast(t); msg(t); await cerrar(true);
    }
  }
  function leido(code) {
    const ahora = Date.now(); if (code === ultimo && ahora - ultimoTs < 2500) return; // evita lecturas repetidas del mismo código
    ultimo = code; ultimoTs = ahora; msg('Leído: ' + code);
    try { navigator.vibrate && navigator.vibrate(80); } catch (x) { }
    if (alLeer) alLeer(code);
  }
  async function cerrar(mantenerMsg) {
    const l = lector; lector = null;
    if (l) { try { await l.stop(); } catch (x) { } try { l.clear(); } catch (x) { } }
    if (!mantenerMsg) $c('cam-box').style.display = 'none';
  }
  document.addEventListener('DOMContentLoaded', () => { const b = $c('cam-stop'); if (b) b.onclick = () => cerrar(); });
  // Al salir de la vista o de la pestaña, apagar la cámara
  document.addEventListener('visibilitychange', () => { if (document.hidden) cerrar(); });
  return { abrir, cerrar };
})();
