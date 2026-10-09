# Plan de validación DGP para Claude
Fecha: 10 de octubre de 2026. Base inspeccionada: rama main, commit af5e998; remoto configurado https://github.com/msb70/DGP.git. Se inspeccionó el checkout local; no se comprobó equivalencia con el remoto ni despliegue público.

## Actualización tras ejecución
La ejecución local ya se realizó. Consulte 06_RESULTADOS_Y_ENTREGA.md y los informes 01–04: 55 casos, 43 aprobados y 12 fallidos; suite RLS original y TypeScript aprobados. Se habilitaron Node/Deno/PostgreSQL/Playwright en el proyecto. Las menciones siguientes a inspección/no ejecutado describen el estado inicial del plan, no el resultado vigente. El alcance externo, dispositivos físicos y carga sostenida siguen pendientes.

## Alcance y estado
Torre de control estática, PWA de conductor, PostgreSQL/Supabase Auth/RLS y Edge Functions usuarios, whatsapp, zoho e ia. Configuración local: producción v3 activada. Incluye validación de datos en todas las áreas.

Este paquete contiene inspección preliminar y plan de ejecución, no certificación de producción. No se modificó código operativo, no se ejecutaron migraciones ni se enviaron mensajes o envíos reales. No se ejecutaron suites SQL, Deno o E2E: no se encontraron Deno ni psql en PATH. Hay Node/npm; Playwright no está declarado como dependencia del proyecto y su ruta predeterminada es externa.

## Orden de ejecución
| Fase | Trabajo | Resultado y criterio de salida |
|---|---|---|
| 0. Entorno reproducible | Fijar commit, crear base exclusiva desechable, configurar Node, Deno, PostgreSQL 16 y Playwright/Chromium; adaptar runners a macOS o contenedor; corregir propagación de errores SQL | Un comando documentado; fallo deliberado retorna código distinto de cero; ninguna conexión a la base operativa |
| 1. Código y datos | Sintaxis, Deno check, dependencias, revisión de cálculos/estados, integridad y coherencia de semillas | Informe 01, fixtures repetibles, defectos reproducibles priorizados |
| 2. Seguridad | Matriz rol × tabla × acción y RPC/Edge; ataques por API y campos; sesiones y auditoría | Informe 03; sin accesos no autorizados ni alteración de estados sensibles |
| 3. Funcional | Ejecutar suites existentes, ampliar casos de negocio, errores y concurrencia; probar PWA real y móvil | Informe 02; flujos críticos aprobados y datos finales conciliados |
| 4. Rendimiento | Medir interfaz, API, consultas y planificación sobre volúmenes crecientes | Informe 04; métricas comparables y ausencia de pérdida/truncamiento oculto |
| 5. Cierre | Reproducir correcciones, regresión completa, pruebas de staging y revisión de configuración desplegada | Cuatro informes finales con evidencia, limitaciones y decisión por área |

Estimación orientativa: 5–8 jornadas técnicas, ajustable tras habilitar el entorno; integraciones reales dependen de credenciales y cuentas de prueba. Primero abordar confiabilidad del runner y seguridad de mutaciones.

## Datos de prueba
Usar datos sintéticos identificados con prefijo QA y valores esperados calculados independientemente del código de la aplicación. Evitar copiar datos personales de producción. Fixture por escenario y limpieza de la base de pruebas.

| Grupo | Casos | Oráculo |
|---|---|---|
| Maestros | Código/SKU duplicado, referencia inexistente, campos vacíos, Unicode, texto largo, HTML y CSV con fórmulas | Rechazo explícito o escape seguro; ninguna relación huérfana |
| Pedidos | 0, negativos, decimales, monto mínimo ±0,01, caja/unidad, peso/volumen/capacidad ± límite | Totales, unidades y elegibilidad exactos; sin NaN ni carga imposible |
| Rutas | Ventanas estrictas, urgentes, ruta bajo mínimo, reasignación y cambios repetidos, bodega distinta | Secuencia válida, capacidad respetada, una asignación activa por pedido |
| Verificación | Faltante, exceso, línea en cero, SKU desconocido, EAN inválido, firma ausente | No liberar hasta cumplir requisitos; envío coincide con mercancía verificada |
| Operación | Entrega parcial, devolución, fotos, odómetro regresivo, combustible negativo, costo y bono | Estados y balances consistentes; auditoría atribuida al usuario real |
| Red/concurrencia | Pérdida de respuesta tras guardar, reconexión, dos pestañas, dos verificadores, sesión vencida | Sin duplicados ni pérdida; conflicto visible y recuperación verificable |
| Tiempo | Medianoche Panamá/Madrid/UTC, cambio de fecha, histórico y semana de incentivo | Fecha operativa y periodo correctos y documentados |

Volúmenes de carga propuestos: 40, 1.000, 10.000 y 25.000 pedidos con líneas proporcionales; 100.000 eventos históricos. Concurrencia: 1, 10 y 30 usuarios como escalones iniciales, no como demanda confirmada de DGP.

## Evidencia y formato de los informes finales
Por caso: ID, requisito, commit/entorno, rol, fixture, pasos o comando, esperado, observado, estado (aprobado/fallido/bloqueado/no ejecutado), duración y evidencia. Por defecto: severidad, impacto, archivo/línea, reproducción, recomendación y prueba de regresión. Conservar logs, JSON, capturas/trazas y planes SQL, sin tokens/contraseñas.

Criterio de aceptación: 100 % de casos críticos aprobados; cero defectos críticos o altos abiertos; diferencias contables y de unidades explicadas; pruebas de acceso negativas aprobadas; métricas dentro de objetivos acordados. Un caso bloqueado no cuenta como aprobado. Los resultados del emulador no sustituyen staging Supabase ni integración real.

## Documentos de entrega
01_INFORME_CODIGO.md, 02_INFORME_FUNCIONAL.md, 03_INFORME_SEGURIDAD.md y 04_INFORME_RENDIMIENTO.md contienen hallazgos iniciales y tareas específicas. 05_ENTREGA_A_CLAUDE.md puede usarse como mensaje de encargo.
