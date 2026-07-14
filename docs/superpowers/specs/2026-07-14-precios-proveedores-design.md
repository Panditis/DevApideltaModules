# Módulo Precios de Proveedores — Diseño

**Fecha:** 2026-07-14
**Estado:** Aprobado por el usuario (diseño conversado y validado sección por sección)

## Objetivo

Comparar y gestionar precios de proveedores contra los costos actuales de SIGA para los
productos marcados para compra. Cargar listas de precios de proveedores desde PDF, URL
web o edición manual, matchearlas a productos SIGA y ver lado a lado precio de lista vs
costo actual vs último precio pagado.

## Decisiones tomadas con el usuario

| Tema | Decisión |
|------|----------|
| Stack UI | HTML+JS vanilla (como el resto del sistema) con estética ChakraUI replicada en CSS. Sin React ni build. |
| Parseo PDF | Parser local heurístico (`pdf-parse` + reglas). Sin IA. |
| URLs de proveedores | Fase 1: solo páginas públicas (`fetch` + `cheerio`). Login/JS headless queda para fase 2; mientras tanto se descarga el archivo manualmente y se sube. |
| Escritura | SIGA es solo lectura. Todo lo propio del módulo se persiste en `data/precios_proveedores.json`. |
| Contenido de tabs | Lista del proveedor + comparación contra SIGA (no solo lista, no historial como vista principal). |
| Estructura | Página nueva independiente (enfoque A), patrón `compras_modulo`: módulo puro + endpoints + JSON. |

## Arquitectura

- **`precios_proveedores.html`** — página nueva vanilla JS. Colores Apidelta: fondo blanco,
  verde como color primario, amarillo para acentos/badges. Componentes visuales estilo
  Chakra (cards con borde suave y sombra, tabs redondeadas, botones sólidos/outline,
  inputs con focus ring). Linkeada desde `inicio.html`.
- **`precios_proveedores.js`** — módulo puro Node (sin SQL, sin fs, sin Date.now; todo por
  parámetros, como `compras_modulo.js`). Exporta: parsing de texto PDF a ítems, parsing de
  tablas HTML a ítems, matching ítem→producto, cálculo de comparación Δ%.
- **Endpoints `/api/precios-proveedores/*`** en `server.js` usando `apiRoute` y el pool
  de lectura existente.
- **`data/precios_proveedores.json`** — persistencia del módulo.
- **Dependencias nuevas:** `pdf-parse`, `cheerio`. Upload con `multer` (ya presente).

## Datos SIGA (solo lectura)

- Universo: `Productos WHERE EsDeCompras = 1 AND Activo = 1` (~3.274 productos hoy).
- Costo actual: `ProductosSucursales.PrecioCosto` de la sucursal central
  (`Sucursales.SoyLaCentral = 1`).
- Último proveedor y precio: `ProductosProveedores` (`UltimoPrecioCompra`,
  `UltimaFechaCompra`, `CodigoProductoProveedor`, `IdProveedor`) tomando la fecha más
  reciente por producto.
- Historial del año: `Compras` (header: `IdProveedor`, `NombreProveedor`, `Fecha`) +
  `ComprasProductos` (detalle: `IdProducto`, `Cantidad`, `Precio`/`PrecioNeto`), join por
  clave de comprobante (`IdSucursal`, `IdTipoComprobante`, `Letra`, `CentroEmisor`,
  `NumeroComprobante`), filtrado desde el 1 de enero del año en curso.
- Búsqueda de proveedores para tabs: tabla `Proveedores` (patrón ya usado en
  `/api/compras-modulo/proveedores/buscar`).

## Persistencia (`data/precios_proveedores.json`)

```json
{
  "toleranciaPct": 2,
  "proveedores": [
    {
      "id": "prov-1",
      "idProveedorSiga": 123,
      "nombre": "Proveedor Ejemplo SA",
      "url": "https://ejemplo.com/lista",
      "listaVigente": {
        "fechaCarga": "2026-07-14T12:00:00.000Z",
        "origen": "pdf",
        "items": [
          {
            "codigoProveedor": "ABC-01",
            "descripcion": "Almendras x 1kg",
            "precio": 1234.56,
            "plu": "7442",
            "matchTipo": "codigo|barras|nombre|manual",
            "matchScore": 0.92
          }
        ]
      },
      "matcheosManuales": { "ABC-01": "7442" }
    }
  ]
}
```

Los matcheos manuales se guardan por proveedor y se reaplican en cargas futuras.

## Vistas

### Vista principal — Listado

Tabla de productos para compra con columnas: código (PLU), nombre, costo actual, último
proveedor, último precio, fecha de última compra. Badge amarillo "N prov." cuando el
producto tiene más de un proveedor en el año; click expande la fila con el listado
(proveedor, última fecha, precio, cantidad). Buscador por código/nombre y ordenamiento
por columna en el cliente.

- `GET /api/precios-proveedores/listado` → filas del universo + enriquecimiento.

### Tabs por proveedor

- Botón "+ Proveedor" abre buscador contra SIGA; el elegido se agrega como tab y se
  persiste. Las tabs se pueden cerrar (se quita del JSON, con confirmación).
- Tab muestra la lista vigente matcheada: código proveedor, descripción, precio lista,
  producto SIGA, costo actual, último pagado, Δ% contra costo actual. Semáforo: verde =
  proveedor más barato, amarillo = dentro de ±2% (tolerancia configurable en el JSON),
  rojo = más caro. Ítems sin matchear en sección aparte con acción "asignar producto".
- Acciones por tab: **Subir PDF**, **Cargar desde URL**, **Edición manual** (alta/edición
  de ítems en línea).

### Pantalla de revisión (previa a guardar cualquier carga)

Toda carga (PDF o URL) pasa por revisión: filas detectadas en tabla editable, celdas
dudosas resaltadas en amarillo, matching propuesto visible y corregible. Recién al
confirmar se persiste como lista vigente. Nada se guarda automáticamente.

## Endpoints

| Método | Ruta | Función |
|--------|------|---------|
| GET | `/api/precios-proveedores/listado` | Universo paraCompra + costo + último proveedor + historial año |
| GET | `/api/precios-proveedores/proveedores` | Tabs persistidas |
| POST | `/api/precios-proveedores/proveedores` | Agregar tab (desde búsqueda SIGA) |
| DELETE | `/api/precios-proveedores/proveedores/:id` | Quitar tab |
| POST | `/api/precios-proveedores/parse-pdf` | multer upload → pdf-parse → ítems propuestos + matching (no persiste) |
| POST | `/api/precios-proveedores/parse-url` | fetch + cheerio → ítems propuestos + matching (no persiste) |
| PUT | `/api/precios-proveedores/proveedores/:id/lista` | Confirmar lista revisada (persiste) |

## Parseo

- **PDF:** `pdf-parse` extrae texto plano. Heurística por línea: precio = último token
  numérico con formato AR (`1.234,56` o `1234.56`), código = primer token si es
  alfanumérico corto, descripción = el medio. Líneas sin precio se descartan. El parser es
  función pura testeable: `parsearTextoPdf(texto) → { items, descartadas }`.
- **URL:** `fetch` nativo (Node 18+) con timeout y User-Agent normal. `cheerio` busca
  `<table>` cuyas columnas parezcan código/descripción/precio (por headers o por forma del
  contenido). También función pura: `parsearHtml(html) → { items, descartadas }`.
- **PDFs escaneados (imagen):** fuera de alcance en fase 1; error claro "PDF sin texto
  extraíble".

## Matching ítem → producto SIGA

Orden de resolución, gana el primero que aplique:

1. `matcheosManuales` del proveedor (persistidos).
2. `CodigoProductoProveedor` exacto en `ProductosProveedores` del mismo proveedor.
3. Código de barras exacto (`Productos.CodigoDeBarras`).
4. Nombre normalizado (minúsculas, sin acentos ni símbolos) con score por solapamiento de
   tokens; se acepta arriba de un umbral (constante en el módulo puro), abajo queda
   "sin matchear".

Correcciones manuales en la pantalla de revisión alimentan `matcheosManuales`.

## Manejo de errores

- PDF sin texto / corrupto → 422 con mensaje específico visible en UI.
- URL inaccesible, timeout o sin tablas reconocibles → 422 con causa.
- Validación de inputs en todos los endpoints (ids, tamaños de archivo, formato de items).
- SQL con valores escapados/parametrizados como el resto de `server.js`.
- Errores de red/servidor en UI: banner rojo con mensaje, nunca silencio.

## Testing

Tests unitarios en `test/` (patrón existente del repo) para el módulo puro:

- `parsearTextoPdf`: formatos de línea AR típicos, líneas basura, precios con y sin miles.
- `parsearHtml`: tabla con headers, tabla sin headers, HTML sin tablas.
- Matching: manual > código proveedor > barras > nombre; umbral de score.
- Comparación Δ% y semáforo con tolerancia.

Fixtures sintéticos (texto y HTML embebidos en los tests, sin datos reales).

## Fuera de alcance (fase 2)

- Scraping de páginas con login o render JS (Playwright headless).
- OCR de PDFs escaneados.
- Escritura de costos hacia SIGA.
