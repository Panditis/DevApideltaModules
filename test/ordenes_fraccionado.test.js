const test = require('node:test');
const assert = require('node:assert');
const { validarLineasFraccionado, normalizarLineasFraccionado, totalesOrdenFraccionado,
        progresoOrdenFraccionado, marcarLineaOrden } = require('../ordenes_fraccionado');

// ── Ordenes de fraccionado mayorista: validacion, normalizacion y totales ─────────────────────
// Las lineas llegan del body del POST/PUT de /api/mayoristas/ordenes-fraccionado. Antes salian
// siempre del endpoint automatico de faltantes (que resuelve granel); ahora el armado es manual
// y hay productos sin granel resoluble, por eso el granel es opcional.

// Linea "completa" de referencia: mismo shape que manda la UI cuando el granel si se resolvio.
function lineaCompleta(extra) {
  return {
    plu: '30000', nombre: 'Mix Europeo 200G Unidad Bulto', cantidad: 10,
    granelPlu: '1522', granelNombre: 'Mix Europeo 10Kg (Precio por kilo)', cantPorUnidad: 0.2,
    ...extra,
  };
}

// ── Normalizacion: granel presente ────────────────────────────────────────────────────────────

test('linea completa con granel calcula granelNecesario como cantidad por cantPorUnidad', () => {
  // Arrange
  const lineas = [lineaCompleta()];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cantPorUnidad, 0.2);
  assert.strictEqual(linea.granelNecesario, 2);
  assert.strictEqual(linea.granelPlu, '1522');
  assert.strictEqual(linea.granelNombre, 'Mix Europeo 10Kg (Precio por kilo)');
});

test('granelNecesario se redondea a 6 decimales para no arrastrar colas de punto flotante', () => {
  // Arrange: 3 x 0.1 en punto flotante da 0.30000000000000004.
  const lineas = [lineaCompleta({ cantidad: 3, cantPorUnidad: 0.1 })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.granelNecesario, 0.3);
});

// ── Normalizacion: granel ausente o invalido ──────────────────────────────────────────────────

test('linea sin granelPlu se acepta y queda con cantPorUnidad y granelNecesario en cero', () => {
  // Arrange: caso real "Yerba Apidelta 2Kg Pack X 40", cuyo producto de carga no existe en Siga.
  const lineas = [{ plu: '2547', nombre: 'Yerba Apidelta 2Kg Pack X 40', cantidad: 40 }];

  // Act
  const error = validarLineasFraccionado(lineas);
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(linea.granelPlu, '');
  assert.strictEqual(linea.granelNombre, '');
  assert.strictEqual(linea.cantPorUnidad, 0);
  assert.strictEqual(linea.granelNecesario, 0);
});

test('granelPlu vacio ignora el cantPorUnidad que igual haya mandado el cliente', () => {
  // Arrange: sin granel no hay contra que imputar kg, aunque venga un numero valido.
  const lineas = [{ plu: '2547', cantidad: 5, granelPlu: '   ', granelNombre: 'X', cantPorUnidad: 2 }];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cantPorUnidad, 0);
  assert.strictEqual(linea.granelNombre, '');
  assert.strictEqual(linea.granelNecesario, 0);
});

test('cantPorUnidad invalido con granelPlu presente se trata como cero y no rechaza la linea', () => {
  // Arrange: 0, negativo y no numerico son los tres casos que antes devolvian 400.
  const lineas = [
    lineaCompleta({ cantPorUnidad: 0 }),
    lineaCompleta({ cantPorUnidad: -1 }),
    lineaCompleta({ cantPorUnidad: 'no numerico' }),
    lineaCompleta({ cantPorUnidad: undefined }),
  ];

  // Act
  const error = validarLineasFraccionado(lineas);
  const normalizadas = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(error, null);
  for (const linea of normalizadas) {
    assert.strictEqual(linea.cantPorUnidad, 0);
    assert.strictEqual(linea.granelNecesario, 0);
    assert.strictEqual(linea.granelPlu, '1522');   // el granel elegido se conserva
  }
});

// ── Validacion: plu y cantidad siguen siendo obligatorios ─────────────────────────────────────

test('plu vacio o ausente devuelve el error de linea sin PLU', () => {
  // Arrange
  const casos = [
    [{ plu: '', cantidad: 1 }],
    [{ plu: '   ', cantidad: 1 }],
    [{ cantidad: 1 }],
  ];

  // Act + Assert
  for (const lineas of casos) {
    assert.strictEqual(validarLineasFraccionado(lineas), 'Hay una línea sin PLU');
  }
});

test('cantidad cero, negativa o no numerica devuelve el error de cantidad invalida', () => {
  // Arrange
  const casos = [0, -3, 'abc', undefined, null, NaN, Infinity];

  // Act + Assert
  for (const cantidad of casos) {
    const lineas = [lineaCompleta({ cantidad })];
    assert.strictEqual(validarLineasFraccionado(lineas), 'Cantidad inválida en el PLU 30000');
  }
});

test('lineas vacio, no array o con un elemento nulo devuelve error', () => {
  // Arrange + Act + Assert
  const mensajeSinLineas = 'La orden tiene que tener al menos una línea';
  assert.strictEqual(validarLineasFraccionado([]), mensajeSinLineas);
  assert.strictEqual(validarLineasFraccionado(undefined), mensajeSinLineas);
  assert.strictEqual(validarLineasFraccionado(null), mensajeSinLineas);
  assert.strictEqual(validarLineasFraccionado('30000'), mensajeSinLineas);
  assert.strictEqual(validarLineasFraccionado({ plu: '30000' }), mensajeSinLineas);
  assert.strictEqual(validarLineasFraccionado([null]), 'Hay una línea inválida');
  assert.strictEqual(validarLineasFraccionado([lineaCompleta(), 'texto']), 'Hay una línea inválida');
});

// ── Totales ───────────────────────────────────────────────────────────────────────────────────

test('los totales suman unidades de todas las lineas y kg solo de las que tienen granel', () => {
  // Arrange
  const lineas = normalizarLineasFraccionado([
    lineaCompleta({ cantidad: 10, cantPorUnidad: 0.2 }),          // 2 kg
    { plu: '2547', cantidad: 40 },                                // sin granel: 0 kg
    lineaCompleta({ plu: '30002', cantidad: 5, cantPorUnidad: 1.5 }),  // 7.5 kg
  ]);

  // Act
  const totales = totalesOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(totales, { lineas: 3, unidades: 55, kgGranel: 9.5 });
});

test('una orden con todas las lineas sin granel da cero kg pero conserva las unidades', () => {
  // Arrange
  const lineas = normalizarLineasFraccionado([
    { plu: '2547', cantidad: 40 },
    { plu: '2548', cantidad: 2 },
  ]);

  // Act
  const totales = totalesOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(totales, { lineas: 2, unidades: 42, kgGranel: 0 });
});

test('los totales se recalculan y nunca se toman los que manda el cliente', () => {
  // Arrange: el body trae totales inventados; la normalizacion los descarta.
  const lineas = normalizarLineasFraccionado([
    lineaCompleta({ cantidad: 10, cantPorUnidad: 0.2, totales: { lineas: 99, unidades: 99, kgGranel: 99 } }),
  ]);

  // Act
  const totales = totalesOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(totales, { lineas: 1, unidades: 10, kgGranel: 2 });
  assert.strictEqual(lineas[0].totales, undefined);
});

// ── Campos de imputacion de produccion (pluCarga / nombreCarga) ───────────────────────────────

test('pluCarga y nombreCarga se preservan tal cual los manda el frontend', () => {
  // Arrange: vienen de /api/mayoristas/producto-carga, no se derivan ni se validan acá.
  const lineas = [lineaCompleta({ pluCarga: '91645', nombreCarga: 'Mix Europeo PEDIDOS' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.pluCarga, '91645');
  assert.strictEqual(linea.nombreCarga, 'Mix Europeo PEDIDOS');
});

test('pluCarga y nombreCarga ausentes quedan como string vacio', () => {
  // Arrange: la UI puede no haber resuelto el producto de carga; la linea se guarda igual.
  const lineas = [lineaCompleta(), { plu: '2547', cantidad: 1, pluCarga: null, nombreCarga: undefined }];

  // Act
  const normalizadas = normalizarLineasFraccionado(lineas);

  // Assert
  for (const linea of normalizadas) {
    assert.strictEqual(linea.pluCarga, '');
    assert.strictEqual(linea.nombreCarga, '');
  }
});

// ── Resto del shape persistido ────────────────────────────────────────────────────────────────

test('manual y clientes conservan su forma persistida', () => {
  // Arrange
  const lineas = [lineaCompleta({
    manual: 'si',                                          // solo `true` estricto cuenta
    clientes: [{ idCliente: 7, nombre: 'Cliente A', pendiente: '3' }, { idCliente: 8 }],
  })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.manual, false);
  assert.deepStrictEqual(linea.clientes, [
    { idCliente: 7, nombre: 'Cliente A', pendiente: 3 },
    { idCliente: 8, nombre: '', pendiente: 0 },
  ]);
});

// ── Estado por linea: normalizacion y retrocompatibilidad ─────────────────────────────────────
// La encargada de fraccionamiento marca cada linea desde la tab Pedidos: o carga la produccion
// ("cargado", cualquier cantidad cierra la linea) o avisa que no la va a hacer ("sin_stock").

test('linea nueva arranca pendiente, sin cantidad cargada ni fecha', () => {
  // Arrange
  const lineas = [lineaCompleta()];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.estado, 'pendiente');
  assert.strictEqual(linea.cargadoCant, 0);
  assert.strictEqual(linea.cargadoFecha, '');
});

test('orden vieja sin los campos de avance se normaliza con los defaults', () => {
  // Arrange: las ordenes guardadas antes de este campo no deben romperse al leerlas ni al editarlas.
  const lineas = [{ plu: '30000', nombre: 'Mix Europeo 200G', cantidad: 10 }];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.estado, 'pendiente');
  assert.strictEqual(linea.cargadoCant, 0);
  assert.strictEqual(linea.cargadoFecha, '');
});

test('normalizar preserva el avance ya marcado para que editar la orden no lo borre', () => {
  // Arrange: el PUT de la orden renormaliza las lineas; lo que ya cargo la encargada tiene que sobrevivir.
  const lineas = [lineaCompleta({ estado: 'cargado', cargadoCant: 50, cargadoFecha: '2026-07-30' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.estado, 'cargado');
  assert.strictEqual(linea.cargadoCant, 50);
  assert.strictEqual(linea.cargadoFecha, '2026-07-30');
});

test('normalizar descarta un estado de linea que no sea uno de los tres validos', () => {
  // Arrange: dato corrupto en el archivo o body malicioso; se cae al default seguro.
  const lineas = [lineaCompleta({ estado: 'terminado', cargadoCant: 9, cargadoFecha: '2026-07-30' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.estado, 'pendiente');
  assert.strictEqual(linea.cargadoCant, 0);
  assert.strictEqual(linea.cargadoFecha, '');
});

// ── marcarLineaOrden: cambios de estado ───────────────────────────────────────────────────────

// Orden minima con dos lineas, el shape que devuelve el CRUD.
function ordenDePrueba(extraLineas) {
  return {
    id: 1785430167930, fecha: '2026-07-30', estado: 'pendiente',
    lineas: normalizarLineasFraccionado([
      lineaCompleta({ plu: '30000', cantidad: 84 }),
      lineaCompleta({ plu: '30002', cantidad: 12 }),
      ...(extraLineas || []),
    ]),
  };
}

test('marcar cargado guarda la cantidad real aunque sea menor a la pedida', () => {
  // Arrange: regla de negocio, no hay parciales: 50 de 84 igual cierra la linea.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
    { estado: 'cargado', cargadoCant: 50, fecha: '2026-07-30' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].estado, 'cargado');
  assert.strictEqual(nueva.lineas[0].cargadoCant, 50);
  assert.strictEqual(nueva.lineas[0].cargadoFecha, '2026-07-30');
  assert.strictEqual(nueva.lineas[1].estado, 'pendiente');   // las demas no se tocan
});

test('marcar sin_stock ignora cualquier cantidad porque no se produjo nada', () => {
  // Arrange: "sin stock" es por linea y sin nota, un solo toque.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30002',
    { estado: 'sin_stock', cargadoCant: 5, fecha: '2026-07-30' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[1].estado, 'sin_stock');
  assert.strictEqual(nueva.lineas[1].cargadoCant, 0);
  assert.strictEqual(nueva.lineas[1].cargadoFecha, '');
});

test('volver a pendiente desde cargado o sin_stock limpia cantidad y fecha', () => {
  // Arrange: la encargada se puede equivocar y marcar de mas, tiene que poder deshacer.
  const cargada = marcarLineaOrden(ordenDePrueba(), '30000',
    { estado: 'cargado', cargadoCant: 84, fecha: '2026-07-30' }).orden;
  const sinStock = marcarLineaOrden(ordenDePrueba(), '30000',
    { estado: 'sin_stock', fecha: '2026-07-30' }).orden;

  // Act + Assert
  for (const previa of [cargada, sinStock]) {
    const { orden: nueva, error } = marcarLineaOrden(previa, '30000',
      { estado: 'pendiente', fecha: '2026-07-31' });
    assert.strictEqual(error, null);
    assert.strictEqual(nueva.lineas[0].estado, 'pendiente');
    assert.strictEqual(nueva.lineas[0].cargadoCant, 0);
    assert.strictEqual(nueva.lineas[0].cargadoFecha, '');
  }
});

test('marcar una linea no muta la orden original ni sus lineas', () => {
  // Arrange: la funcion es pura, el server persiste solo lo que devuelve.
  const orden = ordenDePrueba();
  const lineaOriginal = orden.lineas[0];

  // Act
  const { orden: nueva } = marcarLineaOrden(orden, '30000',
    { estado: 'cargado', cargadoCant: 84, fecha: '2026-07-30' });

  // Assert
  assert.strictEqual(orden.lineas[0].estado, 'pendiente');
  assert.strictEqual(orden.lineas[0].cargadoCant, 0);
  assert.notStrictEqual(nueva, orden);
  assert.notStrictEqual(nueva.lineas[0], lineaOriginal);
  assert.strictEqual(nueva.lineas[1], orden.lineas[1]);   // las no tocadas se reusan
});

// ── marcarLineaOrden: validaciones ────────────────────────────────────────────────────────────

test('estado de linea invalido devuelve error y no toca la orden', () => {
  // Arrange
  const orden = ordenDePrueba();

  // Act + Assert
  for (const estado of ['terminado', '', undefined, null, 'aplicada']) {
    const { orden: nueva, error } = marcarLineaOrden(orden, '30000', { estado, cargadoCant: 1 });
    assert.strictEqual(nueva, null);
    assert.strictEqual(error, `Estado de línea inválido: ${estado}`);
  }
});

test('PLU inexistente devuelve el error con el PLU pedido', () => {
  // Arrange
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '99999',
    { estado: 'cargado', cargadoCant: 1, fecha: '2026-07-30' });

  // Assert
  assert.strictEqual(nueva, null);
  assert.strictEqual(error, 'La orden no tiene una línea con el PLU 99999');
});

test('cargadoCant negativa, no numerica o ausente devuelve error al cargar', () => {
  // Arrange: solo se exige cantidad cuando se esta cargando produccion.
  const orden = ordenDePrueba();

  // Act + Assert
  for (const cargadoCant of [-1, 'abc', undefined, null, NaN, Infinity]) {
    const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
      { estado: 'cargado', cargadoCant, fecha: '2026-07-30' });
    assert.strictEqual(nueva, null);
    assert.strictEqual(error, 'Cantidad cargada inválida en el PLU 30000');
  }
});

test('cargar cero unidades es valido: cierra la linea sin haber producido nada util', () => {
  // Arrange: 0 es un valor legitimo, distinto de "no numerico".
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
    { estado: 'cargado', cargadoCant: 0, fecha: '2026-07-30' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].estado, 'cargado');
  assert.strictEqual(nueva.lineas[0].cargadoCant, 0);
});

// ── Progreso ──────────────────────────────────────────────────────────────────────────────────

test('el progreso cuenta las lineas de los tres estados por separado', () => {
  // Arrange
  const lineas = normalizarLineasFraccionado([
    lineaCompleta({ plu: '1', estado: 'cargado', cargadoCant: 10 }),
    lineaCompleta({ plu: '2', estado: 'cargado', cargadoCant: 3 }),
    lineaCompleta({ plu: '3', estado: 'sin_stock' }),
    lineaCompleta({ plu: '4' }),
  ]);

  // Act
  const progreso = progresoOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(progreso, { total: 4, cargadas: 2, sinStock: 1, pendientes: 1 });
});

test('las lineas viejas sin estado cuentan como pendientes aunque no se hayan normalizado', () => {
  // Arrange: el progreso se calcula al vuelo sobre lo que haya en el archivo.
  const lineas = [{ plu: '1', cantidad: 5 }, { plu: '2', cantidad: 5, estado: 'cargado' }];

  // Act
  const progreso = progresoOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(progreso, { total: 2, cargadas: 1, sinStock: 0, pendientes: 1 });
});

test('el progreso de una orden sin lineas da todo en cero', () => {
  // Arrange + Act + Assert
  const cero = { total: 0, cargadas: 0, sinStock: 0, pendientes: 0 };
  assert.deepStrictEqual(progresoOrdenFraccionado([]), cero);
  assert.deepStrictEqual(progresoOrdenFraccionado(undefined), cero);
});
