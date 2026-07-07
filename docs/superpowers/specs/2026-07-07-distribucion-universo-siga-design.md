# Distribución: universo de artículos directo de Siga (sin Excel)

**Fecha:** 2026-07-07
**Estado:** Aprobado, pendiente de plan de implementación

## Problema

En el módulo Distribución (tabs Almacén y Pesables), artículos nuevos de Siga no
aparecen. Causa raíz: el universo de PLUs que entra al motor de cálculo
(`calcularDistribucionAlmacen`/`calcularDistribucionPesables` en `server.js`) sale de
`data/distribucion_listas.json` / `data/pesables_listas.json`, generados por
`importar_distribucion.py` a partir de la hoja Excel "Listas Envasado-Almacen". Si un
producto nuevo no fue agregado a las hojas `ProductosAlmacen`/`ProductosPesables` de esa
planilla, queda afuera aunque esté activo y con stock en Siga.

Caso concreto verificado: PLU 5733 ("Leche Descremada La Serenisima Protein 1L"),
rubro Siga = `Almacen`, `Activo=1`, stock real — no está en `productosAlmacen` del JSON
importado.

## Objetivo

El universo de artículos de cada tab sale de una query directa a Siga por rubro
(activos), no de un import manual de Excel.

## Rubros Siga confirmados (activos)

| Rubro | Activos | Va a |
|---|---|---|
| Almacen | 2180 | tab Almacén |
| Almacen Bultos/Cajas | 889 | **no entra** (packaging/granel a granel, no producto terminado) |
| Pesables Fraccionado | 716 | tab Pesables |
| Pesables Produccion | 38 | tab Pesables |
| Pesables Deposito | 451 | no entra |
| Pesables Venta Directa | 365 | no entra |

## Cambios

### 1. Universo Almacén (`calcularDistribucionAlmacen`, server.js)
Reemplaza `Object.keys(listas.productosAlmacen)` (Excel) por:
```sql
SELECT CAST(p.IdProducto AS VARCHAR) IdProducto, p.NombreProducto, r.NombreRubro
FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
WHERE p.Activo=1 AND r.NombreRubro='Almacen'
```
Los flags por sucursal del Excel (`productosAlmacen[plu]`) ya se ignoran en producción
(`corregirBugs:true` → `pa={}` en `distribucion.js`). Se elimina esa dependencia por
completo — sin pérdida funcional, ya era dead weight en producción.

### 2. Universo Pesables (`calcularDistribucionPesables`, server.js)
Mismo mecanismo, rubro IN `('Pesables Fraccionado','Pesables Produccion')`.

`rubro` mostrado en la tabla de salida pasa a leerse de la query en vivo (antes leía
`productosPesables[plu].rubro` del Excel).

### 3. Fact — dinámica para todos los productos, sin excepción
`pesables.js::calcularPesables` deja de recibir/usar `flags` estáticos
(`pesLis.productosPesables[plu].flags`, columnas F..L del Excel, Fact pre-facturación
viva). `enviarTeorico()` y `enviarFinal()` dependen únicamente de `recKeys`
(`calcularFactLive()`, ya vigente hoy como mecanismo primario). Se saca el parámetro
`flags` de las funciones internas que lo usaban solo como fallback estático.

Impacto: código más simple, un solo mecanismo de Fact (el vivo) en vez de dos
superpuestos. `productosPesables` del Excel deja de leerse del todo en el motor de
cálculo — solo sigue existiendo para el campo `rubro` legacy (que ahora ya no se usa,
ver punto 2).

### 4. Listas manuales editables (overlay) — sin cambios de comportamiento
`siempreAlmacen`, `noEnvasa`, `siemprePesable`, `siemprePesableSinGranel`,
`ocultarPesable` (en `data/listas_distribucion.json`, vía `leerListasDistrib()` /
`universoLista()`) siguen aplicando igual, ahora sobre el universo-rubro en vez del
universo-Excel.

### 5. "Restringidos" (por sucursal) → nueva lista editable
Hoy sale de `distribucion_listas.json.restringidos` (Excel, 7 sucursales:
rivadavia/urquiza/chacabuco/nacion/pergamino/sanPedro/villaRamallo). Pasa a vivir en
`data/listas_distribucion.json` (mismo archivo que las otras 5 listas editables),
estructura:
```json
{ "restringidos": { "rivadavia": [], "urquiza": [], "chacabuco": [], "nacion": [],
                     "pergamino": [], "sanPedro": [], "villaRamallo": [] } }
```
Seed único de arranque: copia del último `distribucion_listas.json.restringidos`
importado (migración una sola vez, mismo patrón que ya usa `noEnvasa` hoy en
`leerListasDistrib()`).

`POST /api/distribucion/listas` se extiende: cuando `lista==='restringidos'` requiere
además `sucursal` en el body (una de las 7 claves). Validar contra whitelist.

UI nueva en `distribucion.html`: sección "Restringidos" con selector de sucursal +
alta/baja de PLU, mismo patrón visual que "Siempre en Almacén" (`forzar-almacen`).

### 6. "Importancia Minorista" (planilla) — se elimina
El motor ya usa facturación viva de Siga por defecto
(`importanciaCfg.fuente !== 'planilla'` en `calcularDistribucionAlmacen` y
`calcularDistribucionPesables`). Se saca la rama `if (fuente === 'planilla')` y el
campo `importanciaMinorista` — dead code tras el cambio, no se usa el dato de la
planilla en producción hoy.

### 7. Fórmulas granel / pesos / fraccionadora — SIN CAMBIOS (fuera de alcance)
Se investigó reemplazar `pesLis.formulas` (Excel: producto→código granel+cantidad) por
la tabla real de Siga `ProductosComponentes`. Resultado: el mapeo no es limpio — contra
las 3553 fórmulas actuales del Excel, filtrar por rubro del componente
("Pesables Deposito") solo matchea 53% (1888), 45% sin candidato (1613), y hay casos
donde el Excel elige un componente distinto al esperado (ej. PLU 32: Excel apunta a un
envase/embalaje en vez del componente "Miel Granel En Tambor" que sería lo lógico).

Se descarta la migración automática por ahora. `pesables_listas.json` (`formulas`,
`pesosGranel`, `fraccionadora`) sigue viniendo del último `importar_distribucion.py`
corrido, congelado. Si se agrega un producto pesable nuevo que necesite fórmula de
granel, hay que re-correr el import (caso puntual, no bloquea que el producto aparezca
en la tab ni el cálculo general — solo el ruteo Envasado/Fraccionado de ese producto
específico sin fórmula quedará con `granel=null`, que el código ya maneja
— ver `gkeyOf(null)='NA'`).

### 8. Limpieza
- `importar_distribucion.py` deja de ser necesario para operación normal (visibilidad
  de artículos + Fact). Sigue existiendo para actualizar fórmulas granel puntualmente
  (punto 7).
- Mensajes de error tipo `"Falta data/distribucion_listas.json — corré: python
  importar_distribucion.py"` en `calcularDistribucionAlmacen`/`calcularDistribucionPesables`
  se sacan o se adaptan (el universo ya no depende de ese archivo para existir).
- `validar_almacen.js` / `validar_pesables.js` (comparan motor contra golden del Excel)
  quedan como herramienta histórica sin mantenimiento — no se tocan.
- `a8020.json` NO se toca — ya se regenera en vivo vía `recalcularA8020()` (confirmado
  en código, no depende de Excel).

## Fuera de alcance
- Migrar `formulas`/`pesosGranel`/`fraccionadora` a fuente Siga (punto 7).
- Tocar `validar_almacen.js`/`validar_pesables.js` o los archivos `*_golden.json`.
- Cambios a `docs/*.html` (guías/análisis de distribución) — quedan desactualizados,
  no se actualizan en este cambio.

## Riesgos / notas
- Productos que hoy están en `productosAlmacen`/`productosPesables` del Excel pero
  **no** tienen rubro Almacen/Pesables* en Siga (mal categorizados) van a desaparecer
  del universo tras el cambio, salvo que se agreguen a la lista manual "Siempre en
  Almacén"/"Siempre en Pesable". Vale la pena correr un diff antes de deployar para
  detectar estos casos y decidir si son productos mal categorizados en Siga (arreglar
  ahí) o necesitan el override manual.
- Pesables: perder el flag Fact estático como fallback no debería tener impacto
  observable (ya es el mecanismo secundario, superado por Fact vivo según comentario
  existente en el código).
