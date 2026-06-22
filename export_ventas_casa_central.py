import pyodbc
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

conn_str = (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=servidorapidelta\\SQLSTANDARD;"
    "DATABASE=Siga;"
    "UID=apidelta;"
    "PWD=apd706;"
)

SQL = """
SELECT
    p.IdProducto,
    p.NombreProducto,
    SUM(vp.Cantidad)                                                        AS TotalCantidad,
    COUNT(DISTINCT YEAR(v.Fecha)*100 + MONTH(v.Fecha))                     AS MesesConVenta,
    CAST(SUM(vp.Cantidad) AS DECIMAL(18,4))
        / COUNT(DISTINCT YEAR(v.Fecha)*100 + MONTH(v.Fecha))               AS PromMensual,
    COUNT(DISTINCT v.NumeroComprobante)                                     AS CantComprobantes
FROM VentasProductos vp
INNER JOIN Ventas v
    ON  v.IdSucursal         = vp.IdSucursal
    AND v.IdTipoComprobante  = vp.IdTipoComprobante
    AND v.Letra              = vp.Letra
    AND v.CentroEmisor       = vp.CentroEmisor
    AND v.NumeroComprobante  = vp.NumeroComprobante
INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
WHERE v.IdSucursal = 1
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
GROUP BY p.IdProducto, p.NombreProducto
ORDER BY PromMensual DESC
"""

print("Conectando a SQL Server...")
conn = pyodbc.connect(conn_str, timeout=30)
cursor = conn.cursor()

print("Ejecutando query...")
cursor.execute(SQL)
rows = cursor.fetchall()
conn.close()
print(f"Filas obtenidas: {len(rows)}")

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Ventas Casa Central"

header_fill = PatternFill("solid", start_color="1F4E79", end_color="1F4E79")
header_font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
title_font  = Font(name="Arial", bold=True, size=13)
cell_font   = Font(name="Arial", size=10)
total_fill  = PatternFill("solid", start_color="D6E4F0", end_color="D6E4F0")
total_font  = Font(name="Arial", bold=True, size=10)
alt_fill    = PatternFill("solid", start_color="EBF5FB", end_color="EBF5FB")

# row[0]=IdProducto [1]=NombreProducto [2]=TotalCantidad [3]=MesesConVenta [4]=PromMensual [5]=CantComprobantes
ws.merge_cells("A1:F1")
ws["A1"] = "Ventas Casa Central — Promedio Mensual por Producto (denominador = meses con venta por producto)"
ws["A1"].font = title_font
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.row_dimensions[1].height = 22

ws.merge_cells("A2:F2")
ws["A2"] = "* Excluye comprobantes ANULADO. Meses sin ventas del producto no afectan el promedio."
ws["A2"].font = Font(name="Arial", size=9, italic=True, color="666666")
ws.row_dimensions[2].height = 15
ws.row_dimensions[3].height = 5

headers = ["ID Producto", "Nombre Producto", "Total Vendido", "Meses c/Venta", "Prom. Mensual", "Comprobantes"]
for col, h in enumerate(headers, 1):
    c = ws.cell(row=4, column=col, value=h)
    c.font = header_font
    c.fill = header_fill
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
ws.row_dimensions[4].height = 30

fmt_cant = '#,##0.00'

for i, row in enumerate(rows):
    r = i + 5
    fill = alt_fill if i % 2 == 0 else None
    cells = [
        (1, row[0], None),
        (2, row[1], None),
        (3, float(row[2]) if row[2] is not None else 0, fmt_cant),
        (4, int(row[3])   if row[3] is not None else 0, '#,##0'),
        (5, float(row[4]) if row[4] is not None else 0, fmt_cant),
        (6, int(row[5])   if row[5] is not None else 0, '#,##0'),
    ]
    for col, val, fmt in cells:
        c = ws.cell(row=r, column=col, value=val)
        c.font = cell_font
        if fmt:
            c.number_format = fmt
        if fill:
            c.fill = fill
        c.alignment = Alignment(horizontal="right" if col > 2 else "left", vertical="center")

total_row = len(rows) + 5
ws.cell(row=total_row, column=1, value="TOTAL").font = total_font
ws.cell(row=total_row, column=1).fill = total_fill
ws.merge_cells(f"A{total_row}:B{total_row}")

for col, fmt in [(3, fmt_cant), (6, '#,##0')]:
    letter = get_column_letter(col)
    c = ws.cell(row=total_row, column=col, value=f"=SUM({letter}5:{letter}{total_row-1})")
    c.font = total_font
    c.fill = total_fill
    c.number_format = fmt
    c.alignment = Alignment(horizontal="right", vertical="center")

col_widths = [12, 48, 16, 14, 16, 14]
for i, w in enumerate(col_widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w

ws.freeze_panes = "A5"
ws.auto_filter.ref = f"A4:F{total_row-1}"

output = r"C:\Users\Adriel\Desktop\ventas_casa_central.xlsx"
wb.save(output)
print(f"Guardado en: {output}")
