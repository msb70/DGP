/* DGP · configuración pública del despliegue (no contiene secretos: la clave anon/publishable es pública por diseño
   y la seguridad la imponen el inicio de sesión y las políticas RLS de la base).
   produccion: true  → exige inicio de sesión, sin modo local, sin reinicio de la operación ni claves de IA en el navegador.
   produccion: false → demo de la v2 (selector de usuarios, modo local si no hay Supabase). */
window.DGP_CONFIG = {
  produccion: true,
  version: '3.0',
  url: "https://zeejqutxvpmbozlkkfpe.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplZWpxdXR4dnBtYm96bGtrZnBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MjU3NTYsImV4cCI6MjEwNTMwMTc1Nn0.EP79kiJLhX2KII1juuqAg_yaGX8HGcYbth2BbnM_75Y",
  google: false,          // true cuando se active el proveedor Google en Supabase Auth
  google_hd: 'dgp.com.pa', // dominio de Google Workspace permitido (pista para la pantalla de Google)
  ai: { activa: true }    // usa la Edge Function "ia" del proyecto con la sesión del usuario
};
