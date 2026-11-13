'use strict';
// Precio del catálogo: PrecioVenta de SIGA tal cual (lista 0, sucursal 1) → respaldo → revisar. Nunca de Precios.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cotizador_mayorista');

// Aunque el listado traiga decisión, vigente y sugeridos, el índice sólo da vínculos: el precio sale de `precios`.
const listados = { almacen: [{ plu: '609', decision: { fuente: 'sistema' },
  mayoristas: [{ plu: '3676', tipo: 'pack', vigente: 4850.4 }, { plu: '3677', tipo: 'bulto', vigente: 5000 }],
  sugeridos: { sistema: { mayoristas: [{ plu: '3676', neto: 6000 }, { plu: '3677', neto: 5500 }] } } }] };
const tabla = { filas: [{ cod: '609', seccion: 'Mieles', nombre: 'Miel', packQty: '12u', bultoQty: '48u' }] };
const armar = (precios, respaldos) => C.armarCatalogo({ tabla, indice: C.indicePrecios(listados), precios, respaldos });

test('precio tal cual de SIGA (con decimales, sin IVA ni redondeo), origen siga', () => {
  const { filas, revisar } = armar(new Map([['3676', 4850.37], ['3677', 18000]]));
  assert.deepStrictEqual([filas[0].pack_price, filas[0].origen.pack, filas[0].bulto_price, filas[0].origen.bulto], [4850.37, 'siga', 18000, 'siga']);
  assert.deepStrictEqual(revisar, []);
});

test('sin precio en SIGA → respaldo con motivo en revisar', () => {
  const { filas, revisar } = armar(new Map([['3676', 4850], ['3677', 0]]), new Map([['609', { pack_price: '4000', bulto_price: '3800' }]]));
  assert.deepStrictEqual([filas[0].pack_price, filas[0].origen.pack, filas[0].bulto_price, filas[0].origen.bulto], [4850, 'siga', 3800, 'respaldo']);
  assert.deepStrictEqual(revisar, [{ cod: '609', nombre: 'Miel', motivos: ['bulto: PLU 3677 sin precio en SIGA'], respaldo: true }]);
});

test('sin precio en SIGA ni respaldo → la fila no sale y va a revisar', () => {
  const { filas, revisar } = armar(new Map());
  assert.deepStrictEqual(filas, []);
  assert.deepStrictEqual(revisar, [{ cod: '609', nombre: 'Miel', motivos: ['pack: PLU 3676 sin precio en SIGA', 'bulto: PLU 3677 sin precio en SIGA'], respaldo: false }]);
});

test('plusDePrecio: PLU en uso (explícito o vínculo) de filas incluidas, sin pack en ninguno', () => {
  const idx = C.indicePrecios(listados);
  const filas = [tabla.filas[0], { cod: '1', bultoPlu: '77', packPlu: '76', modoPack: 'ninguno' }, { cod: '2', bultoPlu: '88', incluido: false }];
  assert.deepStrictEqual(C.plusDePrecio(filas, idx), ['3676', '3677', '77']);
});

test('compararConPublicado: cambio de precio de SIGA → cambió con pct y conSiga', () => {
  const pub = C.parsearCsv('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n609,Mieles,Miel,12u,4000,48u,3800\n');
  const r = C.compararConPublicado(pub, armar(new Map([['3676', 4850]]), new Map([['609', { pack_price: '4000', bulto_price: '3800' }]])).filas);
  const pack = r.detalle.find(d => d.tipo === 'pack');
  assert.deepStrictEqual([pack.estado, pack.pct, pack.origen, pack.sistema], ['cambió', 21.3, 'siga', 4850]);
  assert.deepStrictEqual([r.cambiaron, r.iguales, r.conSiga, r.conRespaldo], [1, 1, 1, 1]);
});

test('preciosSigaPorPlu: sucursal 1 y lista 0 fijas, sin filtro de rubro, descarta inyección, chunk de 500, valor tal cual', async () => {
  const sqls = [];
  const { preciosSigaPorPlu } = require('../lib/precios_consultas').crearConsultasPrecios({ LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
    query: async sql => { sqls.push(sql); return sqls.length === 1 ? [{ plu: '1 ', precio: 1234.56 }] : [{ plu: '501', precio: 10 }]; } });
  const r = await preciosSigaPorPlu([...Array.from({ length: 600 }, (_, i) => String(i + 1)), "1'; DROP TABLE x--", '', null, '1']);
  assert.strictEqual(sqls.length, 2);
  assert.ok(!sqls.join().includes('DROP'));
  assert.match(sqls[0], /FROM ProductosSucursalesPrecios\s+WHERE IdSucursal = 1 AND IdListaPrecios = 0 AND PrecioVenta IS NOT NULL AND IdProducto IN \('1','2'/);
  assert.ok(!/Rubro|Activo/i.test(sqls.join()));
  assert.deepStrictEqual([...r], [['1', 1234.56], ['501', 10]]);
  sqls.length = 0;
  assert.deepStrictEqual(await preciosSigaPorPlu(undefined), new Map());
  assert.strictEqual(sqls.length, 0);
});
