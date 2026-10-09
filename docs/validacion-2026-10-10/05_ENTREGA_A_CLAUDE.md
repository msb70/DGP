# Encargo para Claude: corregir y validar DGP
Lee 06_RESULTADOS_Y_ENTREGA.md y los informes 01–04. La validación local ya se ejecutó: 43/55 casos aprobados, 12 fallidos. No aprobar producción.

Corrige primero la escritura de campos sensibles de conductor y el XSS por firma. Luego aborda idempotencia Zoho/offline, arranque offline, elegibilidad con promesa, tope de 20.000, negativos, estados y zona operativa. Reproduce antes de corregir y conserva los casos actuales como regresiones. El runner ya fue adaptado y probado; no hay que volver a ocultar errores ni relajar aserciones.

Ejecuta npm run test:qa --prefix tests hasta eliminar las regresiones y revisa los pendientes de cada área. Por hallazgo entrega ID, causa, cambio, archivos/líneas, prueba y evidencia antes/después. Actualiza los cuatro informes y explica riesgos pendientes. Distingue emulador local, staging Supabase y proveedor real.

No uses bases operativas para fixtures ni envíes mensajes/envíos comerciales de prueba. No restaures demo_all. No publiques ni hagas cambios de producción durante este encargo. Las pruebas externas requieren staging y cuentas/destinatarios de prueba identificados.
