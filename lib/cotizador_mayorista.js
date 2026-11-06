'use strict';
// ── Cotizador mayorista · exportación (spec docs/specs/2026-11-03-cotizador-mayorista-exportacion-design.md) ──
// Puro: sin express ni SQL. Arma las filas de catalogo.csv desde la tabla propia (data/cotizador_mayorista.json) y el
// índice de precios de los listados del módulo Precios, valida, calcula el diff contra la última exportación, el CSV y
// version.json. Decisiones (brief 2026-11-03, mandan sobre la spec):
// - Precio = neto (sin IVA) del pack/bulto con la decisión vigente del producto, Math.round. Pesable vendido por kg:
//   el motor ya da $/kg (unidades 1, lib/precios_listado_esquema unidadesVinculo) → tambores/harinas salen del motor.
// - Sin decisión (o sin vínculo/precio): el precio de ESA columna sale del respaldo = último exportado de ese cod (o, antes
//   de la primera exportación, el de la planilla importada), marcado 'respaldo' y listado en revisar. Sin respaldo: la
//   fila no sale y figura en revisar (y en el diff como quitada si estaba publicada). Nunca se vacía en silencio.
// - Cantidad que no normaliza a Nu/Nkg: la fila entera sale del respaldo (si hay) o no sale; en revisar con el motivo.
// - Filas manuales (PALLET, etc.): cod libre y precios fijos, se exportan tal cual (cantidades igual normalizadas).
// - No hay umbral ni confirmación: el diff es informativo.
// - modoPack por fila (no manual): 'plu' (default, filas viejas sin el campo) = PLU pack vinculado; 'descuento' = precio
//   minorista decidido SIN IVA (precio final / (1 + ivaPct del motor), misma base neta que pack/bulto) × (1 − descuentoPack/100),
//   Math.round; sigue al minorista solo. Sin minorista decidido o sin cantidad pack → error (no exportable). 'ninguno' = pack vacío.
const crypto = require('crypto');

const COLUMNAS = ['cod', 'seccion', 'nombre', 'pack_qty', 'pack_price', 'bulto_qty', 'bulto_price'];
const FUENTES = ['sistema', 'ultimaCompra', 'manual']; // orden del sugerido (sólo comparación), como lib/precios_listado_esquema
const PLU = /^\d{1,12}$/;
const MODOS_PACK = ['plu', 'descuento', 'ninguno'];
const modoPack = f => (f.manual ? 'plu' : f.modoPack || 'plu');
const CLAVE_MINORISTA = plu => `minorista:${plu}`; // en el índice, junto a los PLU pack/bulto
const MAX_TEXTO = 200;
const MAX_FILAS = 2000;
const SUBIDA_DEFECTO = Object.freeze({ host: 'srva103.controlvps.com', usuario: 'Apdftp', ruta: '/web/cotizador/' });

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
// Map plu pack/bulto → { basePlu, tipo, nombre, decidido: neto|null, sugerido: neto|null, fuenteSugerido }.
// La decisión del granel alcanza a sus presentaciones (como itemsDecididos).
function indicePrecios({ almacen = [], fraccionado = [], produccion = [] } = {}) {
  const porPlu = new Map();
  const netoDe = (fila, fuente, plu) => {
    const s = objeto(objeto(fila.sugeridos)[fuente]);
    if (s.error || !Array.isArray(s.mayoristas)) return null;
    const m = s.mayoristas.find(x => x.plu === plu);
    return m && m.neto != null ? m.neto : null;
  };
  const sumar = (fila, decision) => {
    for (const v of fila.mayoristas || []) {
      const fuenteSugerido = FUENTES.find(f => netoDe(fila, f, v.plu) != null) || null;
      const previo = porPlu.get(v.plu);
      const decidido = decision ? netoDe(fila, decision.fuente, v.plu) : null;
      if (previo && previo.decidido != null) continue; // el primero decidido gana
      porPlu.set(v.plu, { basePlu: fila.plu, tipo: v.tipo, nombre: v.nombre, decidido,
        sugerido: fuenteSugerido ? netoDe(fila, fuenteSugerido, v.plu) : null, fuenteSugerido });
    }
    // Minorista decidido (para modoPack 'descuento'): precio final y su neto sin IVA con el ivaPct del motor.
    const s = decision ? objeto(objeto(fila.sugeridos)[decision.fuente]) : {};
    const final = !s.error && s.minorista ? s.minorista.precio : null;
    const iva = objeto(objeto(s.desglose).minorista).ivaPct;
    const clave = CLAVE_MINORISTA(fila.plu);
    if (final > 0 && Number.isFinite(iva) && !porPlu.has(clave)) porPlu.set(clave, { basePlu: fila.plu, tipo: 'minorista', final, ivaPct: iva, neto: final / (1 + iva / 100) });
  };
  for (const f of [...almacen, ...produccion]) sumar(f, f.decision);
  for (const g of fraccionado) {
    sumar(g, g.decision);
    for (const p of g.presentaciones || []) sumar(p, g.decision);
  }
  // Presentaciones mayoristas de fraccionado (regla pack/bulto ya resuelta en Precios): neto $/kg sin IVA del minorista.
  // Después de SIGA: los vínculos SIGA mandan.
  const netoKg = (p, fuente) => {
    const s = objeto(objeto(p.sugeridos)[fuente]);
    return !s.error && s.minorista && s.minorista.sinIva === true && s.minorista.precio != null ? s.minorista.precio : null;
  };
  for (const g of fraccionado) {
    const pres = g.presentaciones || [];
    const hermanos = new Set([g.plu, ...pres.map(p => p.plu)]);
    for (const p of pres) {
      if (!p.mayorista || !['pack', 'bulto'].includes(p.mayoristaTipo) || porPlu.has(p.plu)) continue;
      const fuenteSugerido = FUENTES.find(f => netoKg(p, f) != null) || null;
      porPlu.set(p.plu, { basePlu: g.plu, hermanos, presentacion: true, tipo: p.mayoristaTipo, nombre: p.nombre,
        decidido: g.decision ? netoKg(p, g.decision.fuente) : null,
        sugerido: fuenteSugerido ? netoKg(p, fuenteSugerido) : null, fuenteSugerido });
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

const redondear = n => (n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : null);

// Precio de una columna → { valor, origen: 'decision'|'manual'|'respaldo'|null, motivo }.
function precioColumna(fila, tipo, indice, respaldo) {
  if (fila.manual) return { valor: redondear(fila[`${tipo}Price`]), origen: 'manual', motivo: null };
  if (tipo === 'pack' && modoPack(fila) === 'descuento') return precioDescuento(fila, indice);
  return precioVinculo(fila, tipo, indice, respaldo);
}
// Pack por descuento sobre el minorista. Sin minorista decidido → error (sin respaldo: el modo es "sigue al minorista").
function precioDescuento(fila, indice) {
  const m = indice.get(CLAVE_MINORISTA(texto(fila.cod)));
  const pct = Number(fila.descuentoPack);
  if (!m) return { valor: null, origen: null, motivo: null, error: 'pack por descuento: el minorista no tiene precio decidido' };
  const valor = redondear(m.neto * (1 - pct / 100));
  return { valor, origen: 'descuento', motivo: null,
    descuento: { pct, minoristaFinal: m.final, ivaPct: m.ivaPct, minoristaNeto: Math.round(m.neto * 100) / 100, pack: valor } };
}
function precioVinculo(fila, tipo, indice, respaldo) {
  const plu = pluVinculado(fila, tipo, indice);
  const m = plu ? indice.get(plu) : null;
  const valor = m ? redondear(m.decidido) : null;
  if (valor != null) return { valor, origen: 'decision', motivo: null, plu };
  const motivo = !plu ? `${tipo}: sin vínculo` : !m ? `${tipo}: PLU ${plu} sin precio en el módulo` : `${tipo}: sin decisión vigente`;
  const r = respaldo ? redondear(Number(respaldo[`${tipo}_price`])) : null;
  return { valor: r, origen: r != null ? 'respaldo' : null, motivo, plu };
}

// Secciones agrupadas por primera aparición; dentro de cada una, el orden del array. Sin mutar.
function ordenarPorSeccion(lista) {
  const orden = new Map();
  for (const f of lista) if (!orden.has(f.seccion)) orden.set(f.seccion, orden.size);
  return lista.map((f, i) => ({ f, i })).sort((a, b) => orden.get(a.f.seccion) - orden.get(b.f.seccion) || a.i - b.i).map(x => x.f);
}

// Excel de códigos: todas las filas de la tabla (incluidas o no), ordenadas como el catálogo. → array de arrays con encabezados.
// PLU = explícito o vínculo SIGA (sin presentaciones); manual sin códigos; pack vacío en modoPack 'ninguno'/'descuento'.
const ENCABEZADOS_CODIGOS = ['Codigo', 'Producto', 'CodigoPack', 'Cantidad pack', 'CodigoBulto', 'CantidadBulto'];
function filasExportarCodigos(filas, indice = new Map()) {
  const num = v => (/^\d+$/.test(texto(v)) ? Number(texto(v)) : texto(v));
  const cant = v => { const q = normalizarCantidad(v); return q.valor === null ? texto(v) : q.valor; };
  const plu = (f, t) => (f.manual || (t === 'pack' && modoPack(f) !== 'plu') ? '' : num(pluVinculado(f, t, indice) || ''));
  return [ENCABEZADOS_CODIGOS, ...ordenarPorSeccion(Array.isArray(filas) ? filas : []).map(f =>
    [num(f.cod), texto(f.nombre), plu(f, 'pack'), cant(f.packQty), plu(f, 'bulto'), cant(f.bultoQty)])];
}

// tabla = { filas: [...] } (orden del array = orden del catálogo, secciones agrupadas por primera aparición).
// respaldos = Map cod → fila CSV publicada (objeto con COLUMNAS). → { filas (para el CSV), revisar, avisos, errores }.
function armarCatalogo({ tabla, indice = new Map(), respaldos = new Map() }) {
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
    if (modo === 'descuento' && !qPack.valor) { errores.push(`${cod} ${nombre}: pack por descuento sin cantidad mínima`); continue; }
    const pack = qPack.valor ? precioColumna(f, 'pack', indice, respaldo) : { valor: null, origen: null, motivo: null };
    if (pack.error) { errores.push(`${cod} ${nombre}: ${pack.error}`); continue; }
    const bulto = qBulto.valor ? precioColumna(f, 'bulto', indice, respaldo) : { valor: null, origen: null, motivo: null };
    const motivos = [pack, bulto].filter(p => p.origen !== 'decision' && p.origen !== 'manual' && p.motivo).map(p => p.motivo);
    if (pack.valor == null && bulto.valor == null) {
      revisar.push({ cod, nombre, motivos: motivos.length ? motivos : ['sin precio'], respaldo: false });
      continue;
    }
    if (motivos.length) revisar.push({ cod, nombre, motivos, respaldo: pack.origen === 'respaldo' || bulto.origen === 'respaldo' });
    if (pack.valor != null && bulto.valor != null && bulto.valor > pack.valor) avisos.push(`${cod} ${nombre}: precio bulto (${bulto.valor}) mayor que pack (${pack.valor})`);
    filas.push({ cod, seccion: texto(f.seccion) || 'Otros', nombre,
      pack_qty: pack.valor == null ? '' : qPack.valor, pack_price: pack.valor ?? '',
      bulto_qty: bulto.valor == null ? '' : qBulto.valor, bulto_price: bulto.valor ?? '',
      origen: { pack: pack.origen, bulto: bulto.origen }, modoPack: modo, ...(pack.descuento ? { descuento: pack.descuento } : {}) });
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
  const nuevos = actuales.filter(f => !antes.has(String(f.cod))).map(f => ({ cod: f.cod, nombre: f.nombre }));
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
const PRECIO_MANUAL = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined);
function validarFila(f, i) {
  const o = objeto(f);
  const cod = texto(o.cod), seccion = texto(o.seccion), nombre = texto(o.nombre);
  const err = m => { throw new Error(`Fila ${i + 1}: ${m}`); };
  if (!cod || cod.length > 40) err('cod requerido (hasta 40 caracteres)');
  if (!seccion || seccion.length > MAX_TEXTO) err('sección requerida');
  if (!nombre || nombre.length > MAX_TEXTO) err('nombre requerido');
  const manual = o.manual === true;
  if (!manual && !PLU.test(cod)) err('cod no numérico: sólo en filas manuales');
  const fila = { cod, seccion, nombre, packQty: texto(o.packQty).slice(0, 40), bultoQty: texto(o.bultoQty).slice(0, 40), incluido: o.incluido !== false };
  for (const t of ['pack', 'bulto']) {
    const plu = texto(o[`${t}Plu`]);
    if (plu && !PLU.test(plu)) err(`${t}Plu inválido`);
    if (plu && !manual) fila[`${t}Plu`] = plu;
  }
  if (!manual) {
    const modo = texto(o.modoPack) || 'plu';
    if (!MODOS_PACK.includes(modo)) err('modoPack inválido (plu, descuento o ninguno)');
    fila.modoPack = modo;
    if (modo === 'descuento') {
      const d = Number(texto(o.descuentoPack).replace(',', '.'));
      if (texto(o.descuentoPack) === '' || !Number.isFinite(d) || d <= 0 || d >= 100) err('descuentoPack inválido (porcentaje mayor que 0 y menor que 100)');
      fila.descuentoPack = d;
    }
  }
  if (manual) {
    const packPrice = PRECIO_MANUAL(o.packPrice), bultoPrice = PRECIO_MANUAL(o.bultoPrice);
    if (packPrice === undefined || bultoPrice === undefined) err('precio manual inválido (entero > 0 o vacío)');
    if (packPrice == null && bultoPrice == null) err('fila manual sin precio');
    Object.assign(fila, { manual: true, packPrice, bultoPrice });
  }
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
// sistema (Codigo Pack/Bulto como vínculo explícito si vienen); cod no numérico = manual con los precios de la planilla.
// planilla = precios del Excel: respaldo hasta la primera exportación y base de la comparación.
function filasDesdePlanilla(rows) {
  const filas = [], descartadas = [];
  (rows || []).forEach((r, i) => {
    const cod = texto(r.cod), nombre = texto(r.nombre);
    if (!cod || !nombre) { descartadas.push(i + 2); return; }
    const manual = !PLU.test(cod);
    const precio = v => (texto(v) === '' ? '' : Math.round(Number(v)) || '');
    const fila = { cod, seccion: texto(r.seccion) || 'Otros', nombre, packQty: texto(r.pack_qty), bultoQty: texto(r.bulto_qty), incluido: true,
      planilla: { pack_price: precio(r.pack_price), bulto_price: precio(r.bulto_price) } };
    if (manual) Object.assign(fila, { manual: true, packPrice: precio(r.pack_price) || null, bultoPrice: precio(r.bulto_price) || null });
    else {
      if (PLU.test(texto(r['Codigo Pack']))) fila.packPlu = texto(r['Codigo Pack']);
      if (PLU.test(texto(r['Codigo Bulto']))) fila.bultoPlu = texto(r['Codigo Bulto']);
      fila.modoPack = fila.packPlu || fila.planilla.pack_price !== '' ? 'plu' : 'ninguno'; // nunca inventa descuentos
    }
    filas.push(fila);
  });
  return { filas, descartadas };
}

const conCantidad = (f, t) => (t === 'bulto' || modoPack(f) === 'plu') && !!normalizarCantidad(f[`${t}Qty`]).valor;

// Vinculación de cada fila no manual: explícita, automática o sin vincular (por columna con cantidad).
function resumenVinculos(filas, indice) {
  const sinVincular = [];
  let vinculados = 0;
  for (const f of filas.filter(x => !x.manual)) {
    const faltan = ['pack', 'bulto'].filter(t => conCantidad(f, t) && !pluVinculado(f, t, indice));
    if (faltan.length) sinVincular.push({ cod: f.cod, nombre: f.nombre, faltan }); else vinculados++;
  }
  return { vinculados, sinVincular, manuales: filas.filter(x => x.manual).length };
}

// Completa packPlu/bultoPlu faltantes con pluVinculado (SIGA o presentación mayorista). Sin mutar.
function autocompletarVinculos(filas, indice) {
  const completadas = [];
  const sinVincular = [];
  const nuevas = filas.map(f => {
    if (f.manual) return f;
    const out = { ...f };
    const faltan = [];
    for (const t of ['pack', 'bulto']) {
      if (!conCantidad(f, t) || texto(f[`${t}Plu`])) continue;
      const plu = pluVinculado(f, t, indice, { conPresentaciones: true });
      if (plu) { out[`${t}Plu`] = plu; completadas.push({ cod: f.cod, nombre: f.nombre, tipo: t, plu }); } else faltan.push(t);
    }
    if (faltan.length) sinVincular.push({ cod: f.cod, nombre: f.nombre, faltan });
    return out;
  });
  return { filas: nuevas, completadas, sinVincular };
}

// Comparación (diagnóstico) sistema vs planilla: decidido o, si no hay, sugerido (marcado). Sólo filas no manuales.
function compararConPlanilla(filas, indice) {
  const det = [];
  for (const f of filas.filter(x => !x.manual && x.planilla)) {
    for (const t of ['pack', 'bulto']) {
      const modo = t === 'pack' ? modoPack(f) : 'plu';
      if (modo === 'ninguno') continue;
      const excel = Number(f.planilla[`${t}_price`]) || null;
      const desc = modo === 'descuento' ? precioDescuento(f, indice) : null;
      const plu = desc ? null : pluVinculado(f, t, indice);
      const m = plu ? indice.get(plu) : null;
      const sistema = desc ? desc.valor : m ? redondear(m.decidido ?? m.sugerido) : null;
      if (excel == null && sistema == null) continue;
      const origen = desc ? (desc.valor != null ? 'descuento' : null) : !m ? null : m.decidido != null ? 'decision' : m.sugerido != null ? `sugerido (${m.fuenteSugerido})` : null;
      const pct = excel && sistema ? Math.round(((sistema - excel) / excel) * 1000) / 10 : null;
      det.push({ cod: f.cod, nombre: f.nombre, tipo: t, plu, excel, sistema, origen, pct,
        estado: excel == null || sistema == null ? 'sin dato' : sistema === excel ? 'igual' : 'difiere' });
    }
  }
  const cuenta = e => det.filter(d => d.estado === e).length;
  return { iguales: cuenta('igual'), difieren: cuenta('difiere'), sinDato: cuenta('sin dato'),
    conDecision: det.filter(d => d.origen === 'decision').length, detalle: det };
}

module.exports = {
  COLUMNAS, MODOS_PACK, SUBIDA_DEFECTO, normalizarCantidad, indicePrecios, pluVinculado, armarCatalogo, generarCsv, parsearCsv, sha256,
  isoLocal, generarVersion, diffCatalogo, validarTabla, validarSubida, comandosSubida, filasDesdePlanilla, resumenVinculos, autocompletarVinculos,
  compararConPlanilla, filasExportarCodigos, FTP_PLANTILLA, normalizarFtp, ftpPublico, mensajeFtp, redactar,
};
