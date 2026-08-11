// Verifica el parser embebido en facturador.html. Ese archivo tiene que viajar suelto
// (se abre con file://), así que el parser vive adentro del HTML y no se puede importar:
// el test extrae el bloque delimitado por los marcadores y lo evalúa.
//
// El control principal es de contraste: el lector de .xlsx propio (ZIP + DecompressionStream,
// cero dependencias) se compara celda por celda contra la librería `xlsx` sobre un archivo
// real del repo. Si el parser se rompe, las dos lecturas dejan de coincidir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const RAIZ = path.join(__dirname, '..');
const FIXTURE = path.join(RAIZ, 'data', 'cruce terminales', 'Distribucion Terminales por sucursal.xlsx');

function cargarParser() {
  const src = fs.readFileSync(path.join(RAIZ, 'facturador.html'), 'utf8');
  const desde = src.split('parser-inicio');
  assert.equal(desde.length, 2, 'no se encontró el marcador parser-inicio en facturador.html');
  let bloque = desde[1];
  bloque = bloque.slice(bloque.indexOf('*/') + 2);          // saltea el resto del comentario de apertura
  const fin = bloque.indexOf('/* ---8<--- parser-fin');
  assert.ok(fin > 0, 'no se encontró el marcador parser-fin en facturador.html');
  bloque = bloque.slice(0, fin);
  return new Function(bloque + `
    return { leerZip, filasDeXlsx, filasDeHoja, filasDeCsv, aNumero,
             columnaAIndice, desescaparXml, detectarEncabezado, filasACatalogo,
             construirIndice, digitoControlEan13, parsearCodigoBalanza, resolverEscaneo,
             subtotalLinea, totalesDe, saldoPagos, MEDIOS_PAGO };`)();
}

const P = cargarParser();

test('lee un .xlsx real igual que la librería xlsx', async () => {
  // Arrange
  const buf = fs.readFileSync(FIXTURE);
  const wb = XLSX.readFile(FIXTURE);
  assert.equal(wb.SheetNames.length, 1, 'el fixture debería tener una sola hoja');
  const esperado = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

  // Act
  const obtenido = await P.filasDeXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  // Assert
  assert.ok(obtenido.length >= esperado.length - 1, `filas leídas ${obtenido.length} vs ${esperado.length}`);
  let celdasConDato = 0;
  for (let i = 0; i < esperado.length; i++) {
    for (let j = 0; j < esperado[i].length; j++) {
      const esp = esperado[i][j];
      const obt = obtenido[i] ? obtenido[i][j] : '';
      if (esp === '' && (obt == null || obt === '')) continue;
      celdasConDato++;
      if (typeof esp === 'number') {
        assert.ok(Math.abs(Number(obt) - esp) < 1e-6, `celda ${i},${j}: ${obt} ≠ ${esp}`);
      } else {
        assert.equal(String(obt).trim(), String(esp).trim(), `celda ${i},${j}`);
      }
    }
  }
  assert.ok(celdasConDato > 20, 'el fixture debería aportar más celdas con dato que eso');
});

test('rechaza un archivo que no es un ZIP', async () => {
  await assert.rejects(() => P.filasDeXlsx(new TextEncoder().encode('esto no es un xlsx').buffer),
    /no es un \.xlsx válido/);
});

test('convierte columnas en letras a índice', () => {
  assert.equal(P.columnaAIndice('A1'), 0);
  assert.equal(P.columnaAIndice('Z9'), 25);
  assert.equal(P.columnaAIndice('AA1'), 26);
  assert.equal(P.columnaAIndice('BC12'), 54);
});

test('desescapa entidades XML sin dobles conversiones', () => {
  assert.equal(P.desescaparXml('Caf&#233; &amp; T&#xe9;'), 'Café & Té');
  // El &amp; se resuelve último: si no, "&amp;lt;" terminaría como "<".
  assert.equal(P.desescaparXml('&amp;lt;'), '&lt;');
});

test('normaliza precios en cualquier formato', () => {
  assert.equal(P.aNumero('$ 1.234,56'), 1234.56);   // formato argentino
  assert.equal(P.aNumero('1,234.56'), 1234.56);     // formato inglés
  assert.equal(P.aNumero('1234.56'), 1234.56);      // punto decimal suelto
  assert.equal(P.aNumero('1.234'), 1234);           // punto de miles: agrupa de a 3
  assert.equal(P.aNumero('12.34'), 12.34);          // no agrupa de a 3 → decimal
  assert.equal(P.aNumero(987.65), 987.65);
  assert.ok(Number.isNaN(P.aNumero('sin precio')));
  assert.ok(Number.isNaN(P.aNumero('')));
});

test('parsea CSV con punto y coma, comillas y BOM', () => {
  const csv = '﻿Codigo;Nombre;Precio\r\n1;"Aceite, girasol 900cc";1.234,50\r\n2;"Dice ""oferta""";99\r\n';
  const filas = P.filasDeCsv(csv);
  assert.deepEqual(filas[0], ['Codigo', 'Nombre', 'Precio']);
  assert.deepEqual(filas[1], ['1', 'Aceite, girasol 900cc', '1.234,50']);
  assert.equal(filas[2][1], 'Dice "oferta"');
});

test('encuentra el encabezado aunque haya títulos y filas vacías arriba', () => {
  const filas = [
    ['LISTA DE PRECIOS MAYORISTA', '', ''],
    ['', '', ''],
    ['Codigo', 'Descripcion', 'Precio Venta'],
    ['101', 'Producto uno', '1.500,00'],
  ];
  const enc = P.detectarEncabezado(filas);
  assert.deepEqual(
    { filaEncabezado: enc.filaEncabezado, codigo: enc.codigo, nombre: enc.nombre, precio: enc.precio },
    { filaEncabezado: 2, codigo: 0, nombre: 1, precio: 2 });
});

test('devuelve null cuando ninguna columna parece un precio', () => {
  assert.equal(P.detectarEncabezado([['Fecha', 'Sucursal', 'Terminal'], ['1', '2', '3']]), null);
});

test('arma el catálogo descartando totales y filas sin precio', () => {
  const filas = [
    ['Codigo', 'Descripcion', 'Precio'],
    ['101', 'Producto uno', '$ 1.500,00'],
    ['', '', ''],                          // fila vacía
    ['102', 'Producto dos', '0'],          // precio 0 → fuera
    ['', 'TOTAL GENERAL', ''],             // fila de totales → fuera
    ['103', 'Producto tres', '250,75'],
  ];
  const productos = P.filasACatalogo(filas, { filaEncabezado: 0, codigo: 0, nombre: 1, precio: 2 });
  // Una planilla no trae códigos de barra ni modalidad de balanza: esos campos van vacíos
  // para que el producto tenga la misma forma que el que devuelve el servidor.
  assert.deepEqual(productos, [
    { plu: '101', nombre: 'Producto uno', precio: 1500, barra: '', modalidad: null, unidad: '' },
    { plu: '103', nombre: 'Producto tres', precio: 250.75, barra: '', modalidad: null, unidad: '' },
  ]);
});

test('exige columnas de nombre y precio', () => {
  assert.throws(() => P.filasACatalogo([['a']], { nombre: 0, precio: null }), /nombre y precio/);
});

// ── Escaneo, balanza y pagos ──────────────────────────────────────────────────
// Catálogo sintético con la misma forma que devuelve /api/facturador/catalogo.
const CATALOGO = [
  { plu: '20000', nombre: 'Producto pesable', precio: 1000, barra: '2020000', modalidad: 'PESO', unidad: 'UN' },
  { plu: '1004',  nombre: 'Trigo sarraceno', precio: 8590, barra: '2001004', modalidad: 'PESO', unidad: 'UN' },
  { plu: '11001', nombre: 'Gift card',      precio: 5350, barra: '2011001', modalidad: 'PRECIO', unidad: 'UN' },
  { plu: '100',   nombre: 'Galletitas',     precio: 1740, barra: '7790045001188', modalidad: null, unidad: 'UN' },
  { plu: '201',   nombre: 'Repetido A',     precio: 500,  barra: '7798238030113', modalidad: null, unidad: 'UN' },
  { plu: '202',   nombre: 'Repetido B',     precio: 600,  barra: '7798238030113', modalidad: null, unidad: 'UN' },
];
const IDX = P.construirIndice(CATALOGO);

test('calcula el dígito de control EAN-13 igual que un código real de SIGA', () => {
  // 2020000001409 existe en la base: sus 12 primeros dígitos tienen que dar control 9.
  assert.equal(P.digitoControlEan13('202000000140'), 9);
  assert.equal(P.digitoControlEan13('779004500118'), 8);
});

test('parsea un ticket de balanza: prefijo 2 + PLU(5) + valor(5) + control', () => {
  assert.deepEqual(P.parsearCodigoBalanza('2020000001409'), { plu: '20000', valor: 140 });
});

test('descarta el ticket de balanza si el dígito de control no cierra', () => {
  // Mismo código con el último dígito cambiado: una lectura rota no puede volverse un precio.
  assert.equal(P.parsearCodigoBalanza('2020000001408'), null);
  assert.equal(P.parsearCodigoBalanza('7790045001188'), null);  // EAN normal, no de balanza
  assert.equal(P.parsearCodigoBalanza('2001004'), null);        // código corto, sin peso
});

test('un ticket de balanza por PESO calcula los kilos y deja el precio por kilo', () => {
  const r = P.resolverEscaneo('2020000001409', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'balanza-peso');
  assert.equal(r.producto.plu, '20000');
  assert.equal(r.cant, 0.14);            // 140 gramos
  assert.equal(r.precio, 1000);          // precio por kilo, del catálogo
  assert.equal(r.unidad, 'kg');
  assert.equal(Math.round(r.cant * r.precio * 100) / 100, 140);  // el importe sale solo
});

test('un ticket por PRECIO respeta el importe impreso y no lo multiplica', () => {
  // 11001 tiene modalidad PRECIO: el valor del código son centavos, no gramos.
  const doce = '2011001' + '01234';
  const cod = doce + P.digitoControlEan13(doce);
  const r = P.resolverEscaneo(cod, IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'balanza-importe');
  assert.equal(r.cant, 1);
  assert.equal(r.precio, 12.34);
});

test('un código de barras común agrega una unidad', () => {
  const r = P.resolverEscaneo('7790045001188', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'barra');
  assert.equal(r.producto.plu, '100');
  assert.equal(r.cant, 1);
});

test('un código compartido por varios productos pregunta en vez de adivinar', () => {
  const r = P.resolverEscaneo('7798238030113', IDX);
  assert.equal(r.tipo, 'ambiguo');
  assert.equal(r.opciones.length, 2);
});

test('acepta el PLU tipeado a mano, con y sin ceros a la izquierda', () => {
  assert.equal(P.resolverEscaneo('1004', IDX).producto.plu, '1004');
  assert.equal(P.resolverEscaneo('0001004', IDX).producto.plu, '1004');
});

test('avisa cuando el código no está en el catálogo', () => {
  assert.equal(P.resolverEscaneo('7790000000000', IDX).tipo, 'no_encontrado');
  assert.equal(P.resolverEscaneo('', IDX).tipo, 'vacio');
  // Ticket de balanza de un producto ausente: se distingue para poder avisar mejor.
  const doce = '2099999' + '00500';
  const r = P.resolverEscaneo(doce + P.digitoControlEan13(doce), IDX);
  assert.equal(r.tipo, 'no_encontrado');
  assert.equal(r.balanza, true);
  assert.equal(r.plu, '99999');
});

test('los descuentos de línea y general se aplican en cascada, no sumados', () => {
  const lineas = [
    { cant: 2, precio: 100, dtoPct: 10 },   // 200 → 180
    { cant: 1, precio: 50,  dtoPct: 0 },    // 50
  ];
  const t = P.totalesDe(lineas, 10);
  assert.equal(t.bruto, 250);
  assert.equal(t.dtoLineas, 20);
  assert.equal(t.subtotal, 230);
  assert.equal(t.dtoGlobal, 23);            // 10% sobre 230, no sobre 250
  assert.equal(t.total, 207);
});

test('el descuento se recorta al rango 0-100', () => {
  const lineas = [{ cant: 1, precio: 100, dtoPct: 0 }];
  assert.equal(P.totalesDe(lineas, -5).total, 100);
  assert.equal(P.totalesDe(lineas, 150).total, 0);
  assert.equal(P.subtotalLinea({ cant: 1, precio: 100, dtoPct: 150 }), 0);
});

test('reparte el total entre varios medios de pago', () => {
  const s = P.saldoPagos(1000, [{ medio: 'EFECTIVO', importe: 600 }, { medio: 'DÉBITO', importe: 400 }]);
  assert.equal(s.pagado, 1000);
  assert.equal(s.falta, 0);
  assert.equal(s.vuelto, 0);
  assert.equal(s.completo, true);
});

test('calcula lo que falta y el vuelto', () => {
  const falta = P.saldoPagos(1000, [{ medio: 'EFECTIVO', importe: 300 }]);
  assert.equal(falta.falta, 700);
  assert.equal(falta.completo, false);

  const vuelto = P.saldoPagos(1000, [{ medio: 'EFECTIVO', importe: 1200 }]);
  assert.equal(vuelto.vuelto, 200);
  assert.equal(vuelto.falta, 0);
  assert.equal(vuelto.completo, true);
});

test('una diferencia menor a un centavo cuenta como pagado', () => {
  // Sin esta tolerancia, el redondeo de un descuento deja el pedido "impago" para siempre.
  const s = P.saldoPagos(100.004, [{ medio: 'EFECTIVO', importe: 100 }]);
  assert.equal(s.completo, true);
  assert.equal(s.falta, 0);
});

test('los medios de pago están definidos y sin repetidos', () => {
  assert.ok(P.MEDIOS_PAGO.includes('EFECTIVO'));
  assert.ok(P.MEDIOS_PAGO.length >= 4);
  assert.equal(new Set(P.MEDIOS_PAGO).size, P.MEDIOS_PAGO.length);
});
