'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validarComprobante, modoNumeracion, cuitValido } = require('../lib/siga_compras/validaciones');
const { borradorFactcom, contextoFactcom } = require('./siga_compras_fixture');

// Lo único del cálculo que miran las validaciones: el total y el IVA de cada línea.
const CALCULO = { totales: { importeTotal: 42665.16 }, lineas: [{ porcentajeIVA: 21 }, { porcentajeIVA: 0 }] };
const mensajes = (b, ctx, calc = CALCULO) => validarComprobante(b, ctx, calc).map(e => e.mensaje);

test('FACTCOM A completa: sin errores', () => {
  assert.deepStrictEqual(validarComprobante(borradorFactcom(), contextoFactcom(), CALCULO), []);
});

test('sin proveedor o sin tipo corta ahí (#3, #6)', () => {
  assert.deepStrictEqual(validarComprobante(borradorFactcom(), contextoFactcom({ proveedor: null }), CALCULO),
    [{ campo: 'idProveedor', mensaje: 'Debe cargar un Proveedor.' }]);
  assert.deepStrictEqual(validarComprobante(borradorFactcom(), contextoFactcom({ tipo: null }), CALCULO),
    [{ campo: 'idTipoComprobante', mensaje: 'Falta cargar el tipo de Comprobante.' }]);
});

test('bloqueos v1: notas de crédito, contado, numeraciones no soportadas y PAGO automático', () => {
  const ctx = contextoFactcom();
  assert.match(mensajes(borradorFactcom(), { ...ctx, tipo: { ...ctx.tipo, coeficienteValores: -1 } })[0], /notas de crédito/);
  assert.ok(mensajes(borradorFactcom(), { ...ctx, formaPago: { ...ctx.formaPago, dias: 0 } })
    .some(m => /al contado no se importan/.test(m)));
  assert.match(mensajes(borradorFactcom(), {
    ...ctx, tipo: { ...ctx.tipo, coeficienteStock: 0, afectaCaja: false, actualizaCtaCte: false },
  })[0], /ComprasNumeros/);
  assert.match(mensajes(borradorFactcom(), {
    ...ctx, tipo: { ...ctx.tipo, numeracionAutomatica: true }, ventasNumerosRelacionado: true,
  })[0], /VentasNumeros/);
  assert.match(mensajes(borradorFactcom(), { ...ctx, tipo: { ...ctx.tipo, afectaCaja: false } })[0], /PAGO automático/);
});

test('numeración manual: emisor y número obligatorios, mayores a cero y sin duplicado (#17-#20)', () => {
  const ctx = contextoFactcom();
  assert.deepStrictEqual(mensajes(borradorFactcom({ centroEmisor: null }), ctx), ['Debe cargar un el Número de Emisor.']);
  assert.deepStrictEqual(mensajes(borradorFactcom({ centroEmisor: 0 }), ctx), ['El Emisor no puede ser cero.']);
  assert.deepStrictEqual(mensajes(borradorFactcom({ numeroComprobante: null }), ctx), ['Debe cargar un el número del comprobante.']);
  assert.deepStrictEqual(mensajes(borradorFactcom({ numeroComprobante: -3 }), ctx), ['El Número no puede ser cero.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, duplicado: { enCompras: true, enCtaCte: false } }),
    ['Este comprobante ya fue INGRESADO con ANTERIORIDAD']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, duplicado: { enCompras: false, enCtaCte: true } }),
    ['Este comprobante ya EXISTE en Cuentas Corrientes de Proveedores']);
});

test('numeración automática: no pide emisor ni número', () => {
  const ctx = contextoFactcom();
  const cotizacion = { ...ctx.tipo, idTipoComprobante: 'COTIZACIONCOM', numeracionAutomatica: true, letrasHabilitadas: ['X'], grabaLibro: false };
  const b = borradorFactcom({ idTipoComprobante: 'COTIZACIONCOM', letra: 'X', centroEmisor: null, numeroComprobante: null });
  assert.deepStrictEqual(mensajes(b, { ...ctx, tipo: cotizacion }), []);
});

test('fecha, período fiscal, importe mínimo y CUIT (#8-#13)', () => {
  const ctx = contextoFactcom();
  assert.deepStrictEqual(mensajes(borradorFactcom({ fecha: '2026-10-17' }), ctx),
    ['La fecha del comprobante no puede ser mayor a hoy. Por favor reintente.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, periodo: null }),
    ['El Período Fiscal del Comprobante NO esta habilitado.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, periodo: { periodoFiscal: 202610, fechaCierre: '2026-11-05' } }),
    ['El Período Fiscal del Comprobante se encuentra Cerrado.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, tipo: { ...ctx.tipo, importeMinimo: 50000 } }),
    ['El importe mínimo para el comprobante Factura de compra es de 50.000,00.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, proveedor: { ...ctx.proveedor, cuit: '20-12345678-0' } }),
    ['El Comprobante seleccionado graba en libro, y el proveedor no posee CUIT Valido']);
});

test('fecha: formato válido pero inexistente en el calendario se rechaza (roundtrip)', () => {
  const ctx = contextoFactcom();
  const msg = f => `La fecha del comprobante (${f}) no existe en el calendario.`;
  for (const f of ['2027-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-10-00', '0050-01-01']) {
    assert.deepStrictEqual(mensajes(borradorFactcom({ fecha: f }), ctx), [msg(f)], f);
  }
  // 2028 es bisiesto: el 29 de febrero existe (y no es futura si hoy lo permite).
  assert.deepStrictEqual(mensajes(borradorFactcom({ fecha: '2028-02-29' }), { ...ctx, hoy: '2028-03-01' }), []);
  assert.deepStrictEqual(mensajes(borradorFactcom({ fecha: '' }), ctx), ['v1: falta la fecha del comprobante.']);
});

test('forma de pago y rubro (#21-#23)', () => {
  const ctx = contextoFactcom();
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, formaPago: null }), ['Falta cargar la forma de pago del documento.']);
  assert.deepStrictEqual(mensajes(borradorFactcom(), { ...ctx, proveedor: { ...ctx.proveedor, idRubroCompra: null } }), ['Falta cargar el Rubro.']);
  const sinCtaCte = { ...ctx.tipo, actualizaCtaCte: false, coeficienteStock: 0 };
  assert.ok(mensajes(borradorFactcom(), { ...ctx, tipo: sinCtaCte }).includes(
    'No es posible registrar una Factura de compra a cuenta corriente ya que la misma está configurada como que NO actualiza Cuenta Corriente.'));
});

test('líneas: PLU nuevo, producto inexistente o inactivo, UM distinta, precio y cantidad (§4.3, #25)', () => {
  const ctx = contextoFactcom();
  const con = linea => borradorFactcom({ lineas: [linea] });
  const ok = { orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 10 };
  assert.deepStrictEqual(mensajes(con({ ...ok, plu: 'NUEVO-ab12', nombre: 'Té nuevo', nuevo: true }), ctx),
    ['v1: el artículo Té nuevo todavía no existe en SIGA (NUEVO-ab12); dalo de alta antes de importar.']);
  assert.deepStrictEqual(mensajes(con({ ...ok, plu: '9999' }), ctx), ['v1: el producto 9999 no existe en SIGA.']);
  assert.deepStrictEqual(mensajes(con(ok), { ...ctx, productos: { 1001: { ...ctx.productos['1001'], activo: false } } }),
    ['v1: el producto 1001 está inactivo en SIGA.']);
  assert.deepStrictEqual(mensajes(con(ok), { ...ctx, productos: { 1001: { ...ctx.productos['1001'], idUnidadDeMedidaCompra: 'KG' } } }),
    ['v1: el producto 1001 tiene unidad de compra distinta de la de stock; cargalo en SiGA.']);
  assert.deepStrictEqual(mensajes(con(ok), { ...ctx, productos: { 1001: { ...ctx.productos['1001'], precioPorEmbalaje: true, embalaje: 0 } } }),
    ['v1: el producto 1001 tiene PrecioPorEmbalaje sin embalaje cargado.']);
  assert.deepStrictEqual(mensajes(con({ ...ok, precio: null }), ctx), ['No puede ingresar un producto con precio cero.']);
  assert.deepStrictEqual(mensajes(con({ ...ok, cantidad: 0 }), ctx), ['La cantidad debe ser distinta de cero.']);
  assert.deepStrictEqual(mensajes(con({ ...ok, cantidad: -1 }), ctx), ['La cantidad debe ser mayor a cero.']);
  assert.deepStrictEqual(mensajes(borradorFactcom({ lineas: [] }), ctx), ['Debe cargar como minimo un producto.']);
  assert.strictEqual(validarComprobante(con({ ...ok, plu: '9999' }), ctx, CALCULO)[0].campo, 'lineas[0]');
});

test('líneas: cantidad o precio no numéricos se rechazan antes de redondear (NaN pasaría a 0)', () => {
  const ctx = contextoFactcom();
  const con = linea => borradorFactcom({ lineas: [linea] });
  const ok = { orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 10 };
  const cantidadInvalida = ['La cantidad no es un número válido.'];
  for (const cantidad of [NaN, undefined, null, '', 'abc', '12abc', true, Infinity, [], {}]) {
    assert.deepStrictEqual(mensajes(con({ ...ok, cantidad }), ctx), cantidadInvalida, String(cantidad));
  }
  const precioInvalido = ['El precio no es un número válido.'];
  for (const precio of [NaN, 'abc', '10,5x', true, Infinity, [], {}]) {
    assert.deepStrictEqual(mensajes(con({ ...ok, precio }), ctx), precioInvalido, String(precio));
  }
  for (const precio of [undefined, null, '', 0, -5, '0']) {
    assert.deepStrictEqual(mensajes(con({ ...ok, precio }), ctx), ['No puede ingresar un producto con precio cero.'], String(precio));
  }
  // Números escritos como texto siguen siendo válidos (calcularLinea hace Number()).
  assert.deepStrictEqual(mensajes(con({ ...ok, cantidad: '2', precio: '10.5' }), ctx), []);
  assert.deepStrictEqual(mensajes(con({ ...ok, cantidad: '0' }), ctx), ['La cantidad debe ser distinta de cero.']);
  assert.deepStrictEqual(mensajes(con({ ...ok, cantidad: '-2' }), ctx), ['La cantidad debe ser mayor a cero.']);
});

test('percepciones: proveedor sin IVA discriminado, negativas, PIIBB sin provincia o repetida, tipo repetido (#31)', () => {
  const ctx = contextoFactcom();
  const con = percepciones => borradorFactcom({ percepciones });
  const mono = { ...ctx.proveedor, categoriaFiscal: { ...ctx.proveedor.categoriaFiscal, ivaDiscriminado: false } };
  assert.ok(mensajes(con([{ tipo: 'PIVA', importe: 5 }]), { ...ctx, proveedor: mono })
    .includes('v1: el proveedor no discrimina IVA; SiGA no admite percepciones para él.'));
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: 'SF', importe: -1 }]), ctx), ['Las Percepciones de IIBB no pueden ser negativas.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PGANA', importe: -1 }]), ctx), ['Las Percepciones de Ganancias no pueden ser negativas.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'IMINT', importe: -1 }]), ctx), ['Los Impuestos Internos no pueden ser negativos.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: null, importe: 3 }]), ctx), ['v1: la percepción PIIBB necesita la provincia.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: 'SF', importe: 3 }, { tipo: 'PIIBB', idProvincia: 'SF', importe: 4 }]), ctx),
    ['v1: hay dos percepciones PIIBB para la provincia SF.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIVA', importe: 3 }, { tipo: 'PIVA', importe: 4 }]), ctx), ['v1: hay más de una percepción PIVA.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'XYZ', importe: 3 }]), ctx), ['v1: tipo de percepción desconocido: XYZ.']);
});

test('PIIBB: una fila por provincia, sin provincia vacía (Win L24187)', () => {
  const ctx = contextoFactcom();
  const con = percepciones => borradorFactcom({ percepciones });
  const sinProvincia = ['v1: la percepción PIIBB necesita la provincia.'];
  for (const idProvincia of [null, undefined, '', '   ']) {
    assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia, importe: 3 }]), ctx), sinProvincia, JSON.stringify(idProvincia));
  }
  // Base sin importe también se grabaría (BaseImponible + Importe != 0): necesita provincia.
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: null, importe: 0, baseImponible: 100 }]), ctx), sinProvincia);
  // Una fila totalmente en cero no se graba: no molesta.
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: null, importe: 0, baseImponible: 0 }]), ctx), []);
  // Repetida, aunque cambie el espacio sobrante; provincias distintas, bien.
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: 'SF', importe: 3 }, { tipo: 'PIIBB', idProvincia: ' SF ', importe: 4 }]), ctx),
    ['v1: hay dos percepciones PIIBB para la provincia SF.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: 'SF', importe: 3 }, { tipo: 'PIIBB', idProvincia: 'BA', importe: 4 }]), ctx), []);
});

test('percepciones: importe no numérico o negativo se rechaza', () => {
  const ctx = contextoFactcom();
  const con = percepciones => borradorFactcom({ percepciones });
  for (const importe of [NaN, undefined, null, '', 'abc', true, Infinity, []]) {
    assert.deepStrictEqual(mensajes(con([{ tipo: 'PIVA', importe }]), ctx),
      ['El importe de la percepción PIVA no es un número válido.'], String(importe));
  }
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIIBB', idProvincia: 'SF', importe: 'x' }]), ctx),
    ['El importe de la percepción PIIBB no es un número válido.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PVAR', importe: -0.01 }]), ctx), ['v1: la percepción PVAR no puede ser negativa.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PVAR', importe: '-2' }]), ctx), ['v1: la percepción PVAR no puede ser negativa.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIVA', importe: 10, baseImponible: 'zz' }]), ctx),
    ['La base imponible de la percepción PIVA no es un número válido.']);
  assert.deepStrictEqual(mensajes(con([null]), ctx), ['v1: hay una percepción vacía o inválida.']);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIVA', importe: '955.19' }]), ctx), []);
  assert.deepStrictEqual(mensajes(con([{ tipo: 'PIVA', importe: 0 }]), ctx), []);
});

test('modoNumeracion (DOC Parte I §3.2) y cuitValido', () => {
  assert.strictEqual(modoNumeracion({ numeracionAutomatica: false, coeficienteStock: 1, afectaCaja: true, actualizaCtaCte: true }, false), 'manual');
  assert.strictEqual(modoNumeracion({ numeracionAutomatica: true }, false), 'proveedor');
  assert.strictEqual(modoNumeracion({ numeracionAutomatica: true }, true), 'ventasNumeros');
  assert.strictEqual(modoNumeracion({ numeracionAutomatica: false, coeficienteStock: 0, afectaCaja: false, actualizaCtaCte: false }, false), 'comprasNumeros');
  assert.strictEqual(cuitValido('20-12345678-6'), true);
  assert.strictEqual(cuitValido('20123456780'), false);
  assert.strictEqual(cuitValido('123'), false);
});
