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
  assert.match(html, /<section id="mdAct" class="md-activo md-paso"/);
  assert.match(html, /<p class="md-paso-para">No cambia ningún precio: sólo define si el granel aparece en el listado\.<\/p>/); // para qué sirve el paso
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
const { deltaPesosMd, textoDeltaPesosMd, textoPesoMd, filasPreciosFraccMd, agruparPreciosFraccMd, resumenVariacionFraccMd, chipsVariacionFraccMd,
  subtituloPreciosFraccMd, htmlPreciosFraccMd, htmlColumnasFraccMd } = require('../public/js/precios_modal_fraccionado.js');

// Granel con tres presentaciones (250G sin vigente, 500G igual al vigente con un bulto vinculado, 1Kg que sube) → fila como la manda el detalle.
const granelPrecios = ({ vigentes, decision, vinculos = [{ plu: '201', nombre: 'Almendras Bulto x6', basePlu: '101', cantidad: 6, tipo: 'bulto' }] } = {}) => {
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

// Una tarjeta por presentación (<li class="md-fr-card md-fr-pres">) y, al final, la de los mayoristas del granel (md-fr-granel): se cortan por su apertura.
const cartas = html => html.split('<li class="md-fr-card ').slice(1);
const cartaPres = (html, nombre) => cartas(html).find(c => c.startsWith('md-fr-pres">') && c.includes(`<b>${nombre}</b>`));
const cartaGranel = html => cartas(html).find(c => c.startsWith('md-fr-granel">'));
// Granel con tres presentaciones: la 500G con dos códigos mayoristas (un bulto y un pack), la 1Kg y la 250G sin ninguno, y un bulto del granel mismo.
const VINCULOS_VARIOS = [
  { plu: '201', nombre: 'Almendras Bulto x6', basePlu: '101', cantidad: 6, tipo: 'bulto' },
  { plu: '202', nombre: 'Almendras Pack x2', basePlu: '101', cantidad: 2, tipo: 'pack' },
  { plu: '203', nombre: 'Almendras Bulto 25 kg', basePlu: '100', cantidad: 25, tipo: 'bulto' }];
const VIGENTES_VARIOS = new Map([['101', 1950], ['102', 1500], ['201', 9000], ['202', 3000], ['203', 1100]]);
const granelVarios = () => granelPrecios({ vinculos: VINCULOS_VARIOS, vigentes: VIGENTES_VARIOS });

test('agruparPreciosFraccMd: cada pack/bulto con su presentación (sin IVA + con IVA juntos); los de antes de la primera presentación son del granel; orden por peso', () => {
  const g = agruparPreciosFraccMd(filasPreciosFraccMd(granelVarios(), 'sistema'));
  assert.deepStrictEqual(g.presentaciones.map(p => [p.minorista.plu, p.mayoristas.map(m => [m.tipo, m.plu])]), [
    ['103', []], ['101', [['bulto', '201'], ['pack', '202']]], ['102', []]]);          // 250G, 500G, 1Kg: orden del server (por peso)
  assert.deepStrictEqual(g.granel.map(m => [m.tipo, m.plu, m.nombre, m.unidades]), [['bulto', '203', 'Almendras Bulto 25 kg', 1]]);
  const [bulto] = g.presentaciones[1].mayoristas;
  assert.deepStrictEqual(bulto.filas.map(r => r.conIva), [false, true]);                // la fila sin IVA primero (lleva vigente y Δ), la con IVA después
  assert.ok(g.presentaciones.every(p => p.minorista.tipo === 'minorista'));
});

test('agruparPreciosFraccMd: sin pack/bulto ni presentaciones → grupos vacíos; no muta las filas', () => {
  const filas = filasPreciosFraccMd(granelPrecios({ vinculos: [] }), 'sistema');
  assert.deepStrictEqual(agruparPreciosFraccMd(filas).granel, []);
  assert.ok(agruparPreciosFraccMd(filas).presentaciones.every(p => p.mayoristas.length === 0));
  assert.deepStrictEqual(agruparPreciosFraccMd([]), { granel: [], presentaciones: [] });
  const antes = JSON.stringify(filas);
  agruparPreciosFraccMd(filas);
  assert.strictEqual(JSON.stringify(filas), antes);
});

test('htmlPreciosFraccMd: lista (sin tabla ancha) con nombre, PLU y peso arriba, vigente → sugerido con el Δ % como chip y Δ $ y margen aparte', () => {
  const html = htmlPreciosFraccMd(granelPrecios(), 'sistema');
  assert.doesNotMatch(html, /<table|<th/); // la tarjeta derecha es angosta: sin columnas
  const item = nombre => cartaPres(html, nombre);
  const kilo = item('Almendras 1Kg');
  assert.match(kilo, /<b>Almendras 1Kg<\/b>/);
  assert.match(kilo, /PLU 102 · 1 kg/);
  assert.match(kilo, /<span class="sr-only">Vigente <\/span>\$ 1\.500/);                       // vigente, con su rótulo para lector de pantalla
  assert.match(kilo, /<span class="sr-only">Sugerido <\/span><b class="md-nuevo">\$ 1\.800<\/b>/);
  assert.match(kilo, /<span class="pr-sem sem-subir md-chip"><span aria-hidden="true">▲<\/span>\+20\.0%<\/span>/); // Δ % = chip (el del listado)
  assert.match(kilo, /<span class="font-semibold text-crit">\+\$ 300<\/span>/);                // Δ $ sube (claseDelta del listado)
  assert.match(kilo, /\+\$ 300<\/span> · margen 80 %/);                                          // margen total en la segunda línea
  const igual = item('Almendras 500G');
  assert.match(igual, /<span class="text-gris">\$ 0<\/span>/);
  assert.match(igual, /sem-ok md-chip"><span aria-hidden="true">=<\/span>0\.0%/);
  const sinVig = item('Almendras 250G');
  assert.match(sinVig, /PLU 103 · 250 g/);
  assert.doesNotMatch(sinVig, /text-crit|text-warn|md-chip/);                                // sin vigente no hay semáforo ni chip
  assert.match(sinVig, /<span class="sr-only">Vigente <\/span><span class="md-nd">—<\/span>/);
});

test('htmlPreciosFraccMd: los pack/bulto van DENTRO de la tarjeta de su presentación, en el sub-bloque "Códigos mayoristas" (sin IVA con Δ, con IVA sin Δ); baja en color de baja', () => {
  const html = htmlPreciosFraccMd(granelPrecios(), 'sistema');
  const medio = cartaPres(html, 'Almendras 500G');
  assert.match(medio, /<div class="md-fr-mays-t">Códigos mayoristas<\/div>/);
  assert.ok(medio.indexOf('md-fr-l3') < medio.indexOf('md-fr-mays'));                      // primero la presentación, después lo subordinado
  const codigo = medio.match(/<li class="md-fr-cod">.*?<\/li>/s)[0];
  assert.match(codigo, /<b>Bulto<\/b> <span class="md-sub">PLU 201 · × 1<\/span>/);       // tipo, PLU y unidades
  assert.match(codigo, /<span class="md-warn" title="[^"]*">revisar unidad<\/span>/);       // el aviso queda junto al código
  assert.match(codigo, /<div class="md-fr-cod-nom">Almendras Bulto x6<\/div>/);
  const sinIva = codigo.match(/<div class="md-fr-fila"><span class="md-fr-iva">Sin IVA<\/span>.*?<\/div>(?=<div class="md-fr-fila">|<\/li>)/s)[0];
  assert.match(sinIva, /<span class="font-semibold text-warn">-\$ 7\.460<\/span>/);
  assert.match(sinIva, /sem-bajar md-chip"><span aria-hidden="true">▼<\/span>-82\.9%/);
  const conIva = codigo.match(/<div class="md-fr-fila"><span class="md-fr-iva">Con IVA<\/span>.*?<\/div>/s)[0];
  assert.match(conIva, /\$ 1\.850/);
  assert.doesNotMatch(conIva, /text-crit|text-warn|text-gris|md-chip/);                      // sin vigente ni Δ
  assert.ok(html.indexOf('PLU 201') < html.indexOf('Almendras 1Kg'));                        // el bulto de la 500G está en su tarjeta, antes que la 1Kg
});

test('htmlPreciosFraccMd: una presentación sin pack/bulto no muestra el sub-bloque; varios códigos de una presentación van en su misma tarjeta', () => {
  const html = htmlPreciosFraccMd(granelVarios(), 'sistema');
  assert.strictEqual(cartas(html).filter(c => c.startsWith('md-fr-pres">')).length, 3);      // una tarjeta por presentación
  for (const sin of ['Almendras 250G', 'Almendras 1Kg']) assert.doesNotMatch(cartaPres(html, sin), /md-fr-mays|Códigos mayoristas|PLU 20/);
  const medio = cartaPres(html, 'Almendras 500G');
  assert.deepStrictEqual([...medio.matchAll(/<li class="md-fr-cod">.*?<b>(Bulto|Pack)<\/b> <span class="md-sub">PLU (\d+)/gs)].map(m => [m[1], m[2]]), [['Bulto', '201'], ['Pack', '202']]);
  assert.match(medio, /<ul class="md-fr-cods" aria-label="Códigos mayoristas de Almendras 500G">/); // el lector de pantalla sabe de quién son
});

test('htmlPreciosFraccMd: los pack/bulto del granel van en su propia tarjeta, titulada y al final; ninguna presentación los lleva', () => {
  const html = htmlPreciosFraccMd(granelVarios(), 'sistema');
  const granel = cartaGranel(html);
  assert.match(granel, /<h4 class="md-fr-card-t">Mayoristas del granel <span class="md-sub">· venta por kg<\/span><\/h4>/);
  assert.match(granel, /<b>Bulto<\/b> <span class="md-sub">PLU 203 · × 1<\/span>/);
  assert.match(granel, /Almendras Bulto 25 kg/);
  assert.ok(cartas(html).at(-1).startsWith('md-fr-granel">'));                                // al final, después de todas las presentaciones
  assert.ok(cartas(html).filter(c => c.startsWith('md-fr-pres">')).every(c => !c.includes('PLU 203')));
  assert.doesNotMatch(htmlPreciosFraccMd(granelPrecios(), 'sistema'), /md-fr-granel|Mayoristas del granel/); // sin pack/bulto del granel no hay tarjeta
});

test('htmlPreciosFraccMd: resumen de variación (el título y el subtítulo son del header de la tarjeta) y las filas escapadas', () => {
  assert.strictEqual(subtituloPreciosFraccMd(granelPrecios({ decision: { fuente: 'sistema' } }), 'sistema'), 'por kg · con costo sistema');
  const html = htmlPreciosFraccMd(granelPrecios({ decision: { fuente: 'sistema' } }), 'sistema');
  assert.doesNotMatch(html, /Precios de las presentaciones|por kg/);
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
  assert.match(vacia, /<p class="text-gris">Sin precios para mostrar\.<\/p>/);
  assert.doesNotMatch(vacia, /<ul/);
});

// ── Columna izquierda: lo de abajo de las tarjetas de costo va en dos columnas si hay dos bloques ──
test('htmlColumnasFraccMd: con dos bloques los pone en dos columnas; con uno (sin configuración sólo queda el estado) a ancho completo; sin ninguno, vacío', () => {
  assert.strictEqual(htmlColumnasFraccMd('<i>a</i>', '<i>b</i>'), '<div class="md-fr-cols"><div class="md-fr-col"><i>a</i></div><div class="md-fr-col"><i>b</i></div></div>');
  assert.strictEqual(htmlColumnasFraccMd('', '<i>b</i>'), '<i>b</i>');
  assert.strictEqual(htmlColumnasFraccMd('<i>a</i>', ''), '<i>a</i>');
  assert.strictEqual(htmlColumnasFraccMd('', ''), '');
});

// ── Acordeón "Cómo se conforma el costo y el precio": cuentas alineadas (concepto a la izquierda, importe a la derecha, operadores en columna) ──
const { motivoSinTiempoMd, filasCostoPresFraccMd, htmlCuentaFraccMd, cuentasPrecioFraccMd, htmlTarjetaCostoFraccMd, htmlTarjetaPrecioFraccMd } = require('../public/js/precios_modal_fraccionado.js');

// Presentación costeada de 500 g como la arma el server: mercadería (granel) + 2 insumos + mano de obra + máquina.
const presCosteada = (extra = {}) => ({ plu: '101', nombre: 'Almendra <500G>', pesoG: 500, costos: { sistema: 1618.5 },
  costeoPresentacion: { facilidad: 'normal', tiempo: 'lento', minutosBase: 1, factorTiempo: 1.5, factorFacilidad: 1.25, minutos: 1.875, porUnidad: 309.25, extraKg: 0 }, avisosCosto: [],
  componentesCosto: [
    { plu: '900', nombre: 'Bolsa 500g', rol: 'insumo', cantidad: 1, costoUnit: 20, importe: 20 }, { plu: '901', nombre: 'Etiqueta 500g', rol: 'insumo', cantidad: 1, costoUnit: 8, importe: 8 },
    { plu: '_manoObra', rol: 'mo', cantidad: 1.875, costoUnit: 6000, importe: 187.5 }, { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 1.875, costoUnit: 3000, importe: 93.75 }], ...extra });
const COSTOS_GRANEL = { sistema: 1000 };

test('motivoSinTiempoMd: sólo el motivo; textoSinTiempoMd = concepto — motivo (sin cambios)', () => {
  assert.strictEqual(motivoSinTiempoMd('mo', ['sinSubrubro']), 'sin minutos: el granel no tiene subrubro en SIGA');
  assert.strictEqual(motivoSinTiempoMd('maquina', ['sinMaquina']), 'sin asignar (ni del subrubro ni del granel)');
  assert.strictEqual(textoSinTiempoMd('mo', ['sinTramos']), `Mano de obra — ${motivoSinTiempoMd('mo', ['sinTramos'])}`);
});

test('filasCostoPresFraccMd: mercadería + insumos (con su desglose) + mano de obra + máquina = costo real por unidad ÷ peso = costo real $/kg', () => {
  const filas = filasCostoPresFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL);
  assert.deepStrictEqual(filas.map(r => [r.op || '', r.tipo || '', r.txt, r.det || '', r.v ?? r.u ?? null]), [
    ['', '', 'Mercadería', '0,5 kg × $\u00a01.000,00/kg', 500],
    ['+', '', 'Insumos', '', 28],
    ['', 'sub', 'Bolsa 500g', '1 × $\u00a020,00', 20],
    ['', 'sub', 'Etiqueta 500g', '1 × $\u00a08,00', 8],
    ['+', '', 'Mano de obra', '1 × 1,5 (tiempo) × 1,25 (facilidad) = 1,875 min × $\u00a06.000,00/h', 187.5],
    ['+', '', 'Máquina Envasadora', '1 × 1,5 (tiempo) × 1,25 (facilidad) = 1,875 min × $\u00a03.000,00/h', 93.75],
    ['=', '', 'Costo real por unidad', '', 809.25],
    ['÷', '', 'Peso de la presentación', '', '0,5 kg'],
    ['=', '', 'Costo real $/kg', '', 1618.5]]);
});

test('filasCostoPresFraccMd: sin insumos / sin minutos / sin máquina → renglón gris (nd) con su motivo, importe 0; sin tocar el total', () => {
  const p = presCosteada({ componentesCosto: [], avisosCosto: ['sinInsumos', 'sinTramos'], costeoPresentacion: { facilidad: 'normal', tiempo: 'normal', porUnidad: 0 } });
  const filas = filasCostoPresFraccMd(p, 'sistema', COSTOS_GRANEL);
  const por = txt => filas.find(r => r.txt === txt);
  assert.deepStrictEqual([por('Insumos').tipo, por('Insumos').det, por('Insumos').v], ['nd', 'sin cargar (Configuración › Costeo Fraccionado › Insumos por peso)', 0]);
  assert.deepStrictEqual([por('Mano de obra').tipo, por('Mano de obra').det, por('Mano de obra').v], ['nd', motivoSinTiempoMd('mo', p.avisosCosto), 0]);
  assert.deepStrictEqual([por('Máquina').tipo, por('Máquina').det, por('Máquina').v], ['nd', motivoSinTiempoMd('maquina', p.avisosCosto), 0]);
  assert.strictEqual(filas.find(r => r.txt === 'Costo real $/kg').v, 1618.5);
});

test('filasCostoPresFraccMd: insumo sin costo → costo por unidad sin dato y con su motivo; la mercadería sin costo del granel también', () => {
  const sinCosto = presCosteada({ costeoPresentacion: { facilidad: 'normal', tiempo: 'lento', porUnidad: null }, costos: { sistema: null },
    componentesCosto: [{ plu: '900', nombre: 'Bolsa', rol: 'insumo', cantidad: 1, costoUnit: null, importe: null }] });
  const filas = filasCostoPresFraccMd(sinCosto, 'sistema', { sistema: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Mercadería'), { txt: 'Mercadería', det: '0,5 kg × sin costo', v: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Insumos'), { op: '+', txt: 'Insumos', v: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Bolsa'), { tipo: 'sub', txt: 'Bolsa', det: '1 × sin costo', v: null });
  const unidad = filas.find(r => r.txt === 'Costo real por unidad');
  assert.deepStrictEqual([unidad.det, unidad.v], ['falta el costo de un insumo', null]);
  assert.strictEqual(filas.at(-1).v, null);
});

test('filasCostoPresFraccMd: presentación sin peso en el nombre → sólo mercadería: una nota y el costo $/kg', () => {
  const filas = filasCostoPresFraccMd(presCosteada({ pesoG: null, avisosCosto: ['sinPeso'] }), 'sistema', COSTOS_GRANEL);
  assert.deepStrictEqual(filas, [{ tipo: 'nota', txt: 'Sin peso en el nombre: sólo mercadería' }, { op: '=', txt: 'Costo $/kg', v: 1618.5 }]);
});

test('htmlCuentaFraccMd: operadores en su columna, concepto + detalle, importes con $; el último "=" es el total y los demás subtotales', () => {
  const html = htmlCuentaFraccMd(filasCostoPresFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL));
  assert.match(html, /^<div class="md-cu">/);
  assert.match(html, /<div class="md-cu-f"><span class="md-cu-op" aria-hidden="true"><\/span><span class="md-cu-t">Mercadería<span class="md-cu-d">0,5 kg × \$\u00a01\.000,00\/kg<\/span><\/span><span class="md-cu-v">\$ 500,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-sub"><span class="md-cu-op" aria-hidden="true"><\/span><span class="md-cu-t">Bolsa 500g<span class="md-cu-d">1 × \$\u00a020,00<\/span><\/span><span class="md-cu-v">\$ 20,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-sub-r"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Costo real por unidad<\/span><span class="md-cu-v">\$ 809,25<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f"><span class="md-cu-op" aria-hidden="true">÷<\/span><span class="md-cu-t">Peso de la presentación<\/span><span class="md-cu-v">0,5 kg<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-tot"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Costo real \$\/kg<\/span><span class="md-cu-v">\$ 1\.618,50<\/span><\/div><\/div>$/);
  assert.strictEqual((html.match(/md-cu-tot/g) || []).length, 1);
});

test('htmlCuentaFraccMd: sin dato → "—" gris; renglón nd con su motivo; nota sin importe; escapa lo que viene del server', () => {
  const html = htmlCuentaFraccMd([{ txt: 'A <b>', det: 'x & y', v: null }, { op: '+', txt: 'Insumos', det: 'sin cargar', tipo: 'nd', v: 0 }, { tipo: 'nota', txt: 'incluye ajuste' }, { op: '=', txt: 'Total', v: 5 }]);
  assert.match(html, /<span class="md-cu-t">A &lt;b&gt;<span class="md-cu-d">x &amp; y<\/span><\/span><span class="md-cu-v md-cu-vnd">—<\/span>/);
  assert.match(html, /<div class="md-cu-f md-cu-nd"><span class="md-cu-op" aria-hidden="true">\+<\/span><span class="md-cu-t">Insumos<span class="md-cu-d">sin cargar<\/span><\/span><span class="md-cu-v">\$ 0,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-nota"><span class="md-cu-op" aria-hidden="true"><\/span><span class="md-cu-t">incluye ajuste<\/span><span class="md-cu-v"><\/span><\/div>/);
  assert.doesNotMatch(html, /A <b>/);
});

// Presentación con el desglose del precio por fuente (sólo con permiso) y un bulto propio; el granel, con otro bulto.
const desgloseFr = (costo = 1000) => ({ error: null, costo, gastosPct: 10, costoConGastos: costo * 1.1,
  minorista: { margenPct: 40, neto: 1540, extrasPct: 5, conExtras: 1617, ivaPct: 21, exacto: 1956.57, precio: 1950 },
  porVinculo: { 201: { margenPct: 40, netoUnidad: 1540, unidades: 6, exactoNeto: 9240, neto: 9240, exactoIva: 11180.4, conIva: 11200 }, 203: { margenPct: 30, netoUnidad: 1430, unidades: 1, exactoNeto: 1430, neto: 1430, exactoIva: 1730.3, conIva: 1750 } } });
const presConPrecio = (extra = {}) => presCosteada({ nombre: 'Almendra 500G', sugeridos: { sistema: { desglose: desgloseFr() } },
  mayoristas: [{ tipo: 'bulto', plu: '201', nombre: 'Almendra Bulto x6', unidades: 6 }], ...extra });

test('cuentasPrecioFraccMd: el minorista y cada pack/bulto con su cuenta; sin desglose de la fuente → null', () => {
  const c = cuentasPrecioFraccMd(presConPrecio(), 'sistema');
  assert.deepStrictEqual(c.minorista.map(r => [r.op || '', r.txt, r.v ?? null]), [
    ['', 'Costo real', 1000], ['+', 'Gastos variables 10 %', 1100], ['×', 'Margen 40 %', 1540], ['×', 'Extras minoristas 5 %', 1617], ['×', 'IVA 21 %', 1956.57], ['=', 'Precio redondeado', 1950]]);
  assert.deepStrictEqual(c.mayoristas.map(m => [m.tipo, m.plu, m.unidades, m.filas.at(-1).txt, m.filas.at(-1).v]), [['bulto', '201', 6, 'Con IVA redondeado', 11200]]);
  assert.strictEqual(cuentasPrecioFraccMd(presConPrecio(), 'ultimaCompra'), null);
  assert.strictEqual(cuentasPrecioFraccMd({ nombre: 'sin' }, 'sistema'), null);
  // presentación sin costeo (sin componentes): "Costo de mercadería"
  assert.strictEqual(cuentasPrecioFraccMd(presConPrecio({ componentesCosto: undefined }), 'sistema').minorista[0].txt, 'Costo de mercadería');
});

test('cuentasPrecioFraccMd: el granel no tiene minorista propio (sólo sus pack/bulto); los ajustes del margen salen como notas debajo', () => {
  const granelFila = { plu: '100', nombre: 'Almendras', sugeridos: { sistema: { desglose: desgloseFr() } }, mayoristas: [{ tipo: 'bulto', plu: '203', nombre: 'Bulto 25 kg', unidades: 1 }] };
  const c = cuentasPrecioFraccMd(granelFila, 'sistema', { minorista: false });
  assert.strictEqual(c.minorista, null);
  assert.deepStrictEqual(c.mayoristas.map(m => [m.plu, m.filas.length]), [['203', 6]]);
  const d = desgloseFr(); d.minorista = { ...d.minorista, margenEspecialPct: 5 };
  const conAjuste = cuentasPrecioFraccMd({ ...presConPrecio(), sugeridos: { sistema: { desglose: d } } }, 'sistema').minorista;
  assert.match(conAjuste.find(r => r.tipo === 'nota').txt, /^incluye margen especial del producto \+5 %/);
});

test('htmlTarjetaCostoFraccMd / htmlTarjetaPrecioFraccMd: una mini-tarjeta por presentación con su cabecera (nombre, PLU, peso, facilidad · tiempo) y la cuenta', () => {
  const costo = htmlTarjetaCostoFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL);
  assert.match(costo, /^<li class="md-dt-card"><div class="md-dt-cab"><b>Almendra &lt;500G&gt;<\/b><span class="md-chip-0" title="Facilidad y tiempo del subrubro con que se costeó">Normal · Lento<\/span><\/div><div class="md-sub md-dt-sub">PLU 101 · 500 g<\/div><div class="md-cu">/);
  assert.match(costo, /md-cu-tot/);
  const precio = htmlTarjetaPrecioFraccMd(presConPrecio(), 'sistema');
  assert.match(precio, /^<li class="md-dt-card"><div class="md-dt-cab"><b>Almendra 500G<\/b><\/div><div class="md-sub md-dt-sub">Minorista · PLU 101 · 500 g<\/div><div class="md-cu">/);
  assert.match(precio, /<div class="md-dt-canal"><b>Bulto<\/b> <span class="md-sub">PLU 201 · × 6<\/span><div class="md-dt-canal-nom">Almendra Bulto x6<\/div><\/div><div class="md-cu">/);
  assert.match(precio, /Precio redondeado/);
  assert.match(precio, /Con IVA redondeado/);
  assert.match(htmlTarjetaPrecioFraccMd(presConPrecio(), 'ultimaCompra'), /Sin desglose para esta fuente\./);
});
