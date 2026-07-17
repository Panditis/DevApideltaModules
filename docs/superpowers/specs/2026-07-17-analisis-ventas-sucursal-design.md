# Análisis de Ventas por Sucursal — Diseño

**Fecha:** 2026-07-17
**Estado:** Aprobado
**Autor:** Apidelta / Claude

## Objetivo

Módulo de análisis de rendimiento de ventas por sucursal en un rango de fechas
definido por el usuario. Calcula ticket promedio, días/horas pico, productos más
vendidos, comparativa entre sucursales y tendencia diaria.

Sucursales en alcance (fijas): **2 Urquiza, 3 Nación, 4 Chacabuco, 5 Rivadavia,
7 San Pedro, 9 Villa Ramallo, 10 Pergamino**. La central (`IdSucursal=1`) se
excluye siempre.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Métrica de importe (ticket / facturación) | **Bruto** (`ImporteTotal`, con IVA) |
| Ventas a contar | **Solo venta real**: excluye `ANULADO` y transferencias internas (clientes categoría `SUCURSAL`) |
| Ranking productos | **Ambos**: top por unidades y top por facturación |
| KPIs extra | Comparativa sucursales, tendencia diaria, día de semana + hora pico |
| Export Excel | No (fuera de alcance) |

## Fuente de datos (SIGA, SQL Server)

Conexión existente: `mssql/msnodesqlv8`, pool singleton `getPool()` + helper
`query(sql)` (`server.js:54-65`). Endpoints envueltos con `apiRoute(fn)`
(`server.js:974`).

Tablas:
- `Ventas` (cabecera / ticket) — 1 fila por comprobante. Clave compuesta de 5:
  `IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante`.
  Columnas: `Fecha` (DATETIME), `IdSucursal`, `ImporteTotal` (bruto),
  `IdEstadoComprobante`, `IdCliente`.
- `VentasProductos` (renglón) — join a `Ventas` por la clave de 5.
  Columnas: `IdProducto`, `Cantidad`, `ImporteTotalNeto`.
- `Productos` — `IdProducto`, `Nombre`.
- `Sucursales` — `IdSucursal`, `Nombre`, `SoyLaCentral`.
- `Clientes` (`IdCliente` → `IdCategoria`) + `Categorias` (`NombreCategoria`)
  para excluir transferencias internas.

### Filtros comunes (patrón `server.js:2019`)

```sql
WHERE v.Fecha >= '{desde} 00:00:00' AND v.Fecha <= '{hasta} 23:59:59'
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
  AND v.IdSucursal IN ({sucIds})
  AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
```

### Correctitud: dos niveles de agregación

Para no inflar métricas al joinear renglones:

- **Nivel cabecera (`Ventas`)** → facturación bruta = `SUM(v.ImporteTotal)`,
  tickets = `COUNT(*)` (1 fila por comprobante). Ticket promedio =
  facturación / tickets. De aquí: KPIs, comparativa, tendencia, día-semana, hora.
- **Nivel renglón (`VentasProductos`)** → unidades = `SUM(vp.Cantidad)`,
  facturación producto = `SUM(vp.ImporteTotalNeto)`. Solo para top productos.

El filtro de categoría `SUCURSAL` aplica a nivel cabecera (`Ventas.IdCliente`),
válido para ambos niveles.

Día de semana normalizado a lun–dom independiente de `@@DATEFIRST`:
`((DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST + 5) % 7)` → 0=lunes … 6=domingo.

## Arquitectura

Mismo patrón que `precios-proveedores` / `compras-modulo`:

- `analisis_ventas.js` — **módulo puro** (sin SQL exec, sin fs). Exporta:
  builders de SQL a partir de params ya saneados, y derivaciones de KPIs
  (ticket promedio, orden de rankings, mapeo de día-semana). Testeable.
- `analisis_ventas.html` — UI (Chart.js 4.4.0 CDN, paleta verde Apidelta).
- Endpoints inline en `server.js` que importan `analisis_ventas.js`, ejecutan
  `query()` y arman la respuesta.

### Endpoint

`GET /api/analisis-ventas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&sucursales=2,3,...`

Corre ~5 queries en `Promise.all`. Respuesta:

```json
{
  "rango": { "desde": "...", "hasta": "..." },
  "kpis": { "facturacion": 0, "tickets": 0, "ticketProm": 0, "unidades": 0, "productosDistintos": 0 },
  "comparativa": [{ "idSuc": 2, "nombre": "Urquiza", "facturacion": 0, "tickets": 0, "ticketProm": 0 }],
  "tendencia": [{ "fecha": "2026-07-01", "facturacion": 0, "tickets": 0 }],
  "diaSemana": [{ "dow": 0, "facturacion": 0, "tickets": 0 }],
  "horas": [{ "hora": 9, "facturacion": 0, "tickets": 0 }],
  "topUnidades": [{ "idProd": 0, "nombre": "...", "unidades": 0, "facturacion": 0 }],
  "topFacturacion": [{ "idProd": 0, "nombre": "...", "unidades": 0, "facturacion": 0 }]
}
```

Endpoint auxiliar (opcional, si conviene separar): lista de sucursales para el
multiselect — o bien se hardcodea la whitelist con nombres traídos en la
comparativa. Se resuelve en el plan.

### Queries (esquema, cabecera vs renglón)

1. **KPIs + comparativa** (cabecera, `GROUP BY v.IdSucursal` + `LEFT JOIN Sucursales`):
   `SUM(ImporteTotal)`, `COUNT(*)`. KPIs globales = suma de las filas.
2. **Tendencia** (cabecera, `GROUP BY CAST(v.Fecha AS DATE)`).
3. **Día de semana** (cabecera, `GROUP BY` expresión normalizada).
4. **Hora** (cabecera, `GROUP BY DATEPART(HOUR, v.Fecha)`).
5. **Top productos** (renglón, `GROUP BY vp.IdProducto, p.Nombre`, `TOP {N}`),
   una consulta ordenada por unidades y otra por facturación (o una sola
   ordenada y re-ordenada en JS).

## Frontend

`analisis_ventas.html`, vanilla JS, Chart.js 4.4.0 por CDN, paleta verde Apidelta
(variables CSS de `dashboard_consumo.html`: `--green:#405936`, `--yellow:#FFCC00`,
etc.), fuentes Barlow.

Layout:
- Header verde con logo.
- Barra de controles: `desde` / `hasta` (default: mes actual, día 1 → hoy),
  multiselect de sucursales (default todas), botón **Aplicar**.
- Fila de KPI cards: facturación total, tickets, ticket promedio, unidades,
  productos distintos.
- Comparativa sucursales: tabla + bar chart de facturación.
- Tendencia diaria: line chart.
- Día de semana (bar) + hora pico (bar).
- Top productos: 2 tablas (TOP 20 por unidades / por facturación).

Fetch vanilla: arma querystring `?desde&hasta&sucursales` y `await fetch(url)`
(patrón `ventas_hora.html:231`). Un solo request, un estado de carga.

## Seguridad

- Interpolación SQL solo tras sanear: fechas con `safeDate` (regex `YYYY-MM-DD`,
  `server.js:79`), sucursales con `safeIntList` (`server.js:82`) ∩ whitelist
  `[2,3,4,5,7,9,10]`, `TOP N` clamp a entero. Ningún string de usuario crudo
  entra al SQL.
- `apiRoute` captura excepciones → `500 {error}`.

## Manejo de errores

- Rango de fechas ausente/ inválido → default mes actual.
- Sucursales vacías tras intersección → usar whitelist completa.
- Frontend: banner de error y estados vacíos (sin datos en el rango).

## Testing

- Unit tests en `test/` sobre `analisis_ventas.js`: los builders de SQL contienen
  los filtros correctos (fecha, anulado, whitelist, categoría SUCURSAL); las
  derivaciones (ticket promedio = facturación/tickets, orden de rankings, mapeo
  día-semana 0=lunes) son correctas.
- Ejecución SQL real contra SIGA = verificación manual (requiere DB viva).

## Registro en la app

- `server.js` (~línea 15): `const analisisVentas = require('./analisis_ventas');`
- Bloque de rutas HTML (`server.js:924-933`):
  `app.get('/analisis-ventas', (_q,res) => res.sendFile(path.join(__dirname,'analisis_ventas.html')));`
- Endpoint `app.get('/api/analisis-ventas', apiRoute(async req => { ... }));`
- `inicio.html` (array de módulos, ~180-221): card verde nueva, `href:'/analisis-ventas'`,
  icon Lucide `bar-chart-3` (o `trending-up`).

## Assumption a validar en implementación

Ranking de productos por facturación usa `vp.ImporteTotalNeto` (neto, campo
estándar ABC) aunque los KPIs de ticket usan `ImporteTotal` bruto — el bruto a
nivel renglón puede no existir en `VentasProductos`. Se confirma contra el
esquema real de SIGA al implementar.

## Fuera de alcance (YAGNI)

- Export a Excel.
- Central (sucursal 1).
- Persistencia / caché de resultados (queries en vivo por rango).
- Comparación entre dos rangos de fechas.
