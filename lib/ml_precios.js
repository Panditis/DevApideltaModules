'use strict';
// ── Control de precios Mercado Libre (spec 2026-11-10-control-precios-ml) ──────
// Lógica pura: parseo de la bajada de ML, precio esperado, estado y KPIs. Sin I/O ni SQL.
// Sin margen: precio final − comisiones ≈ carta de SIGA. El gross-up es costoConGastos de lib/precios_esquema.js.
//
// IVA: la carta (ProductosSucursalesPrecios, lista 0) es el precio de mostrador CON IVA (ver
// lib/precios_listado_esquema.js "la lista minorista de SIGA va con IVA" y docs/modulo_precios_plan.md),
// igual que PRICE de ML. Por eso el esperado NO multiplica por (1 + iva/100). Sin verificar contra SQL.
const zlib = require('zlib');
const XLSX = require('xlsx');
const { r2, redondearMultiplo, costoConGastos } = require('./precios_esquema');

class ErrorBajada extends Error {}

const HOJA = 'Publicaciones';
const FILA_DATOS = 5; // índice 0-based: fila 6 de la hoja (las 5 primeras son headers/ayuda)
const MAX_FILAS = 20000;
// Tope anti zip bomb (una bajada real de ~20000 filas son pocos MB). Objeto exportado para que los tests lo bajen.
const LIMITES_ZIP = { totalBytes: 200 * 1024 * 1024, entradaBytes: 100 * 1024 * 1024 };
const FIRMA_ZIP = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const CUOTAS = ['no', 'agregar', 'interes_bajo'];

const CONFIG_DEFAULT = Object.freeze({
  comisionPct: 16,
  envioGratisPct: 0,
  cuotasBasePct: 4, // % por cuotas que se suma siempre (aun con 1 cuota) al recargo de tablaCuotas
  tablaCuotas: Object.freeze([[1, 0], [3, 8], [6, 12], [9, 16], [12, 19]].map(([cuotas, recargoPct]) => Object.freeze({ cuotas, recargoPct }))),
  toleranciaPct: 2,
  redondeoPaso: 0,
  // $ van al numerador, % al divisor.
  envioMonto: 0, // $ por venta, solo con envío gratis: envío por defecto (peso no definido o mayor al último tope)
  costoFijoMonto: 0, // $ por venta sin tramo: precio mayor al último precioMax de tablaCostoFijo
  tablaCostoFijo: Object.freeze([[15000, 1115], [25000, 2300], [33000, 2810]].map(([precioMax, valor]) => Object.freeze({ precioMax, valor }))),
  impuestosPct: 0,
  extras: [], // [{ nombre, tipo: '$' | '%', valor }]
  tablaEnvio: Object.freeze([
    [0.3, 5620], [0.5, 6140], [1, 7000], [2, 7470], [4.9, 10500],
    [9.9, 12090], [14.9, 14060], [19.9, 16790], [24.9, 20130], [29.9, 27700],
  ].map(([topeKg, valor]) => Object.freeze({ topeKg, valor }))), // envío por paquete según peso de la publicación
  envioGratisDesde: 33000, // $: desde acá ML obliga envío gratis; 0 = desactivado
  envioBonificado: false, // bonificación de ML: el envío aplicado se paga al ENVIO_BONIFICACION
});
const MAX_EXTRAS = 20;
const MAX_NOMBRE_EXTRA = 60;
const MAX_TRAMOS_ENVIO = 30;
const MAX_FILAS_CUOTAS = 12;
const MAX_CUOTAS = 24;
const ENVIO_BONIFICACION = 0.5;

// Config leída del JSON con los campos nuevos completados (0 / []). No muta la entrada.
// tablaEnvio ausente → tabla inicial; presente (aunque sea []) → se respeta.
function normalizarConfig(cfg) {
  const { cuotasPct: _viejo, tablaMargen: _sinMargen, ...c } = cfg || {}; // criterios viejos (cuotas por texto, tabla de márgenes): se ignoran
  return {
    ...CONFIG_DEFAULT, ...c,
    envioMonto: c.envioMonto ?? 0, costoFijoMonto: c.costoFijoMonto ?? 0, impuestosPct: c.impuestosPct ?? 0,
    extras: Array.isArray(c.extras) ? c.extras : [],
    tablaEnvio: Array.isArray(c.tablaEnvio) ? c.tablaEnvio : CONFIG_DEFAULT.tablaEnvio,
    envioGratisDesde: c.envioGratisDesde ?? CONFIG_DEFAULT.envioGratisDesde,
    envioBonificado: c.envioBonificado ?? false,
    cuotasBasePct: c.cuotasBasePct ?? CONFIG_DEFAULT.cuotasBasePct,
    tablaCuotas: Array.isArray(c.tablaCuotas) ? c.tablaCuotas : CONFIG_DEFAULT.tablaCuotas,
    tablaCostoFijo: Array.isArray(c.tablaCostoFijo) ? c.tablaCostoFijo : CONFIG_DEFAULT.tablaCostoFijo,
  };
}

// Primer tramo con topeKg ≥ pesoKg; sin peso válido o más pesado que el último tope → envío por defecto.
function tramoEnvio(tablaEnvio, pesoKg, envioDefecto) {
  const defecto = { monto: envioDefecto, topeKg: null, origen: 'defecto' };
  if (typeof pesoKg !== 'number' || !Number.isFinite(pesoKg) || pesoKg <= 0) return defecto;
  const t = (tablaEnvio || []).find(x => x.topeKg >= pesoKg);
  return t ? { monto: t.valor, topeKg: t.topeKg, origen: 'tabla' } : defecto;
}

// Recargo % de la fila con esa cantidad exacta de cuotas; sin fila o cantidad inválida → 0.
function recargoCuotas(tablaCuotas, cuotasQty) {
  const t = Number.isInteger(cuotasQty) ? (tablaCuotas || []).find(x => x.cuotas === cuotasQty) : null;
  return t ? t.recargoPct : 0;
}

// Primer tramo con precioMax ≥ precio; precio inválido o mayor al último precioMax → cargo por defecto.
function tramoCostoFijo(tabla, precio, defecto) {
  const def = { monto: defecto, precioMax: null, origen: 'defecto' };
  if (typeof precio !== 'number' || !Number.isFinite(precio)) return def;
  const t = (tabla || []).find(x => x.precioMax >= precio);
  return t ? { monto: t.valor, precioMax: t.precioMax, origen: 'tabla' } : def;
}

// Peso estimado (kg por unidad) desde el nombre de SIGA: primer "cantidad + unidad de peso/volumen", o "N x M unidad" = N×M.
// Líquidos con densidad 1. El multiplicador no puede empezar con 0 ("Harina 000 x 1 kg" toma el 1 kg). Sin match o 0 → null.
// Fracciones "1/2 kg" = 0.5. "1.000 g" / "1.500 ml": con g/ml/cc el punto o coma seguido de 3 dígitos es de miles; con kg/l es decimal.
// Unitario > PESO_MAX_ESTIMADO_KG → null.
// ponytail: "x 10" / "x 12" sin unidad de peso (¿unidades o gramos?) se ignora: ambiguo, mejor sin peso que uno inventado.
const PESO_MAX_ESTIMADO_KG = 50;
const UNIDADES_CHICAS = new Set(['gramos', 'gramo', 'grs', 'gr', 'g', 'ml', 'cc']);
const RE_PESO = /\b(?:([1-9]\d*)\s*x\s*)?(\d+(?:[.,]\d+)?(?:\/\d+)?)\s*(kilos|kilo|kgs|kgr|kg|gramos|gramo|grs|gr|g|litros|litro|lts|lt|l|ml|cc)\b/;
const FACTOR_PESO = { kilos: 1, kilo: 1, kgs: 1, kgr: 1, kg: 1, litros: 1, litro: 1, lts: 1, lt: 1, l: 1, gramos: 0.001, gramo: 0.001, grs: 0.001, gr: 0.001, g: 0.001, ml: 0.001, cc: 0.001 };
function estimarPesoKg(nombre) {
  const n = String(nombre ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const m = n.match(RE_PESO);
  if (!m) return null;
  const [num, den] = m[2].split('/');
  if (den !== undefined && !(Number(den) > 0)) return null;
  const cantidad = /^\d{1,3}[.,]\d{3}$/.test(num) && UNIDADES_CHICAS.has(m[3]) ? Number(num.replace(/[.,]/, '')) : Number(num.replace(',', '.'));
  const kg = Math.round((m[1] ? Number(m[1]) : 1) * (cantidad / (den === undefined ? 1 : Number(den))) * FACTOR_PESO[m[3]] * 1000) / 1000;
  return kg > 0 && kg <= PESO_MAX_ESTIMADO_KG ? kg : null;
}

const sumaExtras = (cfg, tipo) => (cfg.extras || []).filter(e => e.tipo === tipo).reduce((s, e) => s + e.valor, 0);

const texto = v => String(v ?? '').trim();
const numero = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function envioDe(v) {
  const s = texto(v);
  if (s === 'Mercado Envíos gratis') return 'gratis';
  if (s === 'Mercado Envíos a cargo del comprador') return 'comprador';
  if (s === 'No realizo envíos') return 'sin';
  return 'nd';
}

function cuotasDe(v) {
  const s = texto(v);
  if (s === 'Agregar cuotas') return 'agregar';
  if (/inter[eé]s bajo/i.test(s)) return 'interes_bajo';
  return 'no';
}

// Bajada de publicaciones de ML (xlsx) → publicaciones padre. Las variantes (VARIATION_ID con valor) se cuentan y se
// ignoran; dedup por ITEM_ID, gana la última.
function parsearBajada(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 4).equals(FIRMA_ZIP)) throw new ErrorBajada('El archivo tiene que ser el .xlsx de publicaciones de Mercado Libre.');
  // Antes de SheetJS: inflar cada entrada con tope y exigir tamaño real == declarado y CRC ok. SheetJS lee las mismas
  // entradas (mismos offsets del central directory), así que nunca infla más que lo verificado acá.
  const zip = leerZip(buffer);
  for (const e of zip.entradas) contenidoZip(buffer, e);
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_FILAS + 1, cellNF: false, cellText: false });
  } catch (_err) {
    throw new ErrorBajada('No pude leer el xlsx.');
  }
  const hoja = wb.Sheets[HOJA];
  if (!hoja) throw new ErrorBajada(`El xlsx no tiene la hoja "${HOJA}".`);
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' });
  if (filas.length > MAX_FILAS) throw new ErrorBajada('La hoja es demasiado grande para ser una bajada de ML.');
  const header = (filas[0] || []).map(texto);
  const col = nombre => header.indexOf(nombre);
  const c = {
    id: col('ITEM_ID'), producto: col('PRODUCT_NUMBER'), familia: col('FAMILY_ID'), variante: col('VARIATION_ID'), titulo: col('TITLE'), stock: col('QUANTITY'), precio: col('PRICE'),
    promo: col('SALE_PRICE'), iva: col('VALUE_ADDED_TAX'), envio: col('SHIPPING_METHOD'), estado: col('STATUS'), cuotas: col('LISTING_TYPE_V3'),
  };
  const faltan = ['id', 'variante', 'titulo', 'precio'].filter(k => c[k] < 0);
  if (faltan.length) throw new ErrorBajada('El xlsx no tiene las columnas de la bajada de ML (ITEM_ID, VARIATION_ID, TITLE, PRICE).');

  const porId = new Map();
  let total = 0;
  let variantesIgnoradas = 0;
  for (const f of filas.slice(FILA_DATOS)) {
    const id = texto(f[c.id]);
    if (!id) continue;
    total++;
    if (texto(f[c.variante])) { variantesIgnoradas++; continue; }
    const promo = numero(f[c.promo]);
    porId.set(id, {
      id,
      producto: c.producto < 0 ? '' : texto(f[c.producto]),
      familia: c.familia < 0 ? '' : texto(f[c.familia]),
      titulo: texto(f[c.titulo]),
      precio: numero(f[c.precio]),
      precioPromo: promo > 0 ? promo : null,
      envio: envioDe(f[c.envio]),
      activa: texto(f[c.estado]) === 'Activa',
      cuotas: cuotasDe(f[c.cuotas]),
      stock: Number(f[c.stock]) || 0,
      iva: parseFloat(texto(f[c.iva])) || 0,
    });
  }
  return { total, variantesIgnoradas, publicaciones: [...porId.values()] };
}

// ── Export: la misma bajada con PRICE = esperado, editando el zip/XML a mano para no perder formato ──────────
// SheetJS community reescribe el libro y pierde estilos/validaciones: acá se copian byte a byte todas las entradas
// del zip salvo la hoja Publicaciones, y en esa hoja solo se reemplazan las celdas PRICE. Sin zip64 ni cifrado.
const errZip = () => new ErrorBajada('No pude leer el xlsx.');

function leerZip(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 4).equals(FIRMA_ZIP)) throw new ErrorBajada('El archivo tiene que ser el .xlsx de publicaciones de Mercado Libre.');
  let fin = -1;
  // Desde el final: el primer candidato cuyo largo de comentario cierra justo con el archivo (evita firmas falsas en el comentario).
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { fin = i; break; }
  if (fin < 0) throw errZip();
  const total = buf.readUInt16LE(fin + 10), cdOffset = buf.readUInt32LE(fin + 16);
  if (total === 0xFFFF || cdOffset === 0xFFFFFFFF || cdOffset > fin) throw errZip();
  const entradas = [];
  let p = cdOffset, declarado = 0;
  for (let k = 0; k < total; k++) {
    if (p + 46 > fin || buf.readUInt32LE(p) !== 0x02014b50) throw errZip();
    const largoNombre = buf.readUInt16LE(p + 28);
    const largo = 46 + largoNombre + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const e = {
      cd: buf.subarray(p, p + largo),
      nombre: buf.toString('utf8', p + 46, p + 46 + largoNombre),
      flags: buf.readUInt16LE(p + 8), metodo: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16),
      tamComp: buf.readUInt32LE(p + 20), tam: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42),
    };
    if ((e.flags & 1) || (e.metodo !== 0 && e.metodo !== 8) || [e.tamComp, e.tam, e.offset].includes(0xFFFFFFFF)) throw errZip();
    declarado += e.tam;
    if (e.tam > LIMITES_ZIP.entradaBytes || declarado > LIMITES_ZIP.totalBytes) throw new ErrorBajada('El xlsx es demasiado grande para ser una bajada de ML.');
    if (e.offset + 30 > cdOffset || buf.readUInt32LE(e.offset) !== 0x04034b50) throw errZip();
    e.datos = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (e.datos + e.tamComp > cdOffset) throw errZip();
    entradas.push(e);
    p += largo;
  }
  // Tramo crudo de cada entrada: local header + datos + data descriptor, hasta la entrada siguiente.
  const offsets = [...entradas.map(e => e.offset), cdOffset].sort((x, y) => x - y);
  const siguiente = new Map(offsets.slice(0, -1).map((o, i) => [o, offsets[i + 1]]));
  return { entradas: entradas.map(e => ({ ...e, hasta: siguiente.get(e.offset) })), eocd: buf.subarray(fin) };
}

function contenidoZip(buf, e) {
  const crudo = buf.subarray(e.datos, e.datos + e.tamComp);
  let datos;
  try {
    // maxOutputLength: los tamaños declarados pueden mentir; RangeError si se pasa → errZip.
    datos = e.metodo === 0 ? crudo : zlib.inflateRawSync(crudo, { maxOutputLength: Math.max(1, Math.min(e.tam, LIMITES_ZIP.entradaBytes)) + 1 });
  } catch (_err) {
    throw errZip();
  }
  if (datos.length !== e.tam || zlib.crc32(datos) !== e.crc) throw errZip();
  return datos;
}

// Mismo zip con la entrada `nombre` reemplazada por `nuevo` (deflate); el resto se copia tal cual y en el mismo orden.
function reemplazarEnZip(buf, zip, nombre, nuevo) {
  const comp = zlib.deflateRawSync(nuevo);
  const crc = zlib.crc32(nuevo);
  const partes = [], cds = [];
  let pos = 0;
  for (const e of zip.entradas) {
    const cd = Buffer.from(e.cd);
    cd.writeUInt32LE(pos, 42);
    if (e.nombre === nombre) {
      const lh = Buffer.from(buf.subarray(e.offset, e.datos));
      for (const [h, d] of [[lh, 0], [cd, 2]]) { // en el central directory los campos van 2 bytes más adelante
        h.writeUInt16LE(e.flags & ~8, 6 + d); // sin data descriptor: tamaños y crc en el header
        h.writeUInt16LE(8, 8 + d);
        h.writeUInt32LE(crc, 14 + d);
        h.writeUInt32LE(comp.length, 18 + d);
        h.writeUInt32LE(nuevo.length, 22 + d);
      }
      partes.push(lh, comp);
      pos += lh.length + comp.length;
    } else {
      partes.push(buf.subarray(e.offset, e.hasta));
      pos += e.hasta - e.offset;
    }
    cds.push(cd);
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.from(zip.eocd);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, cdBuf, eocd]);
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const desescapar = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTIDADES[e] ?? m;
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : m; // inválida → literal
});
const atributo = (tag, nombre) => {
  const m = tag.match(new RegExp(`\\s${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? desescapar(m[1] ?? m[2]) : null;
};
const textosT = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => desescapar(m[1])).join('');
const columnaDe = ref => { let n = 0; for (const ch of /^[A-Z]*/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
const letrasDe = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const tagApertura = celda => celda.match(/^<c\b[^>]*>/)[0];

// Ruta de la hoja Publicaciones y de sharedStrings según xl/workbook.xml + sus rels.
function rutasLibro(buf, zip) {
  const leer = n => { const e = zip.entradas.find(x => x.nombre === n); return e ? contenidoZip(buf, e).toString('utf8') : null; };
  const libro = leer('xl/workbook.xml'), rels = leer('xl/_rels/workbook.xml.rels');
  if (!libro || !rels) throw errZip();
  const destino = pred => {
    const rel = [...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map(m => m[0]).find(pred);
    const t = rel && atributo(rel, 'Target');
    if (!t) return null;
    return t.startsWith('/') ? t.slice(1) : 'xl/' + t;
  };
  const hoja = [...libro.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map(m => m[0]).find(t => atributo(t, 'name') === HOJA);
  const rid = hoja && (hoja.match(/\s\w+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/) || []).slice(1).find(x => x != null);
  const ruta = rid && destino(r => atributo(r, 'Id') === rid);
  if (!ruta) throw new ErrorBajada(`El xlsx no tiene la hoja "${HOJA}".`);
  return { ruta, compartidos: destino(r => /\/sharedStrings$/.test(atributo(r, 'Type') || '')), leer };
}

const numeroCelda = v => (String(v).includes('e') ? v.toFixed(2) : String(v));

// esperadoPorId: { ITEM_ID: esperado }. Reemplaza solo la celda PRICE de las filas padre (sin VARIATION_ID) con
// esperado > 0; el resto del archivo queda byte a byte igual. → { buffer, exportadas, sinCambio }.
// ponytail: asume celdas con atributo r (Excel y ML siempre lo escriben); si una fila sin r y sin PRICE recibe la
// celda insertada, las celdas implícitas que siguen se correrían.
function aplicarPreciosEnBajada(buffer, esperadoPorId) {
  const zip = leerZip(buffer);
  const { ruta, compartidos, leer } = rutasLibro(buffer, zip);
  const xml = leer(ruta);
  if (xml == null) throw new ErrorBajada(`El xlsx no tiene la hoja "${HOJA}".`);
  if (/<\w+:worksheet\b/.test(xml)) throw new ErrorBajada('La hoja Publicaciones usa un formato XML que no sé editar.');
  const sst = compartidos && leer(compartidos);
  const strings = sst ? [...sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(m => textosT(m[1] || '')) : [];
  const valor = celda => {
    if (!celda) return '';
    const t = atributo(tagApertura(celda), 't');
    if (t === 'inlineStr') return textosT(celda).trim();
    const v = celda.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
    if (!v) return '';
    if (t === 's') return (strings[Number(v[1])] ?? '').trim();
    return t === 'n' || t == null ? texto(Number(v[1])) : desescapar(v[1]).trim();
  };

  const ini = xml.indexOf('<sheetData'), fin = xml.indexOf('</sheetData>');
  const reFila = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const reCelda = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  reFila.lastIndex = Math.max(ini, 0);
  const cambios = []; // [desde, hasta, texto], en orden
  let cId = 0, cVar = 0, cPrecio = 0, estiloPrevio = null, fila = 0, exportadas = 0, sinCambio = 0;
  for (let m; ini >= 0 && (m = reFila.exec(xml)) && m.index < fin;) {
    const rAttr = atributo(m[1], 'r');
    fila = rAttr ? Number(rAttr) : fila + 1;
    const cuerpo = m[2] ?? '';
    const inicioCuerpo = m.index + m[0].length - (m[2] == null ? 0 : cuerpo.length + '</row>'.length);
    const celdas = new Map(); // columna → { celda, desde }
    let col = 0;
    for (const c of cuerpo.matchAll(reCelda)) {
      const ref = atributo(tagApertura(c[0]), 'r');
      col = ref ? columnaDe(ref) : col + 1;
      celdas.set(col, { celda: c[0], desde: inicioCuerpo + c.index });
    }
    if (!cPrecio) { // primera fila = header
      if (fila !== 1) break;
      const header = new Map([...celdas].map(([k, x]) => [valor(x.celda), k]));
      [cId, cVar, cPrecio] = ['ITEM_ID', 'VARIATION_ID', 'PRICE'].map(n => header.get(n) || 0);
      if (!cId || !cVar || !cPrecio) break;
      continue;
    }
    const precio = celdas.get(cPrecio);
    const estilo = precio ? atributo(tagApertura(precio.celda), 's') : null;
    const id = fila > FILA_DATOS ? valor(celdas.get(cId)?.celda) : '';
    if (id && !valor(celdas.get(cVar)?.celda)) {
      const esperado = Object.hasOwn(esperadoPorId, id) ? esperadoPorId[id] : undefined;
      if (typeof esperado === 'number' && Number.isFinite(esperado) && esperado > 0) {
        const v = `<v>${numeroCelda(esperado)}</v></c>`;
        if (precio) {
          const attrs = precio.celda.match(/^<c\b([^>]*?)\/?>/)[1].replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, '');
          cambios.push([precio.desde, precio.desde + precio.celda.length, `<c${attrs}>${v}`]);
        } else {
          const nueva = `<c r="${letrasDe(cPrecio)}${fila}"${estiloPrevio != null ? ` s="${estiloPrevio}"` : ''}>${v}`;
          const sigue = [...celdas].find(([k]) => k > cPrecio);
          const en = sigue ? sigue[1].desde : inicioCuerpo + cuerpo.length;
          if (sigue || m[2] != null) cambios.push([en, en, nueva]);
          else cambios.push([m.index, m.index + m[0].length, `<row${m[1]}>${nueva}</row>`]);
        }
        exportadas++;
      } else sinCambio++;
    }
    if (estilo != null) estiloPrevio = estilo;
  }
  if (!cId || !cVar || !cPrecio) throw new ErrorBajada('El xlsx no tiene las columnas ITEM_ID, VARIATION_ID y PRICE.');
  if (!cambios.length) return { buffer, exportadas, sinCambio };
  const trozos = [];
  let desde = 0;
  for (const [a, b, t] of cambios) { trozos.push(xml.slice(desde, a), t); desde = b; }
  trozos.push(xml.slice(desde));
  return { buffer: reemplazarEnZip(buffer, zip, ruta, Buffer.from(trozos.join(''), 'utf8')), exportadas, sinCambio };
}

// Precio con el que se compara: la promo si hay, si no el precio de lista. null si no hay precio > 0.
function precioMlDe(pub) {
  const p = pub.precioPromo ?? pub.precio;
  return p > 0 ? p : null;
}

// esperado = redondeo((base + Σ$) / (1 − Σ%/100)), base = carta × unidades (sin margen). esperado null si Σ% llega al 100 %.
// Σ$ = envío (si aplica) + cargo fijo + extras $; Σ% = comisión + envío heredado % (si aplica) + cuotas + impuestos + extras %.
// Cuotas = cuotasBasePct + recargoCuotas(tablaCuotas, cuotasQty ?? 1).
// Precio de referencia: el esperado SIN envío y SIN cargo fijo (redondeado igual). Sobre él se evalúan el umbral de envío
// gratis obligatorio (ref ≥ envioGratisDesde > 0 → aplica envío aunque la bajada no diga gratis) y el tramo de cargo fijo
// (tramoCostoFijo). Después se calcula el esperado final con envío (monto por tramo de peso + envioGratisPct) y cargo fijo.
// envioBonificado: el monto de envío aplicado se multiplica por ENVIO_BONIFICACION; no cambia la referencia ni si aplica.
// precioPorKg: la carta de SIGA es por kilo → base = carta × pesoKg (unidades se ignora); sin peso válido → null (estado sin_peso).
function precioEsperado(carta, unidades, envio, cuotas, cfg, pesoKg = null, cuotasQty = null, precioPorKg = false) {
  if (precioPorKg) {
    if (!(typeof pesoKg === 'number' && pesoKg > 0)) return null;
    unidades = pesoKg;
  }
  const cuotasPct = r2((cfg.cuotasBasePct || 0) + recargoCuotas(cfg.tablaCuotas, cuotasQty ?? 1));
  const ref = calcularEsperado(carta, unidades, cfg, { cuotasPct, envioPct: 0, envioMonto: 0, costoFijo: 0 });
  const porUmbral = envio !== 'gratis' && cfg.envioGratisDesde > 0 && ref.esperado != null && ref.esperado >= cfg.envioGratisDesde;
  const aplica = envio === 'gratis' || porUmbral;
  const tr = tramoEnvio(cfg.tablaEnvio, pesoKg, cfg.envioMonto || 0);
  const cf = tramoCostoFijo(cfg.tablaCostoFijo, ref.esperado, cfg.costoFijoMonto || 0);
  const bonificado = aplica && cfg.envioBonificado === true;
  const envioMonto = !aplica ? 0 : bonificado ? r2(tr.monto * ENVIO_BONIFICACION) : tr.monto;
  const r = calcularEsperado(carta, unidades, cfg, { cuotasPct, envioPct: aplica ? cfg.envioGratisPct || 0 : 0, envioMonto, costoFijo: cf.monto });
  return {
    ...r, cuotasPct, baseKg: precioPorKg ? r.base : null,
    envioMonto, envioMontoLista: aplica ? tr.monto : 0, envioBonificado: bonificado, envioTopeKg: aplica ? tr.topeKg : null, envioOrigen: aplica ? tr.origen : null, envioPorUmbral: porUmbral,
    costoFijoTabla: cf.monto, costoFijoPrecioMax: cf.precioMax, costoFijoOrigen: cf.origen,
  };
}

function calcularEsperado(carta, unidades, cfg, { cuotasPct, envioPct, envioMonto, costoFijo }) {
  const base = r2(carta * unidades);
  const gastosPct = r2(cfg.comisionPct + envioPct + cuotasPct + (cfg.impuestosPct || 0) + sumaExtras(cfg, '%'));
  const gastosFijos = r2(envioMonto + costoFijo + sumaExtras(cfg, '$'));
  const exacto = costoConGastos(r2(base + gastosFijos), gastosPct, 'precio');
  return { base, gastosPct, gastosFijos, esperado: exacto == null ? null : redondearMultiplo(exacto, cfg.redondeoPaso) };
}

// Estado de control de una publicación. desvioPct a 2 decimales (así el borde de la tolerancia no depende del float).
function estadoDe({ vinculado, carta, precioMl, esperado, toleranciaPct, sinPeso = false }) {
  if (!vinculado) return { estado: 'sin_vincular', desvioPct: null };
  if (!(precioMl > 0)) return { estado: 'sin_precio', desvioPct: null };
  if (!(carta > 0)) return { estado: 'sin_carta', desvioPct: null };
  if (sinPeso) return { estado: 'sin_peso', desvioPct: null };
  if (!(esperado > 0)) return { estado: 'desviada', desvioPct: null }; // ponytail: solo con Σ% ≥ 100, que validarConfig no deja guardar
  const desvioPct = r2((precioMl - esperado) / esperado * 100);
  return { estado: Math.abs(desvioPct) <= toleranciaPct ? 'ok' : 'desviada', desvioPct };
}

function kpis(filas) {
  const k = { activas: 0, inactivas: 0, ok: 0, desviadas: 0, sinVincular: 0, sinCarta: 0, sinPrecio: 0, sinPeso: 0 };
  const clave = { ok: 'ok', desviada: 'desviadas', sin_vincular: 'sinVincular', sin_carta: 'sinCarta', sin_precio: 'sinPrecio', sin_peso: 'sinPeso' };
  for (const f of filas) {
    k[f.activa ? 'activas' : 'inactivas']++;
    k[clave[f.estado]]++;
  }
  return k;
}

// Publicaciones que comparten Número de producto O Agrupador (familia) son la misma cosa en ML: forman un grupo
// (union-find, así A~B por producto y B~C por familia quedan juntas). Cada grupo tiene una principal (la de vínculo
// más reciente; si ninguna tiene, la primera activa) y TODAS usan el vínculo de la principal: código SIGA, unidades,
// peso y cuotas. El precio esperado de cada una se sigue calculando con su envío/cuotas propios.
// → Map id → { principal, esPrincipal, hermanas: [ids], vinculo }
function agruparPublicaciones(pubs, vinculos) {
  const padre = new Map(pubs.map(p => [p.id, p.id]));
  const raiz = x => { while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); } return x; };
  const clave = new Map();
  for (const p of pubs) for (const k of [p.producto && `p:${p.producto}`, p.familia && `f:${p.familia}`]) {
    if (!k) continue;
    if (clave.has(k)) padre.set(raiz(p.id), raiz(clave.get(k))); else clave.set(k, p.id);
  }
  const grupos = new Map();
  for (const p of pubs) { const r = raiz(p.id); grupos.set(r, [...(grupos.get(r) || []), p]); }
  const res = new Map();
  for (const miembros of grupos.values()) {
    const ids = miembros.map(p => p.id);
    const conVinculo = ids.filter(i => vinculos[i]).sort((x, y) => String(vinculos[y].actualizado || '').localeCompare(String(vinculos[x].actualizado || '')));
    const principal = conVinculo[0] || (miembros.find(p => p.activa) || miembros[0]).id;
    for (const id of ids) res.set(id, { principal, esPrincipal: id === principal, hermanas: ids.filter(i => i !== id), vinculo: vinculos[principal] || null });
  }
  return res;
}

// Una fila de la tabla: publicación + vínculo + carta en vivo (cartas: Map String(código) → { precio, nombre }).
function armarFila(pub, vinculo, cartas, cfg, grupo) {
  const precioMl = precioMlDe(pub);
  const info = vinculo ? cartas.get(String(vinculo.codigo)) : null;
  const carta = info && info.precio > 0 ? info.precio : null;
  const pesoKg = vinculo && typeof vinculo.pesoKg === 'number' ? vinculo.pesoKg : null;
  const cuotasQty = vinculo && Number.isInteger(vinculo.cuotasQty) ? vinculo.cuotasQty : null;
  const precioPorKg = !!vinculo && vinculo.precioPorKg === true;
  const calc = vinculo && carta ? precioEsperado(carta, vinculo.unidades, pub.envio, pub.cuotas, cfg, pesoKg, cuotasQty, precioPorKg) : null;
  const sinPeso = precioPorKg && !(pesoKg > 0);
  const { estado, desvioPct } = estadoDe({ vinculado: !!vinculo, carta, precioMl, esperado: calc && calc.esperado, toleranciaPct: cfg.toleranciaPct, sinPeso });
  return {
    hermanas: grupo ? grupo.hermanas : [], principal: grupo ? grupo.principal : pub.id, esPrincipal: grupo ? grupo.esPrincipal : true,
    id: pub.id, titulo: pub.titulo, activa: pub.activa, envio: pub.envio, cuotas: pub.cuotas, stock: pub.stock,
    precioLista: pub.precio, precioPromo: pub.precioPromo, precioMl,
    codigo: vinculo ? vinculo.codigo : null, unidades: vinculo ? vinculo.unidades : null, nombreProducto: info ? info.nombre : null,
    carta, base: calc ? calc.base : null, gastosPct: calc ? calc.gastosPct : null,
    gastosFijos: calc ? calc.gastosFijos : null, esperado: calc ? calc.esperado : null, desvioPct, estado,
    pesoKg, pesoEstimado: !!vinculo && vinculo.pesoEstimado === true, envioMonto: calc ? calc.envioMonto : 0, envioTopeKg: calc ? calc.envioTopeKg : null, envioOrigen: calc ? calc.envioOrigen : null,
    envioPorUmbral: calc ? calc.envioPorUmbral : false,
    envioMontoLista: calc ? calc.envioMontoLista : 0, envioBonificado: calc ? calc.envioBonificado : false,
    cuotasQty, cuotasPct: calc ? calc.cuotasPct : null, precioPorKg, baseKg: calc ? calc.baseKg : null,
    costoFijoTabla: calc ? calc.costoFijoTabla : 0, costoFijoPrecioMax: calc ? calc.costoFijoPrecioMax : null, costoFijoOrigen: calc ? calc.costoFijoOrigen : null,
  };
}

// Tramos ordenados por la clave (> 0, estrictamente creciente) con valor $ ≥ 0; máx MAX_TRAMOS_ENVIO. Ausente = []. Error o null.
function validarTramos(tabla, nombre, clave, etiqueta, plural, monto, campo) {
  const t = tabla ?? [];
  if (!Array.isArray(t)) return `${campo} debe ser una lista`;
  if (t.length > MAX_TRAMOS_ENVIO) return `La tabla de ${nombre} no puede tener más de ${MAX_TRAMOS_ENVIO} tramos`;
  for (const [i, x] of t.entries()) {
    if (!x || typeof x[clave] !== 'number' || !Number.isFinite(x[clave]) || x[clave] <= 0) return `Tramo ${i + 1} de ${nombre}: ${etiqueta} debe ser un número > 0`;
    if (!monto(x.valor)) return `Tramo ${i + 1} de ${nombre}: el valor debe ser un número ≥ 0`;
    if (i > 0 && x[clave] <= t[i - 1][clave]) return `Tabla de ${nombre}: los ${plural} deben ser crecientes y sin repetir (tramo ${i + 1})`;
  }
  return null;
}

// Config del PUT: devuelve un mensaje de error o null.
function validarConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'Falta la configuración';
  const pct = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100;
  const monto = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const k of ['comisionPct', 'envioGratisPct', 'toleranciaPct']) if (!pct(cfg[k])) return `${k} debe ser un número ≥ 0 y < 100`;
  // Campos nuevos: ausentes valen 0 / [] (config vieja).
  if (cfg.impuestosPct != null && !pct(cfg.impuestosPct)) return 'impuestosPct debe ser un número ≥ 0 y < 100';
  if (cfg.envioBonificado != null && typeof cfg.envioBonificado !== 'boolean') return 'envioBonificado debe ser true o false';
  for (const k of ['envioMonto', 'costoFijoMonto', 'envioGratisDesde']) if (cfg[k] != null && !monto(cfg[k])) return `${k} debe ser un número ≥ 0`;
  const extras = cfg.extras ?? [];
  if (!Array.isArray(extras)) return 'extras debe ser una lista';
  if (extras.length > MAX_EXTRAS) return `No puede haber más de ${MAX_EXTRAS} extras`;
  for (const e of extras) {
    if (!e || typeof e.nombre !== 'string' || !e.nombre.trim() || e.nombre.trim().length > MAX_NOMBRE_EXTRA) return `Cada extra necesita un nombre de hasta ${MAX_NOMBRE_EXTRA} caracteres`;
    if (e.tipo !== '$' && e.tipo !== '%') return `El extra "${e.nombre.trim()}" debe ser de tipo $ o %`;
    if (!monto(e.valor)) return `El valor del extra "${e.nombre.trim()}" debe ser un número ≥ 0`;
  }
  const errTabla = validarTramos(cfg.tablaEnvio, 'envío', 'topeKg', 'el tope en kg', 'topes en kg', monto, 'tablaEnvio')
    || validarTramos(cfg.tablaCostoFijo, 'cargo fijo', 'precioMax', 'el precio máximo', 'precios máximos', monto, 'tablaCostoFijo');
  if (errTabla) return errTabla;
  if (cfg.cuotasBasePct != null && !pct(cfg.cuotasBasePct)) return 'cuotasBasePct debe ser un número ≥ 0 y < 100';
  const cuotasT = cfg.tablaCuotas ?? [];
  if (!Array.isArray(cuotasT)) return 'tablaCuotas debe ser una lista';
  if (cuotasT.length > MAX_FILAS_CUOTAS) return `La tabla de cuotas no puede tener más de ${MAX_FILAS_CUOTAS} filas`;
  for (const [i, t] of cuotasT.entries()) {
    if (!t || !Number.isInteger(t.cuotas) || t.cuotas < 1 || t.cuotas > MAX_CUOTAS) return `Fila ${i + 1} de cuotas: la cantidad debe ser un entero de 1 a ${MAX_CUOTAS}`;
    if (!pct(t.recargoPct)) return `Fila ${i + 1} de cuotas: el recargo debe ser un número ≥ 0 y < 100`;
    if (cuotasT.some((x, j) => j < i && x.cuotas === t.cuotas)) return `Tabla de cuotas: la cantidad ${t.cuotas} está repetida`;
  }
  const maxGastos = cfg.comisionPct + cfg.envioGratisPct + (cfg.cuotasBasePct || 0) + Math.max(0, ...cuotasT.map(t => t.recargoPct)) + (cfg.impuestosPct || 0) + sumaExtras({ extras }, '%');
  if (maxGastos >= 100) return 'Comisión + envío + cuotas + impuestos + extras % no puede llegar al 100 %';
  if (typeof cfg.redondeoPaso !== 'number' || !Number.isFinite(cfg.redondeoPaso) || cfg.redondeoPaso < 0) return 'redondeoPaso debe ser un número ≥ 0';
  return null;
}

module.exports = { ErrorBajada, LIMITES_ZIP, CONFIG_DEFAULT, CUOTAS, ENVIO_BONIFICACION, PESO_MAX_ESTIMADO_KG, estimarPesoKg, normalizarConfig, tramoEnvio, recargoCuotas, tramoCostoFijo, parsearBajada, agruparPublicaciones, aplicarPreciosEnBajada, precioMlDe, precioEsperado, estadoDe, kpis, armarFila, validarConfig };
