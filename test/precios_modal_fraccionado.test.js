'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoElegidoMd, textosMinKgMd, bodyGranelMd } = require('../public/js/precios_modal_fraccionado.js');

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

test('opcionesMaquinaMd: "Sin máquina" por defecto + cada máquina de la config, la del granel seleccionada y escapada', () => {
  const html = opcionesMaquinaMd([{ id: 'env', nombre: 'Envasadora <A>' }], 'env');
  assert.match(html, /^<option value="">Sin máquina<\/option>/);
  assert.match(html, /<option value="env" selected>Envasadora &lt;A&gt;<\/option>/);
  assert.doesNotMatch(opcionesMaquinaMd([{ id: 'env', nombre: 'E' }], null), /selected/); // sin máquina: nada elegido
  assert.strictEqual(opcionesMaquinaMd([], null), '<option value="">Sin máquina</option>');
  assert.doesNotMatch(html, /subrubro/i); // ya no hay máquina por subrubro
});

test('formulaMinutosMd: "(min/kg ± ajuste) min/kg × kg = minutos"; sin ajuste no hay paréntesis; sin min/kg sólo los minutos', () => {
  assert.strictEqual(formulaMinutosMd({ minKg: 2, ajusteMinKg: 3 }, 2.5, 0.5), '(2 + 3) min/kg × 0,5 kg = 2,5 min');
  assert.strictEqual(formulaMinutosMd({ minKg: 4, ajusteMinKg: -1.5 }, 1.25, 0.5), '(4 - 1,5) min/kg × 0,5 kg = 1,25 min');
  assert.strictEqual(formulaMinutosMd({ minKg: 2, ajusteMinKg: 0 }, 2, 1), '2 min/kg × 1 kg = 2 min');
  assert.strictEqual(formulaMinutosMd({ minKg: 0, ajusteMinKg: 3 }, 0.75, 0.25), '(0 + 3) min/kg × 0,25 kg = 0,75 min'); // propio 0 vale
  assert.strictEqual(formulaMinutosMd({ minKg: null }, 2, 1), '2 min');
  assert.doesNotMatch(formulaMinutosMd({ minKg: 2, ajusteMinKg: 3 }, 2.5, 0.5), /facilidad/i);
});

test('motivoSinMinutosMd: sin min/kg manda a cargarlo (subrubro o propio); con min/kg pero 0 minutos lo explica; textos sin "facilidad"', () => {
  assert.strictEqual(motivoSinMinutosMd(['sinMinutos', 'sinBolsa']),
    'sin minutos (cargá el min/kg del subrubro en Configuración › Costeo Fraccionado o el propio del producto acá)');
  assert.strictEqual(motivoSinMinutosMd([]), 'sin minutos: el min/kg más el ajuste del tramo de peso da 0');
  assert.strictEqual(motivoSinMinutosMd(undefined), 'sin minutos: el min/kg más el ajuste del tramo de peso da 0');
  assert.doesNotMatch(motivoSinMinutosMd(['sinMinutos']) + motivoSinMinutosMd([]), /facilidad|tramos del subrubro/i);
});

test('textoElegidoMd: min/kg con que se costeó, su ajuste de tramo y de dónde sale; sin min/kg lo dice', () => {
  assert.strictEqual(textoElegidoMd({ minKg: 2, minKgOrigen: 'subrubro', ajusteMinKg: 3 }), '2 min/kg (+3 por tramo) · del subrubro');
  assert.strictEqual(textoElegidoMd({ minKg: 0, minKgOrigen: 'granel', ajusteMinKg: -1.5 }), '0 min/kg (-1,5 por tramo) · propio del producto');
  assert.strictEqual(textoElegidoMd({ minKg: 1.5, minKgOrigen: 'granel', ajusteMinKg: 0 }), '1,5 min/kg · propio del producto');
  assert.strictEqual(textoElegidoMd({ minKg: null, minKgOrigen: null, ajusteMinKg: 0 }), 'sin min/kg');
  assert.strictEqual(textoElegidoMd(undefined), 'sin min/kg');
  assert.doesNotMatch(textoElegidoMd({ minKg: 2, minKgOrigen: 'subrubro', ajusteMinKg: 3 }), /facilidad/i);
});

test('textosMinKgMd: cuál min/kg se usa hoy (propio o del subrubro) y qué hereda si se deja vacío', () => {
  const g = (extra = {}) => ({ minKgPropio: null, minKgSubrubro: 2, minKgOrigen: 'subrubro', subrubroId: 7, subrubro: 'Frutos secos', ...extra });
  assert.deepStrictEqual(textosMinKgMd(g()), { usado: 'Hoy se usa 2 min/kg, del subrubro Frutos secos.', herencia: 'Vacío = hereda 2 min/kg del subrubro Frutos secos.' });
  const propio = textosMinKgMd(g({ minKgPropio: 4, minKgOrigen: 'granel' }));
  assert.strictEqual(propio.usado, 'Hoy se usa 4 min/kg, propio de este producto.');
  assert.strictEqual(propio.herencia, 'Vacío = hereda 2 min/kg del subrubro Frutos secos.'); // lo heredado se ve aunque el propio lo pise
  assert.strictEqual(textosMinKgMd(g({ minKgPropio: 0, minKgOrigen: 'granel' })).usado, 'Hoy se usa 0 min/kg, propio de este producto.'); // 0 vale
  const sin = textosMinKgMd(g({ minKgSubrubro: null, minKgOrigen: null }));
  assert.strictEqual(sin.usado, 'Hoy no hay min/kg: sin minutos no suma mano de obra ni máquina.');
  assert.strictEqual(sin.herencia, 'Vacío = hereda el del subrubro Frutos secos, que todavía no tiene min/kg.');
  assert.strictEqual(textosMinKgMd(g({ minKgSubrubro: null, minKgOrigen: null, subrubroId: null, subrubro: null })).herencia,
    'Vacío = hereda el del subrubro, pero este granel no tiene subrubro en SIGA.');
});

test('bodyGranelMd: min/kg vacío → null (hereda), número 0 a 600 (coma o punto); máquina "" → null; fuera de rango o texto → error sin body', () => {
  assert.deepStrictEqual(bodyGranelMd('', ''), { body: { minKg: null, maquinaId: null, envase: 'bolsa' } });
  assert.deepStrictEqual(bodyGranelMd('  ', 'env'), { body: { minKg: null, maquinaId: 'env', envase: 'bolsa' } });
  assert.deepStrictEqual(bodyGranelMd('0', ''), { body: { minKg: 0, maquinaId: null, envase: 'bolsa' } });      // 0 es un valor válido: pisa al subrubro
  assert.deepStrictEqual(bodyGranelMd('1,5', 'env', 'bobina'), { body: { minKg: 1.5, maquinaId: 'env', envase: 'bobina' } });
  assert.deepStrictEqual(bodyGranelMd('600', ''), { body: { minKg: 600, maquinaId: null, envase: 'bolsa' } });
  for (const otro of [undefined, null, '', 'bolsa', 'Bobina', 'otra']) assert.strictEqual(bodyGranelMd('', '', otro).body.envase, 'bolsa', String(otro)); // todo lo que no es 'bobina' = bolsa
  for (const mal of ['-1', '600,01', 'abc', '1e999']) assert.deepStrictEqual(bodyGranelMd(mal, ''), { error: 'Min por kg: un número de 0 a 600 (vacío = hereda el del subrubro)' }, mal);
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
    ['Bulto sin IVA', '201', null, 9000, 654.89, -8345.11, -92.7],               // el Δ vs vigente va en la fila sin IVA; bulto de la 500G por paquete (× 0,5, 2026-11-05)
    ['Bulto con IVA', '201', null, null, 800, null, null],                    // con IVA no tiene vigente: sin Δ
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
  assert.match(codigo, /<b>Bulto<\/b> <span class="md-sub">PLU 201 · × 0\.5<\/span>/);     // tipo, PLU y unidades (por paquete: peso de la 500G, 2026-11-05)
  assert.match(codigo, /<span class="md-warn" title="[^"]*">revisar unidad<\/span>/);       // el aviso queda junto al código
  assert.match(codigo, /<div class="md-fr-cod-nom">Almendras Bulto x6<\/div>/);
  const sinIva = codigo.match(/<div class="md-fr-fila"><span class="md-fr-iva">Sin IVA<\/span>.*?<\/div>(?=<div class="md-fr-fila">|<\/li>)/s)[0];
  assert.match(sinIva, /<span class="font-semibold text-warn">-\$ 8\.345,11<\/span>/); // bulto por descuento (2026-11-04), por paquete × 0,5 (2026-11-05)
  assert.match(sinIva, /sem-bajar md-chip"><span aria-hidden="true">▼<\/span>-92\.7%/);
  const conIva = codigo.match(/<div class="md-fr-fila"><span class="md-fr-iva">Con IVA<\/span>.*?<\/div>/s)[0];
  assert.match(conIva, /\$ 800/);
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
const { opcionesEnvaseMd, motivoSinMinutosMd, filasCostoPresFraccMd, htmlCuentaFraccMd, cuentasPrecioFraccMd, htmlTarjetaCostoFraccMd, htmlTarjetaPrecioFraccMd } = require('../public/js/precios_modal_fraccionado.js');

// Presentación costeada de 500 g como la arma el server: mercadería (granel) + envase (bolsa) + mano de obra + máquina del granel.
// min/kg 2 (del subrubro) + ajuste +3 del tramo = (2 + 3) × 0,5 kg = 2,5 min.
const presCosteada = (extra = {}) => ({ plu: '101', nombre: 'Almendra <500G>', pesoG: 500, costos: { sistema: 1806 },
  costeoPresentacion: { minutos: 2.5, minKg: 2, minKgOrigen: 'subrubro', ajusteMinKg: 3, porUnidad: 403, extraKg: 806 }, avisosCosto: [],
  componentesCosto: [
    { plu: '900', nombre: 'Bolsa 500g', rol: 'insumo', origen: 'bolsa', cantidad: 1, costoUnit: 28, importe: 28 },
    { plu: '_manoObra', rol: 'mo', cantidad: 2.5, costoUnit: 6000, importe: 250 }, { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 2.5, costoUnit: 3000, importe: 125 }], ...extra });
const COSTOS_GRANEL = { sistema: 1000 };
const sinLineaMaquina = p => ({ ...p, componentesCosto: p.componentesCosto.filter(l => l.rol !== 'maquina') });

test('filasCostoPresFraccMd: mercadería + envase (con su desglose) + mano de obra + máquina = costo real por unidad ÷ peso = costo real $/kg', () => {
  const filas = filasCostoPresFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL);
  assert.deepStrictEqual(filas.map(r => [r.op || '', r.tipo || '', r.txt, r.det || '', r.v ?? r.u ?? null]), [
    ['', '', 'Mercadería', '0,5 kg × $ 1.000,00/kg', 500],
    ['+', '', 'Envase', '', 28],
    ['', 'sub', 'Bolsa 500g', '1 × $ 28,00', 28],
    ['+', '', 'Mano de obra', '(2 + 3) min/kg × 0,5 kg = 2,5 min × $ 6.000,00/h', 250],
    ['+', '', 'Máquina Envasadora', '(2 + 3) min/kg × 0,5 kg = 2,5 min × $ 3.000,00/h', 125],
    ['=', '', 'Costo real por unidad', '', 903],
    ['÷', '', 'Peso de la presentación', '', '0,5 kg'],
    ['=', '', 'Costo real $/kg', '', 1806]]);
});

test('filasCostoPresFraccMd: sin máquina en el granel no hay línea de máquina ni renglón gris (es el estado normal); la mano de obra sigue', () => {
  const filas = filasCostoPresFraccMd(sinLineaMaquina(presCosteada()), 'sistema', COSTOS_GRANEL);
  assert.ok(!filas.some(r => /Máquina/.test(r.txt)), 'sobra la línea de máquina');
  assert.ok(filas.some(r => r.txt === 'Mano de obra' && r.v === 250));
  assert.ok(!filas.some(r => r.tipo === 'nd'));
});

test('filasCostoPresFraccMd: min/kg propio 0 con ajuste +3 muestra (0 + 3) min/kg; sin ajuste, "2 min/kg × kg"; el detalle nunca habla de facilidad', () => {
  const mo = (c, cantidad, importe, pesoG) => filasCostoPresFraccMd(presCosteada({ pesoG, costeoPresentacion: { ...presCosteada().costeoPresentacion, ...c },
    componentesCosto: [{ plu: '_manoObra', rol: 'mo', cantidad, costoUnit: 6000, importe }] }), 'sistema', COSTOS_GRANEL).find(r => r.txt === 'Mano de obra').det;
  assert.match(mo({ minutos: 0.75, minKg: 0, minKgOrigen: 'granel', ajusteMinKg: 3 }, 0.75, 75, 250), /^\(0 \+ 3\) min\/kg × 0,25 kg = 0,75 min × /);
  assert.match(mo({ minutos: 1, minKg: 2, ajusteMinKg: 0 }, 1, 100, 500), /^2 min\/kg × 0,5 kg = 1 min × /);
  assert.doesNotMatch(mo({ minutos: 1, minKg: 2, ajusteMinKg: 0 }, 1, 100, 500), /facilidad/i);
});

test('filasCostoPresFraccMd: sin bolsa / sin minutos → renglón gris (nd) con su motivo, importe 0; sin máquina no hay renglón; sin tocar el total', () => {
  const p = presCosteada({ componentesCosto: [], avisosCosto: ['sinMinutos', 'sinBolsa'],
    costeoPresentacion: { minutos: 0, minKg: null, minKgOrigen: null, ajusteMinKg: 0, porUnidad: 0 }, costos: { sistema: 1000 } });
  const filas = filasCostoPresFraccMd(p, 'sistema', COSTOS_GRANEL);
  const por = txt => filas.find(r => r.txt === txt);
  assert.deepStrictEqual([por('Envase').tipo, por('Envase').det, por('Envase').v], ['nd', 'sin bolsa cargada para este peso', 0]);
  assert.deepStrictEqual([por('Mano de obra').tipo, por('Mano de obra').det, por('Mano de obra').v], ['nd', motivoSinMinutosMd(p.avisosCosto), 0]);
  assert.strictEqual(por('Máquina'), undefined);
  assert.strictEqual(filas.find(r => r.txt === 'Costo real $/kg').v, 1000);
});

test('filasCostoPresFraccMd: bolsa sin costo → costo por unidad sin dato y con su motivo; la mercadería sin costo del granel también', () => {
  const sinCosto = presCosteada({ costeoPresentacion: { minutos: 0, minKg: 2, minKgOrigen: 'subrubro', ajusteMinKg: 0, porUnidad: null }, costos: { sistema: null },
    componentesCosto: [{ plu: '900', nombre: 'Bolsa', rol: 'insumo', origen: 'bolsa', cantidad: 1, costoUnit: null, importe: null }] });
  const filas = filasCostoPresFraccMd(sinCosto, 'sistema', { sistema: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Mercadería'), { txt: 'Mercadería', det: '0,5 kg × sin costo', v: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Envase'), { op: '+', txt: 'Envase', v: null });
  assert.deepStrictEqual(filas.find(r => r.txt === 'Bolsa'), { tipo: 'sub', txt: 'Bolsa', det: '1 × sin costo', v: null });
  const unidad = filas.find(r => r.txt === 'Costo real por unidad');
  assert.deepStrictEqual([unidad.det, unidad.v], ['falta el costo del envase', null]);
  assert.strictEqual(filas.at(-1).v, null);
});

test('filasCostoPresFraccMd: presentación sin peso en el nombre → sólo mercadería: una nota y el costo $/kg', () => {
  const filas = filasCostoPresFraccMd(presCosteada({ pesoG: null, avisosCosto: ['sinPeso'] }), 'sistema', COSTOS_GRANEL);
  assert.deepStrictEqual(filas, [{ tipo: 'nota', txt: 'Sin peso en el nombre: sólo mercadería' }, { op: '=', txt: 'Costo $/kg', v: 1806 }]);
});

test('htmlCuentaFraccMd: operadores en su columna, concepto + detalle, importes con $; el último "=" es el total y los demás subtotales', () => {
  const html = htmlCuentaFraccMd(filasCostoPresFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL));
  assert.match(html, /^<div class="md-cu">/);
  assert.match(html, /<div class="md-cu-f"><span class="md-cu-op" aria-hidden="true"><\/span><span class="md-cu-t">Mercadería<span class="md-cu-d">0,5 kg × \$\u00a01\.000,00\/kg<\/span><\/span><span class="md-cu-v">\$ 500,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-sub"><span class="md-cu-op" aria-hidden="true"><\/span><span class="md-cu-t">Bolsa 500g<span class="md-cu-d">1 × \$\u00a028,00<\/span><\/span><span class="md-cu-v">\$ 28,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-sub-r"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Costo real por unidad<\/span><span class="md-cu-v">\$ 903,00<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f"><span class="md-cu-op" aria-hidden="true">÷<\/span><span class="md-cu-t">Peso de la presentación<\/span><span class="md-cu-v">0,5 kg<\/span><\/div>/);
  assert.match(html, /<div class="md-cu-f md-cu-tot"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Costo real \$\/kg<\/span><span class="md-cu-v">\$ 1\.806,00<\/span><\/div><\/div>$/);
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

test('htmlTarjetaCostoFraccMd / htmlTarjetaPrecioFraccMd: una mini-tarjeta por presentación con su cabecera (nombre, PLU, peso, min/kg) y la cuenta', () => {
  const costo = htmlTarjetaCostoFraccMd(presCosteada(), 'sistema', COSTOS_GRANEL);
  assert.match(costo, /^<li class="md-dt-card"><div class="md-dt-cab"><b>Almendra &lt;500G&gt;<\/b><span class="md-chip-0" title="[^"]*">2 min\/kg \(\+3 por tramo\) · del subrubro<\/span><\/div><div class="md-sub md-dt-sub">PLU 101 · 500 g<\/div><div class="md-cu">/);
  assert.match(costo, /md-cu-tot/);
  const precio = htmlTarjetaPrecioFraccMd(presConPrecio(), 'sistema');
  assert.match(precio, /^<li class="md-dt-card"><div class="md-dt-cab"><b>Almendra 500G<\/b><\/div><div class="md-sub md-dt-sub">Minorista · PLU 101 · 500 g<\/div><div class="md-cu">/);
  assert.match(precio, /<div class="md-dt-canal"><b>Bulto<\/b> <span class="md-sub">PLU 201 · × 6<\/span><div class="md-dt-canal-nom">Almendra Bulto x6<\/div><\/div><div class="md-cu">/);
  assert.match(precio, /Precio redondeado/);
  assert.match(precio, /Con IVA redondeado/);
  assert.match(htmlTarjetaPrecioFraccMd(presConPrecio(), 'ultimaCompra'), /Sin desglose para esta fuente\./);
});

test('filasCostoPresFraccMd: bobina → "Bobina 0,008 kg (8 g de bolsa) × $ 6.000,00/kg"; sin $/kg "sin costo" y falta el costo del envase', () => {
  // Arrange
  const bob = (costoUnit, importe) => presCosteada({ componentesCosto: [{ plu: '_bobina', nombre: 'Bobina', rol: 'insumo', origen: 'bobina', cantidad: 0.008, costoUnit, importe }],
    costeoPresentacion: { minutos: 0, minKg: null, minKgOrigen: null, ajusteMinKg: 0, porUnidad: importe }, avisosCosto: ['sinMinutos'] });
  // Act
  const ok = filasCostoPresFraccMd(bob(6000, 48), 'sistema', COSTOS_GRANEL);
  const falta = filasCostoPresFraccMd(bob(null, null), 'sistema', COSTOS_GRANEL);
  // Assert
  assert.deepStrictEqual(ok.find(r => r.txt === 'Bobina'), { tipo: 'sub', txt: 'Bobina', det: '0,008 kg (8 g de bolsa) × $ 6.000,00/kg', v: 48 });
  assert.deepStrictEqual(ok.find(r => r.txt === 'Envase'), { op: '+', txt: 'Envase', v: 48 });
  assert.deepStrictEqual(falta.find(r => r.txt === 'Bobina').det, '0,008 kg (8 g de bolsa) × sin costo');
  assert.strictEqual(falta.find(r => r.txt === 'Costo real por unidad').det, 'falta el costo del envase');
});

test('filasCostoPresFraccMd: bolsa sin nombre de SIGA → "Bolsa PLU 900"; nombre sin "Bolsa" adelante lo suma; sinBobina y sin aviso tienen su motivo', () => {
  const env = l => filasCostoPresFraccMd(presCosteada({ componentesCosto: [{ rol: 'insumo', origen: 'bolsa', cantidad: 1, costoUnit: 5, importe: 5, ...l }] }), 'sistema', COSTOS_GRANEL)[2].txt;
  assert.deepStrictEqual([env({ plu: '900', nombre: null }), env({ plu: '900', nombre: 'Polietileno 20x30' }), env({ plu: '900', nombre: 'BOLSA 1kg' })],
    ['Bolsa PLU 900', 'Bolsa Polietileno 20x30', 'BOLSA 1kg']);
  const sinBob = filasCostoPresFraccMd(presCosteada({ componentesCosto: [], avisosCosto: ['sinBobina'] }), 'sistema', COSTOS_GRANEL);
  assert.strictEqual(sinBob.find(r => r.txt === 'Envase').det, 'sin peso de bolsa para este peso');
  const sinNada = filasCostoPresFraccMd(presCosteada({ componentesCosto: [], avisosCosto: [] }), 'sistema', COSTOS_GRANEL);
  assert.strictEqual(sinNada.find(r => r.txt === 'Envase').det, 'sin envase cargado');
});

test('opcionesEnvaseMd: bolsa por defecto (también con undefined o un valor raro); bobina sólo si lo es', () => {
  const sel = h => (h.match(/<option value="(\w+)" selected>/) || [])[1];
  assert.deepStrictEqual(['bobina', undefined, null, 'bolsa', 'otra'].map(v => sel(opcionesEnvaseMd(v))), ['bobina', 'bolsa', 'bolsa', 'bolsa', 'bolsa']);
});

test('htmlTarjetaCostoFraccMd: el nombre de la bolsa con HTML sale escapado en el desglose', () => {
  const html = htmlTarjetaCostoFraccMd(presCosteada({ componentesCosto: [{ plu: '900', nombre: 'Bolsa <img src=x onerror=alert(1)>', rol: 'insumo', origen: 'bolsa', cantidad: 1, costoUnit: 5, importe: 5 }] }), 'sistema', COSTOS_GRANEL);
  assert.ok(!html.includes('<img'));
  assert.match(html, /Bolsa &lt;img/);
});

test('htmlPreciosFraccMd: cada tarjeta de presentación dice Mayorista (por peso / marcada a mano) o Minorista; sin dato del server no dice nada', () => {
  const g = granelPrecios();
  const marcas = { 101: { mayorista: true, mayoristaOrigen: 'peso' }, 102: { mayorista: true, mayoristaOrigen: 'manual' }, 103: { mayorista: false, mayoristaOrigen: null } };
  const html = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(p => ({ ...p, ...marcas[p.plu] })) }, 'sistema');
  assert.match(cartaPres(html, 'Almendras 500G'), /Mayorista · Bulto \(por peso\)/); // sin mayoristaTipo = bulto
  assert.match(cartaPres(html, 'Almendras 1Kg'), /Mayorista · Bulto \(marcada a mano\)/);
  const pack = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(p => ({ ...p, mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' })) }, 'sistema');
  assert.match(cartaPres(pack, 'Almendras 500G'), /Mayorista · Pack \(marcada a mano\)/);
  assert.match(cartaPres(html, 'Almendras 250G'), /<span>Minorista<\/span>/);
  const sin = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(({ mayorista, mayoristaOrigen, ...p }) => p) }, 'sistema');
  assert.doesNotMatch(sin, />Minorista<|Mayorista \(/);
});

test('htmlActividadFraccMd: leyenda "Activo por presentación" solo con activoPorPresentaciones', () => {
  const { htmlActividadFraccMd } = require('../public/js/precios_modal_fraccionado.js');
  const f = { plu: '100', nombre: 'Almendras', reefer: false, activo: true, activoManual: null };
  const con = htmlActividadFraccMd({ ...f, actividad: { auto: 'activo', motivos: [], activoPorPresentaciones: true } });
  assert.match(con, /title="El granel no tuvo movimientos propios en el último año, pero una presentación sí\.">Activo por presentación</);
  assert.doesNotMatch(htmlActividadFraccMd({ ...f, actividad: { auto: 'activo', motivos: [], activoPorPresentaciones: false } }), /Activo por presentación/);
  assert.doesNotMatch(htmlActividadFraccMd(f), /Activo por presentación/);
});

test('htmlActividadFraccMd: leyenda "Activo por stock" solo con activoPorStock', () => {
  const { htmlActividadFraccMd } = require('../public/js/precios_modal_fraccionado.js');
  const f = { plu: '100', nombre: 'Almendras', reefer: false, activo: true, activoManual: null };
  const con = htmlActividadFraccMd({ ...f, actividad: { auto: 'activo', motivos: [], activoPorStock: true, stockPresentaciones: 7, sucursalesConStock: [2] } });
  assert.match(con, /title="Sin movimientos recientes, pero hay stock en 1 sucursal\(es\): 7 unidades">Activo por stock</);
  assert.doesNotMatch(htmlActividadFraccMd({ ...f, actividad: { auto: 'activo', motivos: [], activoPorStock: false } }), /Activo por stock/);
  assert.doesNotMatch(htmlActividadFraccMd(f), /Activo por stock/);
});

test('htmlActividadFraccMd: estado y botón según actividad; sin botón en REEFER y sin granel', () => {
  const { htmlActividadFraccMd } = require('../public/js/precios_modal_fraccionado.js');
  const base = { plu: '100', nombre: 'Almendras', reefer: false, actividad: { auto: 'activo', motivos: [] } };
  const activo = htmlActividadFraccMd({ ...base, activo: true, activoManual: null });
  assert.match(activo, />Activo</); assert.match(activo, /Automático/); assert.match(activo, /data-valor="false"[^>]*>Desactivar/); assert.doesNotMatch(activo, /Volver a automático/);
  assert.match(activo, /solo-config/);
  const inactivo = htmlActividadFraccMd({ ...base, activo: false, activoManual: false });
  assert.match(inactivo, />Inactivo</); assert.match(inactivo, /Fijado a mano/); assert.match(inactivo, /data-valor="true"[^>]*>Activar/); assert.match(inactivo, /data-valor="null"[^>]*>Volver a automático/);
  assert.strictEqual(htmlActividadFraccMd({ ...base, reefer: true, activo: true }), '');
  assert.strictEqual(htmlActividadFraccMd({ ...base, plu: null }), '');
});

test('htmlPreciosFraccMd: control Minorista | Mayorista · Pack | Mayorista · Bulto con el estado efectivo; "Volver a automático" sólo si la marca es manual; sin PLU no hay toggle', () => {
  const g = granelPrecios();
  const marcas = { 101: { mayorista: true, mayoristaOrigen: 'peso' }, 102: { mayorista: true, mayoristaOrigen: 'manual' }, 103: { mayorista: false, mayoristaOrigen: null } };
  const html = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(p => ({ ...p, ...marcas[p.plu] })) }, 'sistema');
  const peso = cartaPres(html, 'Almendras 500G'), manual = cartaPres(html, 'Almendras 1Kg'), minor = cartaPres(html, 'Almendras 250G');
  assert.match(peso, /solo-config/);
  assert.match(peso, /data-valor="&quot;bulto&quot;" aria-pressed="true" aria-label="Mayorista · Bulto: /); assert.match(peso, /data-valor="&quot;pack&quot;" aria-pressed="false"/); assert.match(peso, /data-valor="false" aria-pressed="false"/);
  assert.doesNotMatch(peso, /Volver a automático/);
  assert.match(manual, /data-valor="null"[^>]*>Volver a automático/);
  assert.match(minor, /data-valor="false" aria-pressed="true"/); assert.match(minor, /data-valor="&quot;pack&quot;" aria-pressed="false"/); assert.match(minor, /data-valor="&quot;bulto&quot;" aria-pressed="false"/);
  const esPack = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(p => ({ ...p, mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' })) }, 'sistema');
  assert.match(cartaPres(esPack, 'Almendras 500G'), /data-valor="&quot;pack&quot;" aria-pressed="true"/);
  const sinPlu = htmlPreciosFraccMd({ ...g, presentaciones: g.presentaciones.map(p => ({ ...p, plu: p.plu, mayorista: true, mayoristaOrigen: 'peso' })) }, 'sistema');
  assert.ok(sinPlu.includes('md-may'));
});

// ── Precio mayorista en la card de la presentación y en "Cómo se conforma" (sugerido = bulto SIN IVA) ──
const { datosMayoristaFraccMd, htmlBloqueMayoristaFraccMd, pasosMinoristaFraccMd } = require('../public/js/precios_modal_fraccionado.js');
const MIN_MAY_MD = { precio: 1300, margenTotalPct: 18.2, deltaPct: -0.05, estado: 'bajar', minoristaOriginal: 2000, minoristaOriginalNeto: 1652.89,
  pack: { neto: 1487.6, conIva: 1800, margenPct: 31.4 }, bulto: { neto: 1300, conIva: 1573, margenPct: 18.2 } };
const MAYORISTA_DESGLOSE = { base: 1652.89, descPackPct: 10, descBultoPct: 10,
  pack: { descuentoMayoristaPct: 10, neto: 1487.6, precio: 1487.6, exactoIva: 1800, conIva: 1800, margenPct: 31.4 }, bulto: { descuentoMayoristaPct: 19, neto: 1300, precio: 1300, exactoIva: 1573, conIva: 1573, margenPct: 18.2 } };
const DESGLOSE_MAY = { costo: 1000, gastosPct: 5, costoConGastos: 1050, porVinculo: {}, minorista: { margenPct: 18.2, neto: 1652.89, extrasPct: 0, conExtras: 1652.89, ivaPct: 21, exacto: 1300, precio: 1300, sinIva: true,
  minoristaOriginal: { margenPct: 57.4, exacto: 2000, precio: 2000 }, mayorista: MAYORISTA_DESGLOSE, calculoMayorista: 'descuento' } };
const presMay = (extra = {}, sug = {}) => ({ plu: '51', nombre: 'A 500G', mayorista: true, sugeridos: { sistema: { minorista: MIN_MAY_MD, ...sug } }, ...extra });

test('datosMayoristaFraccMd: sin desglose, sólo lo público (bulto sin IVA = sugerido, pack, antes, márgenes); con desglose suma base y descuentos', () => {
  const pub = datosMayoristaFraccMd(presMay(), 'sistema');
  assert.deepStrictEqual([pub.conDesglose, pub.base, pub.bultoNeto, pub.bultoIva, pub.packIva, pub.packNeto, pub.antes, pub.packMargenPct, pub.bultoMargenPct], [false, null, 1300, 1573, 1800, 1487.6, 2000, 31.4, 18.2]);
  const full = datosMayoristaFraccMd(presMay({}, { desglose: DESGLOSE_MAY }), 'sistema');
  assert.deepStrictEqual([full.conDesglose, full.base, full.descPackPct, full.descBultoPct], [true, 1652.89, 10, 10]);
});
test('datosMayoristaFraccMd: minorista, sin precio → null; mayorista sin descuento (margen fijo) → { fijo }', () => {
  assert.strictEqual(datosMayoristaFraccMd({ ...presMay(), mayorista: false }, 'sistema'), null);
  assert.strictEqual(datosMayoristaFraccMd(presMay(), 'ultimaCompra'), null);
  assert.strictEqual(datosMayoristaFraccMd({ mayorista: true, sugeridos: { sistema: { error: 'margen' } } }, 'sistema'), null);
  assert.deepStrictEqual(datosMayoristaFraccMd({ mayorista: true, sugeridos: { sistema: { minorista: { precio: 1800 } } } }, 'sistema'), { fijo: true });
});
test('htmlBloqueMayoristaFraccMd: el bulto sin IVA es el resultado (negrita); con y sin desglose, margen fijo y vacío; la tarjeta lo incluye sólo si es mayorista', () => {
  const full = htmlBloqueMayoristaFraccMd(datosMayoristaFraccMd(presMay({}, { desglose: DESGLOSE_MAY }), 'sistema'));
  for (const re of [/Precio mayorista/, /Minorista por kg, sin IVA \(base\)/, /Pack \(−10 %\)/, /Bulto sin IVA \(sugerido, −10 % sobre el pack\)/, /<b class="md-nuevo">\$ 1\.300<\/b>/,
    /margen 31,4 %/, /margen 18,2 %/, /Minorista anterior \(con IVA\)/, /<s>\$ 2\.000<\/s>/]) assert.match(full, re);
  const pub = htmlBloqueMayoristaFraccMd(datosMayoristaFraccMd(presMay(), 'sistema'));
  assert.doesNotMatch(pub, /\(base\)|Pack \(−/); assert.match(pub, /Bulto sin IVA \(sugerido\)/); assert.match(pub, /con IVA 1\.573/);
  assert.match(htmlBloqueMayoristaFraccMd({ fijo: true }), /Margen fijo del producto: sin descuento mayorista/);
  assert.strictEqual(htmlBloqueMayoristaFraccMd(null), '');
  const g = { plu: '50', nombre: 'Almendra', presentaciones: [presMay({ mayoristas: [] })], mayoristas: [] };
  const html = htmlPreciosFraccMd(g, 'sistema');
  assert.match(html, /Precio mayorista/); assert.match(html, /title="El sugerido de una presentación mayorista es el precio bulto sin IVA">sin IVA/);
  assert.doesNotMatch(htmlPreciosFraccMd({ ...g, presentaciones: [presMay({ mayorista: false, mayoristas: [] })] }, 'sistema'), /Precio mayorista|sin IVA<\/span>/);
});
test('pasosMinoristaFraccMd: mayorista con descuento parte del minorista de antes, pasa por el pack y termina en el bulto sin IVA (sugerido); sin descuento = cuenta de siempre', () => {
  const pasos = pasosMinoristaFraccMd(DESGLOSE_MAY, 'Costo de mercadería');
  const txt = pasos.map(p => p[1]);
  assert.ok(txt.includes('Margen 57,4 %')); assert.ok(!txt.some(t => /^Margen 18,2/.test(t)));   // el margen de tabla no se muestra como aplicado
  assert.deepStrictEqual(pasos.filter(p => p[0] === '=').map(p => [p[1], p[2]]), [['Precio pack con IVA', 1800], ['Precio bulto sin IVA (sugerido)', 1300]]); // el último "=" (total) es el bulto neto
  assert.ok(txt.some(t => /Margen efectivo del pack 31,4 %/.test(t)) && txt.some(t => /Margen efectivo del bulto 18,2 %/.test(t)));
  const plano = { ...DESGLOSE_MAY, minorista: { ...DESGLOSE_MAY.minorista, mayorista: undefined, minoristaOriginal: undefined, margenPct: 40 } };
  assert.ok(pasosMinoristaFraccMd(plano, 'Costo').some(p => p[1] === 'Margen 40 %'));
});
test('filasPreciosFraccMd: presentación mayorista con vigenteNeto compara el sugerido (sin IVA) con el vigente sin IVA; sin vigenteNeto, el vigente de siempre', () => {
  const { filasPreciosFraccMd } = require('../public/js/precios_modal_fraccionado.js');
  const r = p => filasPreciosFraccMd({ plu: '50', nombre: 'G', presentaciones: [p], mayoristas: [] }, 'sistema').find(x => x.tipo === 'minorista');
  const conVn = (vn, extra = {}) => ({ ...presMay(extra, {}), vigente: 1950, sugeridos: { sistema: { minorista: { ...MIN_MAY_MD, ...(vn != null ? { vigenteNeto: vn } : {}) } } } });
  assert.strictEqual(r(conVn(1611.57)).vigente, 1611.57); // el server manda vigenteNeto en sugeridos[fuente].minorista, no en la fila
  assert.strictEqual(r(conVn(null)).vigente, 1950);
  assert.strictEqual(r(conVn(1611.57, { mayorista: false })).vigente, 1611.57);
  assert.strictEqual(r({ ...conVn(null), vigenteNeto: 1611.57 }).vigente, 1950); // un vigenteNeto suelto en la fila no cuenta
  const x = r(conVn(1611.57)); assert.ok((x.deltaPct < 0) === (x.sugerido - x.vigente < 0), 'Δ$ y Δ% con el mismo signo');
});
test('pasosMinoristaFraccMd: con el contrato real del server (pack/bulto sin exacto), cada × lleva importe y el pack con IVA es conIva', () => {
  const pasos = pasosMinoristaFraccMd(DESGLOSE_MAY, 'Costo');
  assert.ok(pasos.every(p => p[0] !== '×' || p[2] != null));
  assert.strictEqual(pasos.find(p => p[1] === 'Precio pack con IVA')[2], 1800);
  assert.strictEqual(pasos.find(p => p[1].startsWith('Descuento bulto'))[2], 1573);
});
test('datosMayoristaFraccMd: sin pack/bulto públicos, el fallback del desglose usa conIva', () => {
  const p = presMay({}, { desglose: DESGLOSE_MAY });
  const d = datosMayoristaFraccMd({ ...p, sugeridos: { sistema: { minorista: { precio: 1300, margenTotalPct: 18.2 }, desglose: DESGLOSE_MAY } } }, 'sistema');
  assert.strictEqual(d.packIva, 1800); assert.strictEqual(d.bultoIva, 1573);
});

// ── Tipo pack: el sugerido es el pack SIN IVA (el bulto pasa a dato secundario) ──
const MIN_PACK_MD = { ...MIN_MAY_MD, precio: 1487.6, margenTotalPct: 31.4, tipoMayorista: 'pack' };
const DESGLOSE_PACK = { ...DESGLOSE_MAY, minorista: { ...DESGLOSE_MAY.minorista, precio: 1487.6, tipoMayorista: 'pack', mayorista: { ...MAYORISTA_DESGLOSE, tipoMayorista: 'pack' } } };
const presPack = (extra = {}, sug = {}) => ({ plu: '51', nombre: 'A 500G', mayorista: true, mayoristaTipo: 'pack', sugeridos: { sistema: { minorista: MIN_PACK_MD, ...sug } }, ...extra });

test('datosMayoristaFraccMd / htmlBloqueMayoristaFraccMd: tipo pack → "Pack sin IVA (sugerido)" en negrita y el bulto como dato secundario', () => {
  const d = datosMayoristaFraccMd(presPack({}, { desglose: DESGLOSE_PACK }), 'sistema');
  assert.strictEqual(d.tipo, 'pack'); assert.strictEqual(d.packNeto, 1487.6); assert.strictEqual(d.bultoNeto, 1300);
  const html = htmlBloqueMayoristaFraccMd(d);
  assert.match(html, /Pack sin IVA \(sugerido, −10 % sobre el minorista\)/);
  assert.match(html, /<b class="md-nuevo">\$ 1\.487,6<\/b>|<b class="md-nuevo">\$ 1\.488<\/b>|<b class="md-nuevo">[^<]*1\.48/);
  assert.doesNotMatch(html, /Bulto sin IVA \(sugerido/);
  assert.match(html, /Bulto \(−10 % sobre el pack\)/);
  const bulto = htmlBloqueMayoristaFraccMd(datosMayoristaFraccMd(presMay({}, { desglose: DESGLOSE_MAY }), 'sistema'));
  assert.match(bulto, /Bulto sin IVA \(sugerido/); assert.doesNotMatch(bulto, /Pack sin IVA \(sugerido/);
  const tipoPorFila = datosMayoristaFraccMd({ ...presMay(), mayoristaTipo: 'pack' }, 'sistema'); // sin tipoMayorista en el sugerido: manda la marca de la fila
  assert.strictEqual(tipoPorFila.tipo, 'pack');
  const tarjeta = htmlPreciosFraccMd({ plu: '50', nombre: 'G', presentaciones: [presPack({ mayoristas: [] })], mayoristas: [] }, 'sistema');
  assert.match(tarjeta, /es el precio pack sin IVA/);
});
test('pasosMinoristaFraccMd: tipo pack termina en "Precio pack sin IVA (sugerido)" sin aplicar el descuento de bulto', () => {
  const pasos = pasosMinoristaFraccMd(DESGLOSE_PACK, 'Costo');
  const txt = pasos.map(p => p[1]);
  assert.deepStrictEqual(pasos.filter(p => p[0] === '=').map(p => p[1]), ['Precio pack con IVA', 'Precio pack sin IVA (sugerido)']);
  assert.strictEqual(pasos[pasos.length - 2][2], 1487.6); // el último "=" es el pack neto
  assert.ok(!txt.some(t => /bulto/i.test(t)));
});
