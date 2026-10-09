# Informe ejecutado: rendimiento
Fecha: 10 de octubre de 2026 · Base af5e998, rama main + cambios de infraestructura de pruebas. Entorno macOS arm64, PostgreSQL 16.14 local en 127.0.0.1:55439, Node 22.23.2 y Deno 2.9.6.

## Estado tras la corrección (Claude · 10-oct-2026)
Entorno de la re-ejecución: Linux x64, PostgreSQL embebido 16.14 en 127.0.0.1:55439 (mismo runner `npm run test:qa`), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium/Firefox/WebKit). Rama `qa-correcciones` sobre `main` 892da4f. **Emulador local**: PostgreSQL real con RLS, Auth/PostgREST emulados, Meta y Zoho simulados. No es staging ni proveedor real.

**REN-01 corregido.** Causa: `DB.all` tenía `max = opts.limit || 20000` y paraba en silencio. Cambio: sin `limit` se pagina hasta el final (public/js/db.js:70–73). Prueba «DB.all no omite pedidos sobre 20.000»: 20.000/25.000 → **25.000/25.000**.

**Consecuencia que hay que asumir:** leer 25.000 pedidos completos tardó ~15,8 s en el emulador (antes 3,3 s porque leía 20 % menos). La corrección elimina la pérdida silenciosa de datos, no el coste. La torre no debería traer todo el histórico: filtrar por fecha/estado en servidor o paginar en pantalla. Pendiente de decidir con el volumen real de DGP (las cifras de carga del emulador no son de Supabase productivo).

REN-04 (envío concurrente): corregido, ver FUN-05. REN-02/03 (N+1 en generación de paquetes y lectura de maestros en conductor): sin benchmark ni cambio; la copia offline del conductor ya limita clientes a los de sus paradas. Pendientes sin cambio: carga sostenida 15 min, planificación a 1.000 pedidos, CPU/memoria/LCP/INP/CLS, red móvil lenta y despliegue cloud.

---
## Informe original de Codex (reproducción previa a la corrección)
## Dictamen: resultados locales; falla integridad bajo volumen
Benchmark de DB.all sobre 25.000 pedidos sintéticos y carga breve de lectura REST con 1/10/30 clientes concurrentes. PostgreSQL real; API emulada, sin red cloud. [Datos crudos](evidencias/e2e/qa-extended.json). Estos tiempos no son capacidad/latencia de Supabase productivo.

| Lectura solicitada | Recibida | Tiempo ms |
|---|---|---|
| 40 | 40 | 391.8 |
| 1000 | 1000 | 270.9 |
| 10000 | 10000 | 2689.8 |
| 19999 | 19999 | 6494.2 |
| 20000 | 20000 | 5361.3 |
| 20001 | 20001 | 3733.4 |
| 25000 | 20000 | 3335.1 |

Se usó opts.limit explícito salvo el último caso, que usa comportamiento por defecto. REN-01, severidad alta: de 25.000 filas que cumplen el filtro, DB.all devuelve 20.000 y omite 5.000 (20 %), sin informar que el conjunto es incompleto. Fuente public/js/db.js:68–78. El límite explícito 20.001 funciona, confirmando que la omisión está en el tope predeterminado. No usar el tiempo menor del último caso como mejora: leyó menos datos. Proveer paginación visible/cursor o señal de conjunto incompleto, garantizando cálculos correctos.

| Concurrencia | Peticiones | Errores HTTP | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| 1 | 10 | 0 | 18.5 | 23.2 | 23.2 |
| 10 | 100 | 0 | 37.9 | 73.4 | 78.8 |
| 30 | 300 | 0 | 77.0 | 125.4 | 140.5 |

Son 410 solicitudes de lectura, en ráfagas breves; no prueba sostenida de 15 minutos ni mezcla de acciones de usuarios. No extrapolar percentiles a producción. Muestras chicas (10 requests en concurrencia 1) tienen valor diagnóstico limitado. Firefox/WebKit solo midieron login inicial en dataset pequeño; no Core Web Vitals de campo.

## Consultas SQL
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) sobre base con 25.000 pedidos adicionales y 100.000 eventos asociados a ruta de prueba, bajo rol authenticated de planificador. Planes en [sql-plans.json](evidencias/sql-plans.json); contienen tiempos y bloques leídos. Índices y filtros se deben decidir sobre planes reales, no intuición. La prueba de ruta usa fixture existente y no consulta vacía.

REN-02 posible N+1 al generar paquetes sin paquete previo en ruta (app.js:228), y REN-03 lectura de maestros completos/repetición de paradas en conductor: observaciones estáticas aún sin benchmark de esas acciones. REN-04 de envío concurrente ya confirmado por 2 envíos; consultar informe funcional.

## Pendiente
Carga sostenida 15 min, planificación/publicación a 1.000 pedidos, generación documental N+1, 100 eventos offline, almacenamiento lleno, memoria/CPU/LCP/INP/CLS, red móvil lenta y despliegue cloud. La aceptación de rendimiento completo queda abierta. Se midieron ráfagas y volumen para reproducir el defecto; no se afirma cumplir los objetivos propuestos. Corregir truncamiento e idempotencia antes de interpretar una prueba de capacidad operativa como válida.
