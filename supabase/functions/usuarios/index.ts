// DGP · Edge Function "usuarios": alta, contraseña temporal y activación de cuentas.
// Usa la service_role SOLO en el servidor. El que llama debe tener sesión y el permiso usuarios.gestionar.
// Despliegue: supabase functions deploy usuarios   (verify_jwt activado)
// Secretos automáticos: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Opcional: APP_URL (dirección pública de la torre, para los enlaces de invitación).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim());
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const allow = ORIGINS.includes("*") ? "*" : (ORIGINS.includes(o) ? o : ORIGINS[0]);
  return { "Access-Control-Allow-Origin": allow, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json" } });

function claveTemporal(n = 14) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = Array.from(b, (x) => abc[x % abc.length]).join("");
  if (!/\d/.test(s)) s = s.slice(0, -1) + "7";
  if (!/[a-z]/.test(s)) s = "k" + s.slice(1);
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authz = req.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) return json(req, { error: "Sin sesión" }, 401);

  // 1) Quién llama y con qué permisos (con su propio JWT: RLS aplica)
  const yo = createClient(url, anon, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data: perfil, error: pe } = await yo.rpc("mi_perfil");
  if (pe || !perfil || !perfil.activo) return json(req, { error: "Sesión no válida o usuario inactivo" }, 401);
  const permisos: string[] = perfil.permisos || [];
  if (!permisos.includes("usuarios.gestionar")) return json(req, { error: "Tu rol no gestiona usuarios" }, 403);
  const gestionaRoles = permisos.includes("roles.gestionar");

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json(req, { error: "Cuerpo inválido" }, 400); }
  const auditar = (accion: string, detalle: string, id?: string) =>
    admin.from("auditoria").insert({ entidad: "usuarios", entidad_id: id || null, accion, detalle, actor: perfil.nombre || perfil.email, user_id: perfil.id, actor_email: perfil.email, automatico: false });
  const objetivo = async (id: string) => {
    if (!id) throw new Error("Falta el usuario");
    if (id === perfil.id) throw new Error("No puedes hacer esto sobre tu propio usuario");
    const { data, error } = await admin.from("perfiles").select("id,email,nombre,rol,activo").eq("id", id).single();
    if (error || !data) throw new Error("Usuario no encontrado");
    if (data.rol === "admin" && !gestionaRoles) throw new Error("Solo quien gestiona roles puede modificar a un administrador");
    return data;
  };

  try {
    switch (b.accion) {
      case "listar": {
        const out: unknown[] = []; let page = 1;
        while (page < 20) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) throw error;
          out.push(...data.users.map((u) => ({ id: u.id, email: u.email, confirmado: !!u.email_confirmed_at, ultimo_acceso: u.last_sign_in_at, baneado: !!(u as any).banned_until && new Date((u as any).banned_until) > new Date() })));
          if (data.users.length < 1000) break; page++;
        }
        return json(req, { usuarios: out });
      }
      case "crear": {
        const email = String(b.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Correo no válido");
        const rol = String(b.rol || "");
        const { data: r } = await admin.from("roles").select("codigo").eq("codigo", rol).maybeSingle();
        if (!r || rol === "sin_rol") throw new Error("Rol no válido");
        if (rol === "admin" && !gestionaRoles) throw new Error("Solo quien gestiona roles puede crear administradores");
        if (rol === "conductor" && !b.persona_id) throw new Error("Un conductor debe estar vinculado a su persona");
        const meta = { rol, activo: true, nombre: String(b.nombre || "").slice(0, 120), persona_id: b.persona_id || null, bodega_codigo: b.bodega_codigo || null, creado_por: perfil.email };
        let id: string, clave: string | null = null;
        if (b.metodo === "invitacion") {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: Deno.env.get("APP_URL") || undefined });
          if (error) throw error; id = data.user.id;
          await admin.auth.admin.updateUserById(id, { app_metadata: meta });
        } else {
          clave = claveTemporal();
          const { data, error } = await admin.auth.admin.createUser({ email, password: clave, email_confirm: true, app_metadata: meta });
          if (error) throw error; id = data.user.id;
        }
        // El trigger de alta crea el perfil; se completa aquí por si el usuario ya existía o vino por invitación
        const { error: ue } = await admin.from("perfiles").upsert({ id, email, nombre: meta.nombre, rol, persona_id: meta.persona_id, bodega_codigo: meta.bodega_codigo, activo: true, creado_por: perfil.email, debe_cambiar_clave: !!clave }, { onConflict: "id" });
        if (ue) throw ue;
        await auditar("alta", `Alta de ${email} con rol ${rol} (${clave ? "contraseña temporal" : "invitación"})`, id);
        return json(req, { id, clave_temporal: clave });
      }
      case "reset_clave": {
        const t = await objetivo(b.id);
        const clave = claveTemporal();
        const { error } = await admin.auth.admin.updateUserById(t.id, { password: clave });
        if (error) throw error;
        await admin.from("perfiles").update({ debe_cambiar_clave: true }).eq("id", t.id);
        await auditar("reset_clave", `Contraseña temporal generada para ${t.email}`, t.id);
        return json(req, { clave_temporal: clave });
      }
      case "estado": {
        const t = await objetivo(b.id); const activo = !!b.activo;
        if (activo && t.rol === "sin_rol") throw new Error("Asigna un rol antes de activar el usuario");
        const { error: pe2 } = await admin.from("perfiles").update({ activo }).eq("id", t.id);
        if (pe2) throw pe2;   // p. ej. "Debe quedar al menos un administrador activo"
        const { error } = await admin.auth.admin.updateUserById(t.id, { ban_duration: activo ? "none" : "876000h" });
        if (error) throw error;
        await auditar(activo ? "activado" : "desactivado", `${t.email} ${activo ? "activado" : "desactivado"}`, t.id);
        return json(req, { ok: true });
      }
      default: return json(req, { error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    const m = (e as any)?.message || String(e);
    const msg = /already been registered|already exists/i.test(m) ? "Ya existe un usuario con ese correo" : m;
    return json(req, { error: msg }, 400);
  }
});
