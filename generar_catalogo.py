"""
generar_catalogo.py
Lee productosProduccion.xlsx y genera data/catalogo.json
Ejecutar cada vez que cambie el xlsx.

Columnas del xlsx:
  A = Plu (IdProducto en Siga)
  B = Producto (nombre completo)
  C = P (refId de grupo)
  D = ProductoRef (nombre del grupo para planificacion)
"""
import openpyxl
import json
import os
import re

XLSX_PATH = r'C:\Users\ApideltaMaster\Desktop\productosProduccion.xlsx'
OUT_PATH  = os.path.join(os.path.dirname(__file__), 'data', 'catalogo.json')

PRESENTACION_RE = re.compile(
    r'(\d+(?:[.,]\d+)?\s*(?:G|Kg|Ml|L|g|kg|ml|l))(?:\s+\w+)*$',
    re.IGNORECASE
)

def normalizar(nombre):
    """Quita Pack, Bulto y Vid del nombre para obtener el producto base."""
    n = nombre.strip()
    # Strip desde Pack/Bulto hasta el final (cubre "Pack X 40 Unidades", "Bulto X 160 Unidades (Precio Por Un)", etc.)
    n = re.sub(r'\s+pack\b.*$',  '', n, flags=re.IGNORECASE).strip()
    n = re.sub(r'\s+bulto\b.*$', '', n, flags=re.IGNORECASE).strip()
    n = re.sub(r'\bvid\s+',      '', n, flags=re.IGNORECASE).strip()
    n = re.sub(r'\s+vid$',       '', n, flags=re.IGNORECASE).strip()
    return n.strip()

def extraer_presentacion(base_nombre):
    """Extrae la presentacion (ej: '1Kg', '500G') del nombre base."""
    m = PRESENTACION_RE.search(base_nombre)
    if m:
        raw = m.group(0).strip()
        raw = re.sub(r'(?i)\bkg\b', 'Kg', raw)
        raw = re.sub(r'(?i)\bg\b',  'G',  raw)
        return raw
    return base_nombre

wb = openpyxl.load_workbook(XLSX_PATH, read_only=True, data_only=True)
ws = wb.active

filas = []
for row in ws.iter_rows(min_row=2, values_only=True):
    if len(row) < 4:
        continue
    plu, producto, ref_id, producto_ref = row[0], row[1], row[2], row[3]
    if plu is None or producto is None:
        continue
    try:
        plu_int = int(plu)
    except (ValueError, TypeError):
        continue

    base = normalizar(str(producto))
    presentacion = extraer_presentacion(base)

    nombre_orig = str(producto).strip()
    es_variante = bool(
        re.search(r'\b(pack|bulto|vid)\b', nombre_orig, re.IGNORECASE)
    )

    filas.append({
        'plu':          plu_int,
        'producto':     nombre_orig,
        'baseNombre':   base,
        'presentacion': presentacion,
        'esVariante':   es_variante,
        'refId':        int(ref_id) if ref_id is not None else None,
        'productoRef':  str(producto_ref).strip() if producto_ref else ''
    })

wb.close()

with open(OUT_PATH, 'w', encoding='utf-8') as f:
    json.dump(filas, f, ensure_ascii=False, indent=2)

print(f'Catalogo generado: {len(filas)} productos -> {OUT_PATH}')

refs = {}
for f in filas:
    r = f['productoRef']
    if r not in refs:
        refs[r] = {'total': 0, 'variantes': 0, 'bases': set()}
    refs[r]['total'] += 1
    if f['esVariante']:
        refs[r]['variantes'] += 1
    else:
        refs[r]['bases'].add(f['baseNombre'])

print(f'\nGrupos de planificacion: {len(refs)}')
for nombre, s in sorted(refs.items()):
    print(f'  {nombre}: {len(s["bases"])} presentaciones, {s["variantes"]} variantes')
