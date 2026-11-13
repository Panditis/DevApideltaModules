'use strict';
// ── Control de precios Tienda Nube (spec docs/specs/control_precios_tienda_nube.md) ──────
// Lógica pura: parseo de la bajada CSV de TN, esperado, estado, KPIs y export byte-preserving. Sin I/O ni SQL.
// IVA: la carta (lista 0) ya va con IVA, igual que ML; el esperado no multiplica por IVA. Sin verificar contra SQL.
const { r2, redondearMultiplo } = require('./precios_esquema');

class ErrorBajada extends Error {}

const MAX_FILAS = 20000;
const COLS = {
  url: 'Identificador de URL', nombre: 'Nombre', variante: 'Valor de propiedad 1', precio: 'Precio',
  stock: 'Stock', sku: 'SKU', mostrar: 'Mostrar en tienda', visibilidad: 'Visibilidad', categorias: 'Categorías',
  peso: 'Peso (kg)', prop2: 'Valor de propiedad 2', prop3: 'Valor de propiedad 3',
};
const REQUERIDAS = ['url', 'nombre', 'variante', 'precio', 'sku'];

// Combo = Categorías contiene "combos" (sin mayúsculas ni acentos).
const esComboTexto = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes('combos');

const CONFIG_DEFAULT = Object.freeze({ recargoPct: 10, toleranciaPct: 2, redondeoPaso: 50 });

// Texto latin1 → registros crudos. Parte por '\n' y ';' fuera de comillas; cada celda queda tal cual (con sus
// comillas), así join(';') + join('\n') reproduce los bytes exactos.
function registros(texto) {
  const filas = [];
  let celdas = [];
  let ini = 0;
  let enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (ch === '"') enComillas = !enComillas; // "" escapado alterna dos veces: queda igual
    else if (!enComillas && ch === ';') { celdas.push(texto.slice(ini, i)); ini = i + 1; }
    else if (!enComillas && ch === '\n') { celdas.push(texto.slice(ini, i)); filas.push(celdas); celdas = []; ini = i + 1; }
  }
  celdas.push(texto.slice(ini));
  filas.push(celdas); // si el archivo termina en '\n', este último es [''] y se conserva para el join
  return filas;
}

const valor = crudo => {
  const s = String(crudo ?? '').replace(/\r$/, '');
  return (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).replace(/""/g, '"') : s).trim();
};

// "2,700.00" → 2700. null si vacío o no numérico.
function parsearPrecio(s) {
  const t = String(s ?? '').trim().replace(/,/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

// 2700 → "2,700.00" (formato del original; que TN acepte 2700.00 no está verificado).
function formatearPrecio(n) {
  const [ent, dec] = Number(n).toFixed(2).split('.');
  return `${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

function indices(header) {
  const nombres = header.map(valor);
  const c = Object.fromEntries(Object.entries(COLS).map(([k, n]) => [k, nombres.indexOf(n)]));
  if (REQUERIDAS.some(k => c[k] < 0)) throw new ErrorBajada('El archivo no es la bajada CSV de productos de Tienda Nube (faltan columnas como "Identificador de URL", "Precio" o "SKU").');
  return c;
}

// "500 gr", "1,5 kg", "100gr" → kg. null si el texto no trae un peso reconocible.
function parsearPeso(t) {
  const m = /(\d+(?:[.,]\d+)?)\s*(kilos?|kgs?|gramos|grs?|g)(?![a-z])/i.exec(String(t || ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!(n > 0)) return null;
  return /^k/i.test(m[2]) ? n : n / 1000;
}

// Peso de la presentación de una fila: Peso (kg) de TN > valor de propiedad > nombre. Sin herencia del padre.
function presentacionDe(pesoTxt, props, nombre) {
  const peso = parsearPrecio(pesoTxt);
  if (peso > 0) return { texto: `${peso} kg (Peso TN)`, kg: peso, origen: 'peso_tn' };
  for (const p of props) { const kg = parsearPeso(p); if (kg) return { texto: p, kg, origen: 'propiedad' }; }
  const kg = parsearPeso(nombre);
  return kg ? { texto: nombre, kg, origen: 'nombre' } : { texto: null, kg: null, origen: 'sin_dato' };
}

// Buffer de la bajada → { filas, conSku, sinSku, skuRepetidos }. Las variantes heredan nombre y visibilidad del padre.
function parsearBajada(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ErrorBajada('El archivo está vacío.');
  const regs = registros(buffer.toString('latin1'));
  if (regs.length > MAX_FILAS) throw new ErrorBajada('El archivo es demasiado grande para ser una bajada de Tienda Nube.');
  const c = indices(regs[0]);
  const filas = [];
  let padre = null;
  for (const r of regs.slice(1)) {
    const url = valor(r[c.url]);
    if (!url) continue;
    const nombre = valor(r[c.nombre]);
    const propia = { nombre, mostrar: c.mostrar >= 0 ? valor(r[c.mostrar]) : '', visibilidad: c.visibilidad >= 0 ? valor(r[c.visibilidad]) : '', categorias: c.categorias >= 0 ? valor(r[c.categorias]) : '' };
    if (nombre || !padre || padre.url !== url) padre = { url, ...propia };
    const vis = propia.visibilidad || padre.visibilidad;
    const stockTxt = c.stock >= 0 ? valor(r[c.stock]) : '';
    const variante = valor(r[c.variante]);
    const categorias = propia.categorias || padre.categorias;
    filas.push({
      categorias, esCombo: esComboTexto(categorias),
      clave: `${url}|${variante}`, url, nombre: nombre || padre.nombre, variante, sku: valor(r[c.sku]),
      visible: vis ? vis === 'Visible' : (propia.mostrar || padre.mostrar) === 'SI',
      stock: stockTxt === '' ? null : Number(stockTxt), // vacío = stock infinito en TN
      precioTn: parsearPrecio(valor(r[c.precio])),
      presentacion: presentacionDe(c.peso >= 0 ? valor(r[c.peso]) : '', [variante, ...[c.prop2, c.prop3].filter(i => i >= 0).map(i => valor(r[i]))], nombre),
    });
  }
  const cuenta = new Map();
  for (const f of filas) if (f.sku) cuenta.set(f.sku, (cuenta.get(f.sku) || 0) + 1);
  const conSku = filas.filter(f => f.sku).length;
  return { filas, conSku, sinSku: filas.length - conSku, skuRepetidos: [...cuenta.values()].filter(n => n > 1).length };
}

// Código SIGA de la fila: el vínculo manual pisa al SKU numérico. null si no hay.
function codigoDe(fila, vinculo) {
  if (vinculo) return vinculo.codigo;
  return /^\d+$/.test(fila.sku) && Number(fila.sku) > 0 ? Number(fila.sku) : null;
}

// Línea del producto por su rubro de SIGA, con los mismos nombres de rubro que el universo de Precios
// (lib/precios_consultas.js: Fraccionado = 'Pesables Fraccionado' + 'Pesables Venta Directa'; Reventa = 'Almacen').
const RUBROS_FRACCIONADO = ['Pesables Fraccionado', 'Pesables Venta Directa'];
const lineaDe = info => (!info ? null : RUBROS_FRACCIONADO.includes(info.rubro) ? 'fraccionado' : info.rubro === 'Almacen' ? 'almacen' : 'otra');

// Multiplicador de la carta: unidades manuales del vínculo > kg de la presentación (solo Fraccionado, carta por kg) > 1.
function multiplicadorDe(fila, vinculo, esFraccionado) {
  const pres = { ...(fila.presentacion || { texto: null, kg: null, origen: 'sin_dato' }), aplicada: esFraccionado };
  const manual = vinculo && vinculo.unidades > 0 ? vinculo.unidades : null;
  if (manual) return { unidades: manual, unidadesManual: manual, origenUnidades: 'vinculo', presentacion: { ...pres, origen: 'vinculo' } };
  if (esFraccionado && pres.kg) return { unidades: pres.kg, unidadesManual: null, origenUnidades: 'presentacion', presentacion: pres };
  return { unidades: 1, unidadesManual: null, origenUnidades: 'defecto', presentacion: pres };
}

const precioEsperado = (carta, unidades, cfg) => redondearMultiplo(r2(carta * unidades * (1 + cfg.recargoPct / 100)), cfg.redondeoPaso);

// cartas: Map String(código) → { precio, nombre, rubro }. Código que no está en el Map = inexistente en SIGA → sin_codigo.
function armarFila(fila, vinculo, cartas, cfg) {
  const codigo = codigoDe(fila, vinculo);
  const info = codigo ? cartas.get(String(codigo)) || null : null;
  const linea = lineaDe(info);
  const esFraccionado = linea === 'fraccionado';
  const { unidades, unidadesManual, origenUnidades, presentacion } = multiplicadorDe(fila, vinculo, esFraccionado);
  const carta = info && info.precio > 0 ? info.precio : null;
  const esperado = carta ? precioEsperado(carta, unidades, cfg) : null;
  let estado; let desvioPct = null;
  if (!info) estado = 'sin_codigo';
  else if (!(fila.precioTn > 0)) estado = 'sin_precio';
  else if (!carta) estado = 'sin_carta';
  else {
    desvioPct = r2((fila.precioTn - esperado) / esperado * 100);
    estado = Math.abs(desvioPct) <= cfg.toleranciaPct ? 'ok' : 'desviada';
  }
  return {
    clave: fila.clave, url: fila.url, nombre: fila.nombre, variante: fila.variante, sku: fila.sku, skuOriginal: fila.sku,
    vinculado: !!vinculo, esCombo: false, visible: fila.visible, stock: fila.stock, precioTn: fila.precioTn, codigo, unidades, unidadesManual, origenUnidades, presentacion, linea, esFraccionado,
    nombreProducto: info ? info.nombre : null, carta, esperado, desvioPct, estado,
  };
}

// Combo: esperado = Σ carta × unidades de sus componentes, con recargo y redondeo. componentes: [{codigo, unidades}].
function armarCombo(fila, componentes, cartas, cfg) {
  const comps = (componentes || []).map(c => {
    const info = cartas.get(String(c.codigo));
    return { codigo: c.codigo, unidades: c.unidades, nombre: info ? info.nombre : null, carta: info && info.precio > 0 ? info.precio : null };
  });
  const completo = comps.length > 0 && comps.every(c => c.carta);
  const esperado = completo ? redondearMultiplo(r2(comps.reduce((s, c) => s + c.carta * c.unidades, 0) * (1 + cfg.recargoPct / 100)), cfg.redondeoPaso) : null;
  let estado; let desvioPct = null;
  if (!comps.length) estado = 'sin_componentes';
  else if (!(fila.precioTn > 0)) estado = 'sin_precio';
  else if (!completo) estado = 'sin_carta';
  else {
    desvioPct = r2((fila.precioTn - esperado) / esperado * 100);
    estado = Math.abs(desvioPct) <= cfg.toleranciaPct ? 'ok' : 'desviada';
  }
  return {
    clave: fila.clave, url: fila.url, nombre: fila.nombre, variante: fila.variante, sku: fila.sku, skuOriginal: fila.sku,
    vinculado: false, esCombo: true, visible: fila.visible, stock: fila.stock, precioTn: fila.precioTn, codigo: null, unidades: null,
    nombreProducto: null, componentes: comps, carta: null, esperado, desvioPct, estado,
  };
}

// Los generales cuentan todas las filas (combos incluidos); sinComponentes es el estado propio de combos.
function kpis(filas) {
  const k = { ok: 0, desviadas: 0, sinCodigo: 0, sinCarta: 0, sinPrecio: 0, sinComponentes: 0, ocultas: 0, combos: 0, combosDesviadas: 0, sinPresentacion: 0 };
  const clave = { ok: 'ok', desviada: 'desviadas', sin_codigo: 'sinCodigo', sin_carta: 'sinCarta', sin_precio: 'sinPrecio', sin_componentes: 'sinComponentes' };
  for (const f of filas) {
    k[clave[f.estado]]++;
    if (!f.visible) k.ocultas++;
    if (!f.esCombo && f.esFraccionado && f.presentacion && f.presentacion.origen === 'sin_dato') k.sinPresentacion++;
    if (f.esCombo) { k.combos++; if (f.estado === 'desviada') k.combosDesviadas++; }
  }
  return k;
}

function validarConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'Falta la configuración';
  const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!num(cfg.recargoPct) || cfg.recargoPct >= 1000) return 'recargoPct debe ser un número ≥ 0 y < 1000';
  if (!num(cfg.toleranciaPct) || cfg.toleranciaPct >= 100) return 'toleranciaPct debe ser un número ≥ 0 y < 100';
  if (!num(cfg.redondeoPaso)) return 'redondeoPaso debe ser un número ≥ 0';
  return null;
}

// Bytes de la bajada + correcciones { clave: precio } → Buffer latin1 con cabecera y todas las filas de los productos
// (URL) que tengan al menos una corrección. Solo cambia el texto de la celda Precio de las filas corregidas.
function exportarCsv(buffer, correcciones) {
  const regs = registros(buffer.toString('latin1'));
  const c = indices(regs[0]);
  const keyDe = r => `${valor(r[c.url])}|${valor(r[c.variante])}`;
  const urls = new Set(regs.slice(1).filter(r => Object.hasOwn(correcciones, keyDe(r))).map(r => valor(r[c.url])));
  const salida = [regs[0]];
  for (const r of regs.slice(1)) {
    if (!urls.has(valor(r[c.url]))) continue;
    const k = keyDe(r);
    salida.push(Object.hasOwn(correcciones, k) ? r.map((cel, i) => (i === c.precio ? formatearPrecio(correcciones[k]) : cel)) : r);
  }
  const fin = regs[regs.length - 1].length === 1 && regs[regs.length - 1][0] === '' ? '\n' : '';
  return Buffer.from(salida.map(r => r.join(';')).join('\n') + fin, 'latin1');
}

module.exports = { ErrorBajada, CONFIG_DEFAULT, parsearBajada, parsearPrecio, formatearPrecio, parsearPeso, precioEsperado, armarFila, armarCombo, kpis, validarConfig, exportarCsv };
