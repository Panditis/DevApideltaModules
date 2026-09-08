const test = require('node:test');
const assert = require('node:assert');
const { validarLineasFraccionado, normalizarLineasFraccionado, totalesOrdenFraccionado,
        progresoOrdenFraccionado, marcarLineaOrden, editarLineaOrden, validarLineasNoRepetidas,
        plusEnOrdenesActivas } = require('../lib/ordenes_fraccionado');

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

// ── Nota por linea ────────────────────────────────────────────────────────────────────────────
// La escribe quien arma la orden en Pedidos mayoristas y la lee la encargada en Distribucion.

test('la nota de la linea se guarda sin espacios sobrantes', () => {
  // Arrange
  const lineas = [lineaCompleta({ nota: '  va sin etiqueta  ' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.nota, 'va sin etiqueta');
});

test('una linea sin nota (o con una nota no textual) queda con la nota vacia', () => {
  // Arrange: las ordenes guardadas antes de este campo no la tienen y se leen igual.
  const lineas = normalizarLineasFraccionado([
    lineaCompleta({ plu: '1' }),
    lineaCompleta({ plu: '2', nota: null }),
    lineaCompleta({ plu: '3', nota: 42 }),
  ]);

  // Assert
  assert.strictEqual(lineas[0].nota, '');
  assert.strictEqual(lineas[1].nota, '');
  assert.strictEqual(lineas[2].nota, '42');   // numero: se guarda como texto, no se pierde el dato
});

test('una nota larguisima se recorta a 300 caracteres', () => {
  // Arrange: un pegado accidental no puede inflar el archivo ni romper la fila.
  const lineas = [lineaCompleta({ nota: 'x'.repeat(500) })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.nota.length, 300);
});

test('marcar una linea no pierde su nota', () => {
  // Arrange: la nota es del pedido, el estado es del avance; no se pisan entre si.
  const orden = {
    id: 1, fecha: '2026-08-04', estado: 'pendiente',
    lineas: normalizarLineasFraccionado([lineaCompleta({ nota: 'bolsa chica' })]),
  };

  // Act
  const { orden: nueva } = marcarLineaOrden(orden, '30000',
    { estado: 'preparado', fecha: '2026-08-04', hora: '09:10' });

  // Assert
  assert.strictEqual(nueva.lineas[0].nota, 'bolsa chica');
});

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

test('marcar preparado cierra la linea sin cantidad cargada', () => {
  // Arrange: el producto ya estaba listo, no se fracciono nada.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
    { estado: 'preparado', fecha: '2026-08-04', hora: '09:10' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].estado, 'preparado');
  assert.strictEqual(nueva.lineas[0].cargadoCant, 0);
  assert.strictEqual(nueva.lineas[0].cargadoFecha, '2026-08-04');
  assert.strictEqual(nueva.lineas[0].cargadoHora, '09:10');
  assert.strictEqual(nueva.lineas[1].estado, 'pendiente');   // las demas no se tocan
});

test('marcar preparado no exige cantidad ni guarda la que venga en el body', () => {
  // Arrange: preparado no registra produccion, cualquier cantidad del body se ignora.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
    { estado: 'preparado', cargadoCant: 84, fecha: '2026-08-04' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].cargadoCant, 0);
});

test('volver a pendiente desde preparado limpia el sello de fecha y hora', () => {
  // Arrange: la encargada se puede equivocar y tiene que poder deshacer.
  const preparada = marcarLineaOrden(ordenDePrueba(), '30000',
    { estado: 'preparado', fecha: '2026-08-04', hora: '09:10' }).orden;

  // Act
  const { orden: nueva, error } = marcarLineaOrden(preparada, '30000',
    { estado: 'pendiente', fecha: '2026-08-05', hora: '10:00' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].estado, 'pendiente');
  assert.strictEqual(nueva.lineas[0].cargadoFecha, '');
  assert.strictEqual(nueva.lineas[0].cargadoHora, '');
});

test('marcar cargado guarda la hora junto con la fecha', () => {
  // Arrange: el badge de la tab Pedidos muestra dia y hora de la carga.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
    { estado: 'cargado', cargadoCant: 84, fecha: '2026-07-30', hora: '14:35' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].cargadoHora, '14:35');
});

test('una hora con formato invalido se guarda vacia y no rompe la carga', () => {
  // Arrange: dato corrupto o body armado a mano; la linea igual se tiene que poder cargar.
  const orden = ordenDePrueba();

  // Act + Assert
  for (const hora of ['25:00', '9:5', 'ayer', '', undefined]) {
    const { orden: nueva, error } = marcarLineaOrden(orden, '30000',
      { estado: 'cargado', cargadoCant: 84, fecha: '2026-07-30', hora });
    assert.strictEqual(error, null);
    assert.strictEqual(nueva.lineas[0].cargadoHora, '');
  }
});

test('volver a pendiente o marcar sin_stock limpia la hora de carga', () => {
  // Arrange: si no se cargo nada, no puede quedar la hora de una carga anterior.
  const cargada = marcarLineaOrden(ordenDePrueba(), '30000',
    { estado: 'cargado', cargadoCant: 84, fecha: '2026-07-30', hora: '14:35' }).orden;

  // Act + Assert
  for (const estado of ['pendiente', 'sin_stock']) {
    const { orden: nueva } = marcarLineaOrden(cargada, '30000',
      { estado, fecha: '2026-07-31', hora: '08:00' });
    assert.strictEqual(nueva.lineas[0].cargadoHora, '');
  }
});

test('normalizar preserva la hora de carga al editar la orden', () => {
  // Arrange: el PUT de la orden renormaliza las lineas; la hora ya cargada tiene que sobrevivir.
  const lineas = [lineaCompleta({ estado: 'cargado', cargadoCant: 50,
    cargadoFecha: '2026-07-30', cargadoHora: '14:35' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cargadoHora, '14:35');
});

test('una linea vieja cargada sin hora se normaliza con la hora vacia', () => {
  // Arrange: las ordenes cargadas antes de este campo se leen igual, sin inventarles un horario.
  const lineas = [lineaCompleta({ estado: 'cargado', cargadoCant: 50, cargadoFecha: '2026-07-30' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cargadoFecha, '2026-07-30');
  assert.strictEqual(linea.cargadoHora, '');
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

// ── editarLineaOrden: cambiar la cantidad pedida ──────────────────────────────────────────────
// Pedidos mayoristas puede corregir la cantidad de una linea mientras la sala no la haya trabajado.

test('editar la cantidad recalcula el granel necesario de la linea', () => {
  // Arrange: 84 unidades a 0.2 kg c/u; se pasa a 100.
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = editarLineaOrden(orden, '30000',
    { cantidad: 100, fecha: '2026-08-04', hora: '13:20' });

  // Assert
  assert.strictEqual(error, null);
  assert.strictEqual(nueva.lineas[0].cantidad, 100);
  assert.strictEqual(nueva.lineas[0].granelNecesario, 20);
  assert.strictEqual(nueva.lineas[0].editadoFecha, '2026-08-04');
  assert.strictEqual(nueva.lineas[0].editadoHora, '13:20');
  assert.strictEqual(nueva.lineas[1].cantidad, 12);   // las demas no se tocan
});

test('editar con cantidad cero, negativa o no numerica devuelve error', () => {
  // Arrange: mismo criterio que validarLineasFraccionado.
  const orden = ordenDePrueba();

  // Act + Assert
  for (const cantidad of [0, -5, 'abc', undefined, null, NaN, Infinity]) {
    const { orden: nueva, error } = editarLineaOrden(orden, '30000', { cantidad });
    assert.strictEqual(nueva, null);
    assert.strictEqual(error, 'Cantidad inválida en el PLU 30000');
  }
});

test('editar un PLU que no esta en la orden devuelve error', () => {
  // Arrange
  const orden = ordenDePrueba();

  // Act
  const { orden: nueva, error } = editarLineaOrden(orden, '99999', { cantidad: 5 });

  // Assert
  assert.strictEqual(nueva, null);
  assert.strictEqual(error, 'La orden no tiene una línea con el PLU 99999');
});

test('editar una linea ya resuelta se rechaza cualquiera sea el estado que la cerro', () => {
  // Arrange: si la sala ya la trabajo, cambiar la cantidad desfasaria la produccion registrada.
  // Para pedir mas se genera una orden nueva.
  const orden = ordenDePrueba();

  // Act + Assert
  for (const estado of ['cargado', 'preparado', 'sin_stock']) {
    const resuelta = marcarLineaOrden(orden, '30000',
      { estado, cargadoCant: 84, fecha: '2026-08-04', hora: '09:00' }).orden;
    const { orden: nueva, error } = editarLineaOrden(resuelta, '30000', { cantidad: 100 });
    assert.strictEqual(nueva, null);
    assert.strictEqual(error, 'La línea del PLU 30000 ya está resuelta y no se puede editar');
  }
});

test('cantidadOriginal se sella en la primera edicion y no se pisa en las siguientes', () => {
  // Arrange: Distribucion tiene que ver "pedia 84", no la penultima cantidad.
  const orden = ordenDePrueba();

  // Act
  const primera = editarLineaOrden(orden, '30000', { cantidad: 100 }).orden;
  const segunda = editarLineaOrden(primera, '30000', { cantidad: 120 }).orden;

  // Assert
  assert.strictEqual(primera.lineas[0].cantidadOriginal, 84);
  assert.strictEqual(segunda.lineas[0].cantidadOriginal, 84);
  assert.strictEqual(segunda.lineas[0].cantidad, 120);
});

test('editar reemplaza la nota si viene y la conserva si se omite', () => {
  // Arrange: mandar '' es borrar la observacion; no mandarla es no tocarla.
  const orden = {
    ...ordenDePrueba(),
    lineas: normalizarLineasFraccionado([lineaCompleta({ cantidad: 84, nota: 'bolsa chica' })]),
  };

  // Act
  const reemplazada = editarLineaOrden(orden, '30000', { cantidad: 90, nota: 'va sin etiqueta' }).orden;
  const borrada = editarLineaOrden(orden, '30000', { cantidad: 90, nota: '' }).orden;
  const conservada = editarLineaOrden(orden, '30000', { cantidad: 90 }).orden;

  // Assert
  assert.strictEqual(reemplazada.lineas[0].nota, 'va sin etiqueta');
  assert.strictEqual(borrada.lineas[0].nota, '');
  assert.strictEqual(conservada.lineas[0].nota, 'bolsa chica');
});

test('editar una linea no muta la orden original ni sus lineas', () => {
  // Arrange: la funcion es pura, el server persiste solo lo que devuelve.
  const orden = ordenDePrueba();
  const lineaOriginal = orden.lineas[0];

  // Act
  const { orden: nueva } = editarLineaOrden(orden, '30000', { cantidad: 100 });

  // Assert
  assert.strictEqual(orden.lineas[0].cantidad, 84);
  assert.strictEqual(orden.lineas[0].granelNecesario, 16.8);
  assert.strictEqual(orden.lineas[0].cantidadOriginal, 0);
  assert.notStrictEqual(nueva, orden);
  assert.notStrictEqual(nueva.lineas[0], lineaOriginal);
  assert.strictEqual(nueva.lineas[1], orden.lineas[1]);   // las no tocadas se reusan
});

test('normalizar preserva el rastro de la edicion para que reenviar la orden no lo borre', () => {
  // Arrange: el PUT de la orden renormaliza las lineas; el "pedia 84" tiene que sobrevivir.
  const lineas = [lineaCompleta({ cantidad: 100, cantidadOriginal: 84,
    editadoFecha: '2026-08-04', editadoHora: '13:20' })];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cantidadOriginal, 84);
  assert.strictEqual(linea.editadoFecha, '2026-08-04');
  assert.strictEqual(linea.editadoHora, '13:20');
});

test('una linea nunca editada se normaliza sin rastro de edicion', () => {
  // Arrange: las ordenes guardadas antes de estos campos se leen igual.
  const lineas = [lineaCompleta()];

  // Act
  const [linea] = normalizarLineasFraccionado(lineas);

  // Assert
  assert.strictEqual(linea.cantidadOriginal, 0);
  assert.strictEqual(linea.editadoFecha, '');
  assert.strictEqual(linea.editadoHora, '');
});

// ── Progreso ──────────────────────────────────────────────────────────────────────────────────

test('el progreso cuenta las lineas de cada estado por separado', () => {
  // Arrange
  const lineas = normalizarLineasFraccionado([
    lineaCompleta({ plu: '1', estado: 'cargado', cargadoCant: 10 }),
    lineaCompleta({ plu: '2', estado: 'cargado', cargadoCant: 3 }),
    lineaCompleta({ plu: '3', estado: 'sin_stock' }),
    lineaCompleta({ plu: '4' }),
    lineaCompleta({ plu: '5', estado: 'preparado' }),
  ]);

  // Act
  const progreso = progresoOrdenFraccionado(lineas);

  // Assert: preparadas va aparte de cargadas; solo el frontend de mayoristas las suma.
  assert.deepStrictEqual(progreso,
    { total: 5, cargadas: 2, preparadas: 1, sinStock: 1, pendientes: 1 });
});

test('las lineas viejas sin estado cuentan como pendientes aunque no se hayan normalizado', () => {
  // Arrange: el progreso se calcula al vuelo sobre lo que haya en el archivo.
  const lineas = [{ plu: '1', cantidad: 5 }, { plu: '2', cantidad: 5, estado: 'cargado' }];

  // Act
  const progreso = progresoOrdenFraccionado(lineas);

  // Assert
  assert.deepStrictEqual(progreso,
    { total: 2, cargadas: 1, preparadas: 0, sinStock: 0, pendientes: 1 });
});

test('el progreso de una orden sin lineas da todo en cero', () => {
  // Arrange + Act + Assert
  const cero = { total: 0, cargadas: 0, preparadas: 0, sinStock: 0, pendientes: 0 };
  assert.deepStrictEqual(progresoOrdenFraccionado([]), cero);
  assert.deepStrictEqual(progresoOrdenFraccionado(undefined), cero);
});

// ── Un articulo, una sola orden ───────────────────────────────────────────────────────────────
// Regla de negocio: un PLU no se puede volver a mandar a fraccionar mientras siga vivo en una
// orden anterior (cualquier estado menos 'anulada'). Tampoco puede venir repetido en el mismo POST.

test('validarLineasNoRepetidas acepta un PLU que no esta en ninguna orden previa', () => {
  // Arrange
  const ordenes = [{ estado: 'pendiente', lineas: [{ plu: '111' }] }];

  // Act
  const error = validarLineasNoRepetidas([{ plu: '222', cantidad: 5 }], ordenes);

  // Assert
  assert.strictEqual(error, null);
});

test('validarLineasNoRepetidas rechaza un PLU que ya esta en una orden pendiente', () => {
  // Arrange
  const ordenes = [{ estado: 'pendiente', lineas: [{ plu: '30000', nombre: 'Mix Europeo' }] }];

  // Act
  const error = validarLineasNoRepetidas([lineaCompleta()], ordenes);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas rechaza un PLU que ya esta en una orden aplicada', () => {
  // Arrange: 'aplicada' tambien bloquea; solo 'anulada' libera el articulo.
  const ordenes = [{ estado: 'aplicada', lineas: [{ plu: '30000' }] }];

  // Act
  const error = validarLineasNoRepetidas([lineaCompleta()], ordenes);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas deja volver a pedir un PLU cuya unica orden esta anulada', () => {
  // Arrange
  const ordenes = [{ estado: 'anulada', lineas: [{ plu: '30000' }] }];

  // Act
  const error = validarLineasNoRepetidas([lineaCompleta()], ordenes);

  // Assert
  assert.strictEqual(error, null);
});

test('validarLineasNoRepetidas permite el mismo PLU en otra orden activa si el cliente es distinto', () => {
  // Arrange: PLU 30000 ya pedido para el cliente 1 en una orden pendiente.
  const ordenes = [{
    estado: 'pendiente',
    lineas: [{ plu: '30000', clientes: [{ idCliente: '1', nombre: 'Cliente Uno' }] }],
  }];
  const linea = lineaCompleta({ clientes: [{ idCliente: '2', nombre: 'Cliente Dos', pendiente: 5 }] });

  // Act
  const error = validarLineasNoRepetidas([linea], ordenes);

  // Assert
  assert.strictEqual(error, null);
});

test('validarLineasNoRepetidas rechaza el mismo PLU para el mismo cliente en otra orden activa', () => {
  // Arrange
  const ordenes = [{
    estado: 'pendiente',
    lineas: [{ plu: '30000', clientes: [{ idCliente: '1', nombre: 'Cliente Uno' }] }],
  }];
  const linea = lineaCompleta({ clientes: [{ idCliente: '1', nombre: 'Cliente Uno', pendiente: 5 }] });

  // Act
  const error = validarLineasNoRepetidas([linea], ordenes);

  // Assert: el mensaje nombra al cliente para que quede claro por qué choca.
  assert.match(String(error), /30000/);
  assert.match(String(error), /Cliente Uno/);
});

test('validarLineasNoRepetidas rechaza si la linea nueva no trae cliente y el PLU ya esta pedido con cliente', () => {
  // Arrange: sin cliente en la linea nueva no hay con que probar que es "otro" distinto.
  const ordenes = [{
    estado: 'pendiente',
    lineas: [{ plu: '30000', clientes: [{ idCliente: '1', nombre: 'Cliente Uno' }] }],
  }];

  // Act: lineaCompleta() no trae `clientes`.
  const error = validarLineasNoRepetidas([lineaCompleta()], ordenes);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas rechaza cualquier cliente si la orden activa tiene el PLU sin cliente', () => {
  // Arrange: la orden activa es un armado manual del PLU, sin cliente asociado.
  const ordenes = [{ estado: 'pendiente', lineas: [{ plu: '30000', clientes: [] }] }];
  const linea = lineaCompleta({ clientes: [{ idCliente: '2', nombre: 'Cliente Dos', pendiente: 5 }] });

  // Act
  const error = validarLineasNoRepetidas([linea], ordenes);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas rechaza el mismo PLU repetido dentro del mismo POST', () => {
  // Arrange
  const lineas = [lineaCompleta(), lineaCompleta({ cantidad: 3 })];

  // Act
  const error = validarLineasNoRepetidas(lineas, []);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas compara los PLU como texto y sin espacios sobrantes', () => {
  // Arrange: el archivo guarda strings y la UI puede mandar numeros.
  const ordenes = [{ estado: 'pendiente', lineas: [{ plu: ' 30000 ' }] }];

  // Act
  const error = validarLineasNoRepetidas([lineaCompleta({ plu: 30000 })], ordenes);

  // Assert
  assert.match(String(error), /30000/);
});

test('validarLineasNoRepetidas tolera ordenes corruptas o sin lineas', () => {
  // Arrange: el archivo puede tener basura vieja; no puede tirar el POST abajo.
  const ordenes = [null, { estado: 'pendiente' }, { estado: 'pendiente', lineas: [null] }];

  // Act
  const error = validarLineasNoRepetidas([lineaCompleta()], ordenes);

  // Assert
  assert.strictEqual(error, null);
});

test('plusEnOrdenesActivas junta los PLU de todas las ordenes no anuladas', () => {
  // Arrange
  const ordenes = [
    { estado: 'pendiente', lineas: [{ plu: '1' }, { plu: '2' }] },
    { estado: 'aplicada', lineas: [{ plu: '3' }] },
    { estado: 'anulada', lineas: [{ plu: '4' }] },
  ];

  // Act
  const plus = plusEnOrdenesActivas(ordenes);

  // Assert
  assert.deepStrictEqual([...plus].sort(), ['1', '2', '3']);
});
