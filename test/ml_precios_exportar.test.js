'use strict';
// aplicarPreciosEnBajada: edita solo las celdas PRICE del zip/XML y deja el resto byte a byte igual.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const XLSX = require('xlsx');
const ml = require('../lib/ml_precios');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml_publicaciones_muestra.xlsx'));

// Zip mínimo: [nombre, contenido, metodo 0|8]. Usa data descriptor (flag 8) en las deflate, como ML.
function zip(entradas) {
  const locales = [], cds = [];
  let pos = 0;
  for (const [nombre, texto, metodo = 8] of entradas) {
    const datos = Buffer.from(texto, 'utf8'), comp = metodo === 8 ? zlib.deflateRawSync(datos) : datos;
    const crc = zlib.crc32(datos), n = Buffer.from(nombre), dd = metodo === 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(dd ? 8 : 0, 6); lh.writeUInt16LE(metodo, 8);
    if (!dd) { lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(datos.length, 22); }
    lh.writeUInt16LE(n.length, 26);
    const desc = Buffer.alloc(dd ? 16 : 0);
    if (dd) { desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(comp.length, 8); desc.writeUInt32LE(datos.length, 12); }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(dd ? 8 : 0, 8); cd.writeUInt16LE(metodo, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(datos.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(pos, 42);
    locales.push(lh, n, comp, desc);
    cds.push(cd, n);
    pos += 30 + n.length + comp.length + desc.length;
  }
  const cdBuf = Buffer.concat(cds), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(cdBuf.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...locales, cdBuf, fin]);
}

// Leer entradas de un zip (para comparar): nombre → { datos, crudo }.
function entradasZip(buf) {
  const fin = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const out = new Map();
  let p = buf.readUInt32LE(fin + 16);
  for (let k = 0; k < buf.readUInt16LE(fin + 10); k++) {
    const nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42), tc = buf.readUInt32LE(p + 20), metodo = buf.readUInt16LE(p + 10);
    const ini = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const crudo = buf.subarray(ini, ini + tc), datos = metodo === 8 ? zlib.inflateRawSync(crudo) : crudo;
    assert.strictEqual(zlib.crc32(datos), buf.readUInt32LE(p + 16), 'crc del central directory');
    out.set(buf.toString('utf8', p + 46, p + 46 + nl), { datos, crudo });
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const is = (r, t, s = 3) => `<c r="${r}" s="${s}" t="inlineStr"><is><t>${t}</t></is></c>`;
const HOJA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<dimension ref="A1:D9"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  + '<cols><col min="1" max="1" width="18.75" customWidth="1"/><col min="3" max="3" width="40" customWidth="1"/></cols><sheetData>\n'
  + `<row r="1" ht="0" customHeight="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>${is('D1', 'PRICE')}</row>\n`
  + '<row r="2"/><row r="3"><c r="A3" s="9"/></row><row r="4"/>\n'
  + `<row r="5">${is('A5', 'MLA0')}<c r="D5" s="7"><v>1</v></c></row>\n` // fila de ayuda (<6): no se toca aunque tenga id
  + `<row r="6" ht="50" customHeight="1">${is('A6', 'MLA1')}<c r="B6" s="3"/>${is('C6', 'Miel &amp; algo')}<c r="D6" s="7" t="n"><v>100.0</v></c></row>\n`
  + `<row r="7">${is('A7', 'MLA1')}${is('B7', '555')}${is('C7', 'variante')}<c r="D7" s="7"><v>100</v></c></row>\n`
  + `<row r='8' spans='1:4'><c s='8' r='A8' t='s'><v>3</v></c><c r='C8' t='s'><v>4</v></c></row>\n` // PRICE ausente, comillas simples
  + `<row r="9">${is('A9', 'MLA3')}<c t="s" r="D9" s="7"><v>5</v></c></row>\n`
  + `<row r="10">${is('A10', 'MLA4')}<c r="D10" s="7"><f>1+1</f><v>2</v></c></row>\n`
  + `<row r="11">${is('A11', 'MLA5')}<c r="D11" s="7"><v>77</v></c></row>\n`
  + '</sheetData><conditionalFormatting sqref="D6:D100"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>'
  + '<dataValidations count="1"><dataValidation type="decimal" sqref="D6:D100"><formula1>0</formula1></dataValidation></dataValidations></worksheet>';
const SST = '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">'
  + '<si><t>ITEM_ID</t></si><si><r><t>VARIATION</t></r><r><rPr><b/></rPr><t>_ID</t></r></si><si><t xml:space="preserve">TITLE</t></si>'
  + '<si><t>MLA2</t></si><si><t>Sin precio</t></si><si><t>9.5</t></si></sst>';
const ENTRADAS = [
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 0],
  ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="oculta &amp; otra" sheetId="1" state="veryHidden" r:id="rId1"/><sheet r:id="rId2" sheetId="2" name="Publicaciones"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'],
  ['xl/worksheets/sheet2.xml', HOJA_XML],
  ['xl/sharedStrings.xml', SST],
];
const SINTETICO = zip(ENTRADAS);

test('sintético estilo ML: solo cambian las celdas PRICE con esperado; el resto byte a byte igual', () => {
  const esperado = { MLA1: 1234.5, MLA2: 999, MLA3: 50, MLA4: 0.1 + 0.2, MLA0: 1, sinFila: 5 };
  const r = ml.aplicarPreciosEnBajada(SINTETICO, esperado);
  assert.strictEqual(r.exportadas, 4);
  assert.strictEqual(r.sinCambio, 1); // MLA5

  const a = entradasZip(SINTETICO), b = entradasZip(r.buffer);
  assert.deepStrictEqual([...b.keys()], [...a.keys()]);
  for (const [n, x] of a) {
    if (n === 'xl/worksheets/sheet2.xml') continue;
    assert.ok(b.get(n).datos.equals(x.datos), n);
    assert.ok(b.get(n).crudo.equals(x.crudo), `${n} crudo`);
  }
  const hoja = b.get('xl/worksheets/sheet2.xml').datos.toString('utf8');
  const nuevas = [
    ['<c r="D6" s="7" t="n"><v>100.0</v></c>', '<c r="D6" s="7"><v>1234.5</v></c>'],
    ["<c r='C8' t='s'><v>4</v></c>", '<c r="D8" s="7"><v>999</v></c>', true], // insertada después de C8, estilo de la PRICE anterior
    ['<c t="s" r="D9" s="7"><v>5</v></c>', '<c r="D9" s="7"><v>50</v></c>'],
    ['<c r="D10" s="7"><f>1+1</f><v>2</v></c>', `<c r="D10" s="7"><v>${0.1 + 0.2}</v></c>`],
  ];
  let reconstruida = hoja;
  for (const [vieja, nueva, insertada] of nuevas) {
    assert.ok(hoja.includes(nueva), nueva);
    reconstruida = reconstruida.replace(insertada ? vieja + nueva : nueva, vieja);
  }
  assert.strictEqual(reconstruida, HOJA_XML);

  const v = ml.parsearBajada(r.buffer).publicaciones;
  const precio = id => v.find(p => p.id === id).precio;
  assert.strictEqual(precio('MLA1'), 1234.5);
  // MLA2 (fila 8, comillas simples) y las filas siguientes se validan arriba por XML: SheetJS no lee bien atributos con comillas simples.
  const wb = XLSX.read(r.buffer, { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['oculta & otra', 'Publicaciones']);
});

test('fixture SheetJS: round-trip con parsearBajada; solo cambia la hoja Publicaciones', () => {
  const pubs = ml.parsearBajada(FIXTURE).publicaciones;
  const esperado = Object.fromEntries(pubs.filter((_, i) => i % 2 === 0).map((p, i) => [p.id, 1000 + i]));
  const r = ml.aplicarPreciosEnBajada(FIXTURE, esperado);
  assert.strictEqual(r.exportadas, Object.keys(esperado).length);
  assert.strictEqual(r.sinCambio, pubs.length - r.exportadas);
  const v = ml.parsearBajada(r.buffer).publicaciones;
  for (const p of pubs) assert.strictEqual(v.find(x => x.id === p.id).precio, esperado[p.id] ?? p.precio);
  const a = entradasZip(FIXTURE), b = entradasZip(r.buffer);
  const distintas = [...a].filter(([n, x]) => !b.get(n).crudo.equals(x.crudo)).map(([n]) => n);
  assert.strictEqual(distintas.length, 1);
  assert.match(distintas[0], /^xl\/worksheets\//);
});

test('sin esperados: devuelve el mismo buffer; no zip, sin hoja o sin columnas → ErrorBajada', () => {
  assert.strictEqual(ml.aplicarPreciosEnBajada(SINTETICO, {}).buffer, SINTETICO);
  assert.throws(() => ml.aplicarPreciosEnBajada(Buffer.from('hola'), {}), ml.ErrorBajada);
  assert.throws(() => ml.aplicarPreciosEnBajada(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]), {}), ml.ErrorBajada);
  const sinHoja = zip(ENTRADAS.map(([n, t, m]) => [n, n === 'xl/workbook.xml' ? t.replace('"Publicaciones"', '"Otra"') : t, m]));
  assert.throws(() => ml.aplicarPreciosEnBajada(sinHoja, {}), /no tiene la hoja/);
  const sinPrice = zip(ENTRADAS.map(([n, t, m]) => [n, n.endsWith('sheet2.xml') ? t.replace('<t>PRICE</t>', '<t>OTRA</t>') : t, m]));
  assert.throws(() => ml.aplicarPreciosEnBajada(sinPrice, {}), /columnas/);
});

// ── QA: zips hostiles o rotos → ErrorBajada rápido, sin colgarse ─────────────────────────────────────────────
test('zip truncado, offsets/tamaños mentirosos, cifrado o zip64 → ErrorBajada', () => {
  const fin = SINTETICO.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const cd = SINTETICO.readUInt32LE(fin + 16);
  const con = (fn) => { const b = Buffer.from(SINTETICO); fn(b); return b; };
  const casos = {
    'truncado a la mitad': SINTETICO.subarray(0, SINTETICO.length >> 1),
    'sin EOCD completo': SINTETICO.subarray(0, SINTETICO.length - 5),
    'cdOffset fuera de rango': con(b => b.writeUInt32LE(0x7fffffff, fin + 16)),
    'offset local mentiroso': con(b => b.writeUInt32LE(SINTETICO.length - 3, cd + 42)),
    'tamaño comprimido mentiroso': con(b => b.writeUInt32LE(0x7ffffff0, cd + 20)),
    'más entradas que las reales': con(b => b.writeUInt16LE(0xfffe, fin + 10)),
    'cifrado': con(b => b.writeUInt16LE(1, cd + 8)),
    'marcador zip64': con(b => b.writeUInt32LE(0xffffffff, cd + 24)),
    'método no soportado': con(b => b.writeUInt16LE(12, cd + 10)),
  };
  for (const [n, b] of Object.entries(casos)) assert.throws(() => ml.aplicarPreciosEnBajada(b, { MLA1: 1 }), ml.ErrorBajada, n);
});

test('zip bomb: declarado honesto o mentiroso → ErrorBajada antes de que SheetJS infle (parsear y exportar)', () => {
  const previo = { ...ml.LIMITES_ZIP };
  Object.assign(ml.LIMITES_ZIP, { totalBytes: 2 * 1024 * 1024, entradaBytes: 1024 * 1024 });
  try {
    const bomba = zip([...ENTRADAS, ['relleno.bin', 'a'.repeat(50 * 1024 * 1024)]]);
    assert.ok(bomba.length < 200 * 1024);
    const fin = bomba.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
    const ultimoCd = bomba.lastIndexOf(Buffer.from([0x50, 0x4b, 1, 2]), fin);
    const mentiroso = Buffer.from(bomba); mentiroso.writeUInt32LE(100, ultimoCd + 24); // declara 100 bytes
    assert.throws(() => ml.parsearBajada(bomba), /demasiado grande/);
    assert.throws(() => ml.aplicarPreciosEnBajada(bomba, { MLA1: 1 }), /demasiado grande/);
    // mentiroso: lo frena el maxOutputLength en parsearBajada (las rutas lo llaman antes de exportar; aplicar no infla relleno.bin)
    assert.throws(() => ml.parsearBajada(mentiroso), /No pude leer/);
    const varias = zip([...ENTRADAS, ...[1, 2, 3].map(i => [`r${i}.bin`, 'a'.repeat(900 * 1024)])]); // cada una < tope, la suma no
    assert.throws(() => ml.parsearBajada(varias), /demasiado grande/);
  } finally {
    Object.assign(ml.LIMITES_ZIP, previo);
  }
});

test('CRC mal, EOCD falso en el comentario y entidad numérica inválida', () => {
  const fin = SINTETICO.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const cd = SINTETICO.readUInt32LE(fin + 16);
  let cdLibro = cd; // 3ra entrada: xl/workbook.xml, que aplicar sí lee
  for (let k = 0; k < 2; k++) cdLibro += 46 + SINTETICO.readUInt16LE(cdLibro + 28);
  const crcMal = Buffer.from(SINTETICO); crcMal.writeUInt32LE((crcMal.readUInt32LE(cdLibro + 16) ^ 1) >>> 0, cdLibro + 16);
  assert.throws(() => ml.aplicarPreciosEnBajada(crcMal, { MLA1: 1 }), ml.ErrorBajada);
  assert.throws(() => ml.parsearBajada(crcMal), ml.ErrorBajada);

  const falso = Buffer.alloc(22); falso.writeUInt32LE(0x06054b50, 0); falso.writeUInt32LE(0, 16);
  const conComentario = Buffer.concat([SINTETICO, falso, Buffer.from('basta')]); // firma falsa seguida de más comentario
  conComentario.writeUInt16LE(27, SINTETICO.length - 2); // comentario del EOCD real = el EOCD falso
  assert.strictEqual(ml.aplicarPreciosEnBajada(conComentario, { MLA1: 7 }).exportadas, 1);

  const raro = zip(ENTRADAS.map(([n, t, m]) => [n, n.endsWith('sheet2.xml') ? t.replace('Miel &amp; algo', 'x &#99999999; &#xD800; y').replace('<t>MLA5</t>', '<t>&#99999999;</t>') : t, m]));
  assert.strictEqual(ml.aplicarPreciosEnBajada(raro, { MLA1: 7 }).exportadas, 1);
});

test('celdas PRICE autocerrada, inlineStr y fila sin r: se reemplazan sin tocar el resto', () => {
  const hoja = HOJA_XML.replace('<row r="11">', '<row>') // fila sin r: sigue a la 10
    .replace('<c t="s" r="D9" s="7"><v>5</v></c>', '<c r="D9" s="7"/>')
    .replace('<c r="D11" s="7"><v>77</v></c>', '<c r="D11" s="7" t="inlineStr"><is><t>77</t></is></c>');
  const z = zip(ENTRADAS.map(([n, t, m]) => [n, n.endsWith('sheet2.xml') ? hoja : t, m]));
  const r = ml.aplicarPreciosEnBajada(z, { MLA3: 50, MLA5: 1500.25 });
  const nueva = entradasZip(r.buffer).get('xl/worksheets/sheet2.xml').datos.toString('utf8');
  assert.ok(nueva.includes('<c r="D9" s="7"><v>50</v></c>'));
  assert.ok(nueva.includes('<c r="D11" s="7"><v>1500.25</v></c>'));
  assert.strictEqual(nueva.replace('<c r="D9" s="7"><v>50</v></c>', '<c r="D9" s="7"/>')
    .replace('<c r="D11" s="7"><v>1500.25</v></c>', '<c r="D11" s="7" t="inlineStr"><is><t>77</t></is></c>'), hoja);
});

test('esperados no válidos (0, negativo, NaN, string) no se escriben', () => {
  const r = ml.aplicarPreciosEnBajada(SINTETICO, { MLA1: 0, MLA3: -5, MLA4: NaN, MLA5: '100' });
  assert.strictEqual(r.exportadas, 0);
  assert.strictEqual(r.buffer, SINTETICO);
});

// Bajada real de ML (no versionada): ML_BAJADA_REAL=C:/ruta/Publicaciones-....xlsx
test('bajada real de ML: solo cambia la hoja Publicaciones y solo la columna PRICE', { skip: !process.env.ML_BAJADA_REAL && 'sin ML_BAJADA_REAL' }, () => {
  const buf = fs.readFileSync(process.env.ML_BAJADA_REAL);
  const pubs = ml.parsearBajada(buf).publicaciones;
  assert.ok(pubs.length > 0);
  const esperado = Object.fromEntries(pubs.map((p, i) => [p.id, 1000 + i + 0.5]));
  const r = ml.aplicarPreciosEnBajada(buf, esperado);
  assert.strictEqual(r.exportadas + r.sinCambio >= pubs.length, true);
  for (const p of ml.parsearBajada(r.buffer).publicaciones) assert.strictEqual(p.precio, esperado[p.id], p.id);
  const a = entradasZip(buf), b = entradasZip(r.buffer);
  assert.deepStrictEqual([...b.keys()], [...a.keys()]);
  const distintas = [...a].filter(([n, x]) => !b.get(n).datos.equals(x.datos)).map(([n]) => n);
  assert.strictEqual(distintas.length, 1);
  // Fuera de las celdas, el XML es idéntico; y las celdas cambiadas son todas de una sola columna (PRICE).
  const partir = s => s.split(/(<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>))/);
  const x = partir(a.get(distintas[0]).datos.toString('utf8')), y = partir(b.get(distintas[0]).datos.toString('utf8'));
  assert.strictEqual(x.length, y.length);
  const cols = new Set();
  x.forEach((s, i) => { if (s !== y[i]) { assert.ok(s.startsWith('<c'), 'cambio fuera de una celda'); cols.add(/\sr="([A-Z]+)/.exec(s)[1]); } });
  assert.strictEqual(cols.size, 1);
  const ws = XLSX.read(r.buffer, { type: 'buffer' }).Sheets.Publicaciones;
  assert.strictEqual(ws[`${[...cols][0]}1`].v, 'PRICE');
});
