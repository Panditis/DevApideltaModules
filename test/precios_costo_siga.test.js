'use strict';
// Costo NETO (factura y cotización: PrecioNeto; sistema: PrecioCosto ÷ (1 + alícuota)), lib/precios_consultas
// (spec 2026-10-02-precios-costo-neto-iva-curva, Parte A). Antes: plan 2026-09-30-precios-costo-siga-fijo.
const test = require('node:test');
const assert = require('node:assert');
const { costoLineaCompra, filaCostos } = require('../lib/precios_consultas');

// ── Costo neto de una línea de compra ────────────────────────────────────────

test('costoLineaCompra: factura → PrecioNeto SIN sumar su IVA', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 21 }), 1000);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 10.5 }), 1000);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 5785.123 }), 5785.12);
});

test('costoLineaCompra: cotización → PrecioNeto tal cual (también neto)', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONCOM', precioNeto: 6800, porcentajeIVA: 21 }), 6800);
  assert.strictEqual(costoLineaCompra({ tipo: ' cotizacion ', precioNeto: 6800, porcentajeIVA: null }), 6800);
});

test('costoLineaCompra: notas de crédito y líneas sin precio → null', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'NCREDCOM', precioNeto: 1000, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONNCCOM', precioNeto: 1000, porcentajeIVA: 0 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 0, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: null, porcentajeIVA: 21 }), null);
});

// ── Costo de sistema neto ────────────────────────────────────────────────────

test('filaCostos: costo de sistema = PrecioCosto ÷ (1 + alícuota del producto); con IVA queda aparte', () => {
  const f = filaCostos({
    IdProducto: 90270, NombreProducto: 'X', CostoSistema: 6630, IvaCompraPct: 10.5,
    UcPrecioNeto: 5785.12, UcPorcentajeIVA: 21, UcTipo: 'FACTCOM', Proveedor: 'Prov', FechaCompraTxt: '2026-09-20',
  });
  assert.strictEqual(f.costoSistema, 6000); // 6630 ÷ 1,105
  assert.strictEqual(f.costoSistemaConIva, 6630);
  assert.strictEqual(f.ivaCompraPct, 10.5);
  assert.strictEqual(f.ivaCompraSupuesto, false);
  assert.strictEqual(f.costoMercaderia, 5785.12); // factura: neto, sin su IVA
  assert.strictEqual(f.tipoComprobanteUltimaCompra, 'factura');
  assert.strictEqual(f.fechaUltimaCompra, '2026-09-20');
});

test('filaCostos: alícuota faltante → se divide por 1,21 y queda ivaCompraSupuesto', () => {
  const f = filaCostos({ IdProducto: 3, CostoSistema: 1210, IvaCompraPct: null });
  assert.strictEqual(f.costoSistema, 1000);
  assert.strictEqual(f.ivaCompraSupuesto, true);
});

test('filaCostos: última compra por cotización → neto tal cual, tipo "cotización"; sin compra → null', () => {
  const f = filaCostos({ IdProducto: 1, CostoSistema: null, UcPrecioNeto: 900, UcPorcentajeIVA: 21, UcTipo: 'COTIZACIONCOM' });
  assert.strictEqual(f.costoSistema, null);
  assert.strictEqual(f.costoMercaderia, 900);
  assert.strictEqual(f.tipoComprobanteUltimaCompra, 'cotización');
  const g = filaCostos({ IdProducto: 2, CostoSistema: 100 });
  assert.strictEqual(g.costoMercaderia, null);
  assert.strictEqual(g.tipoComprobanteUltimaCompra, null);
});
