# Estilo UI Apidelta — guía del sistema visual

Referencia extraída de `analisis_ventas.html`, que es donde el estilo está más completo y
consistente. Sirve para construir módulos nuevos con el mismo aspecto sin tener que copiar y
adaptar a ojo.

**Principio rector:** dashboard corporativo plano y utilitario. Prioriza densidad de datos y
legibilidad sobre decoración. Sin sombras, sin glassmorphism, sin animaciones. Los únicos
degradados son funcionales: codifican un valor, no adornan.

**Stack:** HTML + CSS plano + JS vanilla. Sin Tailwind, sin Bootstrap, sin framework de
componentes, sin build step. Dos dependencias externas por CDN: Google Fonts y Chart.js.

---

## 1. Tokens

Todo el color y el redondeo salen de variables en `:root`. Nunca hardcodear un color de marca
en una regla: si hace falta un tono nuevo, se agrega como token.

```css
:root{
  --green:#405936; --green-dark:#2E4027; --green-mid:#4E6B43; --green-light:#E8F0E4;
  --yellow:#FFCC00; --gold:#C98A00;
  --bg:#F5F5F5; --surface:#FFFFFF; --text:#1C1B1F; --muted:#6B6B6B; --border:#E6E6E6;
  --radius:12px; --radius-sm:8px;
}
```

### Uso de cada color

| Token | Uso |
|---|---|
| `--green` | Header, botones primarios, acentos sólidos |
| `--green-dark` | Títulos de card, valores de KPI, hover de headers ordenables |
| `--green-mid` | Links secundarios, borde de chip activo |
| `--green-light` | Fondo de chip activo |
| `--yellow` | Acento de marca (la mitad `DELTA` del logo) |
| `--gold` | Acento cálido en gráficos y degradados de dato |
| `--bg` | Fondo de página |
| `--surface` | Fondo de card, controles, chips |
| `--text` / `--muted` | Texto principal / secundario, labels, headers de tabla |
| `--border` | Todos los bordes de 1px |

### Radios

Solo dos: `--radius` (12px) para contenedores — cards, controles, KPI — y `--radius-sm` (8px)
para elementos interactivos — botones, inputs, cajas de error. Los chips son la excepción:
`border-radius:999px` (píldora completa).

---

## 2. Tipografía

Dos cortes de la misma familia, cargados de Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
```

- **`Barlow`** (300-600) — texto corriente, tablas, controles. Es la fuente del `body`.
- **`Barlow Condensed`** (700-800) — logo, títulos de card, valores de KPI. La condensada da
  presencia sin robar ancho, que es lo que permite meter cifras grandes en cards chicas.

Escala real en uso:

| Elemento | Familia | Tamaño / peso |
|---|---|---|
| Logo | Condensed | 22px / 800, `letter-spacing:.5px` |
| Valor de KPI | Condensed | 28px / 800, color `--green-dark` |
| Título de card (`h3`) | Condensed | 18px / 700, color `--green-dark` |
| Texto de tabla | Barlow | 14px |
| Header de tabla (`th`) | Barlow | 12px / 600, `text-transform:uppercase`, color `--muted` |
| Label de control | Barlow | 12px, color `--muted` |
| Descripción de card | Barlow | 12px, `line-height:1.4`, color `--muted` |
| Detalle expandido | Barlow | 13px, color `--muted` |

**Regla de números:** toda celda numérica lleva `font-variant-numeric:tabular-nums` y
`text-align:right`. Sin eso las cifras no alinean verticalmente y la tabla se lee mal.

---

## 3. Layout

```
header  (verde, ancho completo)
└── .wrap  (max-width:1200px, centrado, padding 20px)
    ├── .controls   (filtros, una sola caja)
    ├── #msg        (errores)
    ├── .kpis       (grilla auto-fit)
    └── .grid2 …    (pares de cards)
```

```css
.wrap{max-width:1200px;margin:0 auto;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
```

- Los KPI usan `auto-fit` + `minmax`: se acomodan solos según cuántos haya, sin media query.
- Los pares de cards usan `1fr 1fr` y colapsan a una columna bajo 820px.
- Una card que necesita todo el ancho va suelta, fuera de `.grid2`.
- Espaciado: `gap` de 12px dentro de grupos, 16px entre bloques, `margin-top:16px` entre
  secciones. Padding de card: 16px.

**Único breakpoint: 820px.** No hay más. Si un módulo necesita otro, conviene revisar si el
layout no se está complicando de más.

---

## 4. Componentes

### Header

```html
<header>
  <span class="logo">API<b>DELTA</b></span>
  <span style="font-size:14px;opacity:.9">Nombre del módulo</span>
  <a href="/">← Inicio</a>
</header>
```

Verde sólido, texto blanco, `display:flex` con `gap:12px`. El logo parte el nombre en dos: la
`b` va en `--yellow`. El link a Inicio se empuja a la derecha con `margin-left:auto` y lleva
`opacity:.85`.

### Card

```css
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.card h3{margin:0 0 12px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;color:var(--green-dark)}
.card .desc{margin:-6px 0 12px;font-size:12px;line-height:1.4;color:var(--muted)}
```

**Sin sombra.** El plano se separa por borde de 1px y contraste de fondo (`--bg` gris vs
`--surface` blanco). Es la decisión que más define el estilo: agregar `box-shadow` rompe la
coherencia con el resto del módulo.

`.desc` es un subtítulo opcional para explicar qué mide un gráfico. El `margin-top` negativo
lo pega al título.

### KPI

```css
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.kpi .lbl{font-size:12px;color:var(--muted)}
.kpi .val{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:28px;color:var(--green-dark);margin-top:4px}
```

Label chico y gris arriba, número grande y condensado abajo. Mismo lenguaje que la card pero
con padding menor.

### Chips (selección múltiple)

```css
.chip{padding:6px 10px;border:1px solid var(--border);border-radius:999px;font-size:13px;cursor:pointer;user-select:none;background:#fff}
.chip.active{background:var(--green-light);border-color:var(--green-mid);color:var(--green-dark);font-weight:600}
```

Píldoras que alternan con clic. El estado activo cambia fondo, borde, color y peso — cuatro
señales a la vez, así se distingue sin depender solo del color. Se acompañan de links mini
("todas" / "ninguna") en `--green-mid`, 12px.

### Botón

```css
.btn{background:var(--green);color:#fff;border:0;padding:10px 18px;border-radius:var(--radius-sm);font-weight:600;cursor:pointer;font-family:inherit}
.btn:disabled{opacity:.6;cursor:default}
```

Un solo estilo de botón: verde sólido. No hay variantes secundarias ni outline. Durante la
carga se deshabilita y cambia el texto a "Consultando...".

### Tablas

```css
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
```

Densas, sin zebra striping, separadas por línea fina. Header en mayúsculas pequeñas y gris —
se lee como etiqueta, no compite con los datos.

**Headers ordenables:**

```css
th.orden{cursor:pointer;user-select:none;white-space:nowrap}
th.orden:hover{color:var(--green-dark)}
```

La columna activa muestra ▲ / ▼ en el propio texto del header.

**Filas expandibles:** el detalle son filas de la *misma* tabla, nunca una tabla anidada. Una
tabla anidada tiene su propio reparto de anchos y las columnas dejan de alinear. Se usan
celdas vacías donde no corresponde dato:

```html
<tr class="fam-det fd-3" hidden>
  <td class="pres">· Producto 500G</td>
  <td></td>
  <td class="num">120</td>
  <td class="num">$45.000</td>
  <td></td>
</tr>
```

```css
tr.fam-det>td{background:#FAFBF9;font-size:13px;color:var(--muted);border-top:0}
tr.fam-det>td.pres{padding-left:30px}
```

El caret (▶ / ▼) va en un `span` de ancho fijo 14px para que el texto no salte al abrir.

### Estados

```css
.error{background:#fdecea;color:#b3261e;border:1px solid #f5c6c2;padding:12px;border-radius:var(--radius-sm);margin-top:16px}
.loading{color:var(--muted);padding:20px;text-align:center}
.empty{color:var(--muted);padding:16px;text-align:center;font-size:14px}
```

Los tres casos siempre resueltos: error en rojo suave, carga y vacío en gris centrado. Toda
tabla o gráfico debe manejar el caso sin datos con un mensaje `.empty`, nunca quedar en blanco.

---

## 5. Barras de dato en tablas

Cuando una columna representa participación sobre un total, se dibuja como fondo de la fila,
no como celda aparte:

```css
:root{ --barra-ini:rgba(64,89,54,.55); --barra-fin:rgba(201,138,0,.32); }
tr.fam>td{padding-top:9px;padding-bottom:9px;font-weight:600}
tr.fam>td:first-child{box-shadow:inset 3px 0 0 var(--green)}
/* background-color, no el shorthand: el shorthand borraría la barra (background-image). */
tr.fam:hover{background-color:#F0F3EE}
```

```js
const fondo = `linear-gradient(90deg, var(--barra-ini) 0%, var(--barra-fin) ${corte}%, transparent ${corte}%)`;
```

Tres detalles que importan:

1. **El degradado va con transparencia** (55% → 32%) para que el texto encima siga legible.
2. **El hover usa `background-color`, no `background`.** El shorthand resetea
   `background-image` y borra la barra al pasar el mouse.
3. **El ancho escala contra el máximo de la lista, no contra el 100%.** Con 20 filas ninguna
   llegaría al 15% y todas se verían iguales. El número que se muestra es siempre la
   participación real; lo que se escala es la longitud visual.

---

## 6. Gráficos (Chart.js 4)

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

- Los charts se guardan en un objeto `charts` y se destruyen antes de repintar
  (`destroyChart(key)`), si no se acumulan listeners y el tooltip se vuelve errático.
- `<canvas height="200">` dentro de la card.
- Barras y líneas: leyenda apagada cuando hay una sola serie, con los ejes formateados por las
  mismas funciones que las tablas.

**Paleta semántica en la torta.** Cuando el color comunica una escala de valor, se prioriza el
significado sobre la marca: rojo para el bucket que se quiere reducir, después verde a
amarillo según crece la métrica.

```js
const PALETA_ART = ['#C62828', '#2E7D32', '#6DA340', '#B7BE33', '#F2C200'];
```

**Etiquetas dentro de las porciones.** Chart.js 4 no trae `datalabels` y no se puede sumar un
plugin por CDN, así que se dibuja a mano con un plugin inline (`afterDatasetsDraw`), y se apaga
la leyenda externa. Dos reglas aprendidas:

- **Color de texto por luminancia**, no fijo. Blanco sobre rojo y verdes, gris oscuro sobre
  lima y amarillo. Con blanco fijo el amarillo queda ilegible:

  ```js
  function textoSobre(hex){
    const n = parseInt(String(hex).replace('#',''), 16);
    const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return lum > 150 ? '#1C1B1F' : '#FFFFFF';
  }
  ```

- **Degradación por tamaño de porción**: bajo 7% se cae la etiqueta y queda solo el
  porcentaje; bajo 3% no se dibuja nada. El dato completo sigue en el tooltip.

---

## 7. Formato de números

Tres funciones, siempre locale `es-AR`:

```js
const fmtMoney = n => '$' + Math.round(n).toLocaleString('es-AR');
const fmtNum   = n => Math.round(n).toLocaleString('es-AR');
const fmtDec   = n => Number(n || 0).toLocaleString('es-AR', {minimumFractionDigits:1, maximumFractionDigits:1});
```

Dinero y cantidades sin decimales; promedios y porcentajes con uno. Se usan tanto en las
tablas como en los ejes y tooltips de los gráficos, así el mismo número se ve igual en todos
lados.

---

## 8. Patrones de JS

- `const $ = id => document.getElementById(id);` — helper de una línea, sin librería.
- Una función `render*` por sección, todas llamadas desde `consultar()` tras un único `fetch`.
- El endpoint devuelve todo el dashboard en una sola respuesta; el frontend no encadena
  llamadas.
- `escHtml()` obligatorio sobre cualquier texto que venga del backend antes de meterlo en un
  template string. Los nombres de producto vienen de SiGA y no son confiables.
- Durante la carga: botón deshabilitado con texto "Consultando...", y `.loading` en las zonas
  que se van a llenar.

---

## 9. Checklist para un módulo nuevo

- [ ] Tokens de `:root` copiados sin cambios de valor
- [ ] Las dos fuentes Barlow cargadas
- [ ] Header con logo `API<b>DELTA</b>` + nombre del módulo + link a Inicio
- [ ] `.wrap` con `max-width:1200px`
- [ ] Cards sin sombra, borde 1px, radio 12px
- [ ] Columnas numéricas con `tabular-nums` y alineadas a la derecha
- [ ] Casos `.loading`, `.empty` y `.error` resueltos en todas las secciones
- [ ] Números por `fmtMoney` / `fmtNum` / `fmtDec`
- [ ] `escHtml()` en todo texto que venga del backend
- [ ] Charts destruidos antes de repintar
- [ ] Breakpoint 820px si hay grilla de dos columnas
