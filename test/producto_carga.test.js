const test = require('node:test');
const assert = require('node:assert');
const { resolverProductoCarga, analizarNombreCarga, pesoTokenKg, sqlNombresPorPlu } = require('../lib/producto_carga');

// ── Producto de carga: contra qué producto se imputa la produccion de una linea mayorista ─────
// El `catalogo` simula lo que devuelve la query de candidatos del endpoint: [{ plu, nombre }] de
// productos activos. Los nombres son reales, salidos de /api/productos/buscar contra Siga.

// Catálogo con las familias completas de Siga (minoristas, bultos, packs, granel y PEDIDOS):
// sirve para verificar que se elige el destino correcto y NO un hermano de empaque.
const CATALOGO = [
  { plu: '3802',  nombre: 'Mix Europeo 100G' },
  { plu: '1522',  nombre: 'Mix Europeo 10Kg (Precio por kilo)' },
  { plu: '1523',  nombre: 'Mix Europeo 1Kg' },
  { plu: '20131', nombre: 'Mix Europeo 1Kg Unidad Bulto' },
  { plu: '1524',  nombre: 'Mix Europeo 200G' },
  { plu: '30000', nombre: 'Mix Europeo 200G Unidad Bulto' },
  { plu: '30022', nombre: 'Mix Europeo 200G Unidad Pack' },
  { plu: '1525',  nombre: 'Mix Europeo 5Kg' },
  { plu: '91645', nombre: 'Mix Europeo PEDIDOS' },
  { plu: '1528',  nombre: 'Mix F.S N&P 200G' },
  { plu: '30002', nombre: 'Mix F.S N&P 200G Unidad Bulto' },
  { plu: '91646', nombre: 'Mix F.S N&P PEDIDOS' },
  { plu: '1499',  nombre: 'Yerba Apidelta 2Kg' },
  { plu: '2547',  nombre: 'Yerba Apidelta 2Kg Pack X 40 Unidades (Precio Por Unid)' },
  { plu: '91999', nombre: 'Yerba Apidelta PEDIDOS' },
];

test('presentacion menor a 1kg: el bulto de 200G se carga contra el minorista de 200G', () => {
  // Arrange: caso real de la orden de fraccionado (PLU 30000).
  const nombre = 'Mix Europeo 200G Unidad Bulto';

  // Act
  const r = resolverProductoCarga(nombre, CATALOGO);

  // Assert: gana el minorista puro, no el Pack ni el propio bulto ni el granel de 10Kg.
  assert.deepStrictEqual(r, { plu: '1524', nombre: 'Mix Europeo 200G', via: 'minorista', presentacionKg: 0.2 });
});

test('nombre con simbolos: Mix F.S N&P 200G Unidad Bulto resuelve al minorista de 200G', () => {
  // Arrange: el "&" y los puntos no pueden romper la comparacion.
  const nombre = 'Mix F.S N&P 200G Unidad Bulto';

  // Act
  const r = resolverProductoCarga(nombre, CATALOGO);

  // Assert
  assert.strictEqual(r.plu, '1528');
  assert.strictEqual(r.via, 'minorista');
});

test('el propio producto PEDIDOS se carga contra si mismo', () => {
  // Arrange: caso real (PLU 91848 "G. KETO PEDIDOS"). El nombre no tiene token de peso, asi que
  // la base es el nombre entero: antes se buscaba "... PEDIDOS PEDIDOS" y no resolvia destino.
  const CAT = [{ plu: '91645', nombre: 'Mix Europeo PEDIDOS' }, { plu: '91848', nombre: 'G. KETO PEDIDOS' }];

  // Act
  const r = resolverProductoCarga('G. KETO PEDIDOS', CAT);

  // Assert
  assert.deepStrictEqual(r, { plu: '91848', nombre: 'G. KETO PEDIDOS', via: 'pedidos', presentacionKg: null });
});

test('presentacion mayor a 1kg: el pack de 2Kg se carga contra el producto PEDIDOS', () => {
  // Arrange: caso real (PLU 2547). El nombre encadena presentacion + pack + paentesis.
  const nombre = 'Yerba Apidelta 2Kg Pack X 40 Unidades (Precio Por Unid)';

  // Act
  const r = resolverProductoCarga(nombre, CATALOGO);

  // Assert: NO va al minorista "Yerba Apidelta 2Kg" aunque exista y matchee la presentacion.
  assert.deepStrictEqual(r, { plu: '91999', nombre: 'Yerba Apidelta PEDIDOS', via: 'pedidos', presentacionKg: 2 });
});

test('el limite de 1kg es inclusive: 1Kg todavia va por minorista', () => {
  // Arrange
  const nombre = 'Mix Europeo 1Kg Unidad Bulto';

  // Act
  const r = resolverProductoCarga(nombre, CATALOGO);

  // Assert
  assert.strictEqual(r.plu, '1523');
  assert.strictEqual(r.via, 'minorista');
});

test('coexisten minorista y PEDIDOS: elige segun el peso, no segun lo que exista', () => {
  // Arrange: la familia Mix Europeo tiene minoristas de 100G a 5Kg y ademas el PEDIDOS.
  // Act
  const chico = resolverProductoCarga('Mix Europeo 100G Unidad Bulto', CATALOGO);
  const grande = resolverProductoCarga('Mix Europeo 5Kg Bulto', CATALOGO);

  // Assert
  assert.deepStrictEqual([chico.plu, chico.via], ['3802', 'minorista']);
  assert.deepStrictEqual([grande.plu, grande.via], ['91645', 'pedidos']);
});

test('marcador "Precio por kilo" no achica la presentacion: 10Kg sigue yendo a PEDIDOS', () => {
  // Arrange: pesoPresentacionKg() devuelve 1 para estos nombres porque se venden por kilo, pero
  // el envase sigue siendo de 10Kg y el destino de carga tiene que ser el PEDIDOS.
  const nombre = 'Mix Europeo 10Kg (Precio por kilo)';

  // Act
  const r = resolverProductoCarga(nombre, CATALOGO);

  // Assert
  assert.strictEqual(r.plu, '91645');
  assert.strictEqual(r.via, 'pedidos');
});

test('sin presentacion en el nombre: se asume pedido y va al PEDIDOS', () => {
  // Arrange: hay productos de rubro Produccion sin gramaje en el nombre.
  const catalogo = [{ plu: '91500', nombre: 'Adobo Para Pizza PEDIDOS' }];

  // Act
  const r = resolverProductoCarga('Adobo Para Pizza Bulto', catalogo);

  // Assert
  assert.deepStrictEqual(r, { plu: '91500', nombre: 'Adobo Para Pizza PEDIDOS', via: 'pedidos', presentacionKg: null });
});

test('diferencias de mayusculas y tildes no impiden el match', () => {
  // Arrange: en Siga conviven mayusculas distintas y nombres con y sin tilde.
  const catalogo = [
    { plu: '4001', nombre: 'MANI TOSTADO SALADO 200g' },
    { plu: '4002', nombre: 'Maní Tostado Salado PEDIDOS' },
  ];

  // Act
  const chico = resolverProductoCarga('Maní Tostado Salado 200G Unidad Bulto', catalogo);
  const grande = resolverProductoCarga('MANI TOSTADO SALADO 20Kg', catalogo);

  // Assert
  assert.strictEqual(chico.plu, '4001');
  assert.strictEqual(grande.plu, '4002');
});

test('catalogo sin el destino: devuelve null en vez de inventar un producto', () => {
  // Arrange: existe la familia pero no el minorista de 500G ni el PEDIDOS.
  const catalogo = [
    { plu: '1524', nombre: 'Mix Europeo 200G' },
    { plu: '30000', nombre: 'Mix Europeo 200G Unidad Bulto' },
  ];

  // Act
  const sinMinorista = resolverProductoCarga('Mix Europeo 500G Unidad Bulto', catalogo);
  const sinPedidos = resolverProductoCarga('Mix Europeo 10Kg (Precio por kilo)', catalogo);

  // Assert
  assert.strictEqual(sinMinorista, null);
  assert.strictEqual(sinPedidos, null);
});

test('el minorista destino no puede tener cola de empaque', () => {
  // Arrange: solo estan el bulto y el pack de 200G, ninguno es el minorista puro.
  const catalogo = [
    { plu: '30000', nombre: 'Mix Europeo 200G Unidad Bulto' },
    { plu: '30022', nombre: 'Mix Europeo 200G Unidad Pack' },
  ];

  // Act
  const r = resolverProductoCarga('Mix Europeo 200G Unidad Bulto', catalogo);

  // Assert: prefiere no resolver antes que imputar contra otro bulto.
  assert.strictEqual(r, null);
});

test('empate por puntuacion: gana el nombre escrito igual que el mayorista', () => {
  // Arrange: Siga tiene los dos, "Mix F.S N&P PEDIDOS" y "Mix F.S. N&P PEDIDOS" (PLUs reales).
  const catalogo = [
    { plu: '91648', nombre: 'Mix F.S. N&P PEDIDOS' },
    { plu: '91646', nombre: 'Mix F.S N&P PEDIDOS' },
  ];

  // Act
  const r = resolverProductoCarga('Mix F.S N&P 10Kg (Precio por kilo)', catalogo);

  // Assert
  assert.strictEqual(r.plu, '91646');
});

test('entradas invalidas no revientan: nombre vacio o catalogo ausente devuelven null', () => {
  // Arrange + Act + Assert
  assert.strictEqual(resolverProductoCarga('', CATALOGO), null);
  assert.strictEqual(resolverProductoCarga(null, CATALOGO), null);
  assert.strictEqual(resolverProductoCarga('Mix Europeo 200G Bulto', null), null);
  assert.strictEqual(resolverProductoCarga('Mix Europeo 200G Bulto', []), null);
});

test('analizarNombreCarga separa base, presentacion y cola de empaque', () => {
  // Arrange + Act
  const bulto = analizarNombreCarga('Mix Europeo 200G Unidad Bulto');
  const pack = analizarNombreCarga('Yerba Apidelta 2Kg Pack X 40 Unidades (Precio Por Unid)');
  const puro = analizarNombreCarga('Mix Europeo 200G');
  const sinPres = analizarNombreCarga('Adobo Para Pizza Bulto');

  // Assert
  assert.deepStrictEqual(bulto, { base: 'Mix Europeo', presentacionKg: 0.2, resto: 'Unidad Bulto' });
  assert.strictEqual(pack.base, 'Yerba Apidelta');
  assert.strictEqual(pack.presentacionKg, 2);
  assert.deepStrictEqual(puro, { base: 'Mix Europeo', presentacionKg: 0.2, resto: '' });
  assert.deepStrictEqual(sinPres, { base: 'Adobo Para Pizza', presentacionKg: null, resto: '' });
});

test('pesoTokenKg toma el ultimo token de peso y lo pasa a kg', () => {
  // Arrange + Act + Assert: mismas conversiones que pesoPresentacionKg(), que ahora lo reusa.
  assert.strictEqual(pesoTokenKg('Mani 250G'), 0.25);
  assert.strictEqual(pesoTokenKg('Mani 500 Gr'), 0.5);
  assert.strictEqual(pesoTokenKg('Mani 1Kg'), 1);
  assert.strictEqual(pesoTokenKg('Yerba Apidelta 1Kg Bulto X 160 Unidades (Precio Por Un)'), 1);
  assert.strictEqual(pesoTokenKg('Almendra Non Pareil Grande 5Kg (Precio Por Kg)'), 5);
  assert.strictEqual(pesoTokenKg('Adobo Para Pizza PEDIDOS'), null);
});

// -- Nombres SiGA por PLU: lo que alimenta los CSV de produccion --------------------------------
test('sqlNombresPorPlu cita los codigos, deduplica y descarta lo que no es un PLU', () => {
  // Arrange: el ultimo trae comilla y comentario SQL; los codigos llegan del querystring.
  const plus = ['1011', ' 7063 ', '1011', "90262' UNION SELECT 1--", '', 'PLU 5'];

  // Act
  const sql = sqlNombresPorPlu(plus);

  // Assert
  assert.match(sql, /IN \('1011','7063'\)$/);
  assert.ok(!sql.includes('UNION'));
  assert.strictEqual(sqlNombresPorPlu([]), null);
  assert.strictEqual(sqlNombresPorPlu(["' UNION SELECT 1--"]), null);
});
