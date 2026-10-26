'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd, textoElegidoMd,
  textoAutomaticoMd, valorSelectActivoMd, activoManualDeValorMd, htmlOpcionesActivoMd, lineasEstadoMd, textoGuardadoActivoMd, htmlEstadoActivoMd } = require('../public/js/precios_modal_fraccionado.js');

test('resumenCosteoFraccMd: insumos, MO y máquina por unidad, extra $/kg, mercadería y costo real de la fuente elegida', () => {
  const p = { costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415 },
    componentesCosto: [{ plu: '900', rol: 'insumo', cantidad: 1, costoUnit: 20, importe: 20 }, { plu: '_manoObra', rol: 'mo', cantidad: 1.25, costoUnit: 6000, importe: 125 },
      { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 1.25, costoUnit: 3000, importe: 62.5 }] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.insumos.length, r.subtotalInsumos, r.mo.importe, r.maquina.nombre, r.porUnidad, r.extraKg, r.mercaderiaKg, r.costoKg],
    [1, 20, 125, 'Envasadora', 207.5, 415, 1200, 1615]);
  const faltante = resumenCosteoFraccMd({ componentesCosto: [{ plu: '9', rol: 'insumo', importe: null }] }, 'sistema', {});
  assert.deepStrictEqual([faltante.subtotalInsumos, faltante.mo, faltante.costoKg], [null, null, null]);
});

test('resumenCosteoFraccMd: mercadería y costo real también por unidad (= $/kg × kg de la presentación, con la fuente del modal)', () => {
  const p = { pesoG: 500, costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415 }, componentesCosto: [] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.mercaderiaUnidad, r.costoUnidad], [600, 807.5]);
  // Fuente sin costo (o sin peso): nada por unidad, nunca 0
  assert.deepStrictEqual([resumenCosteoFraccMd(p, 'manual', { manual: null }).mercaderiaUnidad, resumenCosteoFraccMd(p, 'manual', {}).costoUnidad], [null, null]);
  assert.strictEqual(resumenCosteoFraccMd({ ...p, pesoG: null }, 'sistema', { sistema: 1000 }).costoUnidad, null);
});

test('opcionesMaquinaMd: "Del subrubro (X)" + cada máquina como excepción, la del granel seleccionada y escapada', () => {
  const html = opcionesMaquinaMd([{ id: 'env', nombre: 'Envasadora <A>' }], 'env', 'Selladora');
  assert.match(html, /<option value="">Del subrubro \(Selladora\)<\/option>/);
  assert.match(html, /<option value="env" selected>Envasadora &lt;A&gt;<\/option>/);
  assert.match(opcionesMaquinaMd([], null, null), /Del subrubro \(sin máquina\)/);
});

test('formulaMinutosMd: "base × tiempo × facilidad = minutos"; sin base (dato viejo) sólo los minutos', () => {
  assert.strictEqual(formulaMinutosMd({ minutosBase: 1, factorTiempo: 1.5, factorFacilidad: 1.25 }, 1.875), '1 × 1,5 (tiempo) × 1,25 (facilidad) = 1,875 min');
  assert.strictEqual(formulaMinutosMd({}, 2), '2 min');
});

test('textoSinTiempoMd: sin subrubro / sin tramos → sin minutos; con minutos y sin máquina → sin asignar', () => {
  assert.match(textoSinTiempoMd('mo', ['sinTramos']), /^Mano de obra — sin minutos \(cargá los tiempos por peso del subrubro en Configuración › Costeo Fraccionado\)$/);
  assert.strictEqual(textoSinTiempoMd('maquina', ['sinSubrubro', 'sinMaquina']), 'Máquina — sin minutos: el granel no tiene subrubro en SIGA');
  assert.strictEqual(textoSinTiempoMd('maquina', ['sinMaquina']), 'Máquina — sin asignar (ni del subrubro ni del granel)');
});

test('textoElegidoMd: facilidad y tiempo del subrubro (costeoPresentacion)', () => {
  assert.strictEqual(textoElegidoMd({ facilidad: 'normal', tiempo: 'lento' }), 'Normal · Lento');
  assert.strictEqual(textoElegidoMd(undefined), 'sin facilidad · sin tiempo');
});

// ── Bloque "Estado" del granel (spec 2026-10-26 §4) ──
const granelAct = (extra = {}) => ({ plu: '50', nombre: 'Almendra <A>', reefer: false, activo: true, activoManual: null,
  actividad: { auto: 'activo', motivos: [], ultimoMovGranel: '2026-10-12', presentacionesActivas: 2 },
  presentaciones: [{ plu: '51', nombre: 'Almendra 500G', movReciente: true }, { plu: '52', nombre: 'Almendra 1Kg', movReciente: true }, { plu: '53', nombre: 'Almendra 250G', movReciente: false }], ...extra });
const granelInactivo = (extra = {}) => granelAct({ activo: false, actividad: { auto: 'inactivo', motivos: ['sinMovGranel', 'sinMovPresentaciones'], ultimoMovGranel: null, presentacionesActivas: 0 },
  presentaciones: [{ plu: '51', nombre: 'Almendra 500G', movReciente: false }], ...extra });

test('valorSelectActivoMd / activoManualDeValorMd: null/true/false ⇄ auto/activo/inactivo', () => {
  assert.deepStrictEqual([null, true, false, undefined].map(m => valorSelectActivoMd({ activoManual: m })), ['auto', 'activo', 'inactivo', 'auto']);
  assert.deepStrictEqual(['auto', 'activo', 'inactivo'].map(activoManualDeValorMd), [null, true, false]);
});

test('textoAutomaticoMd: "Automático (hoy: activo|inactivo)"; sin datos de actividad lo dice', () => {
  assert.strictEqual(textoAutomaticoMd(granelAct()), 'Automático (hoy: activo)');
  assert.strictEqual(textoAutomaticoMd(granelInactivo()), 'Automático (hoy: inactivo)');
  assert.strictEqual(textoAutomaticoMd(granelAct({ actividad: null })), 'Automático (sin datos de actividad)');
});

test('htmlOpcionesActivoMd: Automático / Activo / Inactivo con la elección guardada seleccionada', () => {
  const v = (f, valor) => new RegExp(`<option value="${valor}" selected>`).test(htmlOpcionesActivoMd(f));
  assert.ok(v(granelAct(), 'auto') && !v(granelAct(), 'activo'));
  assert.ok(v(granelAct({ activoManual: true }), 'activo'));
  assert.ok(v(granelInactivo({ activoManual: false }), 'inactivo'));
  const html = htmlOpcionesActivoMd(granelInactivo());
  assert.match(html, /<option value="auto" selected>Automático \(hoy: inactivo\)<\/option><option value="activo">Activo<\/option><option value="inactivo">Inactivo<\/option>/);
});

test('lineasEstadoMd: motivos del automático, último movimiento del granel y presentaciones con movimiento', () => {
  assert.deepStrictEqual(lineasEstadoMd(granelAct()), [
    'Último movimiento del granel: 12/10/2026.',
    'Presentaciones con movimiento en los últimos 6 meses: 2 de 3 (Almendra 500G, Almendra 1Kg).']);
  const ina = lineasEstadoMd(granelInactivo());
  assert.strictEqual(ina[0], 'Inactivo en automático: el granel no tuvo movimientos en 6 meses; ninguna presentación tuvo movimientos en 6 meses.');
  assert.strictEqual(ina[1], 'Último movimiento del granel: ninguno en los últimos 6 meses.');
  assert.strictEqual(ina[2], 'Presentaciones con movimiento en los últimos 6 meses: 0 de 1.');
  assert.strictEqual(lineasEstadoMd(granelAct({ presentaciones: [] }))[1], 'Sin presentaciones en el listado.');
  assert.deepStrictEqual(lineasEstadoMd(granelAct({ actividad: null })), ['Sin datos de movimientos: no se pudo consultar SIGA, no se oculta por inactivo.']);
  // movReciente null (sin datos) no cuenta como movimiento
  assert.match(lineasEstadoMd(granelAct({ presentaciones: [{ plu: '51', nombre: 'X', movReciente: null }] }))[1], /: 0 de 1\.$/);
});

test('htmlEstadoActivoMd: bloque con label, select, Guardar y estado; escapa; sin PLU (sin granel) → nada; REEFER lo aclara', () => {
  const html = htmlEstadoActivoMd(granelAct({ nombre: 'Almendra <A>', presentaciones: [{ plu: '51', nombre: 'Pres <b>', movReciente: true }] }));
  assert.match(html, /<section id="mdAct" class="md-activo"/);
  assert.match(html, /<label for="mdActSel"[^>]*>/);
  assert.match(html, /<select id="mdActSel"[^>]*>.*<\/select>/);
  assert.match(html, /<button type="button" id="mdActGuardar"/);
  assert.match(html, /id="mdActMsg"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /Pres &lt;b&gt;/);
  assert.doesNotMatch(html, /Pres <b>/);
  assert.doesNotMatch(html, /REEFER/);
  assert.match(htmlEstadoActivoMd(granelAct({ reefer: true })), /REEFER/);
  assert.strictEqual(htmlEstadoActivoMd({ plu: null, nombre: 'Sin granel asignado', presentaciones: [] }), '');
  assert.match(htmlEstadoActivoMd(granelAct(), '<span class="text-ok">✓ Guardado</span>'), /id="mdActMsg"[^>]*><span class="text-ok">✓ Guardado<\/span>/);
});

test('textoGuardadoActivoMd: cómo quedó el granel; inactivo avisa que el listado lo oculta', () => {
  assert.strictEqual(textoGuardadoActivoMd({ activoManual: null, activo: true }), 'Guardado · automático: activo.');
  assert.strictEqual(textoGuardadoActivoMd({ activoManual: true, activo: true }), 'Guardado · fijado a mano: activo.');
  assert.match(textoGuardadoActivoMd({ activoManual: false, activo: false }), /^Guardado · fijado a mano: inactivo, el listado lo oculta salvo con "Ver inactivos"\.$/);
});
