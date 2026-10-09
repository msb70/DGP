#!/usr/bin/env python3
"""Genera los datos semilla v2 a partir de data/seed.json.

Uso:  python3 tools/gen_seed.py
Salidas: data/seed.json (v2), public/js/seed.js, supabase/seed.sql, supabase/dgp_mvp_completo.sql

v2 ajusta la semilla a las respuestas del cuestionario de DGP (6-oct-2026):
  - Flota real: panel capota alta (5 m3, 1.000 kg, 120 cajas), panel capota baja (4 m3, 1.000 kg, 86 cajas),
    camión (9 m3, 3.000 kg, 620 cajas). 8 vehículos, 8 conductores, 6 ayudantes. Sin terceros.
  - El valor ya no es un límite: es el MÍNIMO por ruta (panel 2.500, camión 5.000). Limitan espacio y peso.
  - Bodega principal + sucursales Giral y Bejuco.
  - Roles: verificador, encargado de bodega, gestión documental, facturación, CxC, mantenimiento,
    gerente comercial, gerente de operaciones.
  - Códigos EAN-13 válidos.
  - Reglas de incentivos (programa Paneles y programa Camiones/Fuso).
Los pedidos, precios y personas siguen siendo ficticios.
"""
import json, os, copy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)


def ean13(base12):
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(base12))
    return base12 + str((10 - s % 10) % 10)


def to_v2(d):
    if d.get('version') == 2:
        return d
    d = copy.deepcopy(d)
    d['version'] = 2
    # ---- bodegas ----
    d['bodega'] = {"codigo": "VA", "nombre": "Bodega Principal · Vista Alegre", "direccion": "Vista Alegre, Arraiján, Panamá Oeste",
                   "lat": 8.956, "lng": -79.672, "hora_corte": "15:00", "tipo": "principal", "despacha": True}
    d['bodegas'] = [d['bodega'],
                    {"codigo": "GIR", "nombre": "Sucursal Giral", "direccion": "Giral, Colón (coordenada aproximada)", "lat": 9.318, "lng": -79.861,
                     "hora_corte": "15:00", "tipo": "sucursal", "despacha": True},
                    {"codigo": "BEJ", "nombre": "Sucursal Bejuco", "direccion": "Bejuco, Chame, Panamá Oeste (coordenada aproximada)", "lat": 8.603, "lng": -79.884,
                     "hora_corte": "15:00", "tipo": "sucursal", "despacha": True}]
    # ---- artículos: precio x2.2, volumen realista, EAN-13 válido ----
    for i, a in enumerate(d['articulos']):
        a['precio'] = round(a['precio'] * 2.2, 2)
        a['volumen_m3'] = round(a['volumen_m3'] * 0.35, 4)
        a['codigo_barras'] = ean13('745' + str(1000000 + i * 7919).zfill(9)[-9:])
    art = {a['sku']: a for a in d['articulos']}
    for l in d['pedido_lineas']:
        l['precio'] = art[l['sku']]['precio']
    urgentes = {'SO-5204', 'SO-5217', 'SO-5231'}
    for p in d['pedidos']:
        ls = [l for l in d['pedido_lineas'] if l['numero_so'] == p['numero_so']]
        p['valor'] = round(sum(l['cantidad_cajas'] * l['precio'] for l in ls), 2)
        p['volumen_m3'] = round(sum(l['cantidad_cajas'] * art[l['sku']]['volumen_m3'] for l in ls), 4)
        p['cajas'] = sum(l['cantidad_cajas'] for l in ls)
        p['prioridad'] = 1 if p['numero_so'] in urgentes else 3
    # ---- flota DGP ----
    tipos = {
        'panel_alta': dict(cap_peso_kg=1000, cap_volumen_m3=5, cap_cajas=120, km_por_litro=9.0, costo_km=0.42, min_valor=2500, programa='paneles'),
        'panel_baja': dict(cap_peso_kg=1000, cap_volumen_m3=4, cap_cajas=86, km_por_litro=9.4, costo_km=0.40, min_valor=2500, programa='paneles'),
        'camion': dict(cap_peso_kg=3000, cap_volumen_m3=9, cap_cajas=620, km_por_litro=5.6, costo_km=0.78, min_valor=5000, programa='camiones'),
    }
    flota = [
        ('CA-4410', 'Camión Fuso 1', 'camion', 'Ana Morales', 'Rubén Díaz', '#DC2626', 'Rojo'),
        ('CA-4411', 'Camión Fuso 2', 'camion', 'José Batista', 'Kevin Soto', '#2563EB', 'Azul'),
        ('PA-1042', 'Panel alta 1', 'panel_alta', 'Luis Herrera', 'Omar Cedeño', '#EAB308', 'Amarillo'),
        ('PA-1187', 'Panel alta 2', 'panel_alta', 'Carlos Pinzón', 'Iván Mendoza', '#16A34A', 'Verde'),
        ('PA-1203', 'Panel alta 3', 'panel_alta', 'Edwin Castillo', 'Yariel Pérez', '#EA580C', 'Naranja'),
        ('PB-2015', 'Panel baja 1', 'panel_baja', 'Ricardo Vargas', 'Luis Quintero', '#7C3AED', 'Morado'),
        ('PB-2016', 'Panel baja 2', 'panel_baja', 'Abdiel Gómez', None, '#DB2777', 'Rosado'),
        ('PB-2017', 'Panel baja 3', 'panel_baja', 'Félix Rodríguez', None, '#0891B2', 'Celeste'),
    ]
    d['vehiculos'] = []
    for i, (placa, nombre, tipo, cond, ayu, color, cnom) in enumerate(flota):
        t = tipos[tipo]
        d['vehiculos'].append(dict(placa=placa, nombre=nombre, tipo=tipo, cap_valor=None, min_valor=t['min_valor'], programa_incentivo=t['programa'],
                                   cap_peso_kg=t['cap_peso_kg'], cap_volumen_m3=t['cap_volumen_m3'], cap_cajas=t['cap_cajas'], cap_posiciones=None,
                                   km_por_litro=t['km_por_litro'], panapass_tag=f'PP-8821{i}', conductor=cond, ayudante=ayu, color=color, color_nombre=cnom,
                                   costo_km=t['costo_km'], odometro_km=48000 + i * 3100, activo=True))
    # ---- personas y roles ----
    pers = []
    for v in d['vehiculos']:
        pers.append(dict(nombre=v['conductor'], rol='conductor', pin='1234'))
        if v['ayudante']:
            pers.append(dict(nombre=v['ayudante'], rol='ayudante', pin=None))
    pers += [dict(nombre=n, rol=r, pin=None) for n, r in [
        ('Marta Rojas', 'bodega'), ('Diego Castillo', 'bodega'), ('Patricia Vega', 'verificador'), ('Héctor Navarro', 'verificador'),
        ('Julio Barría', 'encargado_bodega'), ('Itzel Samudio', 'gestion_documental'), ('Lorena Ábrego', 'planificador'),
        ('Gabriel Ruiz', 'ejecutivo'), ('Sofía Lam', 'ejecutivo'), ('Mariela Chen', 'gerente_comercial'), ('Daniel Ortega', 'facturacion'),
        ('Karina Méndez', 'cxc'), ('Andrés Pitti', 'mantenimiento'), ('Roberto Domínguez', 'gerente_operaciones'), ('Admin DGP', 'admin')]]
    d['personas'] = pers
    # ---- reglas ----
    r = [x for x in d['reglas'] if x['clave'] != 'cap_valor']
    r.insert(1, {"clave": "minimo_ruta", "valor": {"panel": 2500, "camion": 5000},
                 "descripcion": "Venta mínima que debe llevar una ruta para justificar su costo (B/.). No es un tope: lo que limita la carga es el espacio y el peso.",
                 "accion": "notificar a los dueños de las cuentas de la ruta y al gerente comercial"})
    r.append({"clave": "cambios_ruta", "valor": {"maximo_dia": 7},
              "descripcion": "Cambios por urgencia o anexo de clientes que se esperan en una ruta ya planificada (cada cambio crea versión).", "accion": "alerta"})
    r.append({"clave": "fotos_entrega", "valor": {"maximo": 3, "retencion_meses": 12},
              "descripcion": "Fotos de evidencia por entrega y meses de retención completa (luego miniatura).", "accion": "alerta"})
    r.append({"clave": "incentivo_paneles", "valor": {
        "indicadores": [
            {"k": "facturacion", "n": "Facturación de ruta", "meta": 2500, "op": ">=", "u": "B/.", "pts": 30},
            {"k": "clientes", "n": "Número de clientes atendidos", "meta": 15, "op": ">=", "u": "clientes", "pts": 15},
            {"k": "salida", "n": "Salida puntual (hora límite)", "meta": "09:00", "op": "<", "u": "hora", "pts": 10},
            {"k": "combustible", "n": "Combustible dentro del presupuesto", "meta": 60, "op": "<=", "u": "B/.", "pts": 15},
            {"k": "devoluciones", "n": "Devoluciones sobre facturado", "meta": 2, "op": "<=", "u": "%", "pts": 10},
            {"k": "faltantes", "n": "Faltantes en entrega", "meta": 0, "op": "<=", "u": "%", "pts": 10},
            {"k": "reclamos", "n": "Reclamos de servicio", "meta": 0, "op": "<=", "u": "reclamos", "pts": 10}],
        "tramos": [{"desde": 90, "bono": 120}, {"desde": 80, "bono": 80}, {"desde": 70, "bono": 40}],
        "medicion": "diaria", "anula_bono": "faltantes o información falsa"},
        "descripcion": "Programa operativo de incentivos · Paneles (distribución multipunto). Bono semanal por equipo conductor + ayudante.", "accion": "incentivo"})
    r.append({"clave": "incentivo_camiones", "valor": {
        "indicadores": [
            {"k": "facturacion", "n": "Facturación del viaje", "meta": 10000, "op": ">=", "u": "B/.", "pts": 30},
            {"k": "carga_completa", "n": "Carga completa (100 % del pedido)", "meta": 100, "op": ">=", "u": "%", "pts": 20},
            {"k": "otif", "n": "Entrega a tiempo en la ventana (OTIF)", "meta": 100, "op": ">=", "u": "%", "pts": 15},
            {"k": "tiempo_carga", "n": "Tiempo de carga/descarga dentro del estándar", "meta": 100, "op": ">=", "u": "%", "pts": 10},
            {"k": "pallets", "n": "Devolución de pallets completa y en buen estado", "meta": 100, "op": ">=", "u": "%", "pts": 10},
            {"k": "devoluciones", "n": "Devoluciones sobre facturado", "meta": 1, "op": "<=", "u": "%", "pts": 5},
            {"k": "faltantes", "n": "Faltantes en factura / entrega", "meta": 0, "op": "<=", "u": "%", "pts": 5, "penalidad_factura_con_faltante": -10},
            {"k": "reclamos", "n": "Reclamos de servicio", "meta": 0, "op": "<=", "u": "reclamos", "pts": 5}],
        "tramos": [{"desde": 90, "bono": 180}, {"desde": 80, "bono": 120}, {"desde": 70, "bono": 60}],
        "medicion": "por viaje", "anula_bono": "daño o mal manejo del producto; información falsa"},
        "descripcion": "Programa operativo de incentivos · Camiones / Fuso (cuentas corporativas). Bono semanal por equipo conductor + ayudante.", "accion": "incentivo"})
    d['reglas'] = r
    return d


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (dict, list)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def ins(table, row, key=None):
    cols = list(row.keys())
    s = f"insert into {table}({','.join(cols)}) values ({','.join(q(row[c]) for c in cols)})"
    if key:
        upd = ','.join(f'{c}=excluded.{c}' for c in cols if c != key)
        s += f' on conflict ({key}) do update set {upd}'
    return s + ';'


def sql(d):
    out = ["-- ===== DATOS SEMILLA v2 (generado por tools/gen_seed.py · no editar a mano) =====",
           "-- Clientes: empresas de Panamá como demostración; coordenadas de OpenStreetMap marcadas para validar.",
           "-- Pedidos, precios y personas: ficticios. Flota, capacidades y reglas: según cuestionario de DGP (6-oct-2026).",
           "truncate notificaciones, incentivos, actas_gd, paquetes, eventos, incidencias, alertas, auditoria, abastecimientos, peajes, costos_ruta, posiciones, manifiesto_lineas, manifiestos, paradas, pedido_lineas, pedidos, rutas restart identity cascade;",
           "delete from vehiculos; delete from personas;"]
    for b in d['bodegas']:
        out.append(ins('bodegas', b, 'codigo'))
    for z in d['zonas']:
        out.append(ins('zonas', z, 'codigo'))
    for c in d['clientes']:
        out.append(ins('clientes', c, 'codigo'))
    for a in d['articulos']:
        out.append(ins('articulos', a, 'sku'))
    for v in d['vehiculos']:
        out.append(ins('vehiculos', v, 'placa'))
    for p in d['personas']:
        out.append(ins('personas', p))
    out.append("delete from reglas where clave='cap_valor';")
    for r in d['reglas']:
        out.append(ins('reglas', dict(r, actualizado_por='seed'), 'clave'))
    for p in d['pedidos']:
        row = {k: v for k, v in p.items() if k != 'cliente_codigo'}
        cols = list(row.keys())
        out.append(f"insert into pedidos({','.join(cols)},cliente_id) select {','.join(q(row[c]) for c in cols)},id from clientes where codigo={q(p['cliente_codigo'])};")
    for l in d['pedido_lineas']:
        out.append(f"insert into pedido_lineas(pedido_id,sku,cantidad_cajas,precio) select id,{q(l['sku'])},{l['cantidad_cajas']},{l['precio']} from pedidos where numero_so={q(l['numero_so'])};")
    out.append("update pedidos set fecha=current_date;")
    out.append("insert into auditoria(entidad,accion,detalle,actor,automatico) values ('sistema','seed','Datos semilla v2 cargados: flota, bodegas, roles y reglas según cuestionario DGP','SQL Editor',true);")
    return '\n'.join(out) + '\n'


def main():
    d = to_v2(json.load(open(P('data', 'seed.json'), encoding='utf-8')))
    json.dump(d, open(P('data', 'seed.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    open(P('public', 'js', 'seed.js'), 'w', encoding='utf-8').write('window.DGP_SEED=' + json.dumps(d, ensure_ascii=False) + ';\n')
    s = sql(d)
    open(P('supabase', 'seed.sql'), 'w', encoding='utf-8').write(s)
    schema = open(P('supabase', 'schema.sql'), encoding='utf-8').read()
    open(P('supabase', 'dgp_mvp_completo.sql'), 'w', encoding='utf-8').write(schema + '\n' + s)
    print('ok', len(d['pedidos']), 'pedidos', len(d['vehiculos']), 'vehículos', round(sum(p['valor'] for p in d['pedidos']), 2), 'B/.')


if __name__ == '__main__':
    main()
