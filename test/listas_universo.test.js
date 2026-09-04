const test = require('node:test');
const assert = require('node:assert');
const { universoLista, universoPesables } = require('../lib/listas_universo');

// ── Membresía de lista: qué PLUs entran a las tabs Almacén y Pesables ─────────────────────────
// basePlus simula lo que devuelve SQL (IdProducto casteado a VARCHAR → strings).
// siempre*/noEnvasa/ocultarPesable simulan lo que devuelve leerListasDistrib() (Numbers, del JSON).
// Ordenamos numéricamente antes de comparar porque el orden de salida depende del orden de
// inserción en el Set y no es parte del contrato que nos interesa fijar.
const ordenado = arr => [...arr].map(String).sort((a, b) => Number(a) - Number(b));

test('basePlus normal pasa entero cuando no hay listas que lo toquen', () => {
  const plus = universoLista(['100', '200', '300'], [], []);
  assert.deepStrictEqual(ordenado(plus), ['100', '200', '300']);
});

test('un PLU no numerico de basePlus se descarta (regex /^\\d+$/)', () => {
  // Defensa contra IdProducto sucios en Siga (códigos con letras, guiones o vacíos): si entraran
  // al universo terminarían interpolados en el IN (...) de las queries siguientes.
  const plus = universoLista(['100', 'ABC', '12A', '', '  300  ', '200'], [], []);
  assert.deepStrictEqual(ordenado(plus), ['100', '200']);
});

test('siempre* agrega un PLU que no esta en basePlus', () => {
  // Caso típico: un producto que en Siga no tiene el rubro esperado pero igual queremos ver
  // en la planilla. La lista "siempre" lo fuerza a entrar.
  const plus = universoLista(['100'], [999], []);
  assert.deepStrictEqual(ordenado(plus), ['100', '999']);
});

test('siempre* GANA sobre noEnvasa: un PLU en ambas listas queda dentro', () => {
  // Este es el caso sutil de la implementación: el filtro final es
  //   !excluido || estaEnSiempre
  // así que "siempre" actúa como excepción explícita a noEnvasa, no como regla del mismo nivel.
  // Vale tanto si el PLU venía de basePlus como si sólo estaba en "siempre".
  const desdeBase = universoLista(['100', '555'], [555], [555]);
  assert.deepStrictEqual(ordenado(desdeBase), ['100', '555']);

  const soloSiempre = universoLista(['100'], [555], [555]);
  assert.deepStrictEqual(ordenado(soloSiempre), ['100', '555']);
});

test('noEnvasa saca un PLU que si esta en basePlus', () => {
  const plus = universoLista(['100', '200', '300'], [], [200]);
  assert.deepStrictEqual(ordenado(plus), ['100', '300']);
});

test('ocultarPesable saca el PLU aunque este en siemprePesable', () => {
  // Caso real del PLU 2891: estaba forzado por siemprePesable y aun así el checkbox
  // "Ocultar códigos" debe sacarlo de la tab. Por eso ocultarPesable se aplica AL FINAL,
  // después de resolver siempre*/noEnvasa, y es la única regla que gana a "siempre".
  const plus = universoPesables(['100'], [2891], [], [2891]);
  assert.deepStrictEqual(ordenado(plus), ['100']);

  // Y sigue ganando incluso si el PLU también venía del rubro base y de noEnvasa.
  const conTodo = universoPesables(['100', '2891'], [2891], [2891], [2891]);
  assert.deepStrictEqual(ordenado(conTodo), ['100']);
});

test('universoPesables sin ocultos se comporta igual que universoLista', () => {
  // Garantiza que el wrapper no cambió el comportamiento observable del refactor de server.js:
  // cuando el checkbox "Ocultar códigos" está apagado, la lista de ocultos llega vacía.
  const base = ['100', '200'], siempre = [999], excluir = [200];
  assert.deepStrictEqual(
    ordenado(universoPesables(base, siempre, excluir, [])),
    ordenado(universoLista(base, siempre, excluir)));
});

test('numeros vs strings: las listas en Number matchean contra basePlus en string', () => {
  // Escenario real: basePlus viene de SQL como string (CAST AS VARCHAR) y las listas vienen del
  // JSON como Number. Si la comparación no normalizara con String(), noEnvasa=[200] nunca
  // sacaría el '200' de basePlus y siempre=[100] duplicaría el '100'.
  const plus = universoLista(['100', '200', '300'], [100, '400'], ['200', 500]);
  assert.deepStrictEqual(ordenado(plus), ['100', '300', '400']);
  // Sin duplicados: '100' venía de basePlus (string) y de siempre (Number).
  assert.strictEqual(plus.filter(p => String(p) === '100').length, 1);
  // Todo lo que entra por "siempre" se normaliza a string al agregarse al Set.
  assert.ok(plus.includes('400'));
  // Y ocultarPesable en Number también saca un PLU de basePlus en string.
  assert.deepStrictEqual(universoPesables(['100', '200'], [], [], [200]), ['100']);
});

test('un basePlus en Number entra al universo pero NO se normaliza a string', () => {
  // Comportamiento documentado, no deseado: los elementos de basePlus se guardan en el Set tal
  // como llegan (sólo se los filtra con la regex, que coacciona a string para testear). Un PLU
  // numérico entra como Number y por eso NO lo alcanzan noEnvasa/ocultarPesable, que comparan
  // contra un Set de strings. En producción no pasa porque las queries hacen CAST AS VARCHAR;
  // este test existe para que el día que alguien pase Numbers el cambio de semántica se vea.
  const plus = universoLista([300], [], [300]);
  assert.deepStrictEqual(plus, [300]);   // sobrevive a su propia exclusión
  assert.strictEqual(typeof plus[0], 'number');
  // universoPesables sí normaliza con String(p) en su filtro final, así que ahí no hay fuga.
  assert.deepStrictEqual(universoPesables([300], [], [], [300]), []);
});

test('listas vacias o undefined no explotan', () => {
  // leerListasDistrib() normaliza todo a arrays, pero el módulo no debe caerse si un
  // llamador nuevo (o un JSON recién sembrado) omite una clave.
  assert.deepStrictEqual(universoLista([], [], []), []);
  assert.deepStrictEqual(ordenado(universoLista(['100'])), ['100']);
  assert.deepStrictEqual(ordenado(universoLista(['100'], undefined, undefined)), ['100']);
  assert.deepStrictEqual(universoLista(), []);
  assert.deepStrictEqual(ordenado(universoPesables(['100'], [], [], undefined)), ['100']);
});

test('todo basePlus excluido devuelve lista vacia (el llamador tira el error de "sin productos")', () => {
  // calcularDistribucionAlmacen/Pesables dependen de que esto devuelva [] para lanzar
  // "Sin productos activos de rubro ... en Siga" en lugar de armar una query con IN ().
  assert.deepStrictEqual(universoLista(['100', '200'], [], [100, 200]), []);
  assert.deepStrictEqual(universoPesables(['100'], [], [], [100]), []);
});
