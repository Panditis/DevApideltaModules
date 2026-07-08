# Ranking de importancia por sucursal en A8020

## Problema

A8020 clasifica cada PLU con un ABC global (Pareto de facturación/unidades, `config.abc.metrica`), igual para todas las sucursales. No existe forma de saber si un producto es importante *para una sucursal en particular* — un PLU puede ser C a nivel global pero top-seller en San Pedro. Falta esa señal por (sucursal, producto).

## Alcance

- Columna nueva, **no reemplaza** el ABC global existente (ese sigue siendo la base de `min`/`S` en `computeA8020`).
- Score numérico normalizado 0-1 por (sucursal, PLU). 1.0 = más importante en esa sucursal, 0 = menos importante.
- Métrica base: la misma que ya usa `config.abc.metrica` (hoy `'facturacion'`), pero calculada por sucursal en vez de global.
- Volumen de ventas (unidades) se usa solo como desempate cuando la facturación empata.
- Cálculo: percentil de posición. Se ordenan los PLUs de una sucursal por facturación desc (empate → volumen desc). `score = n===1 ? 1 : 1 - (idx / (n-1))`, con `idx` = posición 0-based tras el ordenamiento.
- Se muestra en `a8020.html` como columna nueva junto a cada columna de sucursal existente (no en tooltip).

## Componentes

### 1. `sqlAbcMetricPorSucursal(idList, meses, metrica)` — server.js

Mismo query que el `sqlAbcMetric` existente (línea ~1801), pero agrupando también por sucursal:

```sql
SELECT vp.IdSucursal, vp.IdProducto, SUM(<col>) AS Metric
FROM VentasProductos vp <join>
WHERE <filtro ventana>
GROUP BY vp.IdSucursal, vp.IdProducto
```

`<col>` = `vp.ImporteTotalNeto` si `metrica !== 'unidades'`, si no `vp.Cantidad` (misma lógica que la función existente).

### 2. `calcularRankingPorSucursal(metricPorSuc, statRows, sucById)` — a8020.js

Función pura nueva, exportada junto a `computeA8020`.

- `metricPorSuc`: `{ [idSucursal]: { [plu]: facturación } }` (construido en server.js desde el nuevo query).
- `statRows`: mismo array que ya recibe `computeA8020` (`{ idSucursal, plu, sumQ, sumQ2, dcv }`) — se usa `sumQ` como volumen de desempate.
- `sucById`: `{ [idSucursal]: sucKey }` — mismo mapeo que ya arma `computeA8020` internamente, se pasa para no duplicar `config.sucursales`.

Retorna `{ [sucKey]: { [plu]: score } }`.

Lógica:
1. Por cada `idSucursal` presente en `metricPorSuc` o `statRows`: unir el universo de PLUs de ambas fuentes.
2. Para cada PLU: `fact = metricPorSuc[idSucursal]?.[plu] || 0`, `vol = sumQ correspondiente en statRows || 0`.
3. Ordenar desc por `fact`, empate → desc por `vol`, empate remanente → mantiene orden estable (no se fuerza por PLU).
4. Asignar score por percentil de posición según fórmula de arriba.

### 3. server.js — `recalcularA8020()`

- Agrega el nuevo query al `Promise.all` existente (junto a `stats`, `ops`, `abcRows`).
- Construye `metricPorSuc` desde las filas del nuevo query.
- Llama `calcularRankingPorSucursal(metricPorSuc, statRows, sucById)` — necesita exponer `sucById` (hoy es una variable local dentro de `computeA8020`; se recalcula igual en server.js a partir de `config.sucursales`, es una sola línea, no requiere tocar la firma de `computeA8020`).
- Mergea el resultado en la construcción existente de `detalle` (línea ~1838-1845): `detalle[plu][sucursal].ranking = ranking[sucursal]?.[plu]`.
- Sin cambios de schema nuevos — `a8020_calc.json` ya persiste `detalle` tal cual.

### 4. a8020.html

- Agrega una columna "Rank" al lado de cada columna de sucursal (`SUC` array, línea ~121) en el `<thead>` dinámico (línea ~129-135) y en el render de filas (línea ~180-190).
- Lee `r.detalle[k].ranking`, formatea a 2 decimales.
- Estilo: reutiliza la convención visual del badge ABC (línea 53-54) — ≥0.8 verde, ≥0.5 amarillo, debajo neutro. No se inventa paleta nueva.
- Sorteable: se extiende `valorCol` (línea ~145) para reconocer las nuevas claves de columna.
- Celda vacía si `ranking` es `undefined` (sucursal sin facturación en la ventana).

## Flujo de datos

```
recalcularA8020()
  ├─ query: sqlVentasStats        → statRows (ya existía)
  ├─ query: sqlDiasOperativos     → opsDays  (ya existía)
  ├─ query: sqlAbcMetric          → metricByPlu (global, ya existía)
  ├─ query: sqlAbcMetricPorSucursal (NUEVO) → metricPorSuc
  ├─ computeA8020(...)            → filas, abc (sin cambios)
  ├─ calcularRankingPorSucursal(metricPorSuc, statRows, sucById) (NUEVO) → ranking
  ├─ merge ranking → detalle[plu][sucursal].ranking
  └─ guardarJSON(a8020_calc.json)

a8020.html
  └─ lee cache.detalle[plu][suc].ranking → columna "Rank" por sucursal
```

## Errores / edge cases

- Sucursal sin facturación en la ventana (`meses`) → no aparece en `metricPorSuc`, sus PLUs quedan sin `ranking` en `detalle` → celda vacía en UI, no rompe cálculo de `min`/`S`.
- PLU con facturación pero sin `sumQ` (por ejemplo baja de precio sin ventas registradas en `VentasProductos` pero sí en otra fuente) → `vol=0`, solo afecta el desempate, no bloquea el score.
- Sucursal con un solo PLU con ventas → `score=1` (trivialmente el más importante ahí).
- `idSucursal` en `statRows`/`metricPorSuc` que no está en `config.sucursales` (sucursal dada de baja) → se descarta, mismo comportamiento que ya tiene `computeA8020` con `sucById[r.idSucursal]` inexistente.

## Testing

El repo no tiene test runner configurado (sin jest/mocha en `package.json`). Sigue el patrón existente de scripts de validación manual (`validar_almacen.js`, `validar_pesables.js`).

Nuevo `validar_ranking.js`:
- Fixture con 2 sucursales, 3-4 PLUs cada una, facturación distinta y un caso de empate en facturación con volumen distinto.
- Verifica: orden desc correcto, score del primero = 1.0, score del último = 0, el empate se resuelve por volumen (el de mayor `sumQ` queda con score más alto), sucursal con 1 solo PLU da score 1.
- Se corre manual (`node validar_ranking.js`), no se integra a CI (no hay CI de tests en este repo).

Verificación end-to-end: pegarle a `/api/distribucion/a8020/recalcular` contra la base real, confirmar que `a8020_calc.json` tiene el campo `ranking` poblado, y visualmente en `a8020.html` que las columnas nuevas ordenan y colorean bien.
