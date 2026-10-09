/* DGP · Indicador "Procesando…": cuando el usuario pulsa un botón o cambia una opción y eso dispara trabajo
   (base de datos, cálculo de rutas, IA), se muestra una barra superior, un aviso con el texto de la acción y se
   bloquean los clics hasta que termina. El sondeo automático en segundo plano no lo activa. */
(function () {
  const css = `#busy{position:fixed;inset:0;z-index:2000;display:none;cursor:progress;background:rgba(15,23,42,.08)}
#busy.on{display:block}
#busy .bar{position:fixed;top:0;left:0;right:0;height:3px;overflow:hidden;background:rgba(22,163,74,.15)}
#busy .bar i{position:absolute;top:0;bottom:0;width:35%;background:#16A34A;animation:busy-bar 1.1s ease-in-out infinite}
#busy .bpill{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0F172A;color:#fff;padding:11px 18px;border-radius:999px;font:600 14px/1.2 'Plus Jakarta Sans',system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 12px 30px -10px rgba(0,0,0,.5);max-width:calc(100vw - 32px)}
#busy .bpill span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#busy .sp{width:16px;height:16px;border-radius:50%;border:2.5px solid rgba(255,255,255,.3);border-top-color:#4ADE80;animation:busy-sp .7s linear infinite;flex:none}
.is-busy{position:relative;opacity:.75;pointer-events:none}
@keyframes busy-bar{0%{left:-35%}100%{left:100%}} @keyframes busy-sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#busy .bar i,#busy .sp{animation-duration:3s}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  let el, txt, pend = 0, armedUntil = 0, shown = false, hideT = null, showT = null, src = null, label = 'Procesando…';
  function mount() { if (el) return; el = document.createElement('div'); el.id = 'busy'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.innerHTML = '<div class="bar"><i></i></div><div class="bpill"><div class="sp"></div><span>Procesando…</span></div>'; document.body.appendChild(el); txt = el.querySelector('span'); }
  function show() { mount(); clearTimeout(hideT); if (shown) return; shown = true; txt.textContent = label; el.classList.add('on'); if (src) src.classList.add('is-busy'); }
  function hide() { clearTimeout(showT); showT = null; if (!shown) return; shown = false; el.classList.remove('on'); if (src) src.classList.remove('is-busy'); src = null; }
  function start() { pend++; if (Date.now() < armedUntil || shown) { clearTimeout(hideT); if (!shown && !showT) showT = setTimeout(() => { showT = null; if (pend > 0) show(); }, 120); armedUntil = Date.now() + 1500; } }
  function end() { pend = Math.max(0, pend - 1); if (pend === 0) { clearTimeout(hideT); hideT = setTimeout(() => { if (pend === 0) hide(); }, 450); } }
  function arm(e) {
    const t = e.target.closest && e.target.closest('button,select,label.btn,a.btn,input[type=checkbox],[data-open],[data-ci],[data-ent],.opt'); if (!t) return;
    const name = (t.tagName === 'SELECT' ? (t.options[t.selectedIndex] || {}).text : (t.innerText || t.value || '')).trim().replace(/\s+/g, ' ').slice(0, 60);
    label = name ? `${name} · procesando…` : 'Procesando…'; src = t.tagName === 'SELECT' ? null : t; armedUntil = Date.now() + 600;
  }
  document.addEventListener('click', arm, true); document.addEventListener('change', arm, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') { label = 'Procesando…'; src = null; armedUntil = Date.now() + 600; } }, true);
  const wrap = (obj, names) => names.forEach(n => { const f = obj && obj[n]; if (typeof f !== 'function' || f.__busy) return; const w = function () { start(); let r; try { r = f.apply(this, arguments); } catch (x) { end(); throw x; } return Promise.resolve(r).finally(end); }; w.__busy = true; obj[n] = w; });
  function patch() { wrap(window.DB, ['all', 'insert', 'upsert', 'update', 'remove', 'audit', 'alerta', 'notificar', 'resetOperacion']); wrap(window.GEO, ['route', 'geocode', 'sleep']); if (window.AI) wrap(window.AI, ['triage', 'normalizarDireccion']); }
  patch(); document.addEventListener('DOMContentLoaded', patch);
  window.BUSY = { show: (l) => { label = l || 'Procesando…'; show(); }, hide };
})();
