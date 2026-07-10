# Módulo Compras — Diseño

**Fecha:** 2026-07-10
**Estado:** Aprobado para planificación

## Contexto

Existe `dashboard_compras.html` (`/compras`) con panel de urgencia/semáforo, consumo y proveedor por producto (`calcularPanelCompras()`, `analizarConsumoCompras()` en `server.js`). Este módulo nuevo es **independiente** — no reemplaza ni extiende el dashboard actual. Unifica tres señales de demanda (reposición A8020, faltantes por micro-envío de distribución, faltantes reales de mercadería) en un listado accionable, con búsqueda de proveedores, carrito de compras con costos estimados y generación de orden de pedido, gestión de presentaciones (bultos) y seguimiento específico de consumos de producción Apidelta.

Infraestructura reutilizada (confirmada por exploración previa, no se reinventa):
- `a8020.js` — `computeA8020()`, ranking por sucursal/global.
- `distribucion.js` — cálculo de piso mínimo escalonado (`pisoMinimo`), micro-envíos descartados (`enviarMicro`), `calcularAlmacen`.
- `server.js:1147-1300` `calcularPanelCompras()` — JOIN SQL `ProductosProveedores`+`Proveedores`+`Productos` (campo `UltimoPrecioCompra`, `UltimaFechaCompra`).
- `server.js:434-595` `analizarConsumoCompras()` — resuelve recursivamente `data/formulas.json` distinguiendo `tipo:'Presentacion'` (venta directa) vs `tipo:'Componente'` (consumo producción).
- `data/lead_times.json`, `data/ordenes.json` (vacío, ya pensado para esto), `data/catalogo.json` (presentaciones/variantes existentes).

## Alcance

Módulo nuevo, autocontenido:
- Backend: `compras_modulo.js` (funciones puras, patrón igual a `distribucion.js`), montado en `server.js` bajo `/api/compras-modulo/*` y ruta `GET /compras-modulo` → `compras_modulo.html`.
- Frontend: `compras_modulo.html`, Tailwind CDN + paleta Apidelta, diseño Fluent minimalista.
- Datos nuevos: `data/presentaciones_compra.json`. Reutiliza `data/ordenes.json` (vacío, ya existente).

Fuera de alcance: no se modifica `dashboard_compras.html`, no se agrega optimización automática de proveedor (solo panel de cobertura informativo), no se agrega ranking global de proveedores como sección aparte.

## Modelo de stock

Separación explícita central vs sucursales:
- **Central (depósito):** stock granel + stock almacén-depósito (los productos rubro Almacén residen en depósito central).
- **Sucursales:** stock fraccionado + stock almacén de sucursal (venta en piso).
- **Consolidado:** columna adicional = suma central + todas las sucursales, siempre visible.
- Vista expandible por producto para ver desglose por sucursal individual (mismo set de sucursales que `a8020.html`: sucu8, sucu9, sucu11, riv, urq, nacion, chaca, pergamino, sanPedro).

## Cálculo de sugerido de compra

`sugerido = déficitA8020 + déficitMicroEnvíos + faltanteReal` (suma simple, sin cap ni máximo — transparente y auditable en el listado, cada componente visible en columna propia).

- **déficitA8020**: suma de déficits de `computeA8020()` por sucursal (unidades bajo punto de pedido `min`), agregado a nivel producto.
- **déficitMicroEnvíos**: acumulado de `enviarMicro[key].qty` (unidades no enviadas por caer bajo umbral de micro-envío) de `distribucion.js`, sumado por producto en todas las sucursales.
- **faltanteReal**: si `stockCentral < pisoMínimo(S, key)` (mismo `pisoMinimo` escalonado ya implementado en `distribucion.js`), faltante = `pisoMínimo - stockCentral`; si no, 0.

## Proveedor, costo y última compra

Por producto: JOIN `ProductosProveedores`+`Proveedores` (mismo patrón `calcularPanelCompras`) → proveedor asociado, `UltimoPrecioCompra` (costo estimado en carrito), `UltimaFechaCompra` + última cantidad comprada (de `MovimientosStockProductos` filtrado por `tiposMovimientoCompra` de `config.json`).

## Buscador de proveedores

`buscarProveedor(nombreOParcial)`: SQL `Proveedores` filtrado por nombre → JOIN `ProductosProveedores` → todos los productos que maneja ese proveedor, con último precio y fecha. Tab propio en la UI, sin relación directa al carrito activo (búsqueda exploratoria).

## Carrito de compras

- Agregar productos desde el listado (cantidad pre-cargada = sugerido, editable).
- **Redondeo a bulto**: si `data/presentaciones_compra.json` tiene entrada para el PLU, la cantidad se redondea hacia arriba al múltiplo de `unidadesPorBulto` (`Math.ceil(cantidad / unidadesPorBulto) * unidadesPorBulto`). Si no hay entrada cargada, se muestra badge "sin bulto cargado" con link directo al tab Presentaciones para cargarlo.
- **Panel de cobertura**: agrupa items del carrito por proveedor asociado a cada producto → muestra por proveedor cuántos ítems del carrito cubre (X de Y) y costo total estimado de esa porción. Sin algoritmo de optimización — el usuario decide con qué proveedor(es) generar la orden.
- Costo total del carrito = `Σ cantidad × UltimoPrecioCompra`.

## Generar orden de pedido

Por proveedor seleccionado en el carrito:
1. `crearOrden(proveedor, items)` persiste en `data/ordenes.json`: `{ id, fecha, proveedor, items:[{plu,nombre,cantidad,costoUnit}], total, estado:'GENERADA' }`.
2. Abre vista imprimible (HTML standalone, `window.print()`/Ctrl+P) con header proveedor, tabla de items (producto, cantidad, costo unitario, subtotal), total.
3. Al generar, esos items se remueven del carrito (o quedan marcados como "ordenados", a definir en plan de implementación — no bloqueante para el diseño).

## Presentaciones (bultos)

`data/presentaciones_compra.json`: `{ [plu]: { unidadesPorBulto: number, nombreBulto?: string } }`.

Tab dedicado:
- Lista productos con déficit/sugerido > 0 que **no tienen** entrada en este JSON ("sin bulto cargado").
- Form de alta rápida: PLU (autocompletar contra catálogo) + unidades por bulto + nombre opcional → `POST /api/compras-modulo/presentacion`.
- Lista productos ya cargados, editable/eliminable.

## Consumos de producción Apidelta

Tab dedicado, reutiliza `analizarConsumoCompras()` filtrando `tipo:'Componente'` (resuelto recursivamente sobre `data/formulas.json`). Muestra **solo componentes con déficit**: consumo proyectado por producción > stock actual disponible. Columnas: componente, stock actual, consumo proyectado, déficit, productos Apidelta que lo usan (trazabilidad desde `formulas.json`).

## Frontend — diseño visual

- Tailwind CSS vía CDN (mismo patrón que `inicio.html`), tema extendido con paleta Apidelta: primario `#405936`, hover `#4f6e42`, dark `#2e4027`, acento `#FFCC00`, fondo `#eef2e9`, texto `#1a1c18`, borde `#c3c9bc`. Semáforo urgencia (reuso de `dashboard_compras.html`): rojo `#D32F2F`, naranja `#E65100`, ámbar `#F57F17`, verde ok `#388E3C`.
- Fuentes: Barlow Condensed (headers/tablas) + Roboto (texto).
- Estilo Fluent minimalista: superficies tipo "acrylic" (fondo semitransparente + `backdrop-filter: blur`), cards con esquinas redondeadas y sombra suave, sin bordes duros ni skeuomorfismo, jerarquía tipográfica clara.
- Estructura: 5 tabs — Listado, Proveedores, Carrito, Presentaciones, Producción.

## Rutas backend nuevas

- `GET /compras-modulo` → sirve `compras_modulo.html`.
- `GET /api/compras-modulo/listado` → `calcularListadoCompras()`.
- `GET /api/compras-modulo/proveedores/buscar?q=` → `buscarProveedor()`.
- `POST /api/compras-modulo/carrito/cobertura` → `calcularCoberturaCarrito(items)`.
- `GET /api/compras-modulo/presentaciones` / `POST` (alta) / `DELETE /:plu`.
- `GET /api/compras-modulo/produccion-deficit` → filtro de `analizarConsumoCompras()`.
- `POST /api/compras-modulo/ordenes` → `crearOrden()`, persiste + devuelve datos para vista imprimible.
- `GET /api/compras-modulo/ordenes` → historial (para futura referencia, no tab dedicado en v1).

## Testing / verificación

- Cálculo de sugerido (suma de 3 déficits) verificable con datos reales de al menos 3 productos conocidos (uno con déficit A8020 puro, uno con micro-envíos acumulados, uno con faltante real de central).
- Redondeo a bulto: casos límite (cantidad = múltiplo exacto, cantidad = 1 unidad sobre múltiplo).
- Generación de orden: verificar persistencia correcta en `ordenes.json` y que la vista imprimible refleje los mismos totales que el carrito.
- Verificación manual en navegador (server dev puerto 8081) de los 5 tabs con datos reales antes de dar por completo.
