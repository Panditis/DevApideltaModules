# Estilo UI Apidelta — guía del sistema visual

Referencia real: `public/css/apidelta-theme.js` + `public/css/apidelta-theme.css` (el theme
compartido), aplicado en `public/insumos.html` (el módulo más completo) y en otros doce más.
Todo módulo nuevo carga estos dos archivos en vez de reinventar paleta/tipografía propia.

**Principio rector:** Fluent 2 (Microsoft) — superficies "acrílicas" (blur), radios chicos,
sombra ambiental en capas — con la paleta propia de Apidelta encima: **navbar verde con
acentos amarillos, body blanco con acentos verdes.** El canvas de página es un verde muy
tenue, no blanco puro, para que las cards blancas se separen del fondo sin necesitar una
sombra fuerte en cada una.

**Stack:** HTML + Tailwind (CDN) + theme compartido. Sin build. Los tokens de color/tipografía/
sombra viven en `tailwind.config` (`apidelta-theme.js`); las clases reusables (navbar, kpi,
tabs, acordeón, animaciones) viven en `apidelta-theme.css`. Nada de Google Fonts por módulo —
todo `system-ui`/"Segoe UI".

---

## 1. Cómo cargar el theme

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="/css/apidelta-theme.js"></script>
<link rel="stylesheet" href="/css/apidelta-theme.css">
```

Ese orden importa: el config de Tailwind tiene que estar seteado antes de que el CDN escanee
las clases de la página. Las rutas ya están registradas en `server.js` (el proyecto no usa
`express.static`, cada archivo estático tiene su propia ruta — no hace falta agregar nada para
un módulo nuevo).

Si el módulo tenía su propio `tailwind.config` inline, sus propias variables `:root`, o
Google Fonts (`Barlow`, `Barlow Condensed`, `Roboto`, etc.), se sacan. Si el `<body>` tenía una
clase o `background` propio, también se saca — el canvas de página (`#eef1ea`) lo pone
automático `body{background:#eef1ea}` del CSS compartido, y una clase `bg-*` en el `<body>` lo
pisa por especificidad.

---

## 2. Tokens

```js
// apidelta-theme.js
tailwind.config = { theme: { extend: {
  colors: {
    verde: '#405936', verdeHover: '#4f6e42', amarillo: '#FFCC00',
    bg: '#eef1ea', card: '#ffffff', borde: 'rgba(26,28,24,.16)', ink: '#242423',
    ok: '#0e700e', warn: '#8a5d00', crit: '#a4262c', gris: '#5c5f52',
  },
  fontFamily: {
    disp: ['system-ui', '"Segoe UI"', 'sans-serif'],
    body: ['system-ui', '"Segoe UI"', 'sans-serif'],
  },
  boxShadow: {
    fluent: '0 1.6px 3.6px rgba(26,28,24,.13), 0 0.3px 0.9px rgba(26,28,24,.1)',
  },
} } };
```

| Token | Uso |
|---|---|
| `verde` | Navbar, botones/links primarios sobre fondo blanco, texto de KPI/valores |
| `verdeHover` | Hover de todo lo que usa `verde` |
| `amarillo` | Acento del navbar (botón primario ahí, hover de links), nunca en el body |
| `bg` | Canvas de página — lo pone `body{}` del CSS compartido, no hace falta clase |
| `card` | Fondo de card/tabla/modal — blanco |
| `borde` | Todos los bordes de 1px |
| `ink` | Texto principal |
| `gris` | Texto secundario / labels / placeholders |
| `ok` / `warn` / `crit` | Estados semánticos (chips, badges, avisos) |

**Regla de oro:** el navbar es la ÚNICA superficie verde sólida del módulo. El body es blanco
con acentos verdes — una tarjeta KPI con fondo verde relleno y valor amarillo es el error más
común al migrar un módulo viejo (pasó en `productividad.html`, se corrigió a blanco+borde con
valor en `verde`).

Si un color no tiene token 1:1 (un dorado, un violeta de categoría, un azul de "info"), se deja
con su hex propio — no se le inventa semántica nueva al theme por un caso puntual.

### Radios y sombra

`rounded-lg` (8px) para controles, `rounded-xl` (12px) para cards grandes, `rounded-full` para
chips/pills. `shadow-fluent` en la tabla principal y cards que necesiten separarse del canvas;
el resto se separa solo con `border-borde` sobre el fondo `bg`.

---

## 3. Tipografía

Una sola familia para todo: `system-ui, "Segoe UI", sans-serif` (clases `font-disp`/`font-body`
del theme, ambas resuelven igual). No hay corte condensado de marca — se abandonó Barlow
Condensed junto con el resto de las fuentes Google Fonts propias de cada módulo.

**Regla de números:** toda celda/valor numérico lleva `font-variant-numeric:tabular-nums` y,
en tablas, `text-align:right`. Esto no cambió respecto al sistema viejo.

---

## 4. Navbar

```html
<header class="acrylic sticky top-0 z-20 border-b border-borde shadow-fluent">
  <div class="max-w-[1500px] mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
    <h1 class="font-disp text-2xl font-bold">CONTROL DE INSUMOS</h1>
    <span class="text-sm">Casa Central</span>
    <div class="ml-auto flex items-center gap-2">
      <button class="px-3 py-1.5 rounded-lg border border-borde text-sm">Exportar xlsx</button>
      <button class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm">Recargar</button>
      <a href="/" class="text-sm">← Inicio</a>
    </div>
  </div>
</header>
```

`.acrylic` sólo pinta verde cuando el elemento es un `<header>` (`header.acrylic` en el CSS
compartido) — fondo `rgba(64,89,54,.95)` con blur, para que otras superficies translúcidas que
puedan aparecer más adelante no hereden el verde por accidente. Dentro de `header.acrylic` el
CSS ya resuelve automático, sin necesidad de clases de color en el HTML:

- `h1` → blanco
- `span` → blanco al 75% de opacidad (subtítulos/meta)
- `a` → blanco, hover amarillo (`#FFCC00`)
- `button` → outline blanco, hover fondo blanco al 14%
- `button.bg-verde` (el botón primario) → pasa a fondo amarillo con texto oscuro automático

No hace falta el link "← Inicio" en `inicio.html` (es el hub) ni en un sub-hub como `rrhh.html`
si ya se está un nivel adentro de la navegación — usar criterio.

### Tabs dentro del navbar

Cuando las tabs de un módulo viven en la franja verde (no sobre el body blanco — para eso está
`.tab`/`.tab.on` en §6), usan un lenguaje distinto: transparentes, con un subrayado amarillo que
crece desde el centro al activarse. Es el patrón de `planificacion.html`/`distribucion.html`,
ahora reusable como `.navtab`/`.navtab.on` en `apidelta-theme.css`:

```html
<div class="tabs">
  <button class="navtab on" data-tab="resumen">Resumen</button>
  <button class="navtab" data-tab="detalle">Detalle</button>
</div>
```

**Filo amarillo:** si el navbar tiene la marca separada de la fila de tabs (ej. `.top` con el
logo, y debajo la fila de tabs), esa costura lleva la firma del sistema — un degradado amarillo
de 2px que se angosta hacia los bordes. Clase reusable `.filo-amarillo` en el contenedor de
arriba (el que necesita el borde inferior).

**Gotcha de especificidad — la causa #1 de "el hover me lo pinta de blanco":** casi todo módulo
grande tiene un reset genérico de sus propios botones, tipo `button{background:var(--x)}` /
`button:hover{background:var(--y)}`. Ese `button:hover` (elemento + pseudo-clase, especificidad
más alta que una sola clase) le gana a `.navtab{background:none}` en el estado hover, porque
`.navtab:hover` que solo declara `color` no compite por la propiedad `background` — nadie más la
está pisando en ese estado. Por eso `.navtab:hover` y `.navtab.on` declaran `background: none`
explícito en vez de asumir que alcanza con heredarlo de la regla base. Si un módulo migrado
sigue mostrando fondo blanco/gris en el hover de una tab o de un botón dentro del navbar después
de sacarle el reset propio, esta es la primera sospecha.

---

## 5. Layout de body

```
header.acrylic  (navbar, ancho completo, sticky)
└── main / div.max-w-…  (max-width según densidad del módulo, mx-auto, padding)
    ├── .kpis / #kpis   (grid auto-fit, cards blancas)
    ├── toolbar         (buscador + filtros, una sola caja)
    ├── #msg / .error   (avisos)
    └── tabla / cards   (bg-card, border-borde, shadow-fluent si es la pieza principal)
```

```css
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
```

Los KPI usan `auto-fit` + `minmax` y **gap real entre tarjetas** (12px como mínimo) — nunca la
estrategia vieja de "tira sin separación con 1px de fondo como grout", que en pantalla se lee
como una sola masa de color en vez de tarjetas individuales.

`max-width` no es un valor único fijo: `insumos.html`/`planificacion.html` (tablas anchas) usan
`1500px`, `fraccionado_externo.html` (formulario angosto) usa `5xl` (~1024px). Elegir según
cuánto contenido horizontal necesita el módulo, no copiar un número fijo.

---

## 6. Componentes

### Card

```css
.card{background:#fff;border:1px solid var(--borde,rgba(26,28,24,.16));border-radius:12px;padding:16px}
```

Blanca, borde de 1px, sin sombra por defecto (la sombra `shadow-fluent` queda para la pieza
principal del módulo — la tabla, un panel destacado — no para cada card suelta).

### KPI

```css
.kpi{background:#fff;border:1px solid var(--borde);border-radius:12px;padding:14px}
.kpi .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--gris)}
.kpi .val{font-family:var(--font-disp);font-weight:800;font-size:28px;color:var(--verde);font-variant-numeric:tabular-nums}
```

Blanco con borde, nunca relleno verde sólido. Label chico y gris arriba, valor grande en verde
abajo. Si el KPI es clickeable (filtro), agrega `cursor:pointer` y un estado `.on` con
`outline:2px solid var(--verde)` — si no es clickeable, `cursor:default` y sin hover.

### Acordeón (listas/secciones colapsables)

Clase compartida `.acordeon` en `apidelta-theme.css`, pensada para cualquier `<details>` del
sistema (desgloses día/semana, historiales, detalle expandido de una fila):

```css
.acordeon > summary{background:rgba(64,89,54,.06)}      /* idle */
.acordeon > summary:hover{background:rgba(64,89,54,.11)} /* hover */
.acordeon[open] > summary{background:rgba(64,89,54,.14)} /* open */
.acordeon .caret{width:20px;height:20px;border-radius:50%;background:rgba(64,89,54,.14)} /* rota 90° al abrir */
```

`<details>` nativo — el navegador abre/cierra, no hace falta JS. El summary se distingue del
fondo con un tinte del verde de marca (no un gris genérico) y el caret es un chip circular que
rota, para que se lea como control y no como texto suelto. Si un módulo tiene su propia versión
con nombres de clase ya usados por su JS (`classList.toggle`), no hace falta renombrar — alcanza
con repuntar los valores de esas reglas locales a la misma receta visual (mismo criterio que se
usó en `productividad.html`/`planificacion.html`).

### Chips / estados

```css
.chip{display:inline-flex;padding:3px 10px;border-radius:999px;font-size:.72rem;font-weight:600}
.chip--ok{background:#dff6dd;color:#0e700e}
.chip--warn{background:#fff4ce;color:#8a5d00}
.chip--crit{background:#fde7e9;color:#a4262c}
```

Tres estados, nada más, salvo que el dato real tenga más categorías (ej. clasificación A/B/C/D
de `a8020.html`) — ahí se mantiene una escala propia en vez de forzar todo a ok/warn/crit.

### Botón

```css
.btn-primario{background:var(--verde);color:#fff}
.btn-primario:hover{background:var(--verdeHover)}
.btn-secundario{background:transparent;border:1px solid var(--borde);color:var(--ink)}
```

Dentro del navbar el primario pasa a amarillo automático (ver §4) — fuera del navbar, siempre
verde.

### Tablas

```css
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--borde)}
th{color:var(--gris);font-weight:600;font-size:12px;text-transform:uppercase}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--sup1, #f5f8f1)}
```

Densas, sin zebra, separadas por línea fina. **Filas expandibles: el detalle son filas de la
misma tabla**, nunca una tabla anidada (una anidada tiene su propio reparto de anchos y las
columnas dejan de alinear) — esto sigue igual que en el sistema viejo.

### Estados de carga/error/vacío

```css
.error{background:#fde7e9;color:#a4262c;border:1px solid #f6c6c2;padding:12px;border-radius:8px}
.loading{color:var(--gris);padding:20px;text-align:center}
.empty{color:var(--gris);padding:16px;text-align:center;font-size:14px}
```

Toda tabla o gráfico maneja el caso sin datos con un mensaje `.empty`, nunca queda en blanco.

---

## 7. Animaciones

`apidelta-theme.css` trae transiciones y una clase de entrada, todas respetando
`@media (prefers-reduced-motion: reduce)`:

- Hover de botones, filas de tabla y tabs: ~120-150ms ease.
- `.fade-in` (fade + `translateY(4px)`, ~180ms) para modales/paneles que aparecen.
- `.tab-panel` con transición de opacidad al cambiar de tab, en vez de corte seco.
- `.spin` (spinner de carga, `@keyframes sp`).

No hay más que eso — el principio sigue siendo utilitario, la animación es para dar feedback de
interacción, no para decorar.

---

## 8. Gráficos (Chart.js 4)

Sin cambios respecto al sistema anterior — esto es independiente de la paleta:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

- Los charts se guardan en un objeto `charts` y se destruyen antes de repintar
  (`destroyChart(key)`) — si no, se acumulan listeners y el tooltip se vuelve errático.
- **La paleta categórica de un gráfico (series por sucursal, por producto, etc.) NO se fuerza a
  verde/amarillo** — son datos, no chrome de UI, y reducir 10 series a 2 colores les hace perder
  distinción. Se deja con su propia paleta (ver `ventas_hora.html`).
- Cuando el color sí comunica una escala de valor (una torta buckets malo→bueno), se prioriza el
  significado sobre la marca: rojo/naranja para lo que se quiere reducir, verde/amarillo del
  theme para lo que crece bien.
- Color de texto sobre una porción: por luminancia, no fijo (blanco sobre oscuro, tinta oscura
  sobre claro) — la función `textoSobre(hex)` de siempre sigue valiendo.

---

## 9. Formato de números

Sin cambios — tres funciones, siempre locale `es-AR`:

```js
const fmtMoney = n => '$' + Math.round(n).toLocaleString('es-AR');
const fmtNum   = n => Math.round(n).toLocaleString('es-AR');
const fmtDec   = n => Number(n || 0).toLocaleString('es-AR', {minimumFractionDigits:1, maximumFractionDigits:1});
```

---

## 10. Patrones de JS

Sin cambios — la migración al theme compartido tocó solo `<head>` y presentación, nunca lógica:

- `const $ = id => document.getElementById(id);` — helper de una línea, sin librería.
- Una función `render*` por sección, todas llamadas desde una función de consulta tras un único
  `fetch` cuando es posible (el backend devuelve todo el dashboard en una sola respuesta).
- `escHtml()`/`escAttr()` obligatorio sobre cualquier texto que venga del backend antes de
  meterlo en un template string — los nombres de producto vienen de SiGA y no son confiables.
- Durante la carga: botón deshabilitado con texto de estado, y `.loading` en las zonas que se
  van a llenar.

---

## 11. Checklist para un módulo nuevo (o para migrar uno viejo)

- [ ] Carga `apidelta-theme.js` + `apidelta-theme.css` después del CDN de Tailwind
- [ ] Sin `tailwind.config` propio, sin variables `:root` de paleta propia, sin Google Fonts
- [ ] `<body>` sin clase/`background` propio (el canvas `#eef1ea` lo pone el theme)
- [ ] Navbar `header.acrylic` con el patrón de §4 (verde, texto blanco, botón primario amarillo)
- [ ] Cards/KPI blancos con borde, **nunca relleno verde sólido**
- [ ] Estados semánticos mapeados a `ok`/`warn`/`crit`, no colores sueltos nuevos
- [ ] Listas colapsables usan `.acordeon`/`.caret` del theme
- [ ] Columnas numéricas con `tabular-nums` y alineadas a la derecha
- [ ] Casos `.loading`, `.empty` y `.error` resueltos en todas las secciones
- [ ] `escHtml()`/`escAttr()` en todo texto que venga del backend
- [ ] Charts destruidos antes de repintar; paleta categórica de datos sin forzar a verde/amarillo
- [ ] Nada de Barlow/Barlow Condensed/Roboto ni otra Google Font propia del módulo

---

## 12. Módulos migrados

`insumos.html`, `fraccionado_externo.html`, `productividad.html`, `planificacion.html`,
`inicio.html`, `rrhh.html`, `diagnostico_quiebre.html`, `rrhh_ausencias_dashboard.html`,
`analisis.html`, `rrhh_relevamiento_ropa.html`, `ventas_hora.html`, `precios_proveedores.html`,
`a8020.html`. El resto de los módulos sigue con su paleta previa hasta que se migren a pedido.
