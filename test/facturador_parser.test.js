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
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
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
             subtotalLinea, totalesDe, saldoPagos, MEDIOS_PAGO,
             precioLibre, PLU_PROMO, PLU_PRECIO_LIBRE,
             limpiarEncabezado, esBarraDeBalanza, consultaDeEscaneo,
             estadoActualizacion, INTERVALO_ACTUALIZACION_MS, VENCIMIENTO_PRECIOS_MS,
             pareceXlsx, pareceHtml, motivoPlanillaRechazada,
             incrustarCatalogo, leerCatalogoEmbebido, catalogoAJson,
             rutaAUrlArchivo, catalogoAArchivoRed, catalogoDeGlobal, GLOBAL_ARCHIVO_RED,
             idDeSheets, urlGviz, filasDeGviz, HANDLER_SHEETS,
             esUrlAppsScript, urlFuenteSheets, grillaDeRespuesta };`)();
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
    { plu: '101', nombre: 'Producto uno', precio: 1500, barra: '', barras: [], modalidad: null, unidad: '' },
    { plu: '103', nombre: 'Producto tres', precio: 250.75, barra: '', barras: [], modalidad: null, unidad: '' },
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
  { plu: '822',   nombre: 'Lechuga lisa x paquete', precio: 2000, barra: '2100822', modalidad: null, unidad: 'UN' },
  { plu: '91366', nombre: 'Set sushi grande', precio: 9000, barra: '2023150254435', modalidad: null, unidad: 'UN' },
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

test('parsea un ticket de balanza: prefijo + PLU(5) + peso(5) + control', () => {
  assert.deepEqual(P.parsearCodigoBalanza('2020000001409'),
    { prefijo: '20', plu: '20000', gramos: 140, pesable: true });
});

test('el prefijo 21 marca la etiqueta de un producto que no es pesable', () => {
  const doce = '2100822' + '01400';
  const r = P.parsearCodigoBalanza(doce + P.digitoControlEan13(doce));
  assert.deepEqual(r, { prefijo: '21', plu: '822', gramos: 1400, pesable: false });
});

test('sólo 20 y 21 son prefijos de balanza', () => {
  for (const pref of ['22', '23', '29', '77', '19']) {
    const doce = pref + '00822' + '01400';
    assert.equal(P.parsearCodigoBalanza(doce + P.digitoControlEan13(doce)), null,
      `el prefijo ${pref} no debería tomarse como balanza`);
  }
});

test('descarta el ticket de balanza si el dígito de control no cierra', () => {
  // Mismo código con el último dígito cambiado: una lectura rota no puede volverse un precio.
  assert.equal(P.parsearCodigoBalanza('2020000001408'), null);
  assert.equal(P.parsearCodigoBalanza('7790045001188'), null);  // EAN normal, no de balanza
  assert.equal(P.parsearCodigoBalanza('2001004'), null);        // código corto, sin peso
});

test('un ticket con prefijo 20 calcula los kilos y deja el precio por kilo', () => {
  const r = P.resolverEscaneo('2020000001409', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'balanza-peso');
  assert.equal(r.producto.plu, '20000');
  assert.equal(r.cant, 0.14);            // 140 gramos
  assert.equal(r.precio, 1000);          // precio por kilo, del catálogo
  assert.equal(r.unidad, 'kg');
  assert.equal(Math.round(r.cant * r.precio * 100) / 100, 140);  // el importe sale solo
});

test('un ticket con prefijo 21 cobra 1 unidad y guarda el peso de dato', () => {
  const doce = '2100822' + '01400';
  const r = P.resolverEscaneo(doce + P.digitoControlEan13(doce), IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'balanza-unidad');
  assert.equal(r.producto.plu, '822');
  assert.equal(r.cant, 1);               // se cobra por unidad, no por peso
  assert.equal(r.precio, 2000);          // precio del catálogo, sin multiplicar
  assert.equal(r.peso, 1.4);             // el peso queda como dato del bulto
  assert.equal(r.unidad, undefined);
});

test('un PLU marcado como precio fijo cobra 1 unidad aunque el ticket sea prefijo 20', () => {
  const r = P.resolverEscaneo('2020000001409', IDX, { pluPrecioFijo: new Set(['20000']) });
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'balanza-fijo');
  assert.equal(r.producto.plu, '20000');
  assert.equal(r.cant, 1);               // ignora el peso de la etiqueta
  assert.equal(r.precio, 1000);          // precio del catálogo, sin multiplicar
  assert.equal(r.peso, undefined);       // ni siquiera queda como dato: no hay cuadro que mostrar
});

test('un EAN propio que arranca con 20 gana sobre la lectura como ticket', () => {
  // El 91366 tiene "2023150254435" cargado como su código: interpretarlo como balanza
  // daría "PLU 23150, 25,443 kg". La coincidencia exacta tiene que ir primero.
  const r = P.resolverEscaneo('2023150254435', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.origen, 'barra');
  assert.equal(r.producto.plu, '91366');
  assert.equal(r.cant, 1);
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

test('una cantidad negativa resta su valor del subtotal, como un descuento', () => {
  const lineas = [
    { cant: 2, precio: 100 },   // 200
    { cant: -1, precio: 50 },   // -50, resta
  ];
  const t = P.totalesDe(lineas, 0);
  assert.equal(t.subtotal, 150);
  assert.equal(t.total, 150);
});

test('el descuento general se carga en negativo y se recorta a -100..0', () => {
  const lineas = [{ cant: 1, precio: 100 }];
  assert.equal(P.totalesDe(lineas, -10).total, 90);   // -10 → 10% de descuento
  assert.equal(P.totalesDe(lineas, 5).total, 100);    // positivo no descuenta (se recorta a 0)
  assert.equal(P.totalesDe(lineas, -150).total, 0);   // se recorta a -100 → 100% de descuento
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

// ── Importación de la exportación real de SIGA ────────────────────────────────
const PLANILLA_SIGA = path.join(RAIZ, 'data', 'facturador', 'PreciosProductos.xlsx');

test('recorta el prefijo de tabla que SIGA le pone a los encabezados', () => {
  assert.equal(P.limpiarEncabezado('ProductosSucursales.Productos.NombreProducto'), 'NombreProducto');
  assert.equal(P.limpiarEncabezado('PrecioVenta'), 'PrecioVenta');
  assert.equal(P.limpiarEncabezado('  IdProducto  '), 'IdProducto');
  assert.equal(P.limpiarEncabezado('termina.'), 'termina.');   // punto final, no es prefijo
});

test('detecta las columnas de la exportación de SIGA sin ayuda', () => {
  const filas = [['IdProducto', 'ProductosSucursales.Productos.NombreProducto',
                  'ProductosSucursales.Productos.IdRubro',
                  'ProductosSucursales.Productos.CodigoDeBarras', 'PrecioVenta']];
  const e = P.detectarEncabezado(filas);
  assert.ok(e, 'no reconoció el encabezado');
  // CodigoDeBarras también matchea el patrón de "código": no puede robarle la columna al PLU.
  assert.deepEqual({ codigo: e.codigo, nombre: e.nombre, precio: e.precio, barra: e.barra },
    { codigo: 0, nombre: 1, precio: 4, barra: 3 });
});

test('consolida las filas repetidas y junta los códigos de barra del producto', () => {
  const filas = [
    ['IdProducto', 'Productos.NombreProducto', 'Productos.CodigoDeBarras', 'PrecioVenta'],
    ['90281', 'Aceite Chia 250ml', '76625241029', 14400],
    ['90281', 'Aceite Chia 250ml', '76625241029', 14400],   // fila idéntica repetida
    ['90281', 'Aceite Chia 250ml', '7798426200038', 14400], // mismo producto, otro código
    ['1',     'A Articulos Varios', '', 1],
  ];
  const e = P.detectarEncabezado(filas);
  const productos = P.filasACatalogo(filas, e);
  assert.equal(productos.length, 2, 'el producto repetido tiene que quedar una sola vez');
  const chia = productos.find(p => p.plu === '90281');
  assert.deepEqual(chia.barras, ['76625241029', '7798426200038']);
  assert.equal(chia.barra, '76625241029');
  // Cualquiera de los dos códigos tiene que encontrar el producto al escanear.
  const idx = P.construirIndice(productos);
  assert.equal(P.resolverEscaneo('7798426200038', idx).producto.plu, '90281');
  assert.equal(P.resolverEscaneo('76625241029', idx).producto.plu, '90281');
});

test('descarta como código de barras los restos de carga de menos de 7 dígitos', () => {
  const filas = [
    ['IdProducto', 'Productos.NombreProducto', 'Productos.CodigoDeBarras', 'PrecioVenta'],
    ['540', 'Aceite CBD 10ml', '540', 12900],   // "540" es el PLU, no un código de barras
    ['1',   'Varios',          '0',   1],
  ];
  const productos = P.filasACatalogo(filas, P.detectarEncabezado(filas));
  assert.deepEqual(productos.map(p => p.barras), [[], []]);
});

test('marca por kilo los productos cuyo código es "20" + PLU', () => {
  assert.equal(P.esBarraDeBalanza('2001004', '1004'), true);
  assert.equal(P.esBarraDeBalanza('2020000', '20000'), true);
  assert.equal(P.esBarraDeBalanza('2001004', '1005'), false);   // no es su propio PLU
  assert.equal(P.esBarraDeBalanza('7790045001188', '100'), false);

  const filas = [
    ['IdProducto', 'Productos.NombreProducto', 'Productos.CodigoDeBarras', 'PrecioVenta'],
    ['1004', 'Trigo Sarraceno 1Kg', '2001004', 8590],
    ['100',  'Galletitas',          '7790045001188', 1740],
  ];
  const productos = P.filasACatalogo(filas, P.detectarEncabezado(filas));
  assert.equal(productos.find(p => p.plu === '1004').modalidad, 'PESO');
  assert.equal(productos.find(p => p.plu === '100').modalidad, null);
});

test('importa la planilla real de SIGA de punta a punta', async () => {
  // Arrange
  const buf = fs.readFileSync(PLANILLA_SIGA);
  const filas = await P.filasDeXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  // Act
  const enc = P.detectarEncabezado(filas);
  assert.ok(enc, 'no reconoció el encabezado de la planilla real');
  const productos = P.filasACatalogo(filas, enc);

  // Assert
  // No se compara contra un número fijo (la planilla se reexporta y cambia), sino contra
  // la propiedad que importa: un producto por cada PLU con precio, ni uno perdido ni
  // repetido. La planilla trae además ~6400 filas vacías al final que no deben entrar.
  const cuerpo = filas.slice(enc.filaEncabezado + 1);
  const esperados = new Set(cuerpo
    .filter(f => String(f[enc.nombre] || '').trim() && Number(f[enc.precio]) > 0)
    .map(f => String(f[enc.codigo]).trim()));
  assert.equal(productos.length, esperados.size,
    `salieron ${productos.length} productos y la planilla tiene ${esperados.size} PLUs con precio`);
  assert.ok(productos.length < cuerpo.length / 2,
    'las filas repetidas por código de barras tendrían que haberse consolidado');
  assert.equal(new Set(productos.map(p => p.plu)).size, productos.length, 'quedaron PLUs duplicados');
  assert.ok(productos.every(p => p.nombre && p.precio > 0), 'hay productos sin nombre o sin precio');
  assert.ok(productos.some(p => p.barras.length > 1), 'ningún producto quedó con varios códigos');
  assert.ok(productos.filter(p => p.modalidad === 'PESO').length > 100, 'no se detectaron los de balanza');

  // Un escaneo real tiene que resolver contra la planilla importada.
  const idx = P.construirIndice(productos);
  const conBarra = productos.find(p => p.barras.some(b => b.length === 13));
  assert.equal(P.resolverEscaneo(conBarra.barras.find(b => b.length === 13), idx).producto.plu, conBarra.plu);
});

test('los medios de pago están definidos y sin repetidos', () => {
  assert.ok(P.MEDIOS_PAGO.includes('EFECTIVO'));
  assert.ok(P.MEDIOS_PAGO.length >= 4);
  assert.equal(new Set(P.MEDIOS_PAGO).size, P.MEDIOS_PAGO.length);
});

// ── Diálogos ──────────────────────────────────────────────────────────────────
// alert/confirm/prompt nativos no se pueden estilar y, repetidos, el navegador ofrece
// "impedir que esta página abra más diálogos": el vendedor se quedaría sin avisos en
// plena venta. Este control evita que vuelvan a entrar por descuido.
test('no quedan diálogos nativos en el facturador', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const nativos = src.split(/\r?\n/)
    .map((linea, i) => ({ n: i + 1, linea }))
    .filter(({ linea }) => /(^|[^\w.])(alert|confirm|prompt)\s*\(/.test(linea));
  assert.deepEqual(nativos, [], 'usar avisoModal / confirmarModal / textoModal en su lugar');
});

test('el modal tiene en el marcado todos los nodos que el código busca', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  for (const id of ['modalFondo', 'modalCaja', 'modalTitulo', 'modalCuerpo', 'modalTexto', 'modalBotones']) {
    assert.ok(src.includes('id="' + id + '"'), 'falta el nodo #' + id);
  }
  // Cada await de confirmación tiene que estar dentro de un handler async, si no el
  // botón tira SyntaxError y deja de funcionar.
  const asyncs = (src.match(/onclick = async/g) || []).length;
  assert.ok(asyncs >= 2, `sólo ${asyncs} handlers async para las confirmaciones`);
  // El mensaje se pinta con textContent: lleva nombres de producto y de archivo.
  assert.ok(/\$\('#modalCuerpo'\)\.textContent = mensaje/.test(src),
    'el cuerpo del modal tiene que usar textContent, nunca innerHTML');
});

// ── Pestaña de consulta ───────────────────────────────────────────────────────
// Sólo muestra precios: no toca el pedido. Los importes se prueban acá, sin navegador.
test('la consulta de un ticket con peso muestra el importe ya calculado', () => {
  const r = P.consultaDeEscaneo('2020000001409', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.nombre, 'Producto pesable');
  assert.equal(r.porKilo, true);
  assert.equal(r.peso, 0.14);
  assert.equal(r.precio, 1000);      // por kilo
  assert.equal(r.total, 140);        // 0,140 kg × $1.000
});

test('la consulta de un producto por kilo sin ticket no inventa un importe', () => {
  // Escanear el código corto no dice cuánto pesa: sólo que el precio es por kilo.
  const r = P.consultaDeEscaneo('2001004', IDX);
  assert.equal(r.tipo, 'ok');
  assert.equal(r.porKilo, true);
  assert.equal(r.peso, null);
  assert.equal(r.total, null, 'sin peso no puede haber importe');
  assert.equal(r.precio, 8590);
});

test('la consulta de un producto por unidad muestra el precio como total', () => {
  const r = P.consultaDeEscaneo('7790045001188', IDX);
  assert.equal(r.porKilo, false);
  assert.equal(r.peso, null);
  assert.equal(r.total, 1740);
  assert.equal(r.precio, 1740);
});

test('la consulta de un ticket con prefijo 21 muestra el peso pero cobra por unidad', () => {
  const doce = '2100822' + '01400';
  const r = P.consultaDeEscaneo(doce + P.digitoControlEan13(doce), IDX);
  assert.equal(r.porKilo, false, 'el 21 no es pesable');
  assert.equal(r.peso, 1.4, 'el peso de la etiqueta se muestra igual');
  assert.equal(r.total, 2000, 'el importe es el precio de la unidad, sin multiplicar');
});

test('la consulta arrastra los casos sin resultado en vez de romperse', () => {
  assert.equal(P.consultaDeEscaneo('', IDX).tipo, 'vacio');
  assert.equal(P.consultaDeEscaneo('7790000000000', IDX).tipo, 'no_encontrado');
  assert.equal(P.consultaDeEscaneo('7798238030113', IDX).tipo, 'ambiguo');
});

test('la pestaña de consulta está en el marcado y no toca el pedido', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  for (const id of ['tabPedido', 'tabConsulta', 'vistaPedido', 'vistaConsulta',
                    'escanerConsulta', 'fichaConsulta']) {
    assert.ok(src.includes('id="' + id + '"'), 'falta el nodo #' + id);
  }
  // consultar() no puede agregar líneas: si llama a agregarLinea, deja de ser una consulta.
  const cuerpo = src.slice(src.indexOf('function consultar('), src.indexOf('// ── Arranque'));
  assert.ok(!cuerpo.includes('agregarLinea'), 'la consulta no debe cargar productos al pedido');
});

test('la vista de consulta estira sus hijos a lo ancho', () => {
  // La regla general de `main` trae align-items:start. En un flex en columna eso deja al
  // buscador y a la ficha con su ancho natural, pegados a la izquierda: con un texto corto
  // como "Esperando un código…" la pantalla entera se ve descentrada.
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const regla = src.slice(src.indexOf('#vistaConsulta {'), src.indexOf('#barraConsulta'));
  assert.ok(/align-items:\s*stretch/.test(regla),
    '#vistaConsulta necesita align-items:stretch explícito');
  assert.ok(/justify-content:\s*center/.test(
    src.slice(src.indexOf('#barraConsulta {'), src.indexOf('#barraConsulta:focus-within'))),
    'el buscador de la consulta tiene que ir centrado');
});

test('la consulta pinta siempre dentro del marco', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  // Todo el contenido de la ficha sale de poner(), que envuelve en .marco: si algún caso
  // escribiera directo en innerHTML quedaría suelto, sin el cartel.
  assert.ok(/ficha\.innerHTML = '<div class="marco/.test(src), 'poner() tiene que envolver en .marco');
  // El corte va hasta el bloque siguiente, no hasta el arranque: si abarcara de más
  // contaría los 'err' del toast y del refresco automático.
  const cuerpo = src.slice(src.indexOf('function consultar('), src.indexOf('// ── Toast ──'));
  assert.ok(!/innerHTML/.test(cuerpo.replace(/const poner = [^;]+;/, '')),
    'la consulta sólo debe pintar a través de poner()');
  // Los casos sin producto van con el marco en rojo.
  assert.equal((cuerpo.match(/, 'err'\)/g) || []).length, 2, 'faltan los marcos de error');
  // El marcado inicial también arranca con marco, para que la pantalla no se vea vacía.
  assert.ok(src.includes('<div id="fichaConsulta"><div class="marco">'), 'el estado inicial necesita marco');
});

test('el archivo abre en el lector de precios', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(src.includes('id="tabConsulta">Lector de precios<'), 'la pestaña cambió de nombre');
  // El marcado y el estado tienen que arrancar de acuerdo: la vista del pedido oculta,
  // la del lector visible, y vistaActual apuntando al lector para que reciba el foco.
  assert.ok(src.includes('<main id="vistaPedido" class="oculto">'), 'el pedido no arranca oculto');
  assert.ok(src.includes('<main id="vistaConsulta" class="no-print">'), 'el lector no arranca visible');
  assert.ok(/let vistaActual = 'consulta';/.test(src), "vistaActual tiene que arrancar en 'consulta'");
  assert.ok(/irA\('consulta'\);/.test(src), 'el arranque debe fijar la vista con irA()');
  // La pestaña del lector va primera: es la principal.
  assert.ok(src.indexOf('id="tabConsulta"') < src.indexOf('id="tabPedido"'), 'el lector va primero');
});

// ── Refresco automático ───────────────────────────────────────────────────────
const MIN = 60000;

test('refresca una vez por minuto', () => {
  assert.equal(P.INTERVALO_ACTUALIZACION_MS, 60000);
});

test('con precios frescos el badge queda tranquilo', () => {
  const e = P.estadoActualizacion({ ultimaOk: 1000 * MIN, ahora: 1000 * MIN, fallando: false, hayCatalogo: true });
  assert.equal(e.clase, 'ok');
  assert.equal(e.texto, 'Precios al día');
});

test('sin catálogo el badge avisa aunque no haya fallado nada', () => {
  const e = P.estadoActualizacion({ ultimaOk: 0, ahora: 5 * MIN, fallando: false, hayCatalogo: false });
  assert.equal(e.clase, 'err');
  assert.equal(e.texto, 'Sin precios cargados');
});

test('al fallar avisa en amarillo y cuenta desde la última actualización buena', () => {
  const e = P.estadoActualizacion({ ultimaOk: 100 * MIN, ahora: 103 * MIN, fallando: true, hayCatalogo: true });
  assert.equal(e.clase, 'warn');
  assert.equal(e.texto, 'Sin conexión · hace 3 min');
});

test('pasados 30 minutos sin éxito el badge escala a rojo', () => {
  // El límite importa: hasta acá los precios sirven, después ya no son de fiar.
  const justoAntes = P.estadoActualizacion({ ultimaOk: 0, ahora: 29 * MIN, fallando: true, hayCatalogo: true });
  assert.equal(justoAntes.clase, 'warn');
  const justoDespues = P.estadoActualizacion({ ultimaOk: 0, ahora: 30 * MIN, fallando: true, hayCatalogo: true });
  assert.equal(justoDespues.clase, 'err');
  assert.equal(justoDespues.texto, 'Precios desactualizados · hace 30 min');
});

test('pasada la hora el badge cuenta en horas', () => {
  const e = P.estadoActualizacion({ ultimaOk: 0, ahora: 150 * MIN, fallando: true, hayCatalogo: true });
  assert.equal(e.texto, 'Precios desactualizados · hace 2 h');
});

test('el badge nunca muestra minutos negativos', () => {
  // El reloj de la máquina puede correrse hacia atrás; el badge no puede decir "hace -3 min".
  const e = P.estadoActualizacion({ ultimaOk: 10 * MIN, ahora: 7 * MIN, fallando: true, hayCatalogo: true });
  assert.equal(e.minutos, 0);
  assert.ok(!e.texto.includes('-'));
});

test('el toast de corte no se repite en cada reintento', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const fn = src.slice(src.indexOf('async function refrescarPrecios'), src.indexOf('setInterval(refrescarPrecios'));
  // Con un reintento por minuto, avisar siempre taparía la pantalla de toasts: sólo se
  // avisa al entrar en falla y al recuperarse.
  assert.ok(/if \(!antes && conAviso\)/.test(fn), 'el aviso de corte tiene que ser sólo en la transición');
  assert.ok(/if \(antes && conAviso\)/.test(fn), 'falta el aviso de recuperación');
  assert.ok(src.includes("setInterval(refrescarPrecios, INTERVALO_ACTUALIZACION_MS)"), 'falta el intervalo');
  assert.ok(src.includes("el.textContent = mensaje"), 'el toast tiene que usar textContent');
  assert.ok(src.includes('id="badgeEstado"'), 'falta el badge junto al lector');
});

// ── Planillas en la nube ──────────────────────────────────────────────────────
test('reconoce un xlsx por sus bytes y no por el nombre', () => {
  // Las descargas de la nube llegan sin extensión: la firma ZIP es la única pista.
  const real = fs.readFileSync(PLANILLA_SIGA);
  assert.equal(P.pareceXlsx(new Uint8Array(real)), true);
  assert.equal(P.pareceXlsx(new TextEncoder().encode('Codigo;Nombre;Precio')), false);
  assert.equal(P.pareceXlsx(new Uint8Array([])), false);
  assert.equal(P.pareceXlsx(null), false);
});

test('detecta la pantalla de login en vez de tratarla como planilla', () => {
  assert.equal(P.pareceHtml('<!DOCTYPE html><html><body>Iniciar sesión'), true);
  assert.equal(P.pareceHtml('<html lang="es">'), true);
  assert.equal(P.pareceHtml('{"error":{"code":"accessDenied"}}'), true);
  assert.equal(P.pareceHtml('Codigo;Nombre;Precio'), false);
});

test('la hora que se muestra es la de este equipo, no la del origen', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  // `generado` lo pone el servidor y puede venir con el reloj corrido o repetido entre
  // refrescos; `traido` lo sella este equipo en cada actualización buena. La pantalla
  // tiene que leer `traido`, si no la hora parece congelada.
  assert.ok(/catalogo = Object\.assign\(\{\}, nuevo, \{ traido: new Date\(\)\.toISOString\(\) \}\)/.test(src),
    'aplicarCatalogo tiene que sellar la hora local en `traido`');
  assert.ok(/new Date\(catalogo\.traido \|\| catalogo\.generado\)/.test(src),
    'el encabezado tiene que preferir `traido`, con `generado` de respaldo para catálogos viejos');
  assert.ok(/let ultimaOk = catalogo \? new Date\(catalogo\.traido \|\| catalogo\.generado\)/.test(src),
    'el contador del badge también tiene que arrancar de `traido`');
  // El badge muestra la hora sólo cuando está todo bien: si falla, el texto ya dice
  // hace cuánto y agregar una hora fija confundiría.
  assert.ok(/e\.clase === 'ok' && hora \? e\.texto \+ ' · ' \+ hora : e\.texto/.test(src),
    'el badge tiene que sumar la hora del último refresco bueno');
});

test('avisa cuando el archivo no es una planilla', () => {
  // Un .xls bajado del navegador suele ser HTML disfrazado: sin este aviso el usuario ve
  // "no se encontró ningún producto" y no sabe qué corregir.
  assert.equal(P.pareceHtml('<!DOCTYPE html><html>login</html>'), true);
  assert.equal(P.pareceHtml('Codigo;Nombre;Precio'), false);
  assert.ok(/no es una planilla/i.test(P.motivoPlanillaRechazada()));
});

// ── Copia autónoma con los precios adentro ────────────────────────────────────
const CAT_DEMO = { generado: '2026-08-20T10:00:00.000Z', origen: 'planilla',
  productos: [{ plu: '1004', nombre: 'Trigo Sarraceno 1Kg', precio: 8590,
                barra: '2001004', barras: ['2001004'], modalidad: 'PESO', unidad: '' }] };

test('el archivo tiene una sola etiqueta de cierre de script', () => {
  // Una etiqueta de cierre escrita en cualquier lado —aunque sea dentro de un comentario—
  // corta el script ahí mismo: el navegador ejecuta la primera mitad y descarta el resto
  // SIN dar ningún error. Este control es la única forma barata de detectarlo.
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const cierres = [...src.matchAll(/<\/script/gi)];
  assert.equal(cierres.length, 1,
    'hay una etiqueta de cierre de script de más: corta el programa por la mitad');
});

test('incrusta el catálogo en el head y no acumula copias', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const uno = P.incrustarCatalogo(src, CAT_DEMO);
  // En el head y no al final del body: si fuera al final, el programa ya habría corrido
  // buscando un elemento que todavía no existe.
  assert.ok(uno.slice(0, uno.indexOf('</head>')).includes('catalogoEmbebido'),
    'el bloque tiene que quedar antes de cerrar el head');
  assert.ok(uno.includes('PLANTILLA_HTML'), 'el clon tiene que conservar el programa entero');
  const dos = P.incrustarCatalogo(uno, CAT_DEMO);
  const tres = P.incrustarCatalogo(dos, CAT_DEMO);
  assert.equal((tres.match(/catalogoEmbebido/g) || []).length,
    (uno.match(/catalogoEmbebido/g) || []).length, 'clonar de nuevo no puede acumular catálogos');
  assert.equal(dos.length, tres.length, 'el archivo no puede crecer en cada clonado');
});

test('el catálogo incrustado se relee tal cual', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const clon = P.incrustarCatalogo(src, CAT_DEMO);
  const json = clon.match(/type="application\/json">([\s\S]*?)<\/script>/)[1];
  const leido = P.leerCatalogoEmbebido(json);
  assert.deepEqual(leido, CAT_DEMO);
});

test('un nombre de producto no puede cortar el script', () => {
  // Si un producto se llamara con una etiqueta de cierre adentro, el archivo generado
  // quedaría partido al medio. Por eso se escapa todo "<".
  const malicioso = { generado: 'x', origen: 'y',
    productos: [{ plu: '1', nombre: 'Raro </' + 'script><b>ups', precio: 10 }] };
  const json = P.catalogoAJson(malicioso);
  assert.ok(!/<\/script/i.test(json), 'el JSON no puede contener una etiqueta de cierre');
  assert.equal(P.leerCatalogoEmbebido(json).productos[0].nombre, 'Raro </' + 'script><b>ups',
    'el nombre tiene que volver intacto al leerlo');
});

test('ignora un bloque incrustado vacío o roto', () => {
  assert.equal(P.leerCatalogoEmbebido(''), null);
  assert.equal(P.leerCatalogoEmbebido('no es json'), null);
  assert.equal(P.leerCatalogoEmbebido('{"productos":[]}'), null, 'sin productos no sirve de nada');
});

test('la única fuente en línea es el servidor', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  // Quedan dos caminos: servidor, y archivo elegido a mano. Nada de URLs de terceros.
  assert.ok(!/urlPlanilla/.test(src), 'quedó código de la fuente por URL');
  assert.ok(!/normalizarUrlPlanilla/.test(src), 'quedó la conversión de enlaces de la nube');
  assert.ok(src.includes('id="cfgServidores"'), 'tiene que seguir la dirección del servidor');
  assert.ok(src.includes('id="inputArchivo"'), 'tiene que seguir la carga por archivo');
});

test('no quedó el botón de WhatsApp', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(!/WhatsApp/i.test(src), 'quedó una referencia a WhatsApp');
  assert.ok(!/btnCopiar/.test(src), 'quedó el handler del botón');
  // El de la lista de pedidos guardados sigue: copia el detalle, no publica en ningún lado.
  assert.ok(src.includes('data-copiar='), 'el copiar de pedidos guardados tiene que seguir');
});

// ── Ticket para comandera ─────────────────────────────────────────────────────
test('la impresión sale en formato de ticket, no como la pantalla', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(/@page \{ size: 72mm auto/.test(src), 'falta el tamaño de rollo de la comandera');
  assert.ok(src.includes('<div id="ticket"></div>'), 'falta el contenedor del ticket');
  assert.ok(/function pintarTicket\(p\)/.test(src), 'falta el armado del ticket');
  // El ticket no puede quedar atrapado por la regla que esconde el resto de la página:
  // el !important de esa regla le gana a cualquier display de más abajo.
  assert.ok(/body > \*:not\(#ticket\) \{ display: none !important; \}/.test(src),
    'la regla que oculta la pantalla tiene que excluir al ticket');
  // Sin fondos: la térmica sólo quema negro y los grises salen sucios.
  assert.ok(/#ticket \* \{ background: transparent !important/.test(src),
    'el ticket tiene que imprimirse sin fondos');
});

test('imprimir arma el ticket antes de mandar a la impresora', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const fn = src.slice(src.indexOf("$('#btnImprimir').onclick"), src.indexOf("$('#btnLimpiar').onclick"));
  assert.ok(fn.indexOf('pintarTicket') < fn.indexOf('window.print()'),
    'hay que pintar el ticket antes de imprimir, si no sale el de la vez anterior');
  assert.ok(/if \(!lineas\.length\)/.test(fn), 'no debería imprimir un pedido vacío');
  // Los pedidos ya guardados también se pueden reimprimir.
  assert.ok(src.includes('data-imprimir='), 'falta el botón de ticket en pedidos guardados');
});

// ── Instructivo ───────────────────────────────────────────────────────────────
test('el instructivo viaja adentro del archivo y cubre los dos temas', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(src.includes('id="secAyuda"'), 'falta la sección de ayuda');
  assert.ok(src.includes('id="btnAyuda"'), 'falta el botón para abrirla');
  const sec = src.slice(src.indexOf('id="secAyuda"'), src.indexOf('<!-- ── Pedidos guardados'));
  assert.ok(/Cómo se usa/.test(sec) && /Exportar las ventas/.test(sec),
    'el instructivo tiene que tener las dos secciones');
});

test('el instructivo nombra las columnas que la planilla exporta de verdad', () => {
  // Un instructivo que miente sobre los nombres de columna es peor que no tenerlo: se
  // desactualiza en silencio en cuanto alguien toca el exportador.
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  // El cierre se busca DESDE la cabecera: "for (const p of pedidos)" también aparece
  // antes, en el contador de numeración, y el corte quedaría vacío.
  const desde = src.indexOf('const COLUMNAS_TICKETS = [');
  const cabecera = src.slice(desde, src.indexOf('];', desde));
  const reales = [...cabecera.matchAll(/'([A-Z][A-Za-z]+)'/g)].map(m => m[1]);
  const sec = src.slice(src.indexOf('id="secAyuda"'), src.indexOf('<!-- ── Pedidos guardados'));
  const nombradas = [...sec.matchAll(/<code>([A-Z][A-Za-z]+)<\/code>/g)].map(m => m[1]);
  assert.ok(reales.length >= 15, 'no se encontró la cabecera de la planilla');
  for (const col of reales) {
    assert.ok(nombradas.includes(col), 'el instructivo no menciona la columna ' + col);
  }
  for (const col of nombradas) {
    assert.ok(reales.includes(col), 'el instructivo menciona una columna que no existe: ' + col);
  }
});

// ── Archivo de precios en la carpeta de red ───────────────────────────────────
// El facturador se abre con file://, donde el navegador bloquea todo fetch. Lo único que
// carga es un <script src>, así que lo que se deja en la red es un .js. Estos tests fijan
// las dos puntas: la ruta que se le pasa al script y el archivo que se genera.

test('una ruta UNC se convierte en un file:// con las cinco barras', () => {
  assert.equal(P.rutaAUrlArchivo(String.raw`\\192.168.1.26\Apidelta\1-Precios\precios.js`),
    'file://///192.168.1.26/Apidelta/1-Precios/precios.js');
});

test('los espacios de la ruta se escapan, y una ruta local o ya en file:// también sirven', () => {
  assert.equal(P.rutaAUrlArchivo(String.raw`\\srv\Apidelta\7- SISTEMA\precios.js`),
    'file://///srv/Apidelta/7-%20SISTEMA/precios.js');
  assert.equal(P.rutaAUrlArchivo(String.raw`C:\precios\precios.js`), 'file:///C:/precios/precios.js');
  assert.equal(P.rutaAUrlArchivo('file:///C:/x/precios.js'), 'file:///C:/x/precios.js');
  assert.equal(P.rutaAUrlArchivo('  '), '');
});

test('el archivo generado se vuelve a leer con el mismo catálogo adentro', () => {
  const catalogo = {
    generado: '2026-08-26T09:00:00.000Z', origen: 'prueba',
    productos: [{ plu: '1878', nombre: 'Producto Ejemplo', precio: 11960, barra: '2001878', modalidad: null, unidad: '' }],
  };
  const js = P.catalogoAArchivoRed(catalogo);
  const ventana = {};
  new Function('window', js)(ventana);          // así lo ejecuta el navegador al cargar el script
  assert.deepEqual(P.catalogoDeGlobal(ventana[P.GLOBAL_ARCHIVO_RED]), catalogo);
});

test('un archivo de red vacío, roto o de otra cosa no pisa los precios buenos', () => {
  for (const valor of [undefined, null, {}, { productos: [] }, { productos: 'no es una lista' }]) {
    assert.throws(() => P.catalogoDeGlobal(valor), /no tiene productos/);
  }
});

// ── Planilla de Google Sheets publicada ───────────────────────────────────────
// gviz es la única puerta que sirve desde un archivo local: contesta JavaScript, así que
// entra por <script src> donde un fetch queda bloqueado. Estos tests fijan cómo se arma
// la URL y cómo se traduce la respuesta a la grilla que ya sabe leer el detector.

test('saca el id de la planilla del link del navegador o del id pelado', () => {
  assert.equal(P.idDeSheets('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678/edit#gid=0'),
    '1AbC_dEf-123456789012345678');
  assert.equal(P.idDeSheets('https://docs.google.com/spreadsheets/d/e/2PACX-1vABCDEFGHIJKLMNOP/pubhtml'),
    '2PACX-1vABCDEFGHIJKLMNOP');
  assert.equal(P.idDeSheets('1AbC_dEf-123456789012345678'), '1AbC_dEf-123456789012345678');
  assert.equal(P.idDeSheets('cualquier cosa'), '');
  assert.equal(P.idDeSheets(''), '');
});

test('arma la url de gviz con el responseHandler y la hoja', () => {
  const url = P.urlGviz('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678/edit', 'Precios', 777);
  assert.ok(url.startsWith('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678/gviz/tq?'), url);
  // El punto y coma va escapado: es el separador que usa tqx, no un separador de parámetros.
  assert.ok(url.includes('tqx=out%3Ajson%3BresponseHandler%3A' + P.HANDLER_SHEETS), url);
  assert.ok(url.includes('&sheet=Precios'), url);
  assert.ok(url.includes('&_=777'), url);
  assert.ok(!P.urlGviz('1AbC_dEf-123456789012345678', '', 1).includes('&sheet='));
});

test('un link que no es de Sheets se rechaza antes de salir a internet', () => {
  assert.throws(() => P.urlGviz('https://ejemplo.com/planilla', '', 1), /no es válido/);
});

// Respuesta de gviz con la forma real: los encabezados vienen en cols[].label.
const GVIZ = {
  version: '0.6', status: 'ok',
  table: {
    cols: [{ id: 'A', label: 'IdProducto', type: 'string' },
           { id: 'B', label: 'NombreProducto', type: 'string' },
           { id: 'C', label: 'PrecioVenta', type: 'number' }],
    rows: [{ c: [{ v: '1878' }, { v: 'Producto Ejemplo 250Gr' }, { v: 11960, f: '11960' }] },
           { c: [{ v: '69' }, { v: 'Otro Producto' }, { v: 3850, f: '3850' }] }],
  },
};

test('la respuesta de gviz se convierte en la misma grilla que una planilla', () => {
  const filas = P.filasDeGviz(GVIZ);
  assert.deepEqual(filas[0], ['IdProducto', 'NombreProducto', 'PrecioVenta']);
  assert.deepEqual(filas[1], ['1878', 'Producto Ejemplo 250Gr', 11960]);
});

test('la planilla de Google pasa por el mismo detector de columnas que un xlsx', () => {
  const filas = P.filasDeGviz(GVIZ);
  const productos = P.filasACatalogo(filas, P.detectarEncabezado(filas));
  assert.equal(productos.length, 2);
  assert.deepEqual([productos[0].plu, productos[0].nombre, productos[0].precio],
    ['1878', 'Producto Ejemplo 250Gr', 11960]);
});

test('cuando Google no manda encabezados, la primera fila hace de encabezado', () => {
  const sinLabels = { table: { cols: [{ id: 'A', label: '' }, { id: 'B', label: '' }, { id: 'C', label: '' }],
    rows: [{ c: [{ v: 'Codigo' }, { v: 'Descripcion' }, { v: 'Precio' }] },
           { c: [{ v: '101' }, { v: 'Producto uno' }, { v: 1500 }] }] } };
  const filas = P.filasDeGviz(sinLabels);
  assert.deepEqual(filas[0], ['Codigo', 'Descripcion', 'Precio']);
  assert.equal(P.filasACatalogo(filas, P.detectarEncabezado(filas)).length, 1);
});

test('celdas vacías y respuestas sin tabla no rompen la lectura', () => {
  const conHuecos = { table: { cols: [{ label: 'Nombre' }, { label: 'Precio' }],
    rows: [{ c: [{ v: 'Producto' }, null] }, { c: null }] } };
  assert.deepEqual(P.filasDeGviz(conHuecos), [['Nombre', 'Precio'], ['Producto', ''], []]);
  assert.throws(() => P.filasDeGviz({}), /no devolvió filas/);
  assert.throws(() => P.filasDeGviz(null), /no devolvió filas/);
});

test('reconoce la URL de un Apps Script y la deja tal cual, con el callback', () => {
  const base = 'https://script.google.com/macros/s/AKfycbXXXXXXXXXXXXXXXXXX/exec';
  assert.ok(P.esUrlAppsScript(base));
  assert.ok(!P.esUrlAppsScript('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678/edit'));
  const url = P.urlFuenteSheets(base, 'Precios', 555);
  assert.ok(url.startsWith(base + '?callback=' + P.HANDLER_SHEETS), url);
  assert.ok(url.includes('&hoja=Precios'), url);
  assert.ok(url.includes('&_=555'), url);
  // Una URL que ya trae parámetros no puede llevar un segundo "?".
  assert.ok(P.urlFuenteSheets(base + '?x=1', '', 1).includes('exec?x=1&callback='));
});

test('un link de planilla sigue yendo por gviz', () => {
  const url = P.urlFuenteSheets('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678/edit', '', 9);
  assert.ok(url.includes('/gviz/tq?'), url);
});

test('las filas del Apps Script se usan directo, sin pasar por el formato de gviz', () => {
  const respuesta = {
    generado: '2026-08-26T09:00:00.000Z', hoja: 'Precios',
    filas: [['IdProducto', 'NombreProducto', 'PrecioVenta'], ['1878', 'Producto Ejemplo', '$ 11.960,00']],
  };
  const filas = P.grillaDeRespuesta(respuesta);
  assert.deepEqual(filas[1], ['1878', 'Producto Ejemplo', '$ 11.960,00']);
  const productos = P.filasACatalogo(filas, P.detectarEncabezado(filas));
  assert.deepEqual([productos[0].nombre, productos[0].precio], ['Producto Ejemplo', 11960]);
});

test('una respuesta sin filas ni tabla se rechaza, venga de donde venga', () => {
  assert.throws(() => P.grillaDeRespuesta({ filas: [] }), /no devolvió filas/);
  assert.throws(() => P.grillaDeRespuesta({}), /no devolvió filas/);
});

// ── Tickets guardados ─────────────────────────────────────────────────────────
// El listado se lee para traspasar la venta al sistema: cada ticket tiene que mostrar
// el detalle completo, y los nombres que vienen del catálogo van escapados.
function cargarDetalleGuardado() {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8').replace(/\r\n/g, '\n');
  // plata, esc y cantTxt van seguidos en el archivo; el corte los toma a los tres.
  const ayudas = src.slice(src.indexOf('const plata ='), src.indexOf('\n', src.indexOf('const cantTxt =')));
  const desde = src.indexOf('function detalleGuardado(');
  assert.ok(desde > 0, 'no se encontró detalleGuardado en facturador.html');
  const cuerpo = src.slice(desde, src.indexOf('\n}\n', desde) + 3);
  return new Function('subtotalLinea', ayudas + cuerpo + '\nreturn { detalleGuardado, plata };')(P.subtotalLinea);
}

test('cada ticket guardado se lista con su detalle adentro', () => {
  const { detalleGuardado, plata } = cargarDetalleGuardado();
  const pedido = {
    numero: 'A-12', fechaLocal: '27/08/2026', horaLocal: '10:05', cliente: 'Kiosco <b>Sur</b>',
    lineas: [
      { plu: '123', nombre: 'Yerba 1 kg', cant: 2, unidad: '', precio: 1000, dtoPct: 0, subtotal: 2000 },
      { plu: '987', nombre: 'Queso', cant: 0.5, unidad: 'kg', precio: 8000, dtoPct: 0 },
    ],
    subtotal: 6000, total: 6000, pagos: [{ medio: 'Efectivo', importe: 6000 }],
  };
  const html = detalleGuardado(pedido, 3);

  assert.ok(html.includes('<details class="tk-guardado" open>'), 'el detalle tiene que arrancar abierto');
  for (const dato of ['A-12', '27/08/2026 10:05', '123', 'Yerba 1 kg', '987', 'Queso', '0.500 kg']) {
    assert.ok(html.includes(dato), 'falta ' + dato + ' en el detalle');
  }
  // El subtotal de la línea de balanza no viene guardado: se calcula con subtotalLinea.
  assert.ok(html.includes(plata(4000)), 'falta el subtotal calculado del pesable');
  assert.ok(html.includes(plata(6000)), 'falta el total del ticket');
  // Los botones apuntan al índice del pedido, que es lo que usa el handler del listado.
  for (const attr of ['data-imprimir="3"', 'data-copiar="3"', 'data-borrar="3"']) {
    assert.ok(html.includes(attr), 'falta ' + attr);
  }
  // Nombres y clientes salen del catálogo y del teclado: nunca se inyectan crudos.
  assert.ok(!html.includes('<b>Sur</b>'), 'el nombre del cliente tiene que ir escapado');
});

test('el listado de tickets vive en un modal propio, debajo de los avisos', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  for (const id of ['fondoGuardados', 'cajaGuardados', 'listaGuardados', 'btnCerrarGuardados']) {
    assert.ok(src.includes('id="' + id + '"'), 'falta el nodo #' + id);
  }
  assert.ok(!src.includes('tablaGuardados'), 'quedó la tabla resumen vieja');
  // #modalFondo está en 100: la confirmación de borrado tiene que tapar al listado.
  const regla = src.slice(src.indexOf('#fondoGuardados {'), src.indexOf('#cajaGuardados {'));
  assert.ok(/z-index: 90;/.test(regla), '#fondoGuardados tiene que quedar debajo de #modalFondo');
  // Con el listado abierto el escáner no puede robar el foco: lo leído entraría a ciegas.
  assert.ok(src.includes("if (modalAbierto || !$('#fondoGuardados').classList.contains('oculto')) return;"),
    'focoEscaner tiene que respetar al listado abierto');
});

test('guardar cierra el pago solo con el medio elegido, sin preguntar', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const cuerpo = src.slice(src.indexOf("$('#btnGuardarPedido').onclick"), src.indexOf('function comoTexto('));
  // Nada puede frenar el guardado: la unica pregunta permitida es la de imprimir, y sale
  // recien despues de persistir el pedido.
  const hastaGrabar = cuerpo.slice(0, cuerpo.indexOf('grabar(K.ped, pedidos)'));
  assert.ok(!hastaGrabar.includes('confirmarModal'), 'guardar no puede frenar con una pregunta');
  assert.ok(cuerpo.includes("pagos = [...pagos, { medio: $('#medioPago').value, importe: falta }]"),
    'el faltante tiene que cerrarse con el medio de pago seleccionado');
  // El importe sale del saldo, no del total: un pago parcial ya cargado no se duplica.
  assert.ok(/const falta = saldoPagos\(/.test(cuerpo), 'el importe automático tiene que salir del saldo');
  const s = P.saldoPagos(1000, [{ medio: 'EFECTIVO', importe: 400 }]);
  assert.equal(s.falta, 600);
  assert.equal(P.saldoPagos(1000, [{ medio: 'EFECTIVO', importe: 1000 }]).falta, 0);
});

test('guardado confirma primero y recien despues ofrece imprimir el ticket', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  const cuerpo = src.slice(src.indexOf("$('#btnGuardarPedido').onclick"), src.indexOf('function comoTexto('));
  const iGrabar   = cuerpo.indexOf('grabar(K.ped, pedidos)');
  const iAviso    = cuerpo.indexOf('okModal(');
  const iPregunta = cuerpo.indexOf('confirmarModal(');
  const iImprimir = cuerpo.indexOf('window.print()');
  assert.ok(iGrabar >= 0 && iAviso > iGrabar, 'el aviso de guardado va despues de persistir');
  assert.ok(iPregunta > iAviso, 'la pregunta de impresion va despues del aviso');
  assert.ok(iImprimir > iPregunta, 'imprimir va despues de confirmar');
  // Si el vendedor cancela, no se imprime nada.
  assert.ok(cuerpo.includes('if (!await confirmarModal(') && cuerpo.includes(')) return;'),
    'cancelar la impresion tiene que cortar el flujo antes de window.print()');
  assert.ok(cuerpo.includes('pintarTicket(p)'), 'el ticket se arma con el pedido ya guardado');
});

test('el lector se puede dejar sin barra y el cartel se achica hasta entrar', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(src.includes('id="btnOcultarBarra"'), 'falta el botón para esconder la barra');
  assert.ok(src.includes('id="btnMostrarBarra"'), 'falta el botón para traerla de vuelta');
  // El botón de vuelta vive fuera del header: si se escondiera con él, la única salida
  // sería recargar la página.
  assert.ok(src.indexOf('id="btnMostrarBarra"') > src.indexOf('</header>'),
    'el botón para mostrar la barra no puede estar adentro del header');
  assert.ok(/body\.sin-barra > header \{ display: none; \}/.test(src), 'falta la regla que esconde la barra');
  assert.ok(/body\.sin-barra #vistaConsulta \{ min-height: 100dvh; \}/.test(src),
    'sin barra el lector tiene que ocupar la pantalla entera');
  // En el facturador la barra vuelve sí o sí: es de donde se guarda y se cambia de vista.
  const cuerpo = src.slice(src.indexOf('function irA('), src.indexOf('function verBarra('));
  assert.ok(cuerpo.includes("verBarra(v === 'consulta' && !!cfg.barraOculta)"),
    'la barra sólo se esconde en el lector');
  assert.ok(cuerpo.includes("$('#btnOcultarBarra').classList.toggle('oculto', v !== 'consulta')"),
    'el botón de esconder sólo va en el lector');
  // Cada repintado del cartel recalcula el ajuste, y el resize también.
  assert.ok(src.includes("+ '</div>'; ajustarFicha(); }"), 'poner() tiene que ajustar el cartel');
  assert.ok(src.includes("addEventListener('resize', ajustarFicha)"), 'falta el ajuste al cambiar de tamaño');
  // El ajuste mira alto y ancho: con el nombre largo el problema es el alto, no el ancho.
  const fn = src.slice(src.indexOf('function ajustarFicha('), src.indexOf("addEventListener('resize'"));
  // El contenedor crece con lo pintado: contra su propio alto la escala siempre da 1.
  assert.ok(!fn.includes('clientHeight'), 'el alto disponible sale de la ventana, no del contenedor');
  assert.ok(fn.includes('innerHeight') && fn.includes('clientWidth'), 'el ajuste tiene que mirar las dos medidas');
  assert.ok(fn.includes('scrollHeight') && fn.includes('scrollWidth'),
    'hay que medir el contenido, no la caja recortada por max-width');
  assert.ok(/Math\.max\(escala, \.35\)/.test(fn), 'falta el piso de escala');
});

// ── Promo y precios bloqueados ────────────────────────────────────────────────
// El precio del ticket tiene que ser el del catálogo: si se puede editar a mano, lo que
// se cobra deja de coincidir con lo que después se carga al sistema. Las únicas dos
// excepciones son los genéricos, que no tienen precio propio.
test('sólo los genéricos llevan precio a mano', () => {
  assert.equal(P.PLU_PROMO, '60000');
  assert.ok(P.precioLibre({ plu: '60000' }), 'la promo tiene que dejar tipear el precio');
  assert.ok(P.precioLibre({ plu: '1' }), 'el código 1 tiene que dejar tipear el precio');
  // Los PLU llegan con ceros a la izquierda según de dónde salga el catálogo.
  assert.ok(P.precioLibre({ plu: '0001' }));
  assert.ok(P.precioLibre({ plu: ' 60000 ' }));
  for (const plu of ['4504', '600001', '6000', '', null, undefined, '10']) {
    assert.ok(!P.precioLibre({ plu }), 'el PLU ' + plu + ' no puede editar el precio');
  }
  assert.ok(!P.precioLibre(null) && !P.precioLibre(undefined), 'sin línea no hay precio libre');
});

test('el facturador bloquea el precio salvo en los genéricos', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'public', 'facturador.html'), 'utf8');
  assert.ok(src.includes('id="btnPromo"'), 'falta el botón de promo al lado del lector');
  // El input arranca readonly salvo que la línea sea de precio libre.
  assert.ok(src.includes("(precioLibre(l) ? '' : ' readonly"), 'el precio tiene que salir readonly');
  // readonly es sólo la pantalla: el handler tampoco puede aceptar el cambio.
  const oninput = src.slice(src.indexOf("$('#tablaLineas').oninput"), src.indexOf("$('#tablaLineas').onclick"));
  assert.ok(oninput.includes("inp.dataset.campo === 'precio' && !precioLibre(lineas[i])"),
    'el handler tiene que rechazar el precio de las líneas bloqueadas');
  // Dos promos distintas no se pueden juntar en una línea: cada una lleva su precio.
  const agregar = src.slice(src.indexOf('function agregarLinea('), src.indexOf('function pintarLineas('));
  assert.ok(agregar.includes('|| precioLibre(nueva) ? -1'), 'los genéricos no se acumulan');
});
