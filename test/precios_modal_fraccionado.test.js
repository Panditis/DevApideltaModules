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

// ── Columna derecha del modal de Fraccionado: precios de las presentaciones y su variación ──
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');
const { deltaPesosMd, textoDeltaPesosMd, textoPesoMd, filasPreciosFraccMd, resumenVariacionFraccMd, chipsVariacionFraccMd,
  subtituloPreciosFraccMd, htmlPreciosFraccMd } = require('../public/js/precios_modal_fraccionado.js');

// Granel con tres presentaciones (250G sin vigente, 500G igual al vigente con un bulto vinculado, 1Kg que sube) → fila como la manda el detalle.
const granelPrecios = ({ vigentes, decision } = {}) => {
  const vinculos = [{ plu: '201', nombre: 'Almendras Bulto x6', basePlu: '101', cantidad: 6, tipo: 'bulto' }];
  const v = vigentes || new Map([['101', 1950], ['102', 1500], ['201', 9000]]);
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }, { plu: '103', nombre: 'Almendras 250G' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: v, mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes: v }), costeo: {}, cfg: CFG,
  });
  return { ...L.filaPublica(g), ...(decision ? { decision } : {}) };
};

test('deltaPesosMd: sugerido − vigente en $ (2 decimales); sin alguno de los dos → null', () => {
  assert.strictEqual(deltaPesosMd(1500, 1800), 300);
  assert.strictEqual(deltaPesosMd(1950, 1950), 0);
  assert.strictEqual(deltaPesosMd(1800, 1500), -300);
  assert.strictEqual(deltaPesosMd(1000.1, 1000.35), 0.25); // sin ruido de punto flotante
  assert.deepStrictEqual([deltaPesosMd(null, 1800), deltaPesosMd(1500, null), deltaPesosMd(undefined, undefined)], [null, null, null]);
});

test('textoDeltaPesosMd: signo explícito, enteros sin decimales, centavos con dos; 0 sin signo; null → "—"', () => {
  assert.strictEqual(textoDeltaPesosMd(300), '+$ 300');
  assert.strictEqual(textoDeltaPesosMd(-7460), '-$ 7.460');
  assert.strictEqual(textoDeltaPesosMd(0.25), '+$ 0,25');
  assert.strictEqual(textoDeltaPesosMd(0), '$ 0');
  assert.strictEqual(textoDeltaPesosMd(null), '—');
});

test('textoPesoMd: gramos hasta 999, kg desde 1000 (con coma decimal); sin peso → vacío', () => {
  assert.deepStrictEqual([250, 500, 999, 1000, 1500, 2000].map(textoPesoMd), ['250 g', '500 g', '999 g', '1 kg', '1,5 kg', '2 kg']);
  assert.deepStrictEqual([null, undefined, 0].map(textoPesoMd), ['', '', '']);
});

test('filasPreciosFraccMd: filas por canal con el peso de la presentación y el Δ $ (sólo donde hay vigente y sugerido)', () => {
  const filas = filasPreciosFraccMd(granelPrecios(), 'sistema');
  assert.deepStrictEqual(filas.map(r => [r.canal, r.plu, r.pesoG ?? null, r.vigente, r.sugerido, r.deltaPesos, r.deltaPct]), [
    ['Minorista · Almendras 250G', '103', 250, null, 1950, null, null],       // sin vigente: sin Δ
    ['Minorista · Almendras 500G', '101', 500, 1950, 1950, 0, 0],
    ['Bulto sin IVA', '201', null, 9000, 1540, -7460, -82.9],                 // el Δ vs vigente va en la fila sin IVA
    ['Bulto con IVA', '201', null, null, 1850, null, null],                   // con IVA no tiene vigente: sin Δ
    ['Minorista · Almendras 1Kg', '102', 1000, 1500, 1800, 300, 20]]);
});

test('filasPreciosFraccMd: fuente sin costo → sin sugeridos ni Δ $; no muta la fila del server', () => {
  const g = granelPrecios();
  const antes = JSON.stringify(g);
  const filas = filasPreciosFraccMd(g, 'ultimaCompra');
  assert.ok(filas.every(r => r.sugerido == null && r.deltaPesos == null));
  assert.strictEqual(JSON.stringify(g), antes);
});

test('resumenVariacionFraccMd: cuenta presentaciones por semáforo; sin vigente y sin precio aparte; los pack/bulto no cuentan', () => {
  const r = resumenVariacionFraccMd(filasPreciosFraccMd(granelPrecios(), 'sistema'));
  assert.deepStrictEqual(r, { n: 3, suben: 1, bajan: 0, iguales: 1, sinVigente: 1, sinPrecio: 0 });
  const sinCosto = resumenVariacionFraccMd(filasPreciosFraccMd(granelPrecios(), 'ultimaCompra'));
  assert.deepStrictEqual([sinCosto.n, sinCosto.sinPrecio, sinCosto.suben], [3, 3, 0]);
  assert.deepStrictEqual(resumenVariacionFraccMd([]), { n: 0, suben: 0, bajan: 0, iguales: 0, sinVigente: 0, sinPrecio: 0 });
});

test('chipsVariacionFraccMd: un chip por grupo no vacío, en orden subir / bajar / sin cambio / sin vigente / sin precio', () => {
  assert.deepStrictEqual(chipsVariacionFraccMd({ n: 5, suben: 2, bajan: 1, iguales: 0, sinVigente: 1, sinPrecio: 1 }), [
    { estado: 'subir', texto: '2 para subir' }, { estado: 'bajar', texto: '1 para bajar' },
    { estado: 'nd', texto: '1 sin vigente' }, { estado: 'nd', texto: '1 sin precio' }]);
  assert.deepStrictEqual(chipsVariacionFraccMd({ n: 1, suben: 0, bajan: 0, iguales: 1, sinVigente: 0, sinPrecio: 0 }), [{ estado: 'ok', texto: '1 sin cambio' }]);
  assert.deepStrictEqual(chipsVariacionFraccMd({ n: 0, suben: 0, bajan: 0, iguales: 0, sinVigente: 0, sinPrecio: 0 }), []);
});

test('subtituloPreciosFraccMd: "por kg" y con qué costo se calculó (sin decisión: costo sistema, para comparar)', () => {
  assert.strictEqual(subtituloPreciosFraccMd(granelPrecios(), 'sistema'), 'por kg · con costo sistema, para comparar');
  assert.strictEqual(subtituloPreciosFraccMd(granelPrecios({ decision: { fuente: 'ultimaCompra' } }), 'ultimaCompra'), 'por kg · con última compra');
});

test('htmlPreciosFraccMd: tabla con Vigente / Sugerido / Δ $ / Δ % por presentación, peso, PLU y color de suba/baja del listado', () => {
  const html = htmlPreciosFraccMd(granelPrecios(), 'sistema');
  for (const t of ['Presentación', 'Vigente', 'Sugerido', 'Δ \\$', 'Δ %', 'Margen total']) assert.match(html, new RegExp(`<th[^>]*>${t}</th>`));
  const fila = plu => html.match(new RegExp(`<tr class="md-min">(?:(?!</tr>).)*PLU ${plu}(?:(?!</tr>).)*</tr>`))[0];
  const kilo = fila('102');
  assert.match(kilo, /<b>Almendras 1Kg<\/b>/);
  assert.match(kilo, /PLU 102 · 1 kg/);
  assert.match(kilo, /\$ 1\.500/);                                              // vigente
  assert.match(kilo, /\$ 1\.800/);                                              // sugerido
  assert.match(kilo, /<span class="font-semibold text-crit">\+\$ 300<\/span>/);  // Δ $ sube (claseDelta del listado)
  assert.match(kilo, /<span class="font-semibold text-crit">\+20\.0%<\/span>/);  // Δ %
  const igual = fila('101');
  assert.match(igual, /<span class="text-gris">\$ 0<\/span>/);
  assert.match(igual, /<span class="text-gris">0\.0%<\/span>/);
  const sinVig = fila('103');
  assert.match(sinVig, /PLU 103 · 250 g/);
  assert.doesNotMatch(sinVig, /text-crit|text-warn/);                          // sin vigente no hay semáforo
});

test('htmlPreciosFraccMd: pack/bulto de la presentación agrupados (sin IVA con Δ, con IVA sin Δ); baja en color de baja', () => {
  const html = htmlPreciosFraccMd(granelPrecios(), 'sistema');
  const grupo = html.match(/<tr class="md-grp">(?:(?!<\/tr>).)*Bulto(?:(?!<\/tr>).)*<\/tr>/)[0];
  assert.match(grupo, /PLU 201 · Almendras Bulto x6 · × 1/);
  const sinIva = html.match(/<tr class="md-may"><td>Sin IVA<\/td>.*?<\/tr>/)[0];
  assert.match(sinIva, /<span class="font-semibold text-warn">-\$ 7\.460<\/span>/);
  assert.match(sinIva, /<span class="font-semibold text-warn">-82\.9%<\/span>/);
  const conIva = html.match(/<tr class="md-may"><td>Con IVA<\/td>.*?<\/tr>/)[0];
  assert.match(conIva, /\$ 1\.850/);
  assert.doesNotMatch(conIva, /text-crit|text-warn|text-gris/);                // sin vigente ni Δ
});

test('htmlPreciosFraccMd: encabezado con el costo usado, resumen de variación y las filas escapadas', () => {
  const html = htmlPreciosFraccMd(granelPrecios({ decision: { fuente: 'sistema' } }), 'sistema');
  assert.match(html, /Precios de las presentaciones/);
  assert.match(html, /por kg · con costo sistema/);
  assert.doesNotMatch(html, /para comparar/);
  assert.match(html, /<span class="pr-sem sem-subir">1 para subir<\/span>/);
  assert.match(html, /<span class="pr-sem sem-ok">1 sin cambio<\/span>/);
  assert.match(html, /<span class="md-chip-0">1 sin vigente<\/span>/);
  const g = granelPrecios();
  const mala = { ...g, presentaciones: g.presentaciones.map((p, i) => (i === 0 ? { ...p, nombre: 'Pres <img src=x>' } : p)) };
  assert.doesNotMatch(htmlPreciosFraccMd(mala, 'sistema'), /<img/);
  assert.match(htmlPreciosFraccMd(mala, 'sistema'), /Pres &lt;img src=x&gt;/);
});

test('htmlPreciosFraccMd: sin sugerido (error del motor) → "—", sin Δ; sin presentaciones ni canales → mensaje vacío', () => {
  const html = htmlPreciosFraccMd(granelPrecios(), 'ultimaCompra');
  assert.doesNotMatch(html, /text-crit|text-warn/);
  assert.match(html, /<span class="md-chip-0">3 sin precio<\/span>/);
  const vacia = htmlPreciosFraccMd({ plu: '100', nombre: 'Granel', presentaciones: [], mayoristas: [], sugeridos: {} }, 'sistema');
  assert.match(vacia, /<p class="text-gris mt-3">Sin precios para mostrar\.<\/p>/);
  assert.doesNotMatch(vacia, /<table/);
});
