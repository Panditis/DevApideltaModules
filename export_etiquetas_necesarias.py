import pyodbc, openpyxl, re, unicodedata
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from collections import defaultdict

LABELS = [
    "Etiqueta Coco 155Cc",
    "Etiqueta Coco 290Cc",
    "Etiqueta Mentomiel",
    "Etiqueta Miel 1Kg Pet Acacia",
    "Etiqueta Miel 1Kg Pet Alfalfa",
    "Etiqueta Miel 1Kg Pet Algarrobo",
    "Etiqueta Miel 1Kg Pet Aliso",
    "Etiqueta Miel 1Kg Pet Arroyo",
    "Etiqueta Miel 1Kg Pet Caa Tay",
    "Etiqueta Miel 1Kg Pet Citrus",
    "Etiqueta Miel 1Kg Pet Eucaliptus",
    "Etiqueta Miel 1Kg Pet Limon",
    "Etiqueta Miel 1Kg Pet Menta",
    "Etiqueta Miel 1Kg Pet Monofloral de Sauce",
    "Etiqueta Miel 1Kg Pet Monte",
    "Etiqueta Miel 1Kg Pet Naranjo",
    "Etiqueta Miel 1Kg Pet Pradera",
    "Etiqueta Miel 1Kg Pet Tilo",
    "Etiqueta Miel 1Kg Pet Trebol",
    "Etiqueta Miel 250G Pet Acacia",
    "Etiqueta Miel 250G Pet Alfalfa",
    "Etiqueta Miel 250G Pet Algarrobo",
    "Etiqueta Miel 250G Pet Aliso",
    "Etiqueta Miel 250G Pet Arroyo",
    "Etiqueta Miel 250G Pet Caa Tay",
    "Etiqueta Miel 250G Pet Citrus",
    "Etiqueta Miel 250G Pet Eucaliptus",
    "Etiqueta Miel 250G Pet Limon",
    "Etiqueta Miel 250G Pet Menta",
    "Etiqueta Miel 250G Pet Monte",
    "Etiqueta Miel 250G Pet Naranjo",
    "Etiqueta Miel 250G Pet Pradera",
    "Etiqueta Miel 250G Pet Tilo",
    "Etiqueta Miel 250G Pet Trebol",
    "Etiqueta Miel 500G Pet Acacia",
    "Etiqueta Miel 500G Pet Alfalfa",
    "Etiqueta Miel 500G Pet Algarrobo",
    "Etiqueta Miel 500G Pet Aliso",
    "Etiqueta Miel 500G Pet Arroyo",
    "Etiqueta Miel 500G Pet Caa Tay",
    "Etiqueta Miel 500G Pet Citrus",
    "Etiqueta Miel 500G Pet Eucaliptus",
    "Etiqueta Miel 500G Pet Limon",
    "Etiqueta Miel 500G Pet Menta",
    "Etiqueta Miel 500G Pet Monofloral de Sauce",
    "Etiqueta Miel 500G Pet Monte",
    "Etiqueta Miel 500G Pet Naranjo",
    "Etiqueta Miel 500G Pet Pico Vertedor Arroyo",
    "Etiqueta Miel 500G Pet Pico Vertedor Catay",
    "Etiqueta Miel 500G Pet Pradera",
    "Etiqueta Miel 500G Pet Tilo",
    "Etiqueta Miel 500G Pet Trebol",
    "Etiqueta Miel Canela",
    "Etiqueta Miel Generica",
    "Etiqueta Miel Jengibre",
    "Etiqueta Tomate Al Natural 1L  Apidelta",
    "Etiqueta Vinagre de Sidra de Manzana 500cc Apidelta",
]

CONN_STR = (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=servidorapidelta\\SQLSTANDARD;"
    "DATABASE=Siga;"
    "UID=apidelta;"
    "PWD=apd706;"
)

SQL = """
SELECT p.IdProducto, p.NombreProducto,
    SUM(vp.Cantidad) AS TotalCantidad,
    COUNT(DISTINCT YEAR(v.Fecha)*100 + MONTH(v.Fecha)) AS MesesConVenta,
    CAST(SUM(vp.Cantidad) AS DECIMAL(18,4))
        / COUNT(DISTINCT YEAR(v.Fecha)*100 + MONTH(v.Fecha)) AS PromMensual
FROM VentasProductos vp
INNER JOIN Ventas v
    ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor
    AND v.NumeroComprobante=vp.NumeroComprobante
INNER JOIN Productos p ON p.IdProducto=vp.IdProducto
WHERE v.IdSucursal=1 AND ISNULL(v.IdEstadoComprobante,'')!='ANULADO'
  AND LOWER(p.NombreProducto) NOT LIKE '%etiqueta%'
  AND (
    LOWER(p.NombreProducto) LIKE '%miel%'
    OR LOWER(p.NombreProducto) LIKE '%mentomiel%'
    OR LOWER(p.NombreProducto) LIKE '%coco%'
    OR LOWER(p.NombreProducto) LIKE '%tomate%'
    OR LOWER(p.NombreProducto) LIKE '%vinagre%'
  )
GROUP BY p.IdProducto, p.NombreProducto
"""

STOPWORDS = {'etiqueta','pet','de','al','la','el','los','las','apidelta','natural','sidra','y'}

def norm(s):
    s = s.lower().strip()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'\bpv\b', 'pico vertedor', s)  # Pv → pico vertedor
    s = re.sub(r'\bcaatay\b', 'catay', s)       # CaaTay → catay
    # normalizar unidades
    s = re.sub(r'(\d+)\s*kg\b',             r'\1kg', s)
    s = re.sub(r'(\d+)\s*(?:g|gr)\b',       r'\1g',  s)
    s = re.sub(r'(\d+)\s*(?:cc|ml)\b',      r'\1g',  s)  # cc/ml → g para igualar 155Cc↔155G
    s = re.sub(r'(\d+)\s*l(?:t|ts)?\b',     r'\1kg', s)  # 1L/1Lt → 1kg para igualar 1L↔1Kg
    return s

def keywords(label):
    return [w for w in norm(label).split() if w not in STOPWORDS and len(w) > 1]

label_kws = [(lbl, keywords(lbl)) for lbl in LABELS]

def best_label(product_name):
    pn = norm(product_name)
    best, best_n = None, 0
    for lbl, kws in label_kws:
        if kws and all(kw in pn for kw in kws) and len(kws) > best_n:
            best, best_n = lbl, len(kws)
    return best

print("Conectando...")
conn = pyodbc.connect(CONN_STR, timeout=30)
rows = conn.cursor().execute(SQL).fetchall()
conn.close()
print(f"Productos: {len(rows)}")

label_groups = defaultdict(list)
unmatched = []

for pid, name, total, meses, prom in rows:
    prom = float(prom) if prom else 0.0
    lbl = best_label(name)
    if lbl:
        label_groups[lbl].append((name, prom))
    else:
        unmatched.append((pid, name, prom))

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Etiquetas"

h_fill    = PatternFill("solid", start_color="1F4E79", end_color="1F4E79")
h_font    = Font(name="Arial", bold=True, color="FFFFFF", size=11)
lbl_fill  = PatternFill("solid", start_color="2E75B6", end_color="2E75B6")
lbl_font  = Font(name="Arial", bold=True, color="FFFFFF", size=10)
no_fill   = PatternFill("solid", start_color="FFE699", end_color="FFE699")
no_font   = Font(name="Arial", bold=True, size=10)
sub_font  = Font(name="Arial", size=10)
alt_fill  = PatternFill("solid", start_color="EBF5FB", end_color="EBF5FB")
tot_fill  = PatternFill("solid", start_color="D6E4F0", end_color="D6E4F0")
tot_font  = Font(name="Arial", bold=True, size=10)
fmt       = '#,##0.00'

ws.merge_cells("A1:C1")
ws["A1"] = "Etiquetas necesarias por mes — Casa Central (prom. mensual por meses con venta)"
ws["A1"].font = Font(name="Arial", bold=True, size=13)
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.row_dimensions[1].height = 22

ws.merge_cells("A2:C2")
ws["A2"] = "* Cada producto asignado a la etiqueta con mayor coincidencia. Sin clasificar = sin etiqueta correspondiente."
ws["A2"].font = Font(name="Arial", size=9, italic=True, color="666666")
ws.row_dimensions[2].height = 14
ws.row_dimensions[3].height = 5

for c, h in enumerate(["Etiqueta / Producto", "Prom. Mensual", "N° Prod."], 1):
    cell = ws.cell(row=4, column=c, value=h)
    cell.font = h_font; cell.fill = h_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")
ws.row_dimensions[4].height = 28

r = 5
grand_total = 0.0

for lbl in LABELS:
    products = sorted(label_groups.get(lbl, []), key=lambda x: -x[1])
    total_prom = sum(p for _, p in products)
    grand_total += total_prom

    for c in range(1, 4):
        ws.cell(row=r, column=c).fill = lbl_fill
    ws.cell(row=r, column=1, value=lbl).font = lbl_font
    ws.cell(row=r, column=1).alignment = Alignment(vertical="center")
    c2 = ws.cell(row=r, column=2, value=total_prom)
    c2.font = lbl_font; c2.number_format = fmt
    c2.alignment = Alignment(horizontal="right", vertical="center")
    c3 = ws.cell(row=r, column=3, value=len(products))
    c3.font = lbl_font; c3.number_format = '#,##0'
    c3.alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[r].height = 20
    r += 1

    if products:
        for i, (pname, pprom) in enumerate(products):
            fill = alt_fill if i % 2 == 0 else None
            c1 = ws.cell(row=r, column=1, value=f"    {pname}")
            c1.font = sub_font
            if fill: c1.fill = fill
            c2 = ws.cell(row=r, column=2, value=pprom)
            c2.font = sub_font; c2.number_format = fmt
            if fill: c2.fill = fill
            c2.alignment = Alignment(horizontal="right")
            ws.row_dimensions[r].height = 16
            r += 1
    else:
        c1 = ws.cell(row=r, column=1, value="    (sin ventas registradas)")
        c1.font = Font(name="Arial", size=10, italic=True, color="999999")
        ws.row_dimensions[r].height = 15
        r += 1

c1 = ws.cell(row=r, column=1, value="TOTAL GENERAL")
c1.font = tot_font; c1.fill = tot_fill
c2 = ws.cell(row=r, column=2, value=grand_total)
c2.font = tot_font; c2.fill = tot_fill; c2.number_format = fmt
c2.alignment = Alignment(horizontal="right")
ws.row_dimensions[r].height = 22
r += 2

if unmatched:
    unmatched_sorted = sorted(unmatched, key=lambda x: -x[2])
    c1 = ws.cell(row=r, column=1, value=f"SIN ETIQUETA ASIGNADA  ({len(unmatched)} productos)")
    c1.font = no_font; c1.fill = no_fill
    ws.row_dimensions[r].height = 20
    r += 1
    for i, (pid, name, prom) in enumerate(unmatched_sorted):
        fill = alt_fill if i % 2 == 0 else None
        c1 = ws.cell(row=r, column=1, value=f"    {name}")
        c1.font = sub_font
        if fill: c1.fill = fill
        c2 = ws.cell(row=r, column=2, value=prom)
        c2.font = sub_font; c2.number_format = fmt
        if fill: c2.fill = fill
        c2.alignment = Alignment(horizontal="right")
        ws.row_dimensions[r].height = 15
        r += 1

ws.column_dimensions["A"].width = 58
ws.column_dimensions["B"].width = 18
ws.column_dimensions["C"].width = 10
ws.freeze_panes = "A5"

output = r"C:\Users\Adriel\Desktop\etiquetas_necesarias.xlsx"
wb.save(output)
matched = sum(len(v) for v in label_groups.values())
print(f"Guardado: {output}")
print(f"Clasificados: {matched}  |  Sin clasificar: {len(unmatched)}")
for lbl in LABELS:
    g = label_groups.get(lbl, [])
    if g:
        print(f"  {lbl[:50]}: {len(g)} prod, prom={sum(p for _,p in g):.1f}/mes")
