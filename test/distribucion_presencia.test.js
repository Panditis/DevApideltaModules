const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen } = require('../lib/distribucion');

// ── Fixtures: PLU 1770 (Aceite Oliva Apidelta 2Lt) con sus valores reales de A8020 ────────────
// Facturación clase A (top del catálogo) pero rotación baja: μ 0.13-0.62 u/día según sucursal.
const A8020_1770 = {
  minRiv: 5, SRiv: 9, minUrq: 4, SUrq: 7, minNacion: 3, SNacion: 5, minChaca: 2, SChaca: 4,
  minPergamino: 3, SPergamino: 6, minSanPedro: 2, SSanPedro: 4, minVRamallo: 5, SVRamallo: 10,
};
const MU_1770 = { SRiv: 0.62, SUrq: 0.349, SNacion: 0.26, SChaca: 0.191,
  SPergamino: 0.265, SSanPedro: 0.129, SVRamallo: 0.548 };

const LISTAS_VACIAS = { rivadavia: new Set(), urquiza: new Set(), nacion: new Set(),
  chacabuco: new Set(), pergamino: new Set(), sanPedro: new Set(), villaRamallo: new Set() };

// Config de producción: presencia por clase 12/8/6 y factor 2 → objetivo 24 para un clase A.
const OPTS_BASE = {
  corregirBugs: true,
  presenciaPorClase: { A: 12, B: 8, C: 6 },
  empujePresenciaFactorS: 2,
  umbralMicroEnvio: { tramos: [{ hastaS: null, pct: 0.2 }], pisoAbsoluto: 1 },
};
const CARO_LENTO = { umbralMu: 1, clasesFact: ['A'], pisoMin: 4, pisoS: 8 };

// Stock central abundante y sucursales vacías → el empuje se aplica y nada raciona.
const STOCKS_VACIOS = { central: 1000, riv: 0, urq: 0, nacion: 0, chaca: 0,
  pergamino: 0, sanpedro: 0, sucu8: 0, sucu9: 0, sucu11: 0 };

function fila1770(opts) {
  return calcularFilaAlmacen(1770, STOCKS_VACIOS, A8020_1770, {}, LISTAS_VACIAS,
    new Set(), 1000, opts);
}

test('sin la regla, el empuje de produccion lleva todo a presencia x factor', () => {
  const f = fila1770({ ...OPTS_BASE, abcPorPlu: { 1770: 'A' } });
  assert.strictEqual(f.sLevels.riv, 24);
  assert.strictEqual(f.sLevels.chaca, 24);
  assert.strictEqual(f.mins.riv, 12);
  assert.strictEqual(f.mins.sanpedro, 12);
});

test('caro y lento: se queda con el A8020 y respeta el piso min 4 / S 8', () => {
  const f = fila1770({ ...OPTS_BASE, abcPorPlu: { 1770: 'A' },
    muPorPlu: { 1770: MU_1770 }, sinEmpujeCaroLento: CARO_LENTO });
  // Todas las sucursales del 1770 rotan por debajo de 1 u/dia → ninguna recibe empuje.
  // Por encima del piso manda el A8020:
  assert.strictEqual(f.sLevels.riv, 9);
  assert.strictEqual(f.mins.riv, 5);
  assert.strictEqual(f.sLevels.sucu9, 10);   // ramallo
  assert.strictEqual(f.mins.sucu9, 5);
  // Por debajo del piso, sube al piso:
  assert.strictEqual(f.sLevels.chaca, 8);    // A8020 tenia 4
  assert.strictEqual(f.mins.chaca, 4);       // A8020 tenia 2
  assert.strictEqual(f.sLevels.sanpedro, 8);
  assert.strictEqual(f.mins.sanpedro, 4);
  assert.strictEqual(f.sLevels.urq, 8);      // A8020 tenia 7
  assert.strictEqual(f.mins.urq, 4);
  // El piso es piso, no objetivo: nadie salta a 24.
  for (const s of Object.values(f.sLevels)) assert.ok(s <= 10, `S=${s} no deberia recibir empuje`);
});

test('caro y lento: la clase de facturacion decide, con el mismo mu lento', () => {
  const lento = { 1770: { ...MU_1770, SRiv: 0.9 } };
  const mk = (claseFact) => fila1770({ ...OPTS_BASE, abcPorPlu: { 1770: claseFact },
    muPorPlu: lento, sinEmpujeCaroLento: CARO_LENTO });
  // chaca: A8020 tiene S 4, por debajo de la presencia de cualquier clase → el empuje se nota.
  assert.strictEqual(mk('A').sLevels.chaca, 8);    // alcanzado por la regla → piso, no empuje
  assert.strictEqual(mk('B').sLevels.chaca, 16);   // fuera de la regla (solo A) -> empuje (presencia B 8 x 2)
  assert.strictEqual(mk('C').sLevels.chaca, 12);   // fuera de la regla → empuje (presencia C 6 x 2)
});

test('caro y lento: la sucursal que rota por encima del umbral si recibe empuje', () => {
  const f = fila1770({ ...OPTS_BASE, abcPorPlu: { 1770: 'A' },
    muPorPlu: { 1770: { ...MU_1770, SRiv: 2 } }, sinEmpujeCaroLento: CARO_LENTO });
  assert.strictEqual(f.sLevels.riv, 24);   // 2 u/dia >= umbral 1 → empuje normal
  assert.strictEqual(f.mins.riv, 12);
  assert.strictEqual(f.sLevels.chaca, 8);  // chaca sigue lenta → piso
});

test('caro y lento: sin mu conocido cuenta como lento (cae al piso)', () => {
  const f = fila1770({ ...OPTS_BASE, abcPorPlu: { 1770: 'A' },
    muPorPlu: {}, sinEmpujeCaroLento: CARO_LENTO });
  assert.strictEqual(f.sLevels.chaca, 8);
  assert.strictEqual(f.sLevels.riv, 9);
});

test('clase F no se empuja ni recibe piso', () => {
  const f = calcularFilaAlmacen(1770, STOCKS_VACIOS, { ...A8020_1770, claseF: true }, {},
    LISTAS_VACIAS, new Set(), 1000, { ...OPTS_BASE, abcPorPlu: { 1770: 'A' },
      muPorPlu: { 1770: MU_1770 }, sinEmpujeCaroLento: CARO_LENTO });
  assert.strictEqual(f.sLevels.riv, 9);
  assert.strictEqual(f.mins.riv, 5);
  assert.strictEqual(f.sLevels.chaca, 4);   // sin piso: queda el A8020 crudo
});

test('sin stock en central no hay empuje ni piso', () => {
  const f = calcularFilaAlmacen(1770, { ...STOCKS_VACIOS, central: 0 }, A8020_1770, {},
    LISTAS_VACIAS, new Set(), 1000, { ...OPTS_BASE, abcPorPlu: { 1770: 'A' },
      muPorPlu: { 1770: MU_1770 }, sinEmpujeCaroLento: CARO_LENTO });
  assert.strictEqual(f.sLevels.riv, 9);
  assert.strictEqual(f.sLevels.chaca, 4);
});
