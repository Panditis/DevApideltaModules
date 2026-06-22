# -*- coding: utf-8 -*-
"""
Importador de datos de distribucion desde la planilla "Listas Envasado-Almacen".
Extrae a dev/data/ los JSON que consume el motor distribucion.js:
  - a8020.json                -> puntos de pedido (Min) por sucursal + consumo/clase por PLU
  - distribucion_listas.json  -> No envasa, Productos Restringidos, ProductosAlmacen (flags), importancia minorista
  - almacen_golden.json       -> fixture: inputs + Enviar calculado por la planilla (validacion paridad)

Uso:
  python importar_distribucion.py "C:\\ruta\\Listas Envasado-Almacen 10.7.xlsm"
Si no se pasa ruta, usa DEFAULT_XLSM.

Nota perf: read_only + iter_rows (camino rapido de openpyxl). NO usar ws.cell(r,c)
aleatorio en read_only (es O(n) por acceso).
"""
import sys, os, json
from openpyxl import load_workbook

DEFAULT_XLSM = r"C:\Users\Adriel\Desktop\Listas Envasado-Almacen 10.7.xlsm"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

def num(v, d=0.0):
    try:
        if v is None or v == "":
            return d
        return float(v)
    except (TypeError, ValueError):
        return d

def ival(v):
    """PLU como int si se puede, sino None."""
    try:
        if v is None or v == "":
            return None
        return int(float(v))
    except (TypeError, ValueError):
        return None

def col(row, idx1):
    """Valor de columna 1-indexed desde tupla de iter_rows(values_only=True)."""
    i = idx1 - 1
    return row[i] if 0 <= i < len(row) else None

# Columnas 1-indexed -----------------------------------------------------------
A8020_COLS = {
    "minUrq": 67, "minNacion": 68, "minChaca": 69, "minPergamino": 70, "minRiv": 71,
    "minSanPedro": 77, "minLogia": 80, "minVRamallo": 83, "minVConst": 86,
    "consumo": 32, "ventas": 55, "clase8020": 56,
}
PROD_ALM_COLS = {
    "urquiza": 6, "nacion": 7, "chacabuco": 8, "pergamino": 9, "sanPedro": 10,
    "sucursal8": 11, "villaRamallo": 12, "sucursal11": 13, "rivadavia": 14,
}
RESTR_COLS = {
    "rivadavia": 1, "urquiza": 4, "chacabuco": 7, "nacion": 10,
    "pergamino": 13, "sanPedro": 16, "villaRamallo": 19,
}
ALM_STOCK = {"central":4,"riv":7,"urq":11,"nacion":15,"chaca":19,"pergamino":23,"sanpedro":27,"sucu8":31,"sucu9":35,"sucu11":39}
ALM_MIN   = {"central":6,"riv":8,"urq":12,"nacion":16,"chaca":20,"pergamino":24,"sanpedro":28,"sucu8":32,"sucu9":36,"sucu11":40}
ALM_ENVIAR = {"riv":43,"urq":44,"nacion":45,"chaca":46,"pergamino":47,"sanPedro":48,"logia":49,"sucursal9":50,"sucursal11":51}

def extraer_a8020(wb):
    ws = wb["A8020"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is None or str(plu) in out:   # VLOOKUP/XLOOKUP toma la primera ocurrencia
            continue
        out[str(plu)] = {k: num(col(row, c)) for k, c in A8020_COLS.items()}
    return out

def extraer_minorista(wb):
    ws = wb["A8020 Minorista"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is None or str(plu) in out:   # primera ocurrencia (VLOOKUP)
            continue
        out[str(plu)] = num(col(row, 58), 0.0)  # col BF = importancia base 80/20
    return out

def extraer_prod_almacen(wb):
    ws = wb["ProductosAlmacen"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is None or str(plu) in out:   # primera ocurrencia (VLOOKUP)
            continue
        out[str(plu)] = {k: num(col(row, c)) for k, c in PROD_ALM_COLS.items()}
    return out

def extraer_restringidos(wb):
    ws = wb["Productos Restringidos"]
    out = {branch: [] for branch in RESTR_COLS}
    for row in ws.iter_rows(min_row=3, values_only=True):
        for branch, c in RESTR_COLS.items():
            plu = ival(col(row, c))
            if plu is not None:
                out[branch].append(plu)
    return out

def extraer_no_envasa(wb):
    ws = wb["No envasa"]
    out = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is not None:
            out.append(plu)
    return out

def extraer_golden(wb):
    ws = wb["Almacen"]
    rows = []
    for row in ws.iter_rows(min_row=3, values_only=True):
        plu = ival(col(row, 1))
        if plu is None:
            continue
        rows.append({
            "plu": plu,
            "stocks": {k: num(col(row, c)) for k, c in ALM_STOCK.items()},
            "mins":   {k: num(col(row, c)) for k, c in ALM_MIN.items()},
            "enviar": {k: num(col(row, c)) for k, c in ALM_ENVIAR.items()},
            "importancia": num(col(row, 53)),   # BA
            "base8020":    num(col(row, 54)),    # BB
            "pideTotal":   num(col(row, 56)),    # BD
            "envasa":      col(row, 57),         # BE Si/No
        })
    return rows

# ── PESABLES (hoja "Pesables") ────────────────────────────────────────────────
# ProductosPesables: flags "Fact" por sucursal (vendido tras recepcion) + rubro.
#   cols F..L 1-indexed: 6=Urquiza 7=Nacion 8=Chacabuco 9=Pergamino 10=SanPedro 11=Rivadavia 12=Ramallo. E(5)=NombreRubro.
PES_PP_COLS = {"urquiza":6, "nacion":7, "chacabuco":8, "pergamino":9, "sanPedro":10, "rivadavia":11, "ramallo":12}
# Pesables: stock central producto (H=8), granel central (F=6, por codigo granel C=3); stock x sucursal:
PES_STOCK = {"central":8, "granel":6, "riv":14, "urq":19, "nacion":24, "chaca":29,
             "pergamino":34, "sanpedro":39, "logia":44, "ramallo":49, "sucu11":54}
# Pesables outputs golden (mins computados, enviar S/N, teorico, enviar, y columnas de decision):
PES_MIN    = {"riv":15, "urq":20, "nacion":25, "chaca":30, "pergamino":35, "sanpedro":40, "logia":45, "ramallo":50, "sucu11":55}
PES_SN     = {"riv":16, "urq":21, "nacion":26, "chaca":31, "pergamino":36, "sanpedro":41, "logia":46, "ramallo":51, "sucu11":56}
PES_TEO    = {"riv":17, "urq":22, "nacion":27, "chaca":32, "pergamino":37, "sanpedro":42, "logia":47, "ramallo":52, "sucu11":57}
PES_ENVIAR = {"riv":18, "urq":23, "nacion":28, "chaca":33, "pergamino":38, "sanpedro":43, "logia":48, "ramallo":53, "sucu11":58}

def extraer_productos_pesables(wb):
    """PLU pesable -> {rubro, flags Fact por sucursal}. Define el universo de PLUs pesables."""
    ws = wb["ProductosPesables"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is None or str(plu) in out:
            continue
        out[str(plu)] = {
            "rubro": col(row, 5) or "",
            "flags": {k: num(col(row, c)) for k, c in PES_PP_COLS.items()},
        }
    return out

def extraer_formulas_granel(wb):
    """PLU -> {granel: IdProductoComponente, cantFormula: Cantidad}. Primera ocurrencia (VLOOKUP/XLOOKUP)."""
    ws = wb["ProductosFormulas"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        if plu is None or str(plu) in out:
            continue
        out[str(plu)] = {"granel": ival(col(row, 3)), "cantFormula": num(col(row, 5), 1.0)}
    return out

def extraer_pesos_granel(wb):
    """Codigo granel -> peso bolsa (col C). Primera ocurrencia."""
    ws = wb["Pesos Granel"]
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        cod = ival(col(row, 1))
        if cod is None or str(cod) in out:
            continue
        out[str(cod)] = num(col(row, 3))
    return out

def extraer_fraccionadora(wb):
    """PLUs con verificador en col A:D = 'Ok' (lo unico que ve el VLOOKUP A:D,4 de la planilla)."""
    ws = wb["Fraccionadora"]
    out = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        plu = ival(col(row, 1))
        ver = col(row, 4)
        if plu is not None and isinstance(ver, str) and ver.strip().lower() == "ok":
            out.append(plu)
    return out

def extraer_pesables_golden(wb):
    ws = wb["Pesables"]
    rows = []
    for row in ws.iter_rows(min_row=3, values_only=True):
        plu = ival(col(row, 1))
        if plu is None:
            continue
        rows.append({
            "plu": plu,
            "granel":  ival(col(row, 3)),                                  # C codigo granel
            "cantF":   num(col(row, 90), 1.0),                             # CL
            "pesoGranel": num(col(row, 89)),                               # CK
            "stocks":  {k: num(col(row, c)) for k, c in PES_STOCK.items()},
            "mins":    {k: num(col(row, c)) for k, c in PES_MIN.items()},
            "sn":      {k: col(row, c) for k, c in PES_SN.items()},
            "teorico": {k: num(col(row, c)) for k, c in PES_TEO.items()},
            "enviar":  {k: col(row, c) for k, c in PES_ENVIAR.items()},    # texto o numero
            "I_deseada": num(col(row, 9)),                                 # I
            "K_envasar": num(col(row, 11)),                                # K
            "L_teorico": num(col(row, 12)),                                # L
            "M_uso":     num(col(row, 13)),                                # M
            "D_aenvasar": num(col(row, 4)),                                # D
            "E_impEnv":   num(col(row, 5)),                                # E
            "F_granel":   num(col(row, 6)),                                # F (=stocks.granel)
            "G_deposito": num(col(row, 7)),                                # G
            "BG_imp":     num(col(row, 59)),                               # BG importancia
            "CG_total":   num(col(row, 85)),                               # CG suma envios
            "CH":         num(col(row, 86)),                               # CH granel distribuido
            "CI":         num(col(row, 87)),                               # CI % reduccion
            "J_envasar":  col(row, 10),                                    # J Si/No
            "BJ":         col(row, 62),                                    # BJ Si/No
            "BK":         col(row, 63),                                    # BK Si/No
            "BL_grupo":   col(row, 64),                                    # BL ruteo
            "BM":         num(col(row, 65)),                               # BM otra importancia
        })
    return rows

def main():
    xlsm = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSM
    if not os.path.exists(xlsm):
        print("ERROR: no existe", xlsm); sys.exit(1)
    os.makedirs(DATA_DIR, exist_ok=True)
    print("Leyendo", xlsm, "(read_only, data_only)...", flush=True)
    wb = load_workbook(xlsm, read_only=True, data_only=True)

    a8020 = extraer_a8020(wb);                 print("  a8020 ok", flush=True)
    listas = {
        "noEnvasa": extraer_no_envasa(wb),
        "restringidos": extraer_restringidos(wb),
        "productosAlmacen": extraer_prod_almacen(wb),
        "importanciaMinorista": extraer_minorista(wb),
    };                                          print("  listas ok", flush=True)
    golden = extraer_golden(wb);                print("  golden ok", flush=True)
    pesables_listas = {
        "productosPesables": extraer_productos_pesables(wb),
        "formulas":          extraer_formulas_granel(wb),
        "pesosGranel":       extraer_pesos_granel(wb),
        "fraccionadora":     extraer_fraccionadora(wb),
    };                                          print("  pesables listas ok", flush=True)
    pesables_golden = extraer_pesables_golden(wb); print("  pesables golden ok", flush=True)
    wb.close()

    def dump(name, obj):
        p = os.path.join(DATA_DIR, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        print("  %-28s %8d bytes" % (name, os.path.getsize(p)), flush=True)

    dump("a8020.json", a8020)
    dump("distribucion_listas.json", listas)
    dump("almacen_golden.json", golden)
    dump("pesables_listas.json", pesables_listas)
    dump("pesables_golden.json", pesables_golden)

    print("OK. PLUs A8020=%d  restringidos=%s  noEnvasa=%d  prodAlmacen=%d  golden=%d" % (
        len(a8020),
        {k: len(v) for k, v in listas["restringidos"].items()},
        len(listas["noEnvasa"]), len(listas["productosAlmacen"]), len(golden),
    ), flush=True)
    print("   Pesables: productos=%d  formulas=%d  pesosGranel=%d  fraccionadora=%d  golden=%d" % (
        len(pesables_listas["productosPesables"]), len(pesables_listas["formulas"]),
        len(pesables_listas["pesosGranel"]), len(pesables_listas["fraccionadora"]), len(pesables_golden),
    ), flush=True)

if __name__ == "__main__":
    main()
