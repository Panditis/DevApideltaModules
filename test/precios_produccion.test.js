'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  recetaEfectiva, costearReceta, costearPresentacion, costearProducto, detectarCambios, resumenAlertas, snapshotDe,
  validarProducto, validarMargenEspecial, validarReceta, validarPresentacion, validarBorrarReceta, escalarVariantes, formulaParaSiga, revisionDe,
  limpiarRecetas,
} = require('../lib/precios_produccion');

// costoDe inyectado: Map plu → costo. Sin entrada = sin costo (null), nunca 0.
const costosDe = obj => clave => (Object.hasOwn(obj, clave) ? { costo: obj[clave], fuente: 'sistema', nombre: `N${clave}` } : null);
const COSTOS = { 300: 400, 7067: 2800, 812: 5200, 6334: 180, 6320: 45, 'm-etiqueta': 60 };
const costoDe = costosDe(COSTOS);

const BASE = {
  nombre: 'Granola clásica', rendimientoKg: 10,
  materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1.5, unidad: 'kg' }],
};
const PASAS = { nombre: 'Granola con pasas', varianteDe: 'base', extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }] };
const RECETAS = { base: BASE, pasas: PASAS };
const costear = (receta, extra = {}) => costearReceta({ receta, recetasDelProducto: RECETAS, costoDe, ...extra });

// ── recetaEfectiva / costearReceta ───────────────────────────────────────────

test('costearReceta: sólo materias primas — costo/kg = Σ cantidad × costo ÷ rendimiento', () => {
  const r = costear(BASE);
  // 5×400 + 1.5×2800 = 2000 + 4200
  assert.strictEqual(r.costoBatch, 6200);
  assert.strictEqual(r.costoKg, 620);
  assert.deepStrictEqual(r.faltantes, []);
  assert.deepStrictEqual(r.componentes.map(c => [c.plu, c.importe]), [['300', 2000], ['7067', 4200]]);
  assert.deepStrictEqual(r.componentes[0], { plu: '300', nombre: 'N300', cantidad: 5, costoUnit: 400, importe: 2000, fuente: 'sistema' });
  assert.deepStrictEqual(r.costos, { 300: 400, 7067: 2800 });
  // MO, máquina y avisos de máquina ya no existen aunque la receta guardada los traiga.
  assert.deepStrictEqual(costear({ ...BASE, minutosElaboracion: 60, categoriaMaquinaId: 'maq' }).costos, { 300: 400, 7067: 2800 });
});
test('costearReceta: merma — costoKg = batch / (rendimiento × (1 − merma/100))', () => {
  assert.strictEqual(costear({ ...BASE, mermaPct: 5 }).costoKg, 652.63); // 6200 / 9.5
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

test('recetaEfectiva: variante = MP de la base + extras, rendimiento = base + kg de extras, hereda la merma', () => {
  const ef = recetaEfectiva(PASAS, { ...RECETAS, base: { ...BASE, mermaPct: 4 } });
  assert.deepStrictEqual(ef.materiasPrimas.map(m => m.plu), ['300', '7067', '812']);
  assert.strictEqual(ef.rendimientoKg, 11); // 10 de la base + 1 kg de pasas
  assert.strictEqual(ef.mermaPct, 4);
  assert.strictEqual(ef.nombre, 'Granola con pasas');
  assert.strictEqual(ef.validado, undefined); // el snapshot de la base no se hereda
  assert.deepStrictEqual(RECETAS.base.materiasPrimas.length, 2); // no muta la base
});
test('costearReceta: variante suma extras sobre el batch de la base', () => {
  const r = costear(PASAS);
  assert.strictEqual(r.costoBatch, 11400); // 6200 + 5200
  assert.strictEqual(r.costoKg, 1036.36); // 11400 / 11 kg (base 10 + extra 1)
  assert.strictEqual(r.varianteDe, 'base');
});
test('costearReceta: variante pisa rendimiento', () => {
  assert.strictEqual(costear({ ...PASAS, rendimientoKg: 12 }).costoKg, 950); // 11400 / 12
});
test('recetaEfectiva: variante de variante o base inexistente → error', () => {
  const recetas = { ...RECETAS, doble: { nombre: 'x', varianteDe: 'pasas', extras: [] } };
  assert.throws(() => recetaEfectiva(recetas.doble, recetas), /variante/);
  assert.throws(() => recetaEfectiva({ nombre: 'x', varianteDe: 'nada', extras: [] }, RECETAS), /no existe/);
});

// ── costearPresentacion ──────────────────────────────────────────────────────

const PRES = { recetaId: 'base', kgPorUnidad: 0.5 };
const presentar = (extra = {}) => costearPresentacion({ plu: '6319', nombre: 'Granola 500g', presentacion: PRES, recetaCosteada: costear(BASE), ...extra });

test('costearPresentacion: costo por unidad = costo/kg de la receta × kg por unidad, sin precio', () => {
  const p = presentar();
  assert.strictEqual(p.costoUnidad, 310); // 0.5 × 620
  assert.deepStrictEqual(p.componentes.map(c => [c.plu, c.importe]), [['_receta', 310]]);
  assert.deepStrictEqual(p.faltantes, []);
  assert.deepStrictEqual(p.costos, { 300: 400, 7067: 2800 }); // los de la receta
  assert.deepStrictEqual([p.plu, p.nombre, p.recetaId], ['6319', 'Granola 500g', 'base']);
  for (const k of ['precioConIva', 'precioNeto', 'markupPct', 'desglose']) assert.ok(!(k in p), k);
  // insumos, MO de empaquetado y corrección guardados de antes no suman
  assert.strictEqual(presentar({ presentacion: { ...PRES, insumos: [{ plu: '6334', cantidad: 1 }], minutosEmpaquetado: 1, correccionPct: 5 } }).costoUnidad, 310);
});

test('costearPresentacion: hereda faltantes de la receta; sin receta o sin kg → faltante', () => {
  const recetaCosteada = costear(BASE, { costoDe: costosDe({ ...COSTOS, 300: null }) });
  assert.deepStrictEqual(presentar({ recetaCosteada }).faltantes, ['300']);
  assert.strictEqual(presentar({ recetaCosteada }).costoUnidad, null);
  assert.deepStrictEqual(presentar({ recetaCosteada: undefined }).faltantes, ['receta']);
  assert.deepStrictEqual(presentar({ presentacion: { ...PRES, kgPorUnidad: 0 } }).faltantes, ['kgPorUnidad']);
});

// ── detectarCambios ──────────────────────────────────────────────────────────

const VALIDADO = { fecha: '2026-09-25', costoKg: 620, costos: { 300: 400, 7067: 2800 } };
const detect = (costosActuales, extra = {}) => detectarCambios({ validado: VALIDADO, costosActuales, toleranciaPct: 3, ...extra });

test('detectarCambios: sin snapshot → sin-validar', () => {
  assert.strictEqual(detectarCambios({ validado: undefined, costosActuales: { 300: 1 }, toleranciaPct: 3 }).estado, 'sin-validar');
  assert.strictEqual(detectarCambios({ validado: { fecha: 'x' }, costosActuales: {}, toleranciaPct: 3 }).estado, 'sin-validar');
});

test('detectarCambios: costos iguales → ok, sin componentes', () => {
  const d = detect({ ...VALIDADO.costos }, { costoActual: 620 });
  assert.deepStrictEqual(d, { estado: 'ok', deltaPct: 0, componentes: [], nuevos: [], quitados: [] });
});

test('detectarCambios: sube o baja más que la tolerancia → cambio con antes/ahora', () => {
  const sube = detect({ ...VALIDADO.costos, 300: 440 }, { costoActual: 640 });
  assert.strictEqual(sube.estado, 'cambio');
  assert.deepStrictEqual(sube.componentes, [{ plu: '300', antes: 400, ahora: 440, deltaPct: 10 }]);
  assert.strictEqual(sube.deltaPct, 3.2); // del costo total validado (620 → 640)
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

test('detectarCambios: costo que pasa a faltar → cambio', () => {
  const falta = detect({ ...VALIDADO.costos, 300: null });
  assert.strictEqual(falta.estado, 'cambio');
  assert.deepStrictEqual(falta.componentes, [{ plu: '300', antes: 400, ahora: null, deltaPct: null }]);
});
// ── snapshotDe / costearProducto / resumenAlertas ────────────────────────────

const CFG = { toleranciaPct: 3 };

// Producto con todo validado contra los costos de `costos` (fecha fija).
function productoValidado(nombre, presentaciones, costos = COSTOS) {
  const sinValidar = { nombre, recetas: RECETAS, presentaciones };
  const c = costearProducto({ producto: sinValidar, costoDe: costosDe(costos), ...CFG });
  const recetas = Object.fromEntries(Object.entries(RECETAS).map(([id, r]) => [id, { ...r, validado: snapshotDe(c.recetas[id], '2026-09-25') }]));
  const pres = Object.fromEntries(Object.entries(presentaciones).map(([plu, p]) => [plu, { ...p, validado: snapshotDe(c.presentaciones[plu], '2026-09-25') }]));
  return { ...sinValidar, recetas, presentaciones: pres };
}

test('snapshotDe: guarda fecha, costo total y copia de los costos de componentes (variante incluye los de la base)', () => {
  assert.deepStrictEqual(snapshotDe(costear(PASAS), '2026-09-25'), { fecha: '2026-09-25', costoKg: 1036.36, costos: { 300: 400, 7067: 2800, 812: 5200 } });
  assert.deepStrictEqual(snapshotDe(presentar(), 'f'), { fecha: 'f', costoUnidad: 310, costos: { 300: 400, 7067: 2800 } });
});
test('costearProducto: recién validado → todo ok y sin revisar; sin validar → sin-validar (no cuenta como alerta)', () => {
  const prod = productoValidado('Granola', { 6319: { ...PRES, nombre: 'Granola 500g' } });
  const ok = costearProducto({ producto: prod, costoDe, ...CFG });
  assert.deepStrictEqual([ok.nombre, ok.recetas.base.estado, ok.recetas.pasas.estado, ok.presentaciones['6319'].estado], ['Granola', 'ok', 'ok', 'ok']);
  assert.strictEqual(ok.presentaciones['6319'].costoUnidad, 310);
  assert.strictEqual(ok.presentaciones['6319'].revisar, null);
  assert.deepStrictEqual(ok.resumen, { alertas: 0, faltantes: 0 });
  assert.ok(!('insumos' in ok));
  const sinValidar = costearProducto({ producto: { nombre: 'X', recetas: RECETAS }, costoDe, ...CFG });
  assert.strictEqual(sinValidar.recetas.base.estado, 'sin-validar');
  assert.strictEqual(sinValidar.recetas.base.revisar, null);
  assert.strictEqual(sinValidar.resumen.alertas, 0);
});
test('costearProducto: aumento de un ingrediente de la base avisa también en la variante', () => {
  const prod = productoValidado('Granola', {});
  const c = costearProducto({ producto: prod, costoDe: costosDe({ ...COSTOS, 300: 500 }), ...CFG });
  assert.strictEqual(c.recetas.base.estado, 'cambio');
  assert.strictEqual(c.recetas.pasas.estado, 'cambio');
  assert.strictEqual(c.resumen.alertas, 2);
});

test('costearProducto + resumenAlertas: materia prima compartida que sube → "a revisar" con nombre, antes y ahora en los dos productos', () => {
  const granola = productoValidado('Granola', { 6319: { ...PRES, nombre: 'Granola 500g' } });
  const pepas = productoValidado('Pepas', { 7001: { ...PRES, recetaId: 'pasas', nombre: 'Pepas 500g' } });
  const nuevo = { nombre: 'Yerba', recetas: RECETAS }; // sin validar: no suma al toast
  const costoDeNuevo = costosDe({ ...COSTOS, 300: 500 }); // harina +25 %
  const costeados = Object.fromEntries(Object.entries({ 'p-granola': granola, 'p-pepas': pepas, 'p-yerba': nuevo })
    .map(([id, producto]) => [id, costearProducto({ producto, costoDe: costoDeNuevo, ...CFG })]));
  const revisar = [{ plu: '300', nombre: 'N300', antes: 400, ahora: 500 }];
  assert.deepStrictEqual(costeados['p-granola'].presentaciones['6319'].revisar, revisar);
  assert.deepStrictEqual(costeados['p-granola'].recetas.base.revisar, revisar);
  const r = resumenAlertas(costeados);
  // granola: base, pasas, 6319 · pepas: base, pasas, 7001
  assert.strictEqual(r.total, 6);
  const pres = r.items.filter(i => i.tipo === 'presentacion').map(i => [i.productoId, i.id, i.componentes]).sort();
  assert.deepStrictEqual(pres, [['p-granola', '6319', revisar], ['p-pepas', '7001', revisar]]);
});

test('revisionDe: componentes movidos, agregados (antes null) y quitados (ahora null) con nombre; sin cambio → null', () => {
  const cambios = { estado: 'cambio', componentes: [{ plu: '300' }], nuevos: ['812'], quitados: ['9'] };
  assert.deepStrictEqual(revisionDe(cambios, { 300: 400, 9: 10 }, { 300: 500, 812: 50 }, { 300: 'Harina', 812: 'Pasas' }), [
    { plu: '300', nombre: 'Harina', antes: 400, ahora: 500 }, { plu: '812', nombre: 'Pasas', antes: null, ahora: 50 },
    { plu: '9', nombre: null, antes: 10, ahora: null }]);
  assert.strictEqual(revisionDe({ estado: 'ok', componentes: [], nuevos: [], quitados: [] }), null);
  assert.strictEqual(revisionDe(undefined), null);
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

test('validarMargenEspecial: canales opcionales > −100 sin tope; 0/null se omiten, vacío → null; canal desconocido, ≤ −100 o no número → error', () => {
  assert.deepStrictEqual(validarMargenEspecial({ minorista: 5, pack: -2.5, bulto: 0 }), { minorista: 5, pack: -2.5 });
  assert.deepStrictEqual(validarMargenEspecial({ minorista: 300, bulto: -50 }), { minorista: 300, bulto: -50 });
  for (const body of [{}, null, { minorista: null, pack: 0 }]) assert.strictEqual(validarMargenEspecial(body), null);
  assert.throws(() => validarMargenEspecial({ mayorista: 5 }), /canal desconocido/);
  assert.deepStrictEqual(validarMargenEspecial({ minorista: 5000, pack: -99.9 }), { minorista: 5000, pack: -99.9 });
  for (const v of [-100, -150, '5', NaN, Infinity]) assert.throws(() => validarMargenEspecial({ pack: v }), /margenEspecial\.pack: El margen debe ser mayor a −100 %/);
});

// Las presentaciones eligen una VARIEDAD (decisión 14), no la base.
const PRESV = { ...PRES, recetaId: 'pasas' };
const PRODUCTO = { nombre: 'Granola', recetas: RECETAS, presentaciones: { 6319: PRES } };

test('validarReceta: base y variante válidas devuelven sólo claves conocidas', () => {
  // MO y máquina guardadas de antes no salen
  assert.deepStrictEqual(validarReceta({ ...BASE, hack: 1, mermaPct: 3, minutosElaboracion: 60, categoriaMaquinaId: 'maq' }, PRODUCTO, 'base'), {
    nombre: 'Granola clásica', rendimientoKg: 10, mermaPct: 3,
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
  // insumos, MO de empaquetado y corrección del body no salen
  const body = { ...PRESV, hack: 1, minutosEmpaquetado: 0.6, correccionPct: 5, insumos: [{ plu: '6334', cantidad: 1 }] };
  assert.deepStrictEqual(validarPresentacion(body, PRODUCTO, { 'p-granola': PRODUCTO }, { plu: '6319', productoId: 'p-granola' }), {
    recetaId: 'pasas', kgPorUnidad: 0.5,
  });
});

test('validarPresentacion: PLU de otro producto, receta inexistente, kg ≤ 0, PLU no numérico → rechazo', () => {
  const todos = { 'p-granola': PRODUCTO, 'p-pepas': { nombre: 'Pepas', presentaciones: { 7001: PRES } } };
  const ok = { plu: '6319', productoId: 'p-granola' };
  assert.throws(() => validarPresentacion(PRESV, PRODUCTO, todos, { plu: '7001', productoId: 'p-granola' }), /Pepas/);
  assert.throws(() => validarPresentacion({ ...PRESV, recetaId: 'nada' }, PRODUCTO, todos, ok), /recetaId/);
  assert.throws(() => validarPresentacion({ ...PRESV, kgPorUnidad: 0 }, PRODUCTO, todos, ok), /kgPorUnidad/);
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

// ── Rendimiento de variante = base + kg de extras; corrección por presentación ──

test('recetaEfectiva: extras en "u" no suman al rendimiento; rendimiento explícito de la variante gana', () => {
  const conU = { ...PASAS, extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }, { plu: '900', cantidad: 20, unidad: 'u' }] };
  assert.strictEqual(recetaEfectiva(conU, RECETAS).rendimientoKg, 11);
  assert.strictEqual(recetaEfectiva({ ...PASAS, rendimientoKg: 12 }, RECETAS).rendimientoKg, 12);
  // costearReceta expone el rendimiento efectivo (la UI de Variedad lo muestra, no lo calcula).
  assert.strictEqual(costear(PASAS).rendimientoKg, 11);
});

test('regresión Excel (hoja Pepas): masa 104 kg + membrillo → variante y presentación 6051 (sólo materias primas)', () => {
  const costo = costosDe({ 1: 232768.2134, 6009: 1726 });
  const recetas = {
    masa: { nombre: 'Masa pepas', rendimientoKg: 104, materiasPrimas: [{ plu: '1', cantidad: 1, unidad: 'kg' }] },
    membrillo: { nombre: 'Pepas membrillo', varianteDe: 'masa', extras: [{ plu: '6009', cantidad: 47.3376, unidad: 'kg' }] },
  };
  const cfg = { recetasDelProducto: recetas, costoDe: costo };
  const masa = costearReceta({ receta: recetas.masa, ...cfg });
  assert.strictEqual(masa.costoKg, 2238.16); // Excel: $2.238/kg (sin MO: 232768.21 / 104)
  const memb = costearReceta({ receta: recetas.membrillo, ...cfg });
  assert.ok(Math.abs(recetaEfectiva(recetas.membrillo, recetas).rendimientoKg - 151.3376) < 1e-9);
  // 232768.21 + 47.3376 × 1726 (81704.70) = 314472.91 / 151.3376 kg = 2077.96
  assert.strictEqual(memb.costoBatch, 314472.91);
  assert.strictEqual(memb.costoKg, 2077.96);
  const p = costearPresentacion({ plu: '6051', recetaCosteada: memb, presentacion: { recetaId: 'membrillo', kgPorUnidad: 0.27 } });
  // A mano: 2077.96 × 0.27 = 561.05 (sin corrección, insumos ni precio: el precio sale del motor del esquema)
  assert.strictEqual(p.costoUnidad, 561.05);
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
  const sinCosto = costearReceta({ receta: PASAS, recetasDelProducto: RECETAS, costoDe: costosDe({ ...COSTOS, 300: null }) });
  assert.strictEqual(sinCosto.costoBaseIngredientes, null);
});

test('costearProducto: presentación sobre la base (dato viejo) se costea igual, con aviso "variedad"', () => {
  const c = costearProducto({ producto: { nombre: 'G', recetas: RECETAS, presentaciones: { 1: PRES, 2: PRESV } }, costoDe, ...CFG });
  assert.ok(c.presentaciones['1'].costoUnidad > 0);
  assert.deepStrictEqual(c.presentaciones['1'].avisos, ['variedad']);
  assert.deepStrictEqual(c.presentaciones['2'].avisos, []);
});

test('formulaParaSiga: por unidad vendida = cantidad / rendimiento efectivo × kg por unidad (sin insumos)', () => {
  const producto = { recetas: RECETAS, presentaciones: { 7001: { recetaId: 'pasas', kgPorUnidad: 0.55, insumos: [{ plu: '6334', cantidad: 1 }] } } };
  // rendimiento efectivo 11 kg: 300 → 5/11×0.55 = 0.25 · 7067 → 1.5/11×0.55 = 0.075 · 812 → 1/11×0.55 = 0.05
  assert.deepStrictEqual(formulaParaSiga(producto, '7001'), [
    { plu: '300', cantidad: 0.25, unidad: 'kg', origen: 'ingrediente' },
    { plu: '7067', cantidad: 0.075, unidad: 'kg', origen: 'ingrediente' },
    { plu: '812', cantidad: 0.05, unidad: 'kg', origen: 'ingrediente' },
  ]);
  assert.deepStrictEqual(formulaParaSiga({ recetas: RECETAS, presentaciones: {} }, '1'), []);
});
test('costearReceta: la variedad trae el desglose del producto terminado por tanda (base + extras, merma)', () => {
  const conU = { ...PASAS, extras: [{ plu: '812', cantidad: 1, unidad: 'kg' }, { plu: '900', cantidad: 20, unidad: 'u' }] };
  const recetas = { ...RECETAS, base: { ...BASE, mermaPct: 10 } };
  const v = costearReceta({ receta: conU, recetasDelProducto: recetas, costoDe: costosDe({ ...COSTOS, 900: 1 }) });
  assert.deepStrictEqual(v.desglose, { baseKg: 10, extrasKg: 1, extrasEnUnidades: true, totalKg: 11, rendimientoPropio: false, mermaPct: 10, utilKg: 9.9 });
  const propia = costearReceta({ receta: { ...PASAS, rendimientoKg: 12 }, recetasDelProducto: RECETAS, costoDe });
  assert.strictEqual(propia.desglose.rendimientoPropio, true);
  assert.strictEqual(propia.desglose.totalKg, 12);
  assert.strictEqual(costear(BASE).desglose, undefined);
});

test('limpiarRecetas: saca insumos, máquinas, MO y corrección; snapshots sólo con materias primas; idempotente', () => {
  const datos = { insumosManuales: { 'm-x': {} }, categoriasMaquina: [], productos: { 'p-a': { nombre: 'A', insumos: [{ plu: '9' }],
    recetas: { base: { nombre: 'Base', rendimientoKg: 10, materiasPrimas: [{ plu: '1', cantidad: 5 }], minutosElaboracion: 30, categoriaMaquinaId: 'horno',
      validado: { fecha: 'f', costoKg: 70, costos: { 1: 100, _costoHora: 4500, _maquina: 300 } } },
      v: { nombre: 'V', varianteDe: 'base', extras: [{ plu: '2', cantidad: 1 }] } },
    presentaciones: { 7: { recetaId: 'v', kgPorUnidad: 0.5, minutosEmpaquetado: 1, correccionPct: 5, insumos: [{ plu: '9', cantidad: 1 }],
      validado: { fecha: 'f', costoUnidad: 50, costos: { 1: 100, 2: 20, 9: 15, _costoHora: 4500 } } } } } } };
  const r = limpiarRecetas(datos);
  assert.deepStrictEqual(r.datos, { productos: { 'p-a': { nombre: 'A',
    recetas: { base: { nombre: 'Base', rendimientoKg: 10, materiasPrimas: [{ plu: '1', cantidad: 5 }], validado: { fecha: 'f', costos: { 1: 100 } } },
      v: { nombre: 'V', varianteDe: 'base', extras: [{ plu: '2', cantidad: 1 }] } },
    presentaciones: { 7: { recetaId: 'v', kgPorUnidad: 0.5, validado: { fecha: 'f', costos: { 1: 100, 2: 20 } } } } } } });
  assert.ok(r.quitadas.includes('archivo.insumosManuales') && r.quitadas.includes('presentacion.validado.costos'));
  assert.ok(r.quitadas.includes('receta.validado.costoKg') && r.quitadas.includes('presentacion.validado.costoUnidad'));
  assert.strictEqual(limpiarRecetas(r.datos), null);
  assert.ok('insumos' in datos.productos['p-a']); // no muta
});

test('limpiarRecetas: el costo total validado viejo (con MO/máquina/insumos) se descarta aunque no haya nada más que podar → Δ% null hasta revalidar', () => {
  const validado = { fecha: 'f', costoKg: 70, costos: { 1: 100 } };
  const datos = { productos: { 'p-a': { nombre: 'A', recetas: { base: { nombre: 'Base', materiasPrimas: [{ plu: '1', cantidad: 5 }], validado } }, presentaciones: {} } } };
  const r = limpiarRecetas(datos);
  assert.deepStrictEqual(r.datos.productos['p-a'].recetas.base.validado, { fecha: 'f', costos: { 1: 100 } });
  assert.deepStrictEqual(r.quitadas, ['receta.validado.costoKg']);
  assert.strictEqual(datos.productos['p-a'].recetas.base.validado.costoKg, 70); // no muta
  const c = detectarCambios({ validado: r.datos.productos['p-a'].recetas.base.validado, costosActuales: { 1: 100 }, costoActual: 20, toleranciaPct: 3 });
  assert.deepStrictEqual([c.estado, c.deltaPct], ['ok', null]);
  assert.strictEqual(limpiarRecetas(r.datos), null);
});

// ── Envasado Apidelta: Familia › Variedad › PLUs (granel de la variedad × kg por unidad + insumos de cada PLU) ──

const { costearEnvasado, validarEnvasado, normalizarEnvasado } = require('../lib/precios_produccion');
// Miel 500 g: granel 7067 ($2800/kg) × 0,5 + envase 6334 ($180) + tapa 6320 ($45) × 1. Vista plana de UN PLU.
const MIEL = { nombre: 'Miel 500 g', plu: '9001', granelPlu: '7067', kgPorUnidad: 0.5,
  componentes: [{ plu: '6334', cantidad: 1 }, { plu: '6320', cantidad: 1 }] };
// Variedad Pradera (familia Miel): 500 g y 1 kg, el mismo granel.
const PRADERA = { tipo: 'envasado', familia: 'Miel', nombre: 'Pradera', granelPlu: '7067', presentaciones: {
  9001: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }, { plu: '6320', cantidad: 1 }] },
  9002: { kgPorUnidad: 1, componentes: [{ plu: '6320', cantidad: 1 }] },
} };

test('costearEnvasado: granel $/kg × kg por unidad + Σ cantidad × costo de los insumos', () => {
  const c = costearEnvasado({ producto: MIEL, costoDe });
  assert.strictEqual(c.costoUnidad, 1625); // 1400 + 180 + 45
  assert.deepStrictEqual(c.faltantes, []);
  assert.deepStrictEqual(c.componentes.map(l => [l.plu, l.cantidad, l.costoUnit, l.importe, l.rol]),
    [['7067', 0.5, 2800, 1400, 'granel'], ['6334', 1, 180, 180, 'empaque'], ['6320', 1, 45, 45, 'empaque']]);
  assert.deepStrictEqual(c.costos, { 7067: 2800, 6334: 180, 6320: 45 });
  const dos = costearEnvasado({ producto: { ...MIEL, componentes: [{ plu: '6320', cantidad: 2.5 }] }, costoDe });
  assert.strictEqual(dos.costoUnidad, 1512.5); // 1400 + 2,5 × 45
});

test('costearEnvasado: granel o insumo sin costo → faltante con su PLU, sin costo (nunca 0); kg inválido → faltante', () => {
  const sinGranel = costearEnvasado({ producto: { ...MIEL, granelPlu: '5555' }, costoDe });
  assert.deepStrictEqual([sinGranel.costoUnidad, sinGranel.faltantes], [null, ['5555']]);
  const sinEnvase = costearEnvasado({ producto: { ...MIEL, componentes: [{ plu: '6334', cantidad: 1 }, { plu: '4444', cantidad: 1 }] }, costoDe });
  assert.deepStrictEqual([sinEnvase.costoUnidad, sinEnvase.faltantes], [null, ['4444']]);
  assert.strictEqual(sinEnvase.componentes[2].importe, null);
  assert.deepStrictEqual(costearEnvasado({ producto: { ...MIEL, kgPorUnidad: 0 }, costoDe }).faltantes, ['kgPorUnidad']);
});

test('costearProducto: variedad envasada → una presentación por PLU, cada una con su costo, estado y "a revisar"', () => {
  const sin = costearProducto({ producto: PRADERA, costoDe, toleranciaPct: 3 });
  assert.deepStrictEqual(Object.keys(sin.recetas), []);
  assert.deepStrictEqual(Object.keys(sin.presentaciones), ['9001', '9002']);
  assert.deepStrictEqual([sin.presentaciones['9001'].costoUnidad, sin.presentaciones['9002'].costoUnidad], [1625, 2845]);
  assert.deepStrictEqual([sin.presentaciones['9001'].estado, sin.tipo, sin.nombre], ['sin-validar', 'envasado', 'Pradera']);
  const v1 = snapshotDe(sin.presentaciones['9001'], '2026-10-13');
  assert.deepStrictEqual(v1, { fecha: '2026-10-13', costoUnidad: 1625, costos: { 7067: 2800, 6334: 180, 6320: 45 } });
  const validada = { ...PRADERA, presentaciones: { ...PRADERA.presentaciones, 9001: { ...PRADERA.presentaciones['9001'], validado: v1 } } };
  const ok = costearProducto({ producto: validada, costoDe, toleranciaPct: 3 });
  assert.deepStrictEqual([ok.presentaciones['9001'].estado, ok.presentaciones['9002'].estado], ['ok', 'sin-validar']);
  // Sube la tapa: "a revisar" sólo en el PLU validado, alerta por PLU.
  const subio = costearProducto({ producto: validada, costoDe: costosDe({ ...COSTOS, 6320: 60 }), toleranciaPct: 3 });
  assert.strictEqual(subio.presentaciones['9001'].estado, 'cambio');
  assert.deepStrictEqual(subio.presentaciones['9001'].revisar, [{ plu: '6320', nombre: 'N6320', antes: 45, ahora: 60 }]);
  assert.strictEqual(subio.resumen.alertas, 1);
  assert.deepStrictEqual(resumenAlertas({ 'p-miel': subio }).items.map(i => [i.productoId, i.tipo, i.id]), [['p-miel', 'presentacion', '9001']]);
  // Un PLU con insumo sin costo no arrastra a los demás.
  const falta = costearProducto({ producto: { ...PRADERA, presentaciones: { ...PRADERA.presentaciones, 9002: { kgPorUnidad: 1, componentes: [{ plu: '4444', cantidad: 1 }] } } }, costoDe });
  assert.deepStrictEqual([falta.presentaciones['9001'].costoUnidad, falta.presentaciones['9002'].costoUnidad, falta.resumen.faltantes], [1625, null, 1]);
  // Variedad sin PLUs todavía: nada que costear.
  assert.deepStrictEqual(costearProducto({ producto: { ...PRADERA, presentaciones: {} }, costoDe }).presentaciones, {});
});

test('validarEnvasado: limpia la variedad, granel numérico, PLUs numéricos, kg > 0, insumos sin repetir ni granel', () => {
  const body = { ...PRADERA, familia: ' Miel ', basura: 1, margenEspecial: {}, presentaciones: {
    9001: { kgPorUnidad: 0.5, componentes: [{ plu: 6334, cantidad: 1, nombre: 'x' }], validado: {}, nombre: 'y' } } };
  assert.deepStrictEqual(validarEnvasado(body, {}, {}), { tipo: 'envasado', familia: 'Miel', nombre: 'Pradera', granelPlu: '7067',
    presentaciones: { 9001: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] } } });
  // Variedad nueva sin PLUs ni familia: vale (los PLUs se agregan después).
  assert.deepStrictEqual(validarEnvasado({ nombre: 'Pradera', granelPlu: '7067' }, {}, {}), { tipo: 'envasado', familia: '', nombre: 'Pradera', granelPlu: '7067', presentaciones: {} });
  const conPres = pr => ({ ...PRADERA, presentaciones: { 9001: pr } });
  assert.deepStrictEqual(validarEnvasado(conPres({ kgPorUnidad: 1 }), {}, {}).presentaciones['9001'].componentes, []);
  assert.throws(() => validarEnvasado(conPres({ kgPorUnidad: 0 }), {}, {}), /presentaciones\.9001\.kgPorUnidad/);
  assert.throws(() => validarEnvasado({ ...PRADERA, granelPlu: '' }, {}, {}), /granelPlu/);
  assert.throws(() => validarEnvasado({ ...PRADERA, presentaciones: { abc: { kgPorUnidad: 1 } } }, {}, {}), /plu/);
  assert.throws(() => validarEnvasado({ ...PRADERA, presentaciones: [] }, {}, {}), /presentaciones/);
  assert.throws(() => validarEnvasado({ ...PRADERA, presentaciones: { 7067: { kgPorUnidad: 1 } } }, {}, {}), /granel/);
  assert.throws(() => validarEnvasado(conPres({ kgPorUnidad: 1, componentes: [{ plu: '6334', cantidad: 0 }] }), {}, {}), /componentes\[0\]\.cantidad/);
  assert.throws(() => validarEnvasado(conPres({ kgPorUnidad: 1, componentes: [{ plu: '6334', cantidad: 1 }, { plu: '6334', cantidad: 2 }] }), {}, {}), /repetido/);
  assert.throws(() => validarEnvasado(conPres({ kgPorUnidad: 1, componentes: [{ plu: '7067', cantidad: 1 }] }), {}, {}), /granel/);
  assert.throws(() => validarEnvasado(conPres({ kgPorUnidad: 1, componentes: [{ plu: '9001', cantidad: 1 }] }), {}, {}), /mismo PLU/);
  assert.throws(() => validarEnvasado({ ...PRADERA, nombre: '' }, {}, {}), /nombre/);
  assert.throws(() => validarEnvasado({ ...PRADERA, familia: 'x'.repeat(61) }, {}, {}), /familia/);
  // Cada PLU de venta pertenece a un solo producto (de receta o envasado); los propios no chocan.
  const otros = { 'p-a': { nombre: 'Granola', presentaciones: { 9001: {} } }, 'p-b': { nombre: 'Azahar', familia: 'Miel', tipo: 'envasado', presentaciones: { 9002: {} } } };
  assert.throws(() => validarEnvasado(PRADERA, otros, {}), /Granola/);
  assert.throws(() => validarEnvasado({ ...PRADERA, presentaciones: { 9002: { kgPorUnidad: 1 } } }, otros, {}), /Miel Azahar/);
  assert.deepStrictEqual(Object.keys(validarEnvasado({ ...PRADERA, presentaciones: { 9002: { kgPorUnidad: 1 } } }, otros, { productoId: 'p-b' }).presentaciones), ['9002']);
});

test('normalizarEnvasado: un envasado viejo de un solo PLU pasa a variedad con ese PLU (familia = 1.ª palabra); idempotente', () => {
  const viejo = { nombre: 'Miel Pradera 10Kg', tipo: 'envasado', plu: '2279', granelPlu: '9710', kgPorUnidad: 10,
    componentes: [{ plu: '9653', cantidad: 1 }], creado: '2026-10-13', validado: { fecha: 'f', costoUnidad: 1, costos: {} }, margenEspecial: { minorista: 5 } };
  const nuevo = normalizarEnvasado(viejo);
  assert.deepStrictEqual(nuevo, { tipo: 'envasado', familia: 'Miel', nombre: 'Miel Pradera 10Kg', granelPlu: '9710', creado: '2026-10-13', margenEspecial: { minorista: 5 },
    presentaciones: { 2279: { kgPorUnidad: 10, componentes: [{ plu: '9653', cantidad: 1 }], validado: { fecha: 'f', costoUnidad: 1, costos: {} } } } });
  assert.strictEqual(normalizarEnvasado(nuevo), nuevo); // ya migrado: el mismo objeto
  assert.strictEqual(viejo.plu, '2279'); // no muta
  assert.strictEqual(normalizarEnvasado({ ...viejo, validado: undefined, nombre: '' }).familia, '');
  assert.ok(!('validado' in normalizarEnvasado({ ...viejo, validado: undefined }).presentaciones['2279']));
  const receta = { nombre: 'Granola', recetas: {}, presentaciones: {} };
  assert.strictEqual(normalizarEnvasado(receta), receta);
  assert.strictEqual(normalizarEnvasado(null), null);
});

test('validarPresentacion: un PLU de una variedad envasada tampoco se puede usar como presentación de receta', () => {
  const prod = { recetas: RECETAS, presentaciones: {} };
  const todos = { 'p-miel': { nombre: 'Pradera', familia: 'Miel', tipo: 'envasado', presentaciones: { 9001: { kgPorUnidad: 0.5 } } } };
  assert.throws(() => validarPresentacion({ recetaId: 'pasas', kgPorUnidad: 1 }, prod, todos, { plu: '9001', productoId: 'p-x' }), /Miel Pradera/);
});

test('limpiarRecetas: no toca los envasados (sus snapshots tienen granel e insumos)', () => {
  const pr = { ...PRADERA, presentaciones: { 9001: { ...PRADERA.presentaciones['9001'], validado: { fecha: 'f', costoUnidad: 1625, costos: { 7067: 2800 } } } } };
  assert.strictEqual(limpiarRecetas({ productos: { 'p-miel': pr } }), null);
});
