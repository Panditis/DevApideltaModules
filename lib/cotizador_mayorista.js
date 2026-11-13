'use strict';
// ── Cotizador mayorista · exportación (spec docs/specs/2026-11-03-cotizador-mayorista-exportacion-design.md) ──
// Puro: sin express ni SQL. Arma las filas de catalogo.csv desde la tabla propia (data/cotizador_mayorista.json) y el
// índice de vínculos de los listados del módulo Precios, valida, calcula el diff contra la última exportación, el CSV y
// version.json. Decisión del usuario (2026-11-13, manda sobre la spec y el brief 2026-11-03):
// - Precio pack/bulto = PrecioVenta de SIGA tal cual (lista 0, sucursal 1, cualquier rubro; lib/precios_consultas
//   preciosSigaPorPlu), sin IVA, descuento ni decisiones de Precios, origen 'siga'. El PLU sale como siempre
//   (explícito packPlu/bultoPlu o vínculo automático del índice de Precios).
// - Sin precio en SIGA (o sin vínculo): el precio de ESA columna sale del respaldo = último exportado de ese cod (o, antes
//   de la primera exportación, el de la planilla importada), marcado 'respaldo' y listado en revisar. Sin respaldo: la
//   fila no sale y figura en revisar (y en el diff como quitada si estaba publicada). Nunca se vacía en silencio.
// - Cantidad que no normaliza a Nu/Nkg: la fila entera sale del respaldo (si hay) o no sale; en revisar con el motivo.
// - No hay filas manuales (precio fijo) ni pack por descuento: validarFila los rechaza.
// - No hay umbral ni confirmación: el diff es informativo.
// - modoPack por fila: 'plu' (default, filas viejas sin el campo) = PLU pack vinculado; 'ninguno' = pack vacío.
const crypto = require('crypto');
const { tipoPorNombre } = require('./precios_pack_bulto');

const COLUMNAS = ['cod', 'seccion', 'nombre', 'pack_qty', 'pack_price', 'bulto_qty', 'bulto_price'];
const PLU = /^\d{1,12}$/;
const MODOS_PACK = ['plu', 'ninguno'];
const modoPack = f => f.modoPack || 'plu';
const MAX_TEXTO = 200;
const MAX_FILAS = 2000;
const SUBIDA_DEFECTO = Object.freeze({ host: 'srva103.controlvps.com', usuario: 'Apdftp', ruta: '/web/cotizador/' });

const redondear = n => (n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : null);
const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const texto = v => (v == null ? '' : String(v).trim());

// "12u"→"12u", "4"→"4u", "160U"→"160u", "caja x 8u"→"8u", "4 cajas x 32u"→"32u", "300kg"→"300kg", "—"/""→"".
// → { valor } | { valor: null, aviso }. El cotizador toma el primer número como mínimo: por eso la forma canónica.
function normalizarCantidad(t) {
  const s = texto(t).toLowerCase().replace(/\s+/g, ' ');
  if (s === '' || /^[—–-]+$/.test(s)) return { valor: '' };
  const m = s.match(/^(?:.*\bx ?)?(\d+(?:[.,]\d+)?) ?(u|kg)?$/);
  if (!m) return { valor: null, aviso: `Cantidad no reconocida: "${texto(t)}"` };
  const n = m[1].replace(',', '.');
  const unidad = m[2] || 'u';
  if (unidad === 'u' && !/^\d+$/.test(n)) return { valor: null, aviso: `Unidades con decimales: "${texto(t)}"` };
  if (!(Number(n) > 0)) return { valor: null, aviso: `Cantidad en cero: "${texto(t)}"` };
  return { valor: `${Number(n)}${unidad}` };
}

// Listados del módulo Precios ({ almacen, fraccionado, produccion }, filas completas de rutas_precios_esquema) →
// Map plu pack/bulto → { basePlu, tipo, nombre, presentacion?, hermanos? }. Sólo vínculos y nombres: el precio sale de SIGA.
function indicePrecios({ almacen = [], fraccionado = [], produccion = [] } = {}) {
  const porPlu = new Map();
  const sumar = fila => {
    for (const v of fila.mayoristas || []) if (!porPlu.has(v.plu)) porPlu.set(v.plu, { basePlu: fila.plu, tipo: v.tipo, nombre: v.nombre });
  };
  for (const f of [...almacen, ...produccion]) sumar(f);
  for (const g of fraccionado) { sumar(g); for (const p of g.presentaciones || []) sumar(p); }
  // Presentaciones mayoristas de fraccionado (regla pack/bulto ya resuelta en Precios). Después de SIGA: los vínculos SIGA mandan.
  for (const g of fraccionado) {
    const pres = g.presentaciones || [];
    const hermanos = new Set([g.plu, ...pres.map(p => p.plu)]);
    for (const p of pres) {
      if (!p.mayorista || !['pack', 'bulto'].includes(p.mayoristaTipo) || porPlu.has(p.plu)) continue;
      porPlu.set(p.plu, { basePlu: g.plu, hermanos, presentacion: true, tipo: p.mayoristaTipo, nombre: p.nombre });
    }
  }
  return porPlu;
}

// PLU del pack/bulto de una fila: el de la tabla (Codigo Pack/Bulto del Excel o edición) o el vínculo automático de SIGA
// (lib/precios_pack_bulto vía listados: mayorista del tipo cuyo base es el cod).
// conPresentaciones (sólo el botón autocompletar): también presentaciones mayoristas de fraccionado (cod = granel o hermana).
function pluVinculado(fila, tipo, indice, { conPresentaciones = false } = {}) {
  const explicito = texto(fila[`${tipo}Plu`]);
  if (explicito) return explicito;
  for (const [plu, m] of indice) {
    if (m.tipo !== tipo) continue;
    if (!m.presentacion ? m.basePlu === fila.cod : conPresentaciones && (m.basePlu === fila.cod || m.hermanos.has(fila.cod))) return plu;
  }
  return null;
}

// Precio de una columna → { valor, origen: 'siga'|'respaldo'|null, motivo, plu }. precios = Map plu → PrecioVenta de SIGA.
// ponytail: valor tal cual de SIGA (sin Math.round); si el cotizador web exigiera enteros, redondear acá.
function precioColumna(fila, tipo, indice, respaldo, precios) {
  const plu = pluVinculado(fila, tipo, indice);
  const siga = plu ? precios.get(plu) : null;
  if (siga != null && Number.isFinite(siga) && siga > 0) return { valor: siga, origen: 'siga', motivo: null, plu };
  const motivo = !plu ? `${tipo}: sin vínculo` : `${tipo}: PLU ${plu} sin precio en SIGA`;
  const r = respaldo ? redondear(Number(respaldo[`${tipo}_price`])) : null;
  return { valor: r, origen: r != null ? 'respaldo' : null, motivo, plu };
}
// PLU pack/bulto en uso de las filas incluidas: los que hay que pedirle a SIGA para armar el catálogo.
const plusDePrecio = (filas, indice) => [...new Set((filas || []).filter(f => f.incluido !== false)
  .flatMap(f => ['pack', 'bulto'].filter(t => t === 'bulto' || modoPack(f) === 'plu').map(t => pluVinculado(f, t, indice))).filter(Boolean))];

// Secciones agrupadas por primera aparición; dentro de cada una, el orden del array. Sin mutar.
function ordenarPorSeccion(lista) {
  const orden = new Map();
  for (const f of lista) if (!orden.has(f.seccion)) orden.set(f.seccion, orden.size);
  return lista.map((f, i) => ({ f, i })).sort((a, b) => orden.get(a.f.seccion) - orden.get(b.f.seccion) || a.i - b.i).map(x => x.f);
}

// Excel de códigos: todas las filas de la tabla (incluidas o no), ordenadas como el catálogo. → array de arrays con encabezados.
// PLU = explícito o vínculo SIGA (sin presentaciones); pack vacío en modoPack 'ninguno'.
// nombres = { plu: nombre } de SIGA (nombresPorPlu) para los explícitos que no están en el índice.
const ENCABEZADOS_CODIGOS = ['Codigo', 'Producto', 'CodigoPack', 'Cantidad pack', 'CodigoBulto', 'CantidadBulto', 'NombrePack', 'NombreBulto'];
const nombrePlu = (plu, indice, nombres = {}) => nombres[plu] ?? (indice.get(plu) || {}).nombre ?? null;
function filasExportarCodigos(filas, indice = new Map(), nombres = {}) {
  const num = v => (/^\d+$/.test(texto(v)) ? Number(texto(v)) : texto(v));
  const cant = v => { const q = normalizarCantidad(v); return q.valor === null ? texto(v) : q.valor; };
  const crudo = (f, t) => (t === 'pack' && modoPack(f) !== 'plu' ? '' : pluVinculado(f, t, indice) || '');
  const nom = (f, t) => { const p = crudo(f, t); return p ? nombrePlu(p, indice, nombres) || '' : ''; };
  return [ENCABEZADOS_CODIGOS, ...ordenarPorSeccion(Array.isArray(filas) ? filas : []).map(f =>
    [num(f.cod), texto(f.nombre), num(crudo(f, 'pack')), cant(f.packQty), num(crudo(f, 'bulto')), cant(f.bultoQty), nom(f, 'pack'), nom(f, 'bulto')])];
}

// tabla = { filas: [...] } (orden del array = orden del catálogo, secciones agrupadas por primera aparición).
// respaldos = Map cod → fila CSV publicada (objeto con COLUMNAS). → { filas (para el CSV), revisar, avisos, errores }.
// precios = Map plu → PrecioVenta de SIGA (preciosSigaPorPlu sobre plusDePrecio).
function armarCatalogo({ tabla, indice = new Map(), respaldos = new Map(), precios = new Map() }) {
  const filas = [], revisar = [], avisos = [], errores = [];
  const vistos = new Set();
  for (const f of ordenarPorSeccion((objeto(tabla).filas || []).filter(f => f.incluido !== false))) {
    const cod = texto(f.cod), nombre = texto(f.nombre);
    if (!cod || !nombre) { avisos.push(`Fila sin cod o nombre descartada (${cod || nombre || 'vacía'})`); continue; }
    if (vistos.has(cod)) { errores.push(`cod repetido: ${cod}`); continue; }
    vistos.add(cod);
    const respaldo = respaldos.get(cod) || null;
    const modo = modoPack(f);
    const qPack = modo === 'ninguno' ? { valor: '' } : normalizarCantidad(f.packQty), qBulto = normalizarCantidad(f.bultoQty);
    const malas = [qPack, qBulto].filter(q => q.valor === null).map(q => q.aviso);
    if (malas.length) {
      const completo = respaldo && respaldo.cod != null; // el respaldo de la planilla trae sólo precios
      revisar.push({ cod, nombre, motivos: malas, respaldo: !!completo });
      if (completo) filas.push({ ...respaldo, origen: { pack: 'respaldo', bulto: 'respaldo' } });
      continue;
    }
    const pack = qPack.valor ? precioColumna(f, 'pack', indice, respaldo, precios) : { valor: null, origen: null, motivo: null };
    const bulto = qBulto.valor ? precioColumna(f, 'bulto', indice, respaldo, precios) : { valor: null, origen: null, motivo: null };
    const motivos = [pack, bulto].filter(p => p.motivo).map(p => p.motivo);
    if (pack.valor == null && bulto.valor == null) {
      revisar.push({ cod, nombre, motivos: motivos.length ? motivos : ['sin precio'], respaldo: false });
      continue;
    }
    if (motivos.length) revisar.push({ cod, nombre, motivos, respaldo: pack.origen === 'respaldo' || bulto.origen === 'respaldo' });
    if (pack.valor != null && bulto.valor != null && bulto.valor > pack.valor) avisos.push(`${cod} ${nombre}: precio bulto (${bulto.valor}) mayor que pack (${pack.valor})`);
    filas.push({ cod, seccion: texto(f.seccion) || 'Otros', nombre,
      pack_qty: pack.valor == null ? '' : qPack.valor, pack_price: pack.valor ?? '',
      bulto_qty: bulto.valor == null ? '' : qBulto.valor, bulto_price: bulto.valor ?? '',
      origen: { pack: pack.origen, bulto: bulto.origen }, modoPack: modo });
  }
  return { filas, revisar, avisos, errores };
}

const celda = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// UTF-8 sin BOM, fin de línea \n (spec §Formatos), última línea con \n.
const generarCsv = filas => [COLUMNAS, ...filas.map(f => COLUMNAS.map(c => f[c]))].map(r => r.map(celda).join(',')).join('\n') + '\n';
const sha256 = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// CSV propio → filas objeto (para leer la última publicación). Mismo contrato que Cat.parseCSV del cotizador.
function parsearCsv(txt) {
  const filas = []; let fila = [], campo = '', q = false;
  const src = String(txt).replace(/^﻿/, '');
  const cerrar = () => { fila.push(campo); campo = ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c !== '"') campo += c; else if (src[i + 1] === '"') { campo += '"'; i++; } else q = false; }
    else if (c === '"') q = true; else if (c === ',') cerrar();
    else if (c === '\n') { cerrar(); if (fila.some(x => x !== '')) filas.push(fila); fila = []; }
    else if (c !== '\r') campo += c;
  }
  cerrar(); if (fila.some(x => x !== '')) filas.push(fila);
  if (!filas.length) return [];
  const cab = filas[0];
  return filas.slice(1).map(f => Object.fromEntries(cab.map((k, i) => [k, f[i] ?? ''])));
}

// Fecha ISO con el huso local (-03:00), como el ejemplo de version.json.
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset(), sig = off >= 0 ? '+' : '-', a = Math.abs(off);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sig}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
const generarVersion = ({ version, csv, productos, usuario, fecha = new Date() }) =>
  ({ version, generado: isoLocal(fecha), sha256: sha256(csv), productos, usuario: usuario || null, catalogo: 'catalogo.csv' });

// Diff informativo contra la última publicación (filas objeto). pct = variación % del precio, 1 decimal.
function diffCatalogo(anteriores = [], actuales = []) {
  const antes = new Map(anteriores.map(f => [String(f.cod), f]));
  const ahora = new Map(actuales.map(f => [String(f.cod), f]));
  const nuevos = actuales.filter(f => !antes.has(String(f.cod))).map(f => ({ cod: f.cod, nombre: f.nombre, pack_price: f.pack_price, bulto_price: f.bulto_price }));
  const quitados = anteriores.filter(f => !ahora.has(String(f.cod))).map(f => ({ cod: f.cod, nombre: f.nombre }));
  const cambiados = [];
  for (const f of actuales) {
    const a = antes.get(String(f.cod));
    if (!a) continue;
    for (const c of ['pack_price', 'bulto_price', 'pack_qty', 'bulto_qty', 'nombre', 'seccion']) {
      if (String(a[c] ?? '') === String(f[c] ?? '')) continue;
      const x = Number(a[c]), y = Number(f[c]);
      const pct = c.endsWith('_price') && x > 0 && y > 0 ? Math.round(((y - x) / x) * 1000) / 10 : null;
      cambiados.push({ cod: f.cod, nombre: f.nombre, campo: c, antes: a[c] ?? '', despues: f[c] ?? '', pct });
    }
  }
  return { nuevos, quitados, cambiados };
}

// ── Tabla propia: validación de lo que manda el front y del import ──
function validarFila(f, i) {
  const o = objeto(f);
  const cod = texto(o.cod), seccion = texto(o.seccion), nombre = texto(o.nombre);
  const err = m => { throw new Error(`Fila ${i + 1}: ${m}`); };
  if (!PLU.test(cod)) err('cod debe ser numérico (1 a 12 dígitos)');
  if (!seccion || seccion.length > MAX_TEXTO) err('sección requerida');
  if (!nombre || nombre.length > MAX_TEXTO) err('nombre requerido');
  if (o.manual === true) err('las filas manuales con precio fijo ya no existen: el precio sale de SIGA');
  const fila = { cod, seccion, nombre, packQty: texto(o.packQty).slice(0, 40), bultoQty: texto(o.bultoQty).slice(0, 40), incluido: o.incluido !== false };
  for (const t of ['pack', 'bulto']) {
    const plu = texto(o[`${t}Plu`]);
    if (plu && !PLU.test(plu)) err(`${t}Plu inválido`);
    if (plu) fila[`${t}Plu`] = plu;
  }
  const modo = texto(o.modoPack) || 'plu';
  if (!MODOS_PACK.includes(modo)) err('modoPack inválido (plu o ninguno)');
  fila.modoPack = modo;
  const planilla = objeto(o.planilla);
  if (planilla.pack_price != null || planilla.bulto_price != null) fila.planilla = { pack_price: planilla.pack_price ?? '', bulto_price: planilla.bulto_price ?? '' };
  return fila;
}
function validarTabla(filas) {
  if (!Array.isArray(filas)) throw new Error('filas: debe ser una lista');
  if (filas.length > MAX_FILAS) throw new Error(`Más de ${MAX_FILAS} filas`);
  const limpias = filas.map(validarFila);
  const rep = limpias.map(f => f.cod).filter((c, i, a) => a.indexOf(c) !== i);
  if (rep.length) throw new Error(`cod repetido: ${[...new Set(rep)].join(', ')}`);
  return limpias;
}
function validarSubida(s) {
  const o = objeto(s);
  const host = texto(o.host), usuario = texto(o.usuario), ruta = texto(o.ruta);
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) throw new Error('host inválido');
  if (!/^[\w.-]{1,64}$/.test(usuario)) throw new Error('usuario inválido');
  if (!/^\/[\w./-]{0,200}$/.test(ruta)) throw new Error('ruta inválida (debe empezar con /)');
  return { host, usuario, ruta: ruta.endsWith('/') ? ruta : `${ruta}/` };
}
// Comandos copiables (curl pide la contraseña por prompt: nunca se guarda ni se incluye). Orden: catalogo.csv primero.
const comandosSubida = ({ host, usuario, ruta }) => ['catalogo.csv', 'version.json']
  .map(a => `curl -T ${a} ftp://${host}${ruta} --user ${usuario}`);

// ── Publicación por FTP: config en data/cotizador_ftp.json (la edita el usuario a mano; data/ está en .gitignore) ──
const FTP_PLANTILLA = Object.freeze({ host: SUBIDA_DEFECTO.host, puerto: 21, usuario: SUBIDA_DEFECTO.usuario, password: '',
  rutaRemota: '/web/cotizador', secure: false });
function normalizarFtp(c) {
  const o = { ...FTP_PLANTILLA, ...objeto(c) };
  return { host: texto(o.host), puerto: Number(o.puerto) || 21, usuario: texto(o.usuario), password: String(o.password ?? ''),
    rutaRemota: texto(o.rutaRemota) || '/', secure: o.secure === true };
}
const ftpPublico = ({ password, ...c }) => ({ ...c, tienePassword: password !== '' });
// Mensaje en español sin credenciales: clasifica por código FTP / errno y nunca reenvía el texto crudo del servidor.
function mensajeFtp(err) {
  const code = err && err.code;
  if (code === 530) return 'El servidor FTP rechazó el usuario o la contraseña: revisá data/cotizador_ftp.json';
  if (code === 550) return 'La carpeta o el archivo remoto no existe o no hay permiso: revisá rutaRemota en data/cotizador_ftp.json';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(code) || /timeout/i.test(String(err && err.message)))
    return 'No se pudo conectar al servidor FTP (sin respuesta o host/puerto incorrecto): revisá la red y data/cotizador_ftp.json';
  return 'Falló la subida por FTP; la publicación remota anterior puede seguir vigente. Reintentá o subí a mano con los comandos curl';
}
// Saca host/usuario/password de un texto (para logs).
const redactar = (s, cfg) => [cfg.password, cfg.usuario, cfg.host].filter(Boolean)
  .reduce((t, x) => t.split(x).join('***'), String(s));

// Filas de la hoja apidelta_precios (sheet_to_json con defval '') → filas de la tabla. cod numérico = producto del
// sistema (Codigo Pack/Bulto como vínculo explícito si vienen); cod vacío o no numérico = fila descartada.
// planilla = precios del Excel: respaldo hasta la primera exportación y base de la comparación.
function filasDesdePlanilla(rows) {
  const filas = [], descartadas = [];
  (rows || []).forEach((r, i) => {
    const cod = texto(r.cod), nombre = texto(r.nombre);
    if (!PLU.test(cod) || !nombre) { descartadas.push(i + 2); return; }
    const precio = v => (texto(v) === '' ? '' : Math.round(Number(v)) || '');
    const fila = { cod, seccion: texto(r.seccion) || 'Otros', nombre, packQty: texto(r.pack_qty), bultoQty: texto(r.bulto_qty), incluido: true,
      planilla: { pack_price: precio(r.pack_price), bulto_price: precio(r.bulto_price) } };
    if (PLU.test(texto(r['Codigo Pack']))) fila.packPlu = texto(r['Codigo Pack']);
    if (PLU.test(texto(r['Codigo Bulto']))) fila.bultoPlu = texto(r['Codigo Bulto']);
    fila.modoPack = fila.packPlu || fila.planilla.pack_price !== '' ? 'plu' : 'ninguno';
    filas.push(fila);
  });
  return { filas, descartadas };
}

const conCantidad = (f, t) => (t === 'bulto' || modoPack(f) === 'plu') && !!normalizarCantidad(f[`${t}Qty`]).valor;

// Vinculación de cada fila: explícita, automática o sin vincular (por columna con cantidad).
function resumenVinculos(filas, indice) {
  const sinVincular = [];
  let vinculados = 0;
  for (const f of filas) {
    const faltan = ['pack', 'bulto'].filter(t => conCantidad(f, t) && !pluVinculado(f, t, indice));
    if (faltan.length) sinVincular.push({ cod: f.cod, nombre: f.nombre, faltan }); else vinculados++;
  }
  return { vinculados, sinVincular };
}

// Pack/bulto en uso (conCantidad) de cada fila → { [cod]: { pack: { plu, nombre, origen: 'fila'|'siga' } | null, bulto } }.
// plu = explícito (origen 'fila') o vínculo SIGA sin presentaciones (lo que usa el precio). nombres como filasExportarCodigos.
function vinculosResueltos(filas, indice, nombres = {}) {
  const out = {};
  for (const f of filas) {
    const r = {};
    for (const t of ['pack', 'bulto']) {
      const plu = conCantidad(f, t) ? pluVinculado(f, t, indice) : null;
      r[t] = plu ? { plu, nombre: nombrePlu(plu, indice, nombres), origen: texto(f[`${t}Plu`]) ? 'fila' : 'siga' } : null;
    }
    out[f.cod] = r;
  }
  return out;
}
// PLU explícitos sin nombre en el índice (los que hay que pedir a SIGA).
const plusSinNombre = (filas, indice) => [...new Set(filas
  .flatMap(f => [texto(f.packPlu), texto(f.bultoPlu)]).filter(p => p && !(indice.get(p) || {}).nombre))];

// Candidatos pack/bulto por fórmula (usos = lib/precios_consultas usosComoFormula: productos cuya fórmula es sólo el
// base). Por base: el nombre manda (tipoPorNombre); los sin tipo, por cantidad: único candidato → bulto; dos → menor
// pack, mayor bulto; uno con tipo por nombre + uno sin tipo → éste toma el que falta. Más de dos sin tipo, cantidades iguales o dos del mismo tipo por nombre → ambiguo (no se asigna).
function candidatosPorFormula(usos = []) {
  const porBase = new Map();
  for (const u of usos) porBase.set(u.basePlu, [...(porBase.get(u.basePlu) || []), u]);
  const asignados = new Map();
  const ambiguos = [];
  for (const [basePlu, lista] of porBase) {
    const c = lista.map(u => ({ plu: u.plu, nombre: u.nombre, cantidad: u.cantidad }));
    const amb = motivo => ambiguos.push({ basePlu, motivo, candidatos: c });
    const porNombre = { pack: [], bulto: [] };
    const sinTipo = [];
    c.forEach((x, i) => { const t = tipoPorNombre(lista[i].nombre); (t ? porNombre[t] : sinTipo).push(x); });
    if (porNombre.pack.length > 1 || porNombre.bulto.length > 1) { amb('varios productos del mismo tipo por nombre'); continue; }
    const a = { ...(porNombre.pack[0] && { pack: porNombre.pack[0] }), ...(porNombre.bulto[0] && { bulto: porNombre.bulto[0] }) };
    const libres = ['pack', 'bulto'].filter(t => !a[t]);
    if (sinTipo.length === 1 && c.length === 1) a.bulto = sinTipo[0];
    else if (sinTipo.length === 1 && c.length === 2 && libres.length === 1) a[libres[0]] = sinTipo[0]; // el otro lo fijó el nombre
    else if (sinTipo.length === 2 && c.length === 2) {
      if (!sinTipo.every(x => x.cantidad != null && Number.isFinite(Number(x.cantidad)))) { amb('candidato sin cantidad en la fórmula'); continue; }
      const [m, M] = [...sinTipo].sort((x, y) => x.cantidad - y.cantidad);
      if (!(m.cantidad < M.cantidad)) { amb('dos candidatos con la misma cantidad'); continue; }
      Object.assign(a, { pack: m, bulto: M });
    } else if (sinTipo.length) { amb(`${sinTipo.length} candidato(s) sin pack/bulto en el nombre`); if (!a.pack && !a.bulto) continue; }
    asignados.set(basePlu, a);
  }
  return { asignados, ambiguos };
}

// Completa packPlu/bultoPlu faltantes: SIGA o presentación mayorista (pluVinculado) y, si no hay, candidato por fórmula
// (candidatosPorFormula). Nunca pisa un PLU explícito ni pone el mismo PLU en pack y bulto de una fila. Sin mutar.
function autocompletarVinculos(filas, indice, candidatos = { asignados: new Map(), ambiguos: [] }) {
  const completadas = [];
  const sinVincular = [];
  const nuevas = filas.map(f => {
    const out = { ...f };
    const faltan = [];
    for (const t of ['pack', 'bulto']) {
      if (!conCantidad(f, t) || texto(f[`${t}Plu`])) continue;
      const otro = texto(out[t === 'pack' ? 'bultoPlu' : 'packPlu']);
      let plu = pluVinculado(f, t, indice, { conPresentaciones: true });
      let origen = plu ? (indice.get(plu) || {}).presentacion ? 'presentacion' : 'sigaVinculo' : null;
      let nombre = plu ? nombrePlu(plu, indice) : null;
      if (!plu) {
        const cand = (candidatos.asignados.get(f.cod) || {})[t];
        if (cand && cand.plu !== otro) { plu = cand.plu; origen = 'formula'; nombre = cand.nombre ?? null; }
      }
      if (plu) { out[`${t}Plu`] = plu; completadas.push({ cod: f.cod, nombre: f.nombre, tipo: t, plu, origen, nombrePlu: nombre }); } else faltan.push(t);
    }
    if (faltan.length) {
      const amb = candidatos.ambiguos.find(a => a.basePlu === f.cod);
      sinVincular.push({ cod: f.cod, nombre: f.nombre, faltan, ...(amb && { motivo: `Fórmula ambigua: ${amb.motivo} (${amb.candidatos.map(x => x.plu).join(', ')})` }) });
    }
    return out;
  });
  return { filas: nuevas, completadas, sinVincular };
}

// PLU cargado en la tabla (catálogo) vs lo que propondría el sistema (misma regla que autocompletarVinculos, sin fórmula)
// por fila. estado: igual|distinto|solo catálogo|solo sistema|sin dato; pack en modoPack ≠ 'plu' → 'no aplica'.
const ESTADOS_CODIGOS = { iguales: 'igual', distintos: 'distinto', soloCatalogo: 'solo catálogo', soloSistema: 'solo sistema', sinDato: 'sin dato' };
function compararCodigos(filas, indice = new Map(), nombres = {}) {
  const detalle = filas.map(f => {
    const r = { cod: f.cod, nombre: f.nombre, seccion: f.seccion };
    for (const t of ['pack', 'bulto']) {
      if (t === 'pack' && modoPack(f) !== 'plu') { r[t] = { catalogo: null, sistema: null, estado: 'no aplica' }; continue; }
      const cat = texto(f[`${t}Plu`]);
      const sis = pluVinculado({ ...f, [`${t}Plu`]: '' }, t, indice, { conPresentaciones: true });
      const estado = cat && sis ? (cat === sis ? 'igual' : 'distinto') : cat ? 'solo catálogo' : sis ? 'solo sistema' : 'sin dato';
      r[t] = {
        catalogo: cat ? { plu: cat, nombre: nombrePlu(cat, indice, nombres) } : null,
        sistema: sis ? { plu: sis, nombre: nombrePlu(sis, indice, nombres), origen: (indice.get(sis) || {}).presentacion ? 'presentacion' : 'sigaVinculo' } : null,
        estado, ...(!conCantidad(f, t) && { sinCantidad: true }) };
    }
    return r;
  });
  const cuenta = e => detalle.reduce((n, d) => n + (d.pack.estado === e) + (d.bulto.estado === e), 0);
  return { ...Object.fromEntries(Object.entries(ESTADOS_CODIGOS).map(([k, e]) => [k, cuenta(e)])), detalle };
}

// Comparación por cod+tipo: último catálogo publicado (filas de parsearCsv) vs catálogo armado hoy (armarCatalogo().filas).
function compararConPublicado(publicadas = [], actuales = []) {
  const antes = new Map(publicadas.map(f => [String(f.cod), f])), ahora = new Map(actuales.map(f => [String(f.cod), f]));
  const precio = (f, t) => (f && Number(f[`${t}_price`]) > 0 ? Number(f[`${t}_price`]) : null);
  const det = [];
  for (const cod of new Set([...ahora.keys(), ...antes.keys()])) {
    const a = antes.get(cod), n = ahora.get(cod);
    for (const t of ['pack', 'bulto']) {
      const publicado = precio(a, t), sistema = precio(n, t);
      if (publicado == null && sistema == null) continue;
      const pct = publicado && sistema ? Math.round(((sistema - publicado) / publicado) * 1000) / 10 : null;
      det.push({ cod: (n || a).cod, nombre: (n || a).nombre, tipo: t, publicado, sistema, origen: n && n.origen ? n.origen[t] ?? null : null, pct,
        estado: !a ? 'nuevo' : !n ? 'quitado' : publicado == null || sistema == null ? 'sin dato' : publicado === sistema ? 'igual' : 'cambió' });
    }
  }
  const cuenta = e => det.filter(d => d.estado === e).length, cuentaOrigen = o => det.filter(d => d.origen === o).length;
  return { iguales: cuenta('igual'), cambiaron: cuenta('cambió'), sinDato: cuenta('sin dato'), nuevos: cuenta('nuevo'), quitados: cuenta('quitado'),
    conSiga: cuentaOrigen('siga'), conRespaldo: cuentaOrigen('respaldo'), detalle: det };
}

module.exports = {
  COLUMNAS, MODOS_PACK, SUBIDA_DEFECTO, normalizarCantidad, indicePrecios, pluVinculado, plusDePrecio, armarCatalogo, generarCsv, parsearCsv, sha256,
  isoLocal, generarVersion, diffCatalogo, validarTabla, validarSubida, comandosSubida, filasDesdePlanilla, resumenVinculos, autocompletarVinculos, candidatosPorFormula,
  compararConPublicado, compararCodigos, filasExportarCodigos, vinculosResueltos, plusSinNombre, FTP_PLANTILLA, normalizarFtp, ftpPublico, mensajeFtp, redactar,
};
