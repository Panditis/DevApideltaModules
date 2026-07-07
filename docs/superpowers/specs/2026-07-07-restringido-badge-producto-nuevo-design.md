# Badge Restringido + Producto Nuevo (prioridad + resaltado)

**Fecha:** 2026-07-07
**Estado:** Aprobado, pendiente de plan de implementación

## Problema

1. La celda de "enviar" por sucursal, cuando el motor devuelve `'Restringido'` (producto
   bloqueado para esa sucursal, ver lista editable "Restringidos" de
   `2026-07-07-distribucion-universo-siga-design.md`), hoy no tiene rama de renderizado
   propia en `distribucion.html` — cae en el `else` genérico (`n = v || 0` → `NaN`/`0`) y
   se muestra como un punto vacío `·`, idéntico a "sin envío". No hay forma visual de
   distinguir "restringido a propósito" de "no le toca enviar".

2. No existe noción de "producto nuevo" basada en fecha de primera compra. Un producto
   recién dado de alta en Siga no tiene historial de ventas/facturación, así que su
   importancia calculada (BG/impNorm) es 0 o casi 0 — queda al final de la cola de
   prioridad de distribución justo cuando más necesita empuje inicial para llegar a
   sucursales.

## Objetivo

- Marcar visualmente las celdas restringidas (Almacén y Pesables).
- Detectar "producto nuevo" (primera compra dentro de los últimos 30 días) y
  resaltarlo, dándole piso de prioridad para que no quede invisible en la distribución
  por falta de historial.

## A. Badge "Restr."

**Archivo:** `distribucion.html`, dos lugares del render de tabla (Almacén ~línea 1508,
Pesables ~línea 1550 — buscar el bloque `const v = r.enviar[k]` seguido de
`if (v === 'Fact') return ...`).

Agregar rama antes del `else` genérico:
```javascript
if (v === 'Restringido') return `${stkTd}<td class="env restr" title="Restringido para esta sucursal"><span style="background:rgba(192,57,43,.15);color:#c0392b;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid rgba(192,57,43,.4);display:inline-block">Restr.</span></td>`;
```
Mismo patrón visual que el badge `Fact` existente (línea 1512/1556), color propio para
no confundir.

## B. Detección "producto nuevo"

**Archivo:** `server.js`, dentro de `calcularDistribucionAlmacen()` y
`calcularDistribucionPesables()`, después de tener `plus` (universo de PLUs).

Query (reutiliza `MovimientosStock`/`MovimientosStockProductos`, mismo patrón que ya usa
`recalcularA8020()` para detectar productos sin ventas):
```sql
SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
FROM MovimientosStockProductos mp
JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
WHERE mp.IdProducto IN (<plus>) AND mp.IdTipoMovimiento IN (<compraTipos>)
GROUP BY mp.IdProducto
```
`compraTipos` = `distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']` (mismo default
que `a8020.js`/`recalcularA8020`, ver `server.js:1897`).

`nuevoDias` = `(distCfg.nuevo || {}).dias || 30` (nuevo campo en
`data/distribucion_config.json`, bajo una clave `nuevo: { dias: 30, pisoImportancia: 0.8 }`).

`esNuevo(plu)` = `Primera[plu] >= hoy - nuevoDias días`. Producto sin ninguna compra
registrada (nunca entró por compra, ej. producción interna) → no es "nuevo" por esta
regla (no hay fecha de referencia) — fuera de alcance, no se marca.

## C. Piso de prioridad ("top 20%")

`pisoImportancia` = `(distCfg.nuevo || {}).pisoImportancia || 0.8`.

Aplicado en server.js **después** de llamar a `calcularAlmacen`/`calcularPesables`, como
post-procesamiento sobre los campos ya normalizados — el motor de cálculo
(`distribucion.js`/`pesables.js`) no se modifica:

- **Almacén:** `f.impNorm` es campo de solo-salida (no alimenta cantidades, verificado en
  `distribucion.js:258-259` — solo se usa para la columna "imp" y el sort). Para cada fila
  con `esNuevo(f.plu)`: `f.impNorm = Math.max(f.impNorm, pisoImportancia)`.
- **Pesables:** `prioridad`/`prioridadSala` son campos de ranking (no alimentan `D`/`G`/
  `CG`/`enviar`, que ya se calcularon en pasadas previas — verificado en `pesables.js`).
  Para cada fila con `esNuevo(f.plu)`: `f.prioridad = Math.max(f.prioridad, pisoImportancia)`
  y `f.prioridadSala = Math.max(f.prioridadSala, pisoImportancia)`.

Motivo de no tocar `importancia`/`BG` crudos: esos valores alimentan otras fórmulas de
cantidad a enviar (ideal, `E`, `workGate`, etc.) — forzarlos artificialmente distorsionaría
las cantidades calculadas, no solo el orden de prioridad. El piso solo debe afectar
**ranking**, no **cantidad**.

## D. Resaltado visual "NUEVO"

Badge junto al nombre del producto, mismo lugar donde ya se renderiza `tipoTag(r.plu)`
(Almacén `distribucion.html:1523`, buscar equivalente en Pesables). Tooltip con la fecha
de primera compra formateada.

```javascript
const nuevoTag = (r) => r.esNuevo ? `<span title="Primera compra: ${r.primeraCompra || '?'}" style="background:rgba(41,128,185,.15);color:#2980b9;font-weight:700;padding:1px 6px;border-radius:5px;border:1px solid rgba(41,128,185,.4);font-size:10px;margin-left:5px">NUEVO</span>` : '';
```
Insertar `${nuevoTag(r)}` junto a `${tipoTag(r.plu)}` en la celda de nombre.

Campos nuevos en la respuesta de `/api/distribucion/almacen` y `/api/distribucion/pesables`:
`esNuevo: boolean`, `primeraCompra: string|null` (fecha ISO o `null` si no aplica).

## Config nueva

`data/distribucion_config.json` gana bloque opcional:
```json
{
  "nuevo": { "dias": 30, "pisoImportancia": 0.8 }
}
```
Si no existe, usa defaults (30 días, piso 0.8) — no requiere migración de datos
existentes.

## Fuera de alcance
- No se toca `a8020.js`/`recalcularA8020()` ni su concepto separado de "nuevo" (productos
  sin ventas, clase F) — es una noción distinta (basada en ventas, no en compra), con su
  propio propósito (order points), y ya tiene su propio flujo. No se renombra ni se
  fusiona con este.
- No se agrega UI para editar `pisoImportancia`/`dias` desde `distribucion.html` — se
  edita el JSON de config a mano, igual que otros parámetros existentes
  (`umbralMicroEnvio`, `empujeDeposito`).
