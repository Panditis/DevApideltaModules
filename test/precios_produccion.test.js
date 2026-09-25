'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  recetaEfectiva, costearReceta, costearPresentacion, costearProducto, detectarCambios, resumenAlertas, snapshotDe,
  validarProducto, validarReceta, validarPresentacion, validarBorrarReceta, insumosDelProducto, escalarVariantes, formulaParaSiga,
} = require('../lib/precios_produccion');

// costoDe inyectado: Map plu → costo. Sin entrada = sin costo (null), nunca 0.
const costosDe = obj => clave => (Object.hasOwn(obj, clave) ? { costo: obj[clave], fuente: 'sistema', nombre: `N${clave}` } : null);
const COSTOS = { 300: 400, 7067: 2800, 812: 5200, 6334: 180, 6320: 45, 'm-etiqueta': 60 };
const costoDe = costosDe(COSTOS);
const COSTO_HORA = 6000; // 100 $/min
const CATEGORIAS = [{ id: 'maq', nombre: 'Líneas Producción', costoHora: 3000 }]; // 50 $/min

const BASE = {
  nombre: 'Granola clásica', rendimientoKg: 10,
  materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1.5, unidad: 'kg' }],
  minutosElaboracion: 60, categoriaMaquinaId: 'maq',
};
const PASAS = { nombre: 'Granola con pasas', varianteDe: 'base', extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }] };
const RECETAS = { base: BASE, pasas: PASAS };
const costear = (receta, extra = {}) => costearReceta({ receta, recetasDelProducto: RECETAS, costoDe, costoHora: COSTO_HORA, categoriasMaquina: CATEGORIAS, ...extra });

// ── recetaEfectiva / costearReceta ───────────────────────────────────────────

test('costearReceta: batch simple — MP + mano de obra + máquina, costo/kg = batch / rendimiento', () => {
  const r = costear(BASE);
  // 5×400 + 1.5×2800 + 60min×100 + 60min×50 = 2000 + 4200 + 6000 + 3000
  assert.strictEqual(r.costoBatch, 15200);
  assert.strictEqual(r.costoKg, 1520);
  assert.deepStrictEqual(r.faltantes, []);
  assert.deepStrictEqual(r.avisos, []);
  assert.deepStrictEqual(r.componentes.map(c => [c.plu, c.importe]),
    [['300', 2000], ['7067', 4200], ['_costoHora', 6000], ['_maquina', 3000]]);
  assert.deepStrictEqual(r.componentes[0], { plu: '300', nombre: 'N300', cantidad: 5, costoUnit: 400, importe: 2000, fuente: 'sistema' });
  assert.deepStrictEqual(r.costos, { 300: 400, 7067: 2800, _costoHora: 6000, _maquina: 3000 });
});

test('costearReceta: merma — costoKg = batch / (rendimiento × (1 − merma/100))', () => {
  assert.strictEqual(costear({ ...BASE, mermaPct: 5 }).costoKg, 1600); // 15200 / 9.5
});

test('costearReceta: materia prima sin costo → faltantes, sin costoBatch ni costoKg (nunca 0 implícito)', () => {
  for (const sinCosto of [costosDe({ 7067: 2800 }), costosDe({ 300: null, 7067: 2800 }), costosDe({ 300: 0, 7067: 2800 })]) {
    const r = costear(BASE, { costoDe: sinCosto });
    assert.deepStrictEqual(r.faltantes, ['300']);
    assert.strictEqual(r.costoBatch, null);
    assert.strictEqual(r.costoKg, null);
    assert.strictEqual(r.componentes[0].importe, null);
    assert.strictEqual(r.costos['300'], null);
  }
});

test('costearReceta: rendimiento ≤ 0 o faltante → faltante rendimientoKg, sin costoKg', () => {
  for (const rendimientoKg of [0, -1, undefined]) {
    const r = costear({ ...BASE, rendimientoKg });
    assert.ok(r.faltantes.includes('rendimientoKg'));
    assert.strictEqual(r.costoKg, null);
  }
});

test('costearReceta: sin costo/hora con minutos > 0 → faltante _costoHora', () => {
  const r = costear(BASE, { costoHora: null });
  assert.deepStrictEqual(r.faltantes, ['_costoHora']);
  assert.strictEqual(r.costoKg, null);
});

test('costearReceta: máquina sin categoría (o inexistente) = 0 con aviso, no faltante', () => {
  for (const receta of [{ ...BASE, categoriaMaquinaId: null }, { ...BASE, categoriaMaquinaId: 'no-existe' }]) {
    const r = costear(receta);
    assert.deepStrictEqual(r.faltantes, []);
    assert.strictEqual(r.avisos.length, 1);
    assert.match(r.avisos[0], /máquina/);
    assert.strictEqual(r.costoBatch, 12200);
    assert.ok(!Object.hasOwn(r.costos, '_maquina'));
  }
});

test('recetaEfectiva: variante = MP de la base + extras, rendimiento = base + kg de extras, hereda minutos/máquina/merma', () => {
  const ef = recetaEfectiva(PASAS, RECETAS);
  assert.deepStrictEqual(ef.materiasPrimas.map(m => m.plu), ['300', '7067', '812']);
  assert.strictEqual(ef.rendimientoKg, 11); // 10 de la base + 1 kg de pasas
  assert.strictEqual(ef.minutosElaboracion, 60);
  assert.strictEqual(ef.categoriaMaquinaId, 'maq');
  assert.strictEqual(ef.nombre, 'Granola con pasas');
  assert.strictEqual(ef.validado, undefined); // el snapshot de la base no se hereda
  assert.deepStrictEqual(RECETAS.base.materiasPrimas.length, 2); // no muta la base
});

test('costearReceta: variante suma extras sobre el batch de la base', () => {
  const r = costear(PASAS);
  assert.strictEqual(r.costoBatch, 20400); // 15200 + 5200
  assert.strictEqual(r.costoKg, 1854.55); // 20400 / 11 kg (base 10 + extra 1)
  assert.strictEqual(r.varianteDe, 'base');
});

test('costearReceta: variante pisa rendimiento y minutos', () => {
  assert.strictEqual(costear({ ...PASAS, rendimientoKg: 12 }).costoKg, 1700); // 20400 / 12
  // 30 min: MO 3000 + máquina 1500 → 2000 + 4200 + 5200 + 4500 = 15900
  assert.strictEqual(costear({ ...PASAS, minutosElaboracion: 30 }).costoBatch, 15900);
});

test('recetaEfectiva: variante de variante o base inexistente → error', () => {
  const recetas = { ...RECETAS, doble: { nombre: 'x', varianteDe: 'pasas', extras: [] } };
  assert.throws(() => recetaEfectiva(recetas.doble, recetas), /variante/);
  assert.throws(() => recetaEfectiva({ nombre: 'x', varianteDe: 'nada', extras: [] }, RECETAS), /no existe/);
});

// ── costearPresentacion ──────────────────────────────────────────────────────

const PRES = {
  recetaId: 'base', kgPorUnidad: 0.5,
  insumos: [{ plu: '6334', cantidad: 1 }, { manualId: 'm-etiqueta', cantidad: 1 }],
  minutosEmpaquetado: 0.6,
};
const BANDAS = [{ costoHastaARS: null, markupMaxPct: 50 }];
const presentar = (extra = {}) => costearPresentacion({ plu: '6319', nombre: 'Granola 500g', presentacion: PRES, recetaCosteada: costear(BASE), costoDe, costoHora: COSTO_HORA, bandas: BANDAS, ...extra });

test('costearPresentacion: kg de receta + insumos + MO empaquetado + markup banda + IVA', () => {
  const p = presentar();
  // 0.5×1520 + 180 + 60 + 0.6min×100 = 760 + 180 + 60 + 60
  assert.strictEqual(p.costoUnidad, 1060);
  assert.deepStrictEqual(p.componentes.map(c => [c.plu, c.importe]), [['_receta', 760], ['6334', 180], ['m-etiqueta', 60], ['_costoHora', 60]]);
  assert.strictEqual(p.markupPct, 50);
  assert.strictEqual(p.banda, 'sin tope');
  assert.strictEqual(p.precioNeto, 1590);
  assert.strictEqual(p.precioConIvaExacto, 1923.9);
  assert.strictEqual(p.precioConIva, 1900);
  assert.deepStrictEqual(p.faltantes, []);
  assert.deepStrictEqual(p.costos, { 300: 400, 7067: 2800, _maquina: 3000, 6334: 180, 'm-etiqueta': 60, _costoHora: 6000 }); // incluye la receta
  assert.strictEqual(p.plu, '6319');
  assert.strictEqual(p.nombre, 'Granola 500g');
});

test('costearPresentacion: override de margen gana sobre la banda', () => {
  const p = presentar({ overridePct: 40 });
  assert.strictEqual(p.banda, 'override');
  assert.strictEqual(p.precioNeto, 1484);
  assert.strictEqual(p.precioConIva, 1800); // 1795.64
});

test('costearPresentacion: hereda faltantes de la receta y queda sin precio', () => {
  const recetaCosteada = costear(BASE, { costoDe: costosDe({ ...COSTOS, 300: null }) });
  const p = presentar({ recetaCosteada });
  assert.deepStrictEqual(p.faltantes, ['300']);
  assert.strictEqual(p.costoUnidad, null);
  assert.strictEqual(p.precioNeto, null);
  assert.strictEqual(p.precioConIva, null);
});

test('costearPresentacion: insumo sin costo, sin receta o sin banda → faltantes, sin precio', () => {
  assert.deepStrictEqual(presentar({ costoDe: costosDe({ ...COSTOS, 6334: null }) }).faltantes, ['6334']);
  assert.deepStrictEqual(presentar({ recetaCosteada: undefined }).faltantes, ['receta']);
  const sinBanda = presentar({ bandas: [] });
  assert.deepStrictEqual(sinBanda.faltantes, ['markupPct']);
  assert.strictEqual(sinBanda.costoUnidad, 1060);
  assert.strictEqual(sinBanda.precioConIva, null);
});

// ── detectarCambios ──────────────────────────────────────────────────────────

const VALIDADO = { fecha: '2026-09-25', costoKg: 1520, costos: { 300: 400, 7067: 2800, _costoHora: 6000 } };
const detect = (costosActuales, extra = {}) => detectarCambios({ validado: VALIDADO, costosActuales, toleranciaPct: 3, ...extra });

test('detectarCambios: sin snapshot → sin-validar', () => {
  assert.strictEqual(detectarCambios({ validado: undefined, costosActuales: { 300: 1 }, toleranciaPct: 3 }).estado, 'sin-validar');
  assert.strictEqual(detectarCambios({ validado: { fecha: 'x' }, costosActuales: {}, toleranciaPct: 3 }).estado, 'sin-validar');
});

test('detectarCambios: costos iguales → ok, sin componentes', () => {
  const d = detect({ ...VALIDADO.costos }, { costoActual: 1520 });
  assert.deepStrictEqual(d, { estado: 'ok', deltaPct: 0, componentes: [], nuevos: [], quitados: [] });
});

test('detectarCambios: sube o baja más que la tolerancia → cambio con antes/ahora', () => {
  const sube = detect({ ...VALIDADO.costos, 300: 440 }, { costoActual: 1560 });
  assert.strictEqual(sube.estado, 'cambio');
  assert.deepStrictEqual(sube.componentes, [{ plu: '300', antes: 400, ahora: 440, deltaPct: 10 }]);
  assert.strictEqual(sube.deltaPct, 2.6); // del costo total validado (1520 → 1560)
  const baja = detect({ ...VALIDADO.costos, 7067: 2500 });
  assert.strictEqual(baja.estado, 'cambio');
  assert.strictEqual(baja.componentes[0].deltaPct, -10.7);
});

test('detectarCambios: dentro de la tolerancia (incluido el borde) → ok', () => {
  assert.strictEqual(detect({ ...VALIDADO.costos, 300: 412 }).estado, 'ok'); // +3% exacto
  assert.strictEqual(detect({ ...VALIDADO.costos, 300: 390 }).estado, 'ok'); // −2.5%
});

test('detectarCambios: componente nuevo o quitado → cambio', () => {
  const nuevo = detect({ ...VALIDADO.costos, 812: 5200 });
  assert.strictEqual(nuevo.estado, 'cambio');
  assert.deepStrictEqual(nuevo.nuevos, ['812']);
  const { 7067: _, ...sin7067 } = VALIDADO.costos;
  const quitado = detect(sin7067);
  assert.strictEqual(quitado.estado, 'cambio');
  assert.deepStrictEqual(quitado.quitados, ['7067']);
});

test('detectarCambios: cambio de _costoHora global → cambio; costo que pasa a faltar → cambio', () => {
  const d = detect({ ...VALIDADO.costos, _costoHora: 7000 });
  assert.strictEqual(d.estado, 'cambio');
  assert.strictEqual(d.componentes[0].plu, '_costoHora');
  const falta = detect({ ...VALIDADO.costos, 300: null });
  assert.strictEqual(falta.estado, 'cambio');
  assert.deepStrictEqual(falta.componentes, [{ plu: '300', antes: 400, ahora: null, deltaPct: null }]);
});

// ── snapshotDe / costearProducto / resumenAlertas ────────────────────────────

const CFG = { costoHora: COSTO_HORA, categoriasMaquina: CATEGORIAS, bandas: BANDAS, toleranciaPct: 3 };

// Producto con todo validado contra los costos de `costos` (fecha fija).
function productoValidado(nombre, presentaciones, costos = COSTOS) {
  const sinValidar = { nombre, recetas: RECETAS, insumos: [{ plu: '6334' }, { manualId: 'm-etiqueta' }, { plu: '6320' }], presentaciones };
  const c = costearProducto({ producto: sinValidar, costoDe: costosDe(costos), ...CFG });
  const recetas = Object.fromEntries(Object.entries(RECETAS).map(([id, r]) => [id, { ...r, validado: snapshotDe(c.recetas[id], '2026-09-25') }]));
  const pres = Object.fromEntries(Object.entries(presentaciones).map(([plu, p]) => [plu, { ...p, validado: snapshotDe(c.presentaciones[plu], '2026-09-25') }]));
  return { ...sinValidar, recetas, presentaciones: pres };
}

test('snapshotDe: guarda fecha, costo total y copia de los costos de componentes (variante incluye los de la base)', () => {
  const s = snapshotDe(costear(PASAS), '2026-09-25');
  assert.deepStrictEqual(s, { fecha: '2026-09-25', costoKg: 1854.55, costos: { 300: 400, 7067: 2800, 812: 5200, _costoHora: 6000, _maquina: 3000 } });
  assert.deepStrictEqual(snapshotDe(presentar(), 'f'), { fecha: 'f', costoUnidad: 1060, costos: { 300: 400, 7067: 2800, _maquina: 3000, 6334: 180, 'm-etiqueta': 60, _costoHora: 6000 } });
});

test('costearProducto: recién validado → todo ok; sin validar → sin-validar (no cuenta como alerta)', () => {
  const prod = productoValidado('Granola', { 6319: { ...PRES, nombre: 'Granola 500g' } });
  const ok = costearProducto({ producto: prod, costoDe, ...CFG });
  assert.strictEqual(ok.nombre, 'Granola');
  assert.strictEqual(ok.recetas.base.estado, 'ok');
  assert.strictEqual(ok.recetas.pasas.estado, 'ok');
  assert.strictEqual(ok.presentaciones['6319'].estado, 'ok');
  assert.strictEqual(ok.presentaciones['6319'].costoUnidad, 1060);
  assert.deepStrictEqual(ok.resumen, { alertas: 0, faltantes: 0 });
  // Insumos = la lista del producto (decisión 11), con costo y en qué presentaciones se usa.
  assert.deepStrictEqual(ok.insumos.map(i => [i.clave, i.costo, i.usadoEn]), [['6334', 180, ['6319']], ['m-etiqueta', 60, ['6319']], ['6320', 45, []]]);
  assert.deepStrictEqual(ok.insumos[1].manualId, 'm-etiqueta');
  const sinValidar = costearProducto({ producto: { nombre: 'X', recetas: RECETAS }, costoDe, ...CFG });
  assert.strictEqual(sinValidar.recetas.base.estado, 'sin-validar');
  assert.strictEqual(sinValidar.resumen.alertas, 0);
});

test('costearProducto: aumento de un ingrediente de la base avisa también en la variante', () => {
  const prod = productoValidado('Granola', {});
  const c = costearProducto({ producto: prod, costoDe: costosDe({ ...COSTOS, 300: 500 }), ...CFG });
  assert.strictEqual(c.recetas.base.estado, 'cambio');
  assert.strictEqual(c.recetas.pasas.estado, 'cambio');
  assert.strictEqual(c.resumen.alertas, 2);
});

test('costearProducto + resumenAlertas: insumo compartido que sube avisa en dos productos; sólo cuenta "cambio"', () => {
  const granola = productoValidado('Granola', { 6319: { ...PRES, nombre: 'Granola 500g' } });
  const pepas = productoValidado('Pepas', { 7001: { ...PRES, recetaId: 'pasas', nombre: 'Pepas 500g' } });
  const nuevo = { nombre: 'Yerba', recetas: RECETAS }; // sin validar: no suma al toast
  const costoDeNuevo = costosDe({ ...COSTOS, 6334: 250 });
  const costeados = Object.fromEntries(Object.entries({ 'p-granola': granola, 'p-pepas': pepas, 'p-yerba': nuevo })
    .map(([id, producto]) => [id, costearProducto({ producto, costoDe: costoDeNuevo, ...CFG })]));
  assert.strictEqual(costeados['p-granola'].recetas.base.estado, 'ok'); // el envase no está en la receta
  const r = resumenAlertas(costeados);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.items.map(i => [i.productoId, i.producto, i.tipo, i.id, i.nombre]).sort(),
    [['p-granola', 'Granola', 'presentacion', '6319', 'Granola 500g'], ['p-pepas', 'Pepas', 'presentacion', '7001', 'Pepas 500g']]);
  assert.ok(r.items.every(i => typeof i.deltaPct === 'number' && i.deltaPct > 0));
});

test('resumenAlertas: vacío → total 0', () => {
  assert.deepStrictEqual(resumenAlertas({}), { total: 0, items: [] });
});

// ── Validadores ──────────────────────────────────────────────────────────────

test('validarProducto: nombre recortado 1–60; rechaza vacío o no texto', () => {
  assert.deepStrictEqual(validarProducto({ nombre: '  Granola ', otro: 1 }), { nombre: 'Granola' });
  for (const body of [null, {}, { nombre: '  ' }, { nombre: 5 }, { nombre: 'x'.repeat(61) }]) {
    assert.throws(() => validarProducto(body), /nombre/);
  }
});

// Las presentaciones eligen una VARIEDAD (decisión 14), no la base.
const PRESV = { ...PRES, recetaId: 'pasas' };
const PRODUCTO = { nombre: 'Granola', recetas: RECETAS, insumos: [{ plu: '6334' }, { manualId: 'm-etiqueta' }], presentaciones: { 6319: PRES } };

test('validarReceta: base y variante válidas devuelven sólo claves conocidas', () => {
  assert.deepStrictEqual(validarReceta({ ...BASE, hack: 1, mermaPct: 3 }, PRODUCTO, 'base'), {
    nombre: 'Granola clásica', rendimientoKg: 10, mermaPct: 3, minutosElaboracion: 60, categoriaMaquinaId: 'maq',
    materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1.5, unidad: 'kg' }],
  });
  assert.deepStrictEqual(validarReceta({ ...PASAS, rendimientoKg: 12 }, PRODUCTO, 'pasas'), {
    nombre: 'Granola con pasas', varianteDe: 'base', extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }], rendimientoKg: 12,
  });
});

test('validarReceta: rechaza rendimiento ≤ 0, cantidades ≤ 0, PLU no numérico, merma fuera de rango', () => {
  assert.throws(() => validarReceta({ ...BASE, rendimientoKg: 0 }, PRODUCTO, 'base'), /rendimientoKg/);
  assert.throws(() => validarReceta({ ...BASE, rendimientoKg: -2 }, PRODUCTO, 'base'), /rendimientoKg/);
  assert.throws(() => validarReceta({ ...PASAS, rendimientoKg: 0 }, PRODUCTO, 'pasas'), /rendimientoKg/);
  assert.throws(() => validarReceta({ ...BASE, materiasPrimas: [{ plu: '300', cantidad: 0 }] }, PRODUCTO, 'base'), /cantidad/);
  assert.throws(() => validarReceta({ ...BASE, materiasPrimas: [{ plu: 'abc', cantidad: 1 }] }, PRODUCTO, 'base'), /plu/);
  assert.throws(() => validarReceta({ ...BASE, materiasPrimas: [] }, PRODUCTO, 'base'), /materiasPrimas/);
  assert.throws(() => validarReceta({ ...PASAS, extras: [{ plu: '812', cantidad: -1 }] }, PRODUCTO, 'pasas'), /cantidad/);
  assert.throws(() => validarReceta({ ...BASE, mermaPct: 100 }, PRODUCTO, 'base'), /mermaPct/);
  assert.throws(() => validarReceta({ ...BASE, minutosElaboracion: -1 }, PRODUCTO, 'base'), /minutosElaboracion/);
});

test('validarReceta: variante de variante, varianteDe inexistente o a sí misma, base con variantes que pasa a variante → rechazo', () => {
  assert.throws(() => validarReceta({ nombre: 'x', varianteDe: 'pasas', extras: [] }, PRODUCTO, 'doble'), /variante/);
  assert.throws(() => validarReceta({ nombre: 'x', varianteDe: 'nada', extras: [] }, PRODUCTO, 'nueva'), /no existe/);
  assert.throws(() => validarReceta({ nombre: 'x', varianteDe: 'base', extras: [] }, PRODUCTO, 'base'), /varianteDe/);
  const conOtraBase = { ...PRODUCTO, recetas: { ...RECETAS, otra: BASE } };
  assert.throws(() => validarReceta({ nombre: 'x', varianteDe: 'otra', extras: [] }, conOtraBase, 'base'), /variantes/);
});

test('validarBorrarReceta: base con variantes o receta usada por una presentación no se borra', () => {
  assert.throws(() => validarBorrarReceta(PRODUCTO, 'base'), /variantes/);
  assert.throws(() => validarBorrarReceta({ ...PRODUCTO, presentaciones: { 6319: { ...PRES, recetaId: 'pasas' } } }, 'pasas'), /6319/);
  assert.doesNotThrow(() => validarBorrarReceta(PRODUCTO, 'pasas'));
});

test('validarPresentacion: válida devuelve sólo claves conocidas', () => {
  assert.deepStrictEqual(validarPresentacion({ ...PRESV, hack: 1 }, PRODUCTO, { 'p-granola': PRODUCTO }, { plu: '6319', productoId: 'p-granola' }), {
    recetaId: 'pasas', kgPorUnidad: 0.5, minutosEmpaquetado: 0.6,
    insumos: [{ plu: '6334', cantidad: 1 }, { manualId: 'm-etiqueta', cantidad: 1 }],
  });
});

test('validarPresentacion: cada insumo tiene que estar en la lista del producto; sin repetidos', () => {
  const ok = { plu: '6319', productoId: 'p-granola' };
  assert.throws(() => validarPresentacion({ ...PRESV, insumos: [{ plu: '9999', cantidad: 1 }] }, PRODUCTO, {}, ok), /9999.*insumos del producto/);
  assert.throws(() => validarPresentacion({ ...PRESV, insumos: [{ plu: '6334', cantidad: 1 }, { plu: '6334', cantidad: 2 }] }, PRODUCTO, {}, ok), /repetido/);
});

test('insumosDelProducto: la lista guardada; sin lista (datos viejos) se deriva de las presentaciones', () => {
  assert.deepStrictEqual(insumosDelProducto(PRODUCTO), [{ plu: '6334' }, { manualId: 'm-etiqueta' }]);
  const viejo = { nombre: 'X', recetas: RECETAS, presentaciones: { 6319: PRES, 7002: { ...PRES, insumos: [{ plu: 6334, cantidad: 2 }] } } };
  assert.deepStrictEqual(insumosDelProducto(viejo), [{ plu: '6334' }, { manualId: 'm-etiqueta' }]);
  assert.doesNotThrow(() => validarPresentacion(PRESV, viejo, {}, { plu: '6319', productoId: 'p' }));
});

test('validarPresentacion: PLU de otro producto, receta inexistente, kg ≤ 0, PLU no numérico → rechazo', () => {
  const todos = { 'p-granola': PRODUCTO, 'p-pepas': { nombre: 'Pepas', presentaciones: { 7001: PRES } } };
  const ok = { plu: '6319', productoId: 'p-granola' };
  assert.throws(() => validarPresentacion(PRESV, PRODUCTO, todos, { plu: '7001', productoId: 'p-granola' }), /Pepas/);
  assert.throws(() => validarPresentacion({ ...PRESV, recetaId: 'nada' }, PRODUCTO, todos, ok), /recetaId/);
  assert.throws(() => validarPresentacion({ ...PRESV, kgPorUnidad: 0 }, PRODUCTO, todos, ok), /kgPorUnidad/);
  assert.throws(() => validarPresentacion({ ...PRESV, insumos: [{ plu: '6334', cantidad: 0 }] }, PRODUCTO, todos, ok), /cantidad/);
  assert.throws(() => validarPresentacion(PRESV, PRODUCTO, todos, { plu: 'abc', productoId: 'p-granola' }), /plu/);
});

// ── Propagación receta → presentaciones (el snapshot de la presentación incluye su receta) ──

const PRES_BASE_Y_PASAS = { 6319: { ...PRES, nombre: 'Granola 500g' }, 7002: { ...PRES, recetaId: 'pasas', nombre: 'Granola pasas 500g' } };
const estados = c => ({
  base: c.recetas.base.estado, pasas: c.recetas.pasas.estado,
  6319: c.presentaciones['6319'].estado, 7002: c.presentaciones['7002'].estado,
});

test('propagación: sube una MP de la base → base, variante y todas sus presentaciones en cambio, con el componente visible', () => {
  const prod = productoValidado('Granola', PRES_BASE_Y_PASAS);
  const c = costearProducto({ producto: prod, costoDe: costosDe({ ...COSTOS, 300: 500 }), ...CFG });
  assert.deepStrictEqual(estados(c), { base: 'cambio', pasas: 'cambio', 6319: 'cambio', 7002: 'cambio' });
  for (const plu of ['6319', '7002']) {
    assert.deepStrictEqual(c.presentaciones[plu].cambios.componentes, [{ plu: '300', antes: 400, ahora: 500, deltaPct: 25 }]);
  }
  assert.strictEqual(resumenAlertas({ 'p-granola': c }).total, 4); // receta y presentaciones cuentan por separado
});

test('propagación: sube un extra de la variante → variante y sus presentaciones en cambio; base y las suyas ok', () => {
  const prod = productoValidado('Granola', PRES_BASE_Y_PASAS);
  const c = costearProducto({ producto: prod, costoDe: costosDe({ ...COSTOS, 812: 6000 }), ...CFG });
  assert.deepStrictEqual(estados(c), { base: 'ok', pasas: 'cambio', 6319: 'ok', 7002: 'cambio' });
});

test('propagación: sube sólo un insumo de empaque → sólo esa presentación en cambio, recetas ok', () => {
  const prod = productoValidado('Granola', { ...PRES_BASE_Y_PASAS, 7002: { ...PRES_BASE_Y_PASAS[7002], insumos: [{ plu: '6320', cantidad: 1 }] } });
  const c = costearProducto({ producto: prod, costoDe: costosDe({ ...COSTOS, 6334: 250 }), ...CFG });
  assert.deepStrictEqual(estados(c), { base: 'ok', pasas: 'ok', 6319: 'cambio', 7002: 'ok' });
});

// ── Rendimiento de variante = base + kg de extras; corrección por presentación ──

test('recetaEfectiva: extras en "u" no suman al rendimiento; rendimiento explícito de la variante gana', () => {
  const conU = { ...PASAS, extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }, { plu: '900', cantidad: 20, unidad: 'u' }] };
  assert.strictEqual(recetaEfectiva(conU, RECETAS).rendimientoKg, 11);
  assert.strictEqual(recetaEfectiva({ ...PASAS, rendimientoKg: 12 }, RECETAS).rendimientoKg, 12);
  // costearReceta expone el rendimiento efectivo (la UI de Variedad lo muestra, no lo calcula).
  assert.strictEqual(costear(PASAS).rendimientoKg, 11);
});

test('costearPresentacion: correccionPct multiplica el costo de receta, línea visible, fuera del snapshot', () => {
  const p = presentar({ presentacion: { ...PRES, correccionPct: 5 } });
  // receta 760 + corrección 5% 38 + 180 + 60 + 60
  assert.strictEqual(p.costoUnidad, 1098);
  assert.deepStrictEqual(p.componentes[1], { plu: '_correccion', nombre: 'Corrección 5%', cantidad: 5, costoUnit: null, importe: 38, fuente: 'config' });
  assert.ok(!Object.hasOwn(p.costos, '_correccion'));
  assert.deepStrictEqual(p.costos, presentar().costos); // cambiarla no dispara alerta
  assert.ok(!presentar().componentes.some(c => c.plu === '_correccion')); // sin corrección no hay línea
});

test('validarPresentacion: correccionPct opcional, número en (-50, 100)', () => {
  const opts = { plu: '6319', productoId: 'p-granola' };
  assert.strictEqual(validarPresentacion({ ...PRESV, correccionPct: 5 }, PRODUCTO, {}, opts).correccionPct, 5);
  assert.ok(!Object.hasOwn(validarPresentacion(PRESV, PRODUCTO, {}, opts), 'correccionPct'));
  for (const correccionPct of [-50, 100, '5', NaN]) {
    assert.throws(() => validarPresentacion({ ...PRESV, correccionPct }, PRODUCTO, {}, opts), /correccionPct/);
  }
});

test('regresión Excel (hoja Pepas): masa 104 kg + membrillo → variante y presentación 6051', () => {
  const costo = costosDe({ 1: 232768.2134, 6009: 1726, 91508: 45, 6316: 112 });
  const recetas = {
    masa: { nombre: 'Masa pepas', rendimientoKg: 104, materiasPrimas: [{ plu: '1', cantidad: 1, unidad: 'kg' }], minutosElaboracion: 1364.7787 * 104 / (8268 / 60) },
    membrillo: { nombre: 'Pepas membrillo', varianteDe: 'masa', extras: [{ plu: '6009', cantidad: 47.3376, unidad: 'kg' }] },
  };
  const cfg = { recetasDelProducto: recetas, costoDe: costo, costoHora: 8268, categoriasMaquina: [] };
  const masa = costearReceta({ receta: recetas.masa, ...cfg });
  assert.ok(Math.abs(masa.costoKg - (2238.16 + 1364.78)) < 0.5); // Excel: $2.238/kg + MO $1.365/kg
  const memb = costearReceta({ receta: recetas.membrillo, ...cfg });
  assert.ok(Math.abs(recetaEfectiva(recetas.membrillo, recetas).rendimientoKg - 151.3376) < 1e-9);
  assert.ok(Math.abs(memb.costoKg - 3015.83) < 0.5); // 456409.89 / 151.3376
  const p = costearPresentacion({
    plu: '6051', recetaCosteada: memb, costoDe: costo, costoHora: 8268, bandas: [], overridePct: 155,
    presentacion: { recetaId: 'membrillo', kgPorUnidad: 0.27, correccionPct: 5, insumos: [{ plu: '91508', cantidad: 1 }, { plu: '6316', cantidad: 1 }] },
  });
  // A mano: 3015.84 × 0.27 = 814.28 · +5% = 40.71 · +45 +112 → 1011.99
  //         × 2.55 = 2580.57 neto · × 1.21 = 3122.49 → múltiplo de $50 = 3100
  assert.strictEqual(p.costoUnidad, 1011.99);
  assert.strictEqual(p.precioNeto, 2580.57);
  assert.strictEqual(p.precioConIva, 3100);
});

// ── Escalar variedades cuando cambia el kg por tanda de la base (decisión 12) ──

test('escalarVariantes: extras y rendimiento explícito de las variedades de esa base × factor (4 decimales), validado intacto', () => {
  const val = { fecha: 'f', costoKg: 1, costos: { 812: 5200 } };
  const recetas = {
    base: { ...BASE },
    pasas: { ...PASAS, extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }, { plu: '900', cantidad: 3, unidad: 'u' }], validado: val },
    propia: { nombre: 'Propia', varianteDe: 'base', extras: [{ plu: '812', cantidad: 0.3333 }], rendimientoKg: 11 },
    otra: { nombre: 'Otra base', rendimientoKg: 5, materiasPrimas: [{ plu: '300', cantidad: 1 }] },
    deOtra: { nombre: 'De otra', varianteDe: 'otra', extras: [{ plu: '812', cantidad: 2 }] },
  };
  const r = escalarVariantes(recetas, 'base', 1.25);
  assert.deepStrictEqual(r.pasas.extras, [{ plu: '812', cantidad: 1.25, unidad: 'kg' }, { plu: '900', cantidad: 3.75, unidad: 'u' }]);
  assert.strictEqual(r.pasas.validado, val);
  assert.strictEqual(r.propia.extras[0].cantidad, 0.4166); // 0.3333 × 1.25 = 0.416625 → 4 decimales
  assert.strictEqual(r.propia.rendimientoKg, 13.75);
  assert.strictEqual(r.deOtra, recetas.deOtra); // otra base: sin tocar
  assert.strictEqual(r.base, recetas.base);
  assert.strictEqual(recetas.pasas.extras[0].cantidad, 1); // sin mutar
  assert.strictEqual(escalarVariantes(recetas, 'base', 1), recetas);
});

// ── Decisiones 13-14: presentación sin PLU SIGA, sólo variedades, fórmula para SIGA, fila base ──

test('validarPresentacion: recetaId tiene que ser una variedad; la base se rechaza con mensaje claro', () => {
  assert.throws(() => validarPresentacion({ ...PRES, recetaId: 'base' }, PRODUCTO, {}, { plu: '6319', productoId: 'p' }), /elegí una variedad/i);
});

test('validarPresentacion: clave provisoria n-… (sin PLU en SIGA) exige nombre', () => {
  const opts = { plu: 'n-granola-800', productoId: 'p' };
  assert.strictEqual(validarPresentacion({ ...PRESV, nombre: 'Granola 800 g' }, PRODUCTO, {}, opts).nombre, 'Granola 800 g');
  assert.throws(() => validarPresentacion(PRESV, PRODUCTO, {}, opts), /nombre/);
  assert.throws(() => validarPresentacion(PRESV, PRODUCTO, {}, { plu: 'x-1', productoId: 'p' }), /plu/);
});

test('validarReceta: variedad sin extras es válida (producto de un solo sabor)', () => {
  assert.deepStrictEqual(validarReceta({ nombre: 'Clásica', varianteDe: 'base', extras: [] }, PRODUCTO, 'clasica'),
    { nombre: 'Clásica', varianteDe: 'base', extras: [] });
});

test('costearReceta: la variedad informa costoBaseIngredientes (suma de los ingredientes de la base)', () => {
  const v = costear(PASAS);
  assert.strictEqual(v.costoBaseIngredientes, 5 * 400 + 1.5 * 2800); // 6200
  assert.strictEqual(costear(BASE).costoBaseIngredientes, undefined);
  const sinCosto = costearReceta({ receta: PASAS, recetasDelProducto: RECETAS, costoDe: costosDe({ ...COSTOS, 300: null }), costoHora: COSTO_HORA, categoriasMaquina: CATEGORIAS });
  assert.strictEqual(sinCosto.costoBaseIngredientes, null);
});

test('costearProducto: presentación sobre la base (dato viejo) se costea igual, con aviso "variedad"', () => {
  const c = costearProducto({ producto: { nombre: 'G', recetas: RECETAS, insumos: [{ plu: '6334' }, { manualId: 'm-etiqueta' }], presentaciones: { 1: PRES, 2: PRESV } }, costoDe, ...CFG });
  assert.ok(c.presentaciones['1'].costoUnidad > 0);
  assert.deepStrictEqual(c.presentaciones['1'].avisos, ['variedad']);
  assert.deepStrictEqual(c.presentaciones['2'].avisos, []);
});

test('formulaParaSiga: por unidad vendida = cantidad / rendimiento efectivo × kg por unidad, + insumos', () => {
  // pasas: base 5 kg harina + 1,5 kg azúcar + 1 kg pasas, rendimiento 10 + 1 = 11 kg; unidad de 0,5 kg.
  const f = formulaParaSiga({ recetas: RECETAS, presentaciones: { 6319: PRESV } }, '6319');
  assert.deepStrictEqual(f, [
    { plu: '300', cantidad: 0.2273, unidad: 'kg', origen: 'ingrediente' },
    { plu: '7067', cantidad: 0.0682, unidad: 'kg', origen: 'ingrediente' },
    { plu: '812', cantidad: 0.0455, unidad: 'kg', origen: 'ingrediente' },
    { plu: '6334', cantidad: 1, unidad: 'u', origen: 'insumo' },
    { plu: null, manualId: 'm-etiqueta', cantidad: 1, unidad: 'u', origen: 'insumo' },
  ]);
  assert.deepStrictEqual(formulaParaSiga({ recetas: RECETAS, presentaciones: {} }, '1'), []);
});


test('costearReceta: la variedad trae el desglose del producto terminado por tanda (base + extras, merma)', () => {
  const conU = { ...PASAS, extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }, { plu: '900', cantidad: 20, unidad: 'u' }] };
  const recetas = { ...RECETAS, base: { ...BASE, mermaPct: 10 } };
  const v = costearReceta({ receta: conU, recetasDelProducto: recetas, costoDe: costosDe({ ...COSTOS, 900: 1 }), costoHora: COSTO_HORA, categoriasMaquina: CATEGORIAS });
  assert.deepStrictEqual(v.desglose, { baseKg: 10, extrasKg: 1, extrasEnUnidades: true, totalKg: 11, rendimientoPropio: false, mermaPct: 10, utilKg: 9.9 });
  const propia = costearReceta({ receta: { ...PASAS, rendimientoKg: 12 }, recetasDelProducto: RECETAS, costoDe, costoHora: COSTO_HORA, categoriasMaquina: CATEGORIAS });
  assert.strictEqual(propia.desglose.rendimientoPropio, true);
  assert.strictEqual(propia.desglose.totalKg, 12);
  assert.strictEqual(costear(BASE).desglose, undefined);
});
