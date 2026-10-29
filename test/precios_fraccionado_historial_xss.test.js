'use strict';
// XSS del historial de Fraccionado (front): los nombres de productos y subrubros vienen de SIGA y no se confía en ellos. Se usa el `esc`
// REAL de public/js/precios_comun.js (no una copia) y se verifica que ningún texto llegue como HTML, ni en el cuerpo ni en atributos.
const test = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');

globalThis.esc = require('../public/js/precios_comun.js').esc;
globalThis.numOrNull = v => (v === '' || v == null ? null : Number(v));
globalThis.msgEsq = () => {};
globalThis.getJson = async () => ({});
const H = require('../public/js/precios_fraccionado_historial.js');

const MALOS = ['"><img src=x onerror=alert(1)>', "' onmouseover='alert(2)", 'A & B <script>alert(3)</script>'];

const historialCon = nombre => H.normalizarHistorialHf({
  cargas: { total: 10, usadas: 8, descartes: {} }, minMuestras: 5,
  productos: { 100: { n: 6, mediana: 5, p25: 4, p75: 6, subrubroId: '7', pocosDatos: false } },
  subrubros: { 7: { n: 18, productos: 3, mediana: 5, p25: 4, p75: 9, pocosDatos: false } },
  tramos: [{ hastaG: 500, base: false, n: 5, mediana: 1, p25: 0, p75: 2, pocosDatos: false }, { hastaG: 1000, base: true, n: 5, mediana: 0, p25: 0, p75: 0, pocosDatos: false }],
  distribucion: { 7: [{ plu: '100', nombre, n: 6, minKg: 5 }, { plu: '101', nombre, n: 6, minKg: 4 }, { plu: '102', nombre, n: 6, minKg: 12 }] },
});

// Sin elementos ni atributos inyectados: sólo las etiquetas que arma el módulo y ningún on*.
function sinInyeccion(htmlStr, contexto) {
  const $ = cheerio.load(`<div id="raiz">${htmlStr}</div>`);
  assert.strictEqual($('img,script').length, 0, `${contexto}: elemento inyectado`);
  $('*').each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) assert.ok(!/^on/i.test(a), `${contexto}: atributo ${a} inyectado`);
  });
  return $;
}

for (const malo of MALOS) {
  test(`XSS: chip y "Ver distribución" del subrubro escapan el nombre en texto y atributos (${malo})`, () => {
    const $ = sinInyeccion(H.htmlSubrubroHf(historialCon(malo), '7', malo), 'subrubro');
    assert.strictEqual($('.hf-ver').attr('data-hf-nombre'), malo);
    assert.strictEqual($('.hf-ver').attr('aria-label'), `Ver distribución de ${malo}`);
    assert.strictEqual($('.hf-usar').attr('aria-label'), `Usar 5 min/kg en ${malo}`);
  });

  test(`XSS: panel de distribución (histograma, tabla alternativa y más alejados con "Fijar") escapa el nombre (${malo})`, () => {
    const h = historialCon(malo);
    const $ = sinInyeccion(H.htmlDistribucionHf(H.modeloDistribucionHf(h, '7', 3)), 'distribución');
    assert.ok($('.hf-barra[role="img"]').length > 0);
    assert.ok($('.hf-tabla tbody tr').length > 0);
    const fijar = $('.hf-fijar');
    assert.ok(fijar.length > 0);
    fijar.each((_, b) => {
      assert.strictEqual($(b).attr('data-hf-nombre'), malo);
      assert.match($(b).attr('aria-label'), new RegExp(`propio de ${malo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    });
    $('.hf-alejados tbody th').each((_, th) => assert.ok($(th).text().startsWith(malo)));
  });

  test(`XSS: chip del producto (modal del granel) y línea de error del estado no dejan pasar HTML (${malo})`, () => {
    sinInyeccion(H.htmlProductoHf(historialCon(malo), '100'), 'producto');
    sinInyeccion(H.htmlTramoHf(historialCon(malo), 500, 500), 'tramo');
    const $ = sinInyeccion(H.htmlEstadoHf({ fase: 'error', datos: null, error: malo }), 'estado');
    assert.match($('.hf-linea').text(), new RegExp(malo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
