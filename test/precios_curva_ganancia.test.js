'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  gananciaPorCurva, ajustarCurva, ajustesPorPeso, validarCurvaGanancia, reescalarGanancias, markupDesdeGanancia,
  propuestaCurva, CURVA_GANANCIA_DEFAULT,
} = require('../lib/precios_costeo');
const { calcularFilaAlmacen, armarGruposFraccionado } = require('../routes/rutas_precios');

const CURVA = { a: 40, b: 3, pisoPct: 5, techoPct: 35 };
const g6 = v => +v.toFixed(6);

// ── gananciaPorCurva ─────────────────────────────────────────────────────────

test('gananciaPorCurva: a − b·ln(costo) a 6 decimales', () => {
  assert.strictEqual(gananciaPorCurva(CURVA, 2000), g6(40 - 3 * Math.log(2000)));
  assert.strictEqual(gananciaPorCurva(CURVA, 100), g6(40 - 3 * Math.log(100)));
});

test('gananciaPorCurva: clamp a piso y techo', () => {
  assert.strictEqual(gananciaPorCurva(CURVA, 1), 35);          // 40 > techo
  assert.strictEqual(gananciaPorCurva(CURVA, 1e9), 5);         // 40 − 62 < piso
});

test('gananciaPorCurva: siempre aplica (activa: false viejo se ignora); inválida o costo ≤ 0 → null', () => {
  assert.strictEqual(gananciaPorCurva({ ...CURVA, activa: false }, 2000), g6(40 - 3 * Math.log(2000)));
  assert.strictEqual(gananciaPorCurva({ a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1 }, 123456), 17.1); // plana, piso = techo
  assert.strictEqual(gananciaPorCurva(null, 2000), null);
  assert.strictEqual(gananciaPorCurva({ ...CURVA, a: 'x' }, 2000), null);
  assert.strictEqual(gananciaPorCurva({ ...CURVA, pisoPct: 50 }, 2000), null); // piso > techo
  assert.strictEqual(gananciaPorCurva(CURVA, 0), null);
  assert.strictEqual(gananciaPorCurva(CURVA, -5), null);
  assert.strictEqual(gananciaPorCurva(CURVA, null), null);
});

test('gananciaPorCurva: suma el ajuste del tramo de peso (misma regla que la matriz)', () => {
  const curva = { ...CURVA, ajustesPeso: { tramosG: [100, 500, 1000], puntos: [8, 3, -2] } };
  const base = g6(40 - 3 * Math.log(2000));
  assert.strictEqual(gananciaPorCurva(curva, 2000, 50), g6(base + 8));
  assert.strictEqual(gananciaPorCurva(curva, 2000, 500), g6(base + 3));
  assert.strictEqual(gananciaPorCurva(curva, 2000, 501), g6(base - 2));
  assert.strictEqual(gananciaPorCurva(curva, 2000, 5000), g6(base - 2)); // más pesado que el último → último
  assert.strictEqual(gananciaPorCurva(curva, 2000), g6(base - 2));       // sin peso → 1 kg
  // El ajuste va después del clamp (puede pasar el techo).
  assert.strictEqual(gananciaPorCurva(curva, 1, 50), 43);
});

// ── ajustarCurva ─────────────────────────────────────────────────────────────

// Generador determinístico (LCG) para que el test no dependa del azar.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function sinteticos(n, { seed = 7, outliers = 0.1 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const costo = Math.exp(Math.log(100) + r() * (Math.log(100000) - Math.log(100)));
    const ruido = (r() - 0.5) * 4;
    const u = r();
    const ganancia = u < outliers / 2 ? 250 : u < outliers ? -40 : 40 - 3 * Math.log(costo) + ruido;
    return { costo, ganancia };
  });
}

test('ajustarCurva: recupera a ≈ 40 y b ≈ 3 de datos con ruido y 10 % de outliers', () => {
  const r = ajustarCurva(sinteticos(600));
  assert.ok(Math.abs(r.a - 40) < 1.5, `a = ${r.a}`);
  assert.ok(Math.abs(r.b - 3) < 0.2, `b = ${r.b}`);
  assert.strictEqual(r.n, 600);
  assert.strictEqual(r.bins.length, 20);
  assert.strictEqual(r.bins.reduce((s, b) => s + b.n, 0), 600);
  assert.ok(r.r2 > 0.9, `r2 = ${r.r2}`);
  assert.strictEqual(r.pisoPct, Math.min(...r.bins.map(b => b.ganancia)));
  assert.strictEqual(r.techoPct, Math.max(...r.bins.map(b => b.ganancia)));
  assert.strictEqual(r.a, Math.round(r.a * 1e4) / 1e4);
  assert.strictEqual(r.pisoPct, Math.round(r.pisoPct * 100) / 100);
  // bins ordenados por costo ascendente
  r.bins.forEach((b, i) => i && assert.ok(b.costo >= r.bins[i - 1].costo));
});

test('ajustarCurva: descarta costo ≤ 0 y ganancia fuera de [−50, 300]; pocos datos → throw', () => {
  const buenos = sinteticos(20, { outliers: 0 });
  const r = ajustarCurva([...buenos, { costo: 0, ganancia: 10 }, { costo: 100, ganancia: 301 }, { costo: 100, ganancia: -51 }, null]);
  assert.strictEqual(r.n, 20);
  assert.throws(() => ajustarCurva(buenos.slice(0, 19)), /pocos datos/);
  assert.throws(() => ajustarCurva([]), /pocos datos/);
  assert.throws(() => ajustarCurva(null), /pocos datos/);
});

// ── ajustesPorPeso ───────────────────────────────────────────────────────────

test('ajustesPorPeso: mediana del residuo por tramo a 1 decimal; tramo sin puntos → 0', () => {
  const curva = { a: 40, b: 3, pisoPct: -50, techoPct: 300 };
  const base = c => 40 - 3 * Math.log(c);
  const puntos = [
    { costo: 1000, ganancia: base(1000) + 10, pesoG: 100 },
    { costo: 2000, ganancia: base(2000) + 12, pesoG: 50 },
    { costo: 3000, ganancia: base(3000) + 11.04, pesoG: 80 },
    { costo: 1000, ganancia: base(1000) - 4, pesoG: 1000 },
    { costo: 1000, ganancia: base(1000) - 5, pesoG: null },  // sin peso → 1 kg
    { costo: 0, ganancia: 50, pesoG: 500 },                  // inválido: no cuenta
  ];
  assert.deepStrictEqual(ajustesPorPeso(puntos, curva, [100, 500, 1000]), { tramosG: [100, 500, 1000], puntos: [11, 0, -4.5] });
});

// ── validarCurvaGanancia ─────────────────────────────────────────────────────

test('validarCurvaGanancia: devuelve la curva limpia (sólo claves conocidas); fraccionado con ajustesPeso', () => {
  const alm = validarCurvaGanancia({ activa: true, a: 40, b: 3, pisoPct: 5, techoPct: 35, ajustadaEl: '2026-09-30', n: 812, basura: 1 }, 'almacen');
  assert.deepStrictEqual(alm, { a: 40, b: 3, pisoPct: 5, techoPct: 35, ajustadaEl: '2026-09-30', n: 812 });
  const fr = validarCurvaGanancia({ a: 40, b: -1, pisoPct: -50, techoPct: 300, ajustesPeso: { tramosG: [100, 1000], puntos: [5, -100] } }, 'fraccionado');
  assert.deepStrictEqual(fr, { a: 40, b: -1, pisoPct: -50, techoPct: 300, ajustadaEl: null, n: null,
    ajustesPeso: { tramosG: [100, 1000], puntos: [5, -100] } });
  // Producción: curva propia, plana (piso = techo) permitida, sin ajustes por peso.
  assert.deepStrictEqual(validarCurvaGanancia({ a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1, ajustesPeso: { tramosG: [1], puntos: [1] } }, 'produccion'),
    { a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1, ajustadaEl: null, n: null });
  assert.strictEqual(validarCurvaGanancia({ a: 1, b: 0, pisoPct: 0, techoPct: 1 }, 'fraccionado').ajustesPeso, null);
  // En Almacén los ajustes por peso no existen: se descartan.
  assert.strictEqual('ajustesPeso' in validarCurvaGanancia({ a: 1, b: 0, pisoPct: 0, techoPct: 1, ajustesPeso: { tramosG: [1], puntos: [1] } }, 'almacen'), false);
});

test('validarCurvaGanancia: errores claros', () => {
  const ok = { a: 40, b: 3, pisoPct: 5, techoPct: 35 };
  assert.throws(() => validarCurvaGanancia(ok, 'otro'), /tipo/);
  assert.throws(() => validarCurvaGanancia(null, 'almacen'), /objeto/);
  assert.throws(() => validarCurvaGanancia({ ...ok, a: '40' }, 'almacen'), /\.a/);
  assert.throws(() => validarCurvaGanancia({ ...ok, b: NaN }, 'almacen'), /\.b/);
  assert.throws(() => validarCurvaGanancia({ ...ok, pisoPct: -51 }, 'almacen'), /pisoPct/);
  assert.throws(() => validarCurvaGanancia({ ...ok, techoPct: 301 }, 'almacen'), /techoPct/);
  assert.throws(() => validarCurvaGanancia({ ...ok, pisoPct: 36 }, 'almacen'), /mayor/);
  assert.throws(() => validarCurvaGanancia({ ...ok, ajustadaEl: '30/09/2026' }, 'almacen'), /ajustadaEl/);
  assert.throws(() => validarCurvaGanancia({ ...ok, n: 1.5 }, 'almacen'), /\.n/);
  const aj = ajustesPeso => validarCurvaGanancia({ ...ok, ajustesPeso }, 'fraccionado');
  assert.throws(() => aj({ tramosG: [100, 100], puntos: [1, 1] }), /ascendentes/);
  assert.throws(() => aj({ tramosG: [0], puntos: [1] }), /tramosG/);
  assert.throws(() => aj({ tramosG: [100], puntos: [1, 2] }), /puntos/);
  assert.throws(() => aj({ tramosG: [100], puntos: [101] }), /puntos/);
  assert.throws(() => aj({ tramosG: Array.from({ length: 21 }, (_, i) => i + 1), puntos: Array(21).fill(0) }), /20/);
  assert.throws(() => aj('x'), /ajustesPeso/);
});

// ── reescalarGanancias con curva ─────────────────────────────────────────────

test('reescalarGanancias: reescala la curva (a, b, piso, techo, ajustes) y el markup total queda igual', () => {
  const costeo = { curvaGanancia: {
    almacen: { ...CURVA },
    fraccionado: { ...CURVA, ajustesPeso: { tramosG: [100, 1000], puntos: [6, -3] } },
    produccion: { a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1 },
  } };
  const r = reescalarGanancias(costeo, 0, 26.09);
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
    for (const costo of [1, 500, 2000, 50000, 1e9]) {
      for (const peso of [50, 1000]) {
        const antes = markupDesdeGanancia(gananciaPorCurva(costeo.curvaGanancia[tipo], costo, peso), 0);
        const despues = markupDesdeGanancia(gananciaPorCurva(r.curvaGanancia[tipo], costo, peso), 26.09);
        assert.ok(Math.abs(antes - despues) < 0.001, `${tipo} ${costo} ${peso}: ${antes} vs ${despues}`);
      }
    }
  }
  assert.deepStrictEqual(r.curvaGanancia.fraccionado.ajustesPeso.tramosG, [100, 1000]);
  assert.strictEqual(costeo.curvaGanancia.almacen.a, 40); // no muta
  assert.strictEqual(reescalarGanancias({}, 0, 10).curvaGanancia, undefined);
  // Por tipo: sólo la de Producción cambia si sólo cambian sus gastos.
  const soloProd = reescalarGanancias(costeo, { almacen: 5, fraccionado: 5, produccion: 5 }, { almacen: 5, fraccionado: 5, produccion: 12 });
  assert.strictEqual(soloProd.curvaGanancia.almacen, costeo.curvaGanancia.almacen);
  assert.ok(Math.abs(markupDesdeGanancia(gananciaPorCurva(soloProd.curvaGanancia.produccion, 900), 12) - markupDesdeGanancia(17.1, 5)) < 0.001);
});

// ── propuestaCurva (puntos desde SIGA) ───────────────────────────────────────

test('propuestaCurva almacén: ganancia implícita del vigente con costoTotal y gastos; costo = costoBase; muestra', () => {
  const pts = sinteticos(60, { outliers: 0 });
  const filas = pts.map((p, i) => {
    const costoTotal = p.costo * 1.03;
    const markup = markupDesdeGanancia(p.ganancia, 20);
    return { plu: String(i), costoBase: p.costo, costoTotal, precioVigente: costoTotal * (1 + markup / 100) * 1.21 }; // vigente = costo neto × (1 + markup) + IVA 21 %
  });
  const r = propuestaCurva('almacen', [...filas, { costoBase: 100, costoTotal: 100, precioVigente: null }], { gastosPct: 20 });
  assert.strictEqual(r.n, 60);
  assert.ok(Math.abs(r.b - 3) < 0.3, `b = ${r.b}`);
  assert.strictEqual(r.muestra.length, 60);
  assert.strictEqual(r.muestra[0].costo, Math.round(pts[0].costo * 100) / 100);
  assert.ok(Math.abs(r.muestra[0].ganancia - pts[0].ganancia) < 0.01, JSON.stringify(r.muestra[0]));
  assert.strictEqual(r.ajustesPeso, undefined);
});

test('propuestaCurva: la muestra se recorta a 1500 puntos de forma determinística', () => {
  const filas = sinteticos(4000, { outliers: 0 }).map(p => ({
    costoBase: p.costo, costoTotal: p.costo, precioVigente: p.costo * (1 + p.ganancia / 100) * 1.21, // + IVA 21 %
  }));
  const a = propuestaCurva('almacen', filas);
  assert.strictEqual(a.muestra.length, 1500);
  assert.deepStrictEqual(propuestaCurva('almacen', filas).muestra, a.muestra);
});

test('propuestaCurva fraccionado: costo = costoBase del granel, ganancia con costoKg, ajustes por peso con los tramos', () => {
  const pts = sinteticos(400, { outliers: 0 });
  const grupos = [
    { granelPlu: null, costoBase: null, presentaciones: [{ costoKg: 100, precioVigente: 500, pesoG: 100 }] },
    ...pts.map((p, i) => {
      const pesoG = i % 2 ? 100 : 1000;
      const ganancia = p.ganancia + (pesoG === 100 ? 10 : 0);
      const costoKg = p.costo + 50; // MO/insumos
      return { granelPlu: String(i), costoBase: p.costo, presentaciones: [
        { costoKg, precioVigente: costoKg * (1 + ganancia / 100) * 1.21, pesoG }, // + IVA 21 % (alícuota supuesta)
        { costoKg, precioVigente: null, pesoG },
      ] };
    }),
  ];
  const r = propuestaCurva('fraccionado', grupos, { gastosPct: 0, tramosG: [100, 1000] });
  assert.strictEqual(r.n, 400);
  assert.deepStrictEqual(r.ajustesPeso.tramosG, [100, 1000]);
  assert.ok(r.ajustesPeso.puntos[0] - r.ajustesPeso.puntos[1] > 8, JSON.stringify(r.ajustesPeso));
  assert.ok(Math.abs(r.b - 3) < 0.4, `b = ${r.b}`);
});

// ── Aplicación: Almacén y Fraccionado (curva sobre el costo neto, siempre activa) ─────────

const GASTOS_2609 = [
  { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
  { id: 'resto', concepto: 'Resto', pct: 11.09, listas: ['sucursal'] },
];
const CFG_ALM = {
  toleranciaPct: 10, margenPorProducto: {}, metodoGanancia: 'curva',
  curvaGanancia: { almacen: { ...CURVA, pisoPct: -10 } },
};

test('calcularFilaAlmacen: banda "curva", gananciaBanda de la curva con el costo NETO y markup convertido con gastos', () => {
  const g = g6(40 - 3 * Math.log(2000)); // costo neto, sin × (1 + IVA)
  const fila = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null, costeoConfig: { ...CFG_ALM, gastosVenta: GASTOS_2609 } });
  assert.strictEqual(fila.banda, 'curva');
  assert.strictEqual(fila.gananciaBanda, g);
  assert.strictEqual(fila.markupBanda, markupDesdeGanancia(g, 26.09));
  assert.strictEqual(fila.markupPct, fila.markupBanda);
  assert.strictEqual('costoBanda' in fila, false);
  const sinGastos = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null, costeoConfig: CFG_ALM });
  assert.strictEqual(sinGastos.markupPct, g);
  assert.strictEqual(sinGastos.precioNeto, Math.round(2000 * (1 + g / 100) * 100) / 100);
  // El IVA de venta (config) sólo cambia el IVA: la ganancia es la misma.
  const iva105 = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null, costeoConfig: { ...CFG_ALM, ivaVentaPct: 10.5 } });
  assert.strictEqual(iva105.gananciaBanda, g);
  assert.strictEqual(iva105.ivaPct, 10.5);
});

test('calcularFilaAlmacen: el override por producto gana sobre la curva; activa:false viejo no apaga la curva', () => {
  const ov = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_ALM, margenPorProducto: { 1: 40 } } });
  assert.strictEqual(ov.markupPct, 40);
  assert.strictEqual(ov.banda, 'override');
  assert.strictEqual(ov.gananciaBanda, g6(40 - 3 * Math.log(2000)));
  const viejaInactiva = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_ALM, curvaGanancia: { almacen: { ...CURVA, activa: false } } } });
  assert.strictEqual(viejaInactiva.banda, 'curva');
  assert.strictEqual(viejaInactiva.markupPct, g6(40 - 3 * Math.log(2000)));
});

test('precio final monótono creciente con el costo (curva migrada de las bandas de dev, costos 1 a 200.000)', () => {
  const curva = { a: 33.6173, b: 1.9559, pisoPct: 12.3, techoPct: 24.2 };
  const cfg = { ...CFG_ALM, gastosVenta: GASTOS_2609, curvaGanancia: { almacen: curva } };
  let anterior = -Infinity, n = 0;
  for (let c = 1; c <= 200000; c = c < 100 ? c + 1 : Math.round(c * 1.01)) {
    const f = calcularFilaAlmacen({ plu: '1', nombre: 'X', costoSistema: c, precioVigente: null, costeoConfig: cfg });
    assert.ok(f.precioConIvaExacto >= anterior, `costo ${c}: ${f.precioConIvaExacto} < ${anterior}`);
    anterior = f.precioConIvaExacto;
    n++;
  }
  assert.ok(n > 800);
});

function armarFrac(curva, extra = {}) {
  return armarGruposFraccionado({
    graneles: [{ plu: '4409', nombre: 'Sem. Lino Granel' }],
    presentaciones: [{ plu: '11', nombre: 'Sem. Lino 500G' }, { plu: '12', nombre: 'Sem. Lino 1Kg' }],
    formulas: { 11: { granel: 4409 }, 12: { granel: 4409 } },
    costos: new Map([['4409', { nombre: 'Sem. Lino Granel', costoMercaderia: 2500, costoSistema: 2297 }]]),
    vigentes: new Map(),
    costeoConfig: { toleranciaPct: 10, margenPorProducto: {}, metodoGanancia: 'curva', curvaGanancia: { fraccionado: curva }, ...extra },
  })[0];
}

test('armarGruposFraccionado: curva + ajuste por peso (costo neto del granel) da gananciaStd; markupStd convertido; temporales igual', () => {
  const curva = { a: 100, b: 5, pisoPct: 10, techoPct: 90, ajustesPeso: { tramosG: [500, 1000], puntos: [4, -2] } };
  const base = 100 - 5 * Math.log(2297); // costo base neto del granel
  const g = armarFrac(curva, { gastosVenta: GASTOS_2609, presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 250, gananciaPct: null }] } });
  const [p500, p1k] = g.presentaciones;
  assert.strictEqual(p500.gananciaStd, g6(base + 4));
  assert.strictEqual(p1k.gananciaStd, g6(base - 2));
  assert.strictEqual(p500.markupStd, markupDesdeGanancia(g6(base + 4), 26.09));
  assert.strictEqual(p500.markupPct, p500.markupStd);
  assert.strictEqual(g.temporales[0].gananciaStd, g6(base + 4));
  assert.strictEqual('costoBanda' in g, false);
  assert.strictEqual('banda' in g, false);
  // activa:false viejo no apaga la curva.
  assert.strictEqual(armarFrac({ ...curva, activa: false }).presentaciones[0].gananciaStd, g6(base + 4));
});

test('precio por kg Fraccionado monótono creciente con el costo del granel para cada peso (curva migrada de la matriz de dev)', () => {
  const curva = { a: 36.894, b: 1.0376, pisoPct: 23.747, techoPct: 30.7819,
    ajustesPeso: { tramosG: [20, 100, 200, 500, 1000, 5000, 10000], puntos: [5.1, 5.1, 0.7, -3.8, -6.9, -11.8, -14.2] } };
  for (const pesoG of [20, 150, 500, 1000, 10000]) {
    let anterior = -Infinity;
    for (let c = 1; c <= 200000; c = c < 100 ? c + 1 : Math.round(c * 1.02)) {
      const precio = c * (1 + markupDesdeGanancia(gananciaPorCurva(curva, c, pesoG), 26.09) / 100);
      assert.ok(precio >= anterior, `peso ${pesoG} costo ${c}`);
      anterior = precio;
    }
  }
});

// ── Endpoints ────────────────────────────────────────────────────────────────

function routerConArchivo(inicial) {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const estado = { archivo: inicial };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [], leerJSON: () => estado.archivo, guardarJSON: (p, d) => { if (!p.endsWith('.bak-antes-curva')) estado.archivo = d; },
    DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: resolve }, () => resolve('next')));
  };
  return { estado, llamar };
}

const ARCHIVO = { toleranciaPct: 10, margenPorProducto: {}, metodoGanancia: 'curva', curvaGanancia: {} };

test('GET config: curvaGanancia con los tres tipos (defaults) sin activa; lo guardado pisa el default', async () => {
  const { llamar } = routerConArchivo({ ...ARCHIVO });
  const c = await llamar('get', '/api/precios/config');
  assert.deepStrictEqual(c.curvaGanancia, CURVA_GANANCIA_DEFAULT);
  assert.deepStrictEqual(Object.keys(c.curvaGanancia), ['almacen', 'fraccionado', 'produccion']);
  assert.strictEqual('activa' in c.curvaGanancia.almacen, false);
  assert.strictEqual(c.curvaGanancia.fraccionado.ajustesPeso, null);
  assert.strictEqual('bandasMarkup' in c, false);
  assert.strictEqual('markupFraccionado' in c, false);
  const { llamar: l2 } = routerConArchivo({ ...ARCHIVO, curvaGanancia: { almacen: { ...CURVA, activa: true } } });
  const c2 = await l2('get', '/api/precios/config');
  assert.strictEqual(c2.curvaGanancia.almacen.a, 40);
  assert.strictEqual('activa' in c2.curvaGanancia.almacen, false);
});

test('PUT config/curva-ganancia/:tipo valida y guarda sólo ese tipo (produccion incluida); inválido no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO });
  const r = await llamar('put', '/api/precios/config/curva-ganancia/almacen', { ...CURVA, activa: false, ajustadaEl: '2026-09-30', n: 300 });
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.curvaGanancia.almacen, { ...CURVA, ajustadaEl: '2026-09-30', n: 300 });
  assert.deepStrictEqual(estado.archivo.curvaGanancia, { almacen: r.curvaGanancia.almacen });
  const p = await llamar('put', '/api/precios/config/curva-ganancia/produccion', { a: 20, b: 0, pisoPct: 20, techoPct: 20 });
  assert.strictEqual(p.error, undefined);
  assert.deepStrictEqual(estado.archivo.curvaGanancia.produccion, { a: 20, b: 0, pisoPct: 20, techoPct: 20, ajustadaEl: null, n: null });
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/curva-ganancia/almacen', { ...CURVA, pisoPct: 50 })).error, /mayor/);
  assert.match((await llamar('put', '/api/precios/config/curva-ganancia/otro', CURVA)).error, /tipo/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT config/gastos-venta: conservando precios reescala las curvas guardadas (también la de produccion)', async () => {
  const prod = { a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1 };
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO, curvaGanancia: { almacen: { ...CURVA }, produccion: prod } });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: GASTOS_2609 });
  assert.strictEqual(r.error, undefined);
  const nueva = estado.archivo.curvaGanancia.almacen;
  const antes = markupDesdeGanancia(gananciaPorCurva(CURVA, 2000), 0);
  assert.ok(Math.abs(markupDesdeGanancia(gananciaPorCurva(nueva, 2000), 26.09) - antes) < 0.001);
  assert.ok(Math.abs(markupDesdeGanancia(gananciaPorCurva(estado.archivo.curvaGanancia.produccion, 900), 26.09) - 17.1) < 0.001);
  assert.deepStrictEqual(r.curvaGanancia.almacen, { ...CURVA_GANANCIA_DEFAULT.almacen, ...nueva });
  assert.strictEqual('bandasMarkup' in r, false);
});

test('PUT config/bandas-markup y markup-fraccionado ya no existen', () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const router = crearRutasPrecios({ apiRoute: fn => fn, query: async () => [], leerJSON: () => ({ ...ARCHIVO }), guardarJSON: () => {}, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1 });
  for (const ruta of ['/api/precios/config/bandas-markup', '/api/precios/config/markup-fraccionado']) {
    assert.strictEqual(router.stack.some(l => l.route && l.route.methods.put && l.match(ruta)), false, ruta);
  }
});

test('POST curva-ganancia/ajustar/:tipo: sin datos → error y no guarda; produccion pasa al router de Producción', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO });
  assert.strictEqual(await llamar('post', '/api/precios/curva-ganancia/ajustar/produccion'), 'next');
  assert.match((await llamar('post', '/api/precios/curva-ganancia/ajustar/otro')).error, /tipo/);
  assert.match((await llamar('post', '/api/precios/curva-ganancia/ajustar/almacen')).error, /pocos datos/);
  assert.match((await llamar('post', '/api/precios/curva-ganancia/ajustar/fraccionado')).error, /pocos datos/);
  assert.deepStrictEqual(estado.archivo.curvaGanancia, {});
});

// ── Producción: propuesta desde SIGA ─────────────────────────────────────────

test('propuestaCurva produccion: filas por presentación (costo por unidad); pocos datos → throw', () => {
  const pts = sinteticos(40, { outliers: 0 });
  const filas = pts.map(p => ({ costoBase: p.costo, costoTotal: p.costo, precioVigente: p.costo * (1 + p.ganancia / 100) * 1.21, ivaPct: 21 }));
  const r = propuestaCurva('produccion', filas, { gastosPct: 0 });
  assert.strictEqual(r.n, 40);
  assert.ok(Math.abs(r.b - 3) < 0.4, `b = ${r.b}`);
  assert.strictEqual(r.ajustesPeso, undefined);
  assert.throws(() => propuestaCurva('produccion', filas.slice(0, 5)), /pocos datos/);
});
