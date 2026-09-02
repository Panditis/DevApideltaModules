const test = require('node:test');
const assert = require('node:assert');

const { ventanaDe, candidatosDeCompra, compararPedido, claveComprobante, signoDe } = require('../compras_control');

// ── Helpers de armado ────────────────────────────────────────────────────────
function pedido(extra = {}) {
  return {
    numero: 'P-0001', idProveedor: 412, proveedor: 'PROVEEDOR SA',
    fecha: '2026-09-01', fechaRetiro: null, estado: 'PENDIENTE',
    items: [
      { plu: '4409', nombre: 'Granel A', unidad: 'KG', cantidad: 50, cantidadEntregada: null, estado: 'pedido', obs: '' },
      { plu: '1010', nombre: 'Producto B', unidad: 'UN', cantidad: 10, cantidadEntregada: null, estado: 'pedido', obs: '' },
    ],
    ...extra,
  };
}

function comprobante(extra = {}) {
  return {
    idSucursal: 1, tipoComprobante: 'FACTCOM', letra: 'C', centroEmisor: 3, numeroComprobante: 756,
    fecha: '2026-09-03', idProveedor: 412, proveedor: 'PROVEEDOR SA', importeTotal: 10000,
    items: [
      { plu: '4409', nombre: 'Granel A', cantidad: 50, importe: 5000 },
      { plu: '1010', nombre: 'Producto B', cantidad: 10, importe: 5000 },
    ],
    ...extra,
  };
}

const filaDe = (r, plu) => r.filas.find(f => f.plu === plu);

// ── claveComprobante / signoDe ───────────────────────────────────────────────
test('claveComprobante arma la PK de SIGA y tolera espacios', () => {
  assert.strictEqual(claveComprobante(comprobante()), '1|FACTCOM|C|3|756');
  assert.strictEqual(claveComprobante({ idSucursal: ' 1 ', tipoComprobante: 'FACTCOM ', letra: 'C', centroEmisor: 3, numeroComprobante: 756 }),
    '1|FACTCOM|C|3|756');
});

test('signoDe: las notas de crédito de compra restan', () => {
  assert.strictEqual(signoDe('FACTCOM'), 1);
  assert.strictEqual(signoDe('ncredcom'), -1);
  assert.strictEqual(signoDe('COTIZACIONNCCOM'), -1);
  assert.strictEqual(signoDe(null), 1);
});

// ── ventanaDe ────────────────────────────────────────────────────────────────
test('ventanaDe sin retiro: desde la fecha del pedido hasta el pedido + margen', () => {
  assert.deepStrictEqual(ventanaDe(pedido()), { desde: '2026-09-01', hasta: '2026-09-16' });
});

test('ventanaDe con retiro: el techo cuelga del retiro', () => {
  assert.deepStrictEqual(ventanaDe(pedido({ fechaRetiro: '2026-09-10' }), { diasDespues: 5 }),
    { desde: '2026-09-01', hasta: '2026-09-15' });
});

test('ventanaDe cruza el fin de mes sin romperse', () => {
  assert.deepStrictEqual(ventanaDe({ fecha: '2026-12-28' }, { diasAntes: 3, diasDespues: 10 }),
    { desde: '2026-12-25', hasta: '2027-01-07' });
});

test('ventanaDe sin fecha de pedido no acota nada', () => {
  assert.deepStrictEqual(ventanaDe({}), { desde: null, hasta: null });
});

// ── candidatosDeCompra ───────────────────────────────────────────────────────
test('candidatosDeCompra deja pasar el comprobante del proveedor dentro de la ventana', () => {
  const r = candidatosDeCompra(pedido(), [comprobante()]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].clave, '1|FACTCOM|C|3|756');
  assert.strictEqual(r[0].etiqueta, 'FACTCOM C 3-756');
  assert.strictEqual(r[0].pluCoincidentes, 2);
  assert.strictEqual(r[0].sugerido, true);
});

test('candidatosDeCompra descarta otro proveedor y lo de fuera de la ventana', () => {
  const otroProv = comprobante({ idProveedor: 999, numeroComprobante: 757 });
  const tarde = comprobante({ fecha: '2026-10-30', numeroComprobante: 758 });
  const temprano = comprobante({ fecha: '2026-08-20', numeroComprobante: 759 });
  const r = candidatosDeCompra(pedido(), [otroProv, tarde, temprano, comprobante()]);
  assert.deepStrictEqual(r.map(c => c.numeroComprobante), [756]);
});

test('candidatosDeCompra sin idProveedor cae al nombre', () => {
  const p = pedido({ idProveedor: null });
  const c = comprobante({ idProveedor: null, proveedor: '  proveedor sa ' });
  assert.strictEqual(candidatosDeCompra(p, [c]).length, 1);
});

test('candidatosDeCompra ordena por PLUs coincidentes y marca sugerido', () => {
  const flojo = comprobante({ numeroComprobante: 800, items: [{ plu: '9999', cantidad: 1, importe: 10 }] });
  const r = candidatosDeCompra(pedido(), [flojo, comprobante()]);
  assert.deepStrictEqual(r.map(c => c.numeroComprobante), [756, 800]);
  assert.deepStrictEqual(r.map(c => c.sugerido), [true, false]);
});

// ── compararPedido: caso limpio ──────────────────────────────────────────────
test('compararPedido: lo cargado coincide con lo pedido → todo ok', () => {
  const r = compararPedido(pedido(), [comprobante()]);
  assert.deepStrictEqual(r.filas.map(f => f.estado), ['ok', 'ok']);
  assert.strictEqual(r.resumen.lineasConDiferencia, 0);
  assert.strictEqual(r.resumen.cumplimientoPct, 100);
  assert.strictEqual(r.resumen.importeCargado, 10000);
  assert.strictEqual(r.resumen.importeFaltante, 0);
});

test('compararPedido calcula el precio unitario de lo cargado', () => {
  const r = compararPedido(pedido(), [comprobante()]);
  assert.strictEqual(filaDe(r, '4409').precioUnitario, 100);
  assert.strictEqual(filaDe(r, '1010').precioUnitario, 500);
});

test('compararPedido no muta el pedido recibido', () => {
  const p = pedido();
  const copia = JSON.parse(JSON.stringify(p));
  compararPedido(p, [comprobante()]);
  assert.deepStrictEqual(p, copia);
});

// ── compararPedido: diferencias ──────────────────────────────────────────────
test('compararPedido marca faltante y lo valúa al precio de la compra', () => {
  const c = comprobante({ items: [
    { plu: '4409', nombre: 'Granel A', cantidad: 40, importe: 4000 },
    { plu: '1010', nombre: 'Producto B', cantidad: 10, importe: 5000 },
  ] });
  const r = compararPedido(pedido(), [c]);
  const f = filaDe(r, '4409');
  assert.strictEqual(f.estado, 'faltante');
  assert.strictEqual(f.difCargadoPedido, -10);
  assert.strictEqual(f.importeFaltante, 1000);   // 10 kg × $100
  assert.strictEqual(r.resumen.importeFaltante, 1000);
  assert.strictEqual(r.resumen.cumplimientoPct, 83.3);   // (40 + 10) / 60
});

test('compararPedido marca excedente cuando cargaron de más', () => {
  const c = comprobante({ items: [{ plu: '4409', cantidad: 55, importe: 5500 }] });
  const f = filaDe(compararPedido(pedido(), [c]), '4409');
  assert.strictEqual(f.estado, 'excedente');
  assert.strictEqual(f.difCargadoPedido, 5);
  assert.strictEqual(f.importeFaltante, null);
});

test('compararPedido marca sin_cargar cuando el producto no aparece en ninguna factura', () => {
  const c = comprobante({ items: [{ plu: '4409', cantidad: 50, importe: 5000 }] });
  const f = filaDe(compararPedido(pedido(), [c]), '1010');
  assert.strictEqual(f.estado, 'sin_cargar');
  assert.strictEqual(f.cargado, 0);
  assert.strictEqual(f.precioUnitario, null);
  assert.strictEqual(f.importeFaltante, null);   // sin precio no se inventa el valor
});

test('compararPedido marca no_pedido lo que vino en la factura y nadie pidió', () => {
  const c = comprobante({ items: [...comprobante().items, { plu: '7777', nombre: 'Sorpresa', cantidad: 3, importe: 900 }] });
  const r = compararPedido(pedido(), [c]);
  const f = filaDe(r, '7777');
  assert.strictEqual(f.estado, 'no_pedido');
  assert.strictEqual(f.enPedido, false);
  assert.strictEqual(f.pedido, 0);
  assert.strictEqual(f.cargado, 3);
  assert.strictEqual(r.resumen.no_pedido, 1);
});

test('compararPedido pone las diferencias arriba', () => {
  const c = comprobante({ items: [
    { plu: '4409', cantidad: 50, importe: 5000 },
    { plu: '1010', cantidad: 4, importe: 2000 },
  ] });
  assert.strictEqual(compararPedido(pedido(), [c]).filas[0].plu, '1010');
});

// ── compararPedido vs seguimiento ────────────────────────────────────────────
test('con cantidadEntregada declarada la referencia es lo entregado, no lo pedido', () => {
  const p = pedido();
  p.items[0] = { ...p.items[0], cantidad: 50, cantidadEntregada: 40, estado: 'entregado' };
  const c = comprobante({ items: [{ plu: '4409', cantidad: 40, importe: 4000 }] });
  const f = filaDe(compararPedido(p, [c]), '4409');
  assert.strictEqual(f.estado, 'ok');            // lo cargado coincide con lo entregado
  assert.strictEqual(f.difCargadoPedido, -10);   // pero sigue faltando contra el pedido
  assert.strictEqual(f.difCargadoEntregado, 0);
});

test('quiebre declarado sin carga en sistema cierra ok', () => {
  const p = pedido();
  p.items[1] = { ...p.items[1], cantidadEntregada: 0, estado: 'sin_stock' };
  const c = comprobante({ items: [{ plu: '4409', cantidad: 50, importe: 5000 }] });
  const r = compararPedido(p, [c]);
  assert.strictEqual(filaDe(r, '1010').estado, 'ok');
  assert.strictEqual(r.resumen.lineasConDiferencia, 0);
});

test('quiebre declarado que igual se facturó queda como excedente', () => {
  const p = pedido();
  p.items[1] = { ...p.items[1], cantidadEntregada: 0, estado: 'no_envia' };
  const r = compararPedido(p, [comprobante()]);
  assert.strictEqual(filaDe(r, '1010').estado, 'excedente');
});

test('cantidadEntregada null no se toma como cero', () => {
  const c = comprobante({ items: [{ plu: '4409', cantidad: 50, importe: 5000 }, { plu: '1010', cantidad: 10, importe: 5000 }] });
  const r = compararPedido(pedido(), [c]);
  assert.strictEqual(filaDe(r, '1010').entregado, null);
  assert.strictEqual(filaDe(r, '1010').referencia, 10);
  assert.strictEqual(filaDe(r, '1010').estado, 'ok');
});

// ── Varios comprobantes ──────────────────────────────────────────────────────
test('compararPedido suma las líneas de varias facturas del mismo pedido', () => {
  const c1 = comprobante({ numeroComprobante: 756, items: [{ plu: '4409', cantidad: 30, importe: 3000 }] });
  const c2 = comprobante({ numeroComprobante: 757, items: [{ plu: '4409', cantidad: 20, importe: 2000 }] });
  const f = filaDe(compararPedido(pedido(), [c1, c2]), '4409');
  assert.strictEqual(f.cargado, 50);
  assert.strictEqual(f.importe, 5000);
  assert.strictEqual(f.estado, 'ok');
  assert.strictEqual(f.comprobantes.length, 2);
});

test('compararPedido suma dos líneas del mismo PLU dentro de una factura', () => {
  const c = comprobante({ items: [
    { plu: '4409', cantidad: 20, importe: 2000 },
    { plu: '4409', cantidad: 30, importe: 3300 },
  ] });
  const f = filaDe(compararPedido(pedido(), [c]), '4409');
  assert.strictEqual(f.cargado, 50);
  assert.strictEqual(f.importe, 5300);
});

test('una nota de crédito resta de lo cargado', () => {
  const nc = comprobante({ tipoComprobante: 'NCREDCOM', numeroComprobante: 900,
    items: [{ plu: '4409', cantidad: 10, importe: 1000 }] });
  const r = compararPedido(pedido(), [comprobante(), nc]);
  const f = filaDe(r, '4409');
  assert.strictEqual(f.cargado, 40);
  assert.strictEqual(f.importe, 4000);
  assert.strictEqual(f.estado, 'faltante');
  assert.strictEqual(r.comprobantes.find(c => c.etiqueta.startsWith('NCREDCOM')).signo, -1);
});

// ── Bordes ───────────────────────────────────────────────────────────────────
test('compararPedido sin comprobantes vinculados: todo sin_cargar', () => {
  const r = compararPedido(pedido(), []);
  assert.deepStrictEqual(r.filas.map(f => f.estado), ['sin_cargar', 'sin_cargar']);
  assert.strictEqual(r.resumen.cumplimientoPct, 0);
  assert.strictEqual(r.resumen.importeCargado, 0);
});

test('compararPedido tolera PLUs con espacios de SIGA de los dos lados', () => {
  const p = pedido({ items: [{ plu: ' 4409 ', nombre: 'Granel A', cantidad: 50, cantidadEntregada: null, estado: 'pedido' }] });
  const c = comprobante({ items: [{ plu: '4409  ', cantidad: 50, importe: 5000 }] });
  const r = compararPedido(p, [c]);
  assert.strictEqual(r.filas.length, 1);
  assert.strictEqual(r.filas[0].estado, 'ok');
});

test('una diferencia de decimales por debajo de la tolerancia no es faltante', () => {
  const c = comprobante({ items: [{ plu: '4409', cantidad: 49.9999, importe: 5000 }, { plu: '1010', cantidad: 10, importe: 5000 }] });
  assert.strictEqual(filaDe(compararPedido(pedido(), [c]), '4409').estado, 'ok');
});

test('toleranciaPct afloja el criterio para pesables', () => {
  const c = comprobante({ items: [{ plu: '4409', cantidad: 49.8, importe: 4980 }, { plu: '1010', cantidad: 10, importe: 5000 }] });
  assert.strictEqual(filaDe(compararPedido(pedido(), [c]), '4409').estado, 'faltante');
  assert.strictEqual(filaDe(compararPedido(pedido(), [c], { toleranciaPct: 1 }), '4409').estado, 'ok');
});

test('compararPedido con pedido vacío o nulo no explota', () => {
  const r = compararPedido(null, null);
  assert.deepStrictEqual(r.filas, []);
  assert.strictEqual(r.resumen.lineas, 0);
  assert.strictEqual(r.resumen.cumplimientoPct, null);
});
