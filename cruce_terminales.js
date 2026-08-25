'use strict';
// Cruce de terminales: toma las bajadas de las plataformas de cobro (Payway y QR) y
// les asigna la sucursal según el número de terminal, usando el mapa que sale del
// xlsx "Distribucion Terminales por sucursal".
// Módulo de cálculo puro: sin fs, sin SQL, sin express. El xlsx entra ya parseado
// como matriz de filas (lo que devuelve sheet_to_json con header:1).

// ── Normalización ─────────────────────────────────────────────────────────────
const SIN_SUCURSAL = { id: null, nombre: 'Sin identificar' };

function sinAcentos(txt) {
  return String(txt ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function norm(txt) {
  return sinAcentos(txt).trim().toUpperCase();
}

// Los identificadores (terminal, establecimiento) vienen como texto en el xlsx y como
// texto entrecomillado en el CSV. Se comparan como dígitos sin ceros a la izquierda
// para que "016826094" y "16826094" sean la misma terminal.
function claveId(valor) {
  const soloDigitos = String(valor ?? '').replace(/\D/g, '');
  if (!soloDigitos) return '';
  return soloDigitos.replace(/^0+(?=\d)/, '');
}

// "$ 28.746,98" | "$ 28746.98" | "13183.74" → 28746.98
function montoANumero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  let txt = String(valor ?? '').replace(/[^\d,.\-]/g, '').trim();
  if (!txt) return 0;
  const ultimaComa = txt.lastIndexOf(',');
  const ultimoPunto = txt.lastIndexOf('.');
  if (ultimaComa >= 0 && ultimaComa > ultimoPunto) {
    // formato es-AR: el separador decimal es la coma
    txt = txt.replace(/\./g, '').replace(',', '.');
  } else {
    txt = txt.replace(/,/g, '');
  }
  const n = Number(txt);
  return Number.isFinite(n) ? n : 0;
}

// "07/08/2026" → "2026-08-07". Deja pasar lo que ya viene en ISO.
function fechaAISO(valor) {
  const txt = String(valor ?? '').trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(txt);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(txt);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return '';
}

// Único criterio de aprobación: el estado que informa la plataforma. Cualquier otra
// cosa (Rechazado, Anulado, Denegado, Pendiente, vacío) cae en "no aprobado" para que
// nada se pierda por un estado nuevo que no conocemos.
function esAprobado(estado) {
  return norm(estado) === 'APROBADO';
}

// ── Parser CSV ────────────────────────────────────────────────────────────────
// Las bajadas vienen delimitadas por punto y coma y con los campos entrecomillados
// (Payway) o sin comillas (QR). Se contemplan comillas dobles escapadas ("").
function parseCSV(texto, delimitador = ';') {
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  const src = String(texto ?? '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (enComillas) {
      if (c === '"') {
        if (src[i + 1] === '"') { campo += '"'; i++; } else { enComillas = false; }
      } else campo += c;
      continue;
    }
    if (c === '"') { enComillas = true; continue; }
    if (c === delimitador) { fila.push(campo); campo = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      filas.push(fila); fila = [];
      continue;
    }
    campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(v => String(v).trim() !== ''));
}

// ── Detección de plataforma ───────────────────────────────────────────────────
// Payway trae una línea de título antes del encabezado y QR una línea en blanco, así
// que el encabezado no siempre es la primera fila: se busca por sus columnas.
const COLUMNAS_PAYWAY = ['TERMINAL', 'ESTABLECIMIENTO', 'ESTADO'];
const COLUMNAS_QR = ['TERMINAL LOGICA', 'ESTADO'];

function indiceEncabezado(filas, columnas) {
  const limite = Math.min(filas.length, 15); // el encabezado siempre está arriba de todo
  for (let i = 0; i < limite; i++) {
    const cols = (filas[i] || []).map(norm);
    if (columnas.every(c => cols.includes(c))) return i;
  }
  return -1;
}

function detectarPlataforma(filas) {
  if (indiceEncabezado(filas, COLUMNAS_QR) >= 0) return 'qr';
  if (indiceEncabezado(filas, COLUMNAS_PAYWAY) >= 0) return 'payway';
  return null;
}

// Convierte las filas en objetos {COLUMNA: valor} usando la fila de encabezado hallada.
function filasComoObjetos(filas, columnas) {
  const idx = indiceEncabezado(filas, columnas);
  if (idx < 0) return [];
  const encabezado = filas[idx].map(norm);
  return filas.slice(idx + 1)
    .map(f => {
      const obj = {};
      encabezado.forEach((col, i) => { if (col) obj[col] = f[i] ?? ''; });
      return obj;
    })
    // La última fila de estas bajadas suele ser un total sin estado.
    .filter(o => String(o.ESTADO ?? '').trim() !== '');
}

// ── Mapa de terminales (xlsx de distribución) ─────────────────────────────────
// Layout del xlsx: una fila con los nombres de sucursal (celdas combinadas, por eso
// se arrastra el último nombre visto hacia la derecha), debajo la fila "ID TERMINAL"
// con una terminal por columna y, más abajo, una fila por marca con el número de
// establecimiento de cada columna.
const FILA_TERMINALES = 'ID TERMINAL';
const MARCA_ESTABLECIMIENTOS = 'ESTABLECIMIENTOS:';

// "URQUIZA - (2)" → { id: 2, nombre: 'URQUIZA' } · "SAN PEDRO   (7)" → { id: 7, nombre: 'SAN PEDRO' }
function parseNombreSucursal(celda) {
  const txt = String(celda ?? '').replace(/\s+/g, ' ').trim();
  if (!txt) return null;
  const m = /\((\d+)\)\s*$/.exec(txt);
  const id = m ? Number(m[1]) : null;
  const nombre = txt.replace(/\(\d+\)\s*$/, '').replace(/[-–]\s*$/, '').trim();
  return { id, nombre: nombre || txt };
}

function parseMapaTerminales(filas) {
  const grilla = Array.isArray(filas) ? filas : [];
  const filaTerm = grilla.findIndex(f => norm(f && f[0]) === FILA_TERMINALES);
  if (filaTerm < 0) {
    throw new Error(`El xlsx no tiene la fila "${FILA_TERMINALES}": no se puede armar el mapa de terminales.`);
  }
  // La fila de sucursales es la última fila no vacía por encima de "ID TERMINAL".
  let filaSuc = -1;
  for (let i = filaTerm - 1; i >= 0; i--) {
    const conDatos = (grilla[i] || []).slice(1).some(v => String(v ?? '').trim() !== '');
    if (conDatos) { filaSuc = i; break; }
  }
  if (filaSuc < 0) throw new Error('El xlsx no tiene la fila de sucursales arriba de "ID TERMINAL".');

  // Celdas combinadas: cada nombre de sucursal vale hasta que aparece el siguiente.
  const porColumna = [];
  let actual = null;
  const anchoMax = Math.max((grilla[filaSuc] || []).length, (grilla[filaTerm] || []).length);
  for (let col = 1; col < anchoMax; col++) {
    const parsed = parseNombreSucursal((grilla[filaSuc] || [])[col]);
    if (parsed) actual = parsed;
    porColumna[col] = actual;
  }

  const terminales = new Map();   // claveId(terminal) → sucursal
  const sucursales = new Map();   // id|nombre → { id, nombre, terminales: [] }
  const claveSuc = s => (s.id != null ? `id:${s.id}` : `nom:${norm(s.nombre)}`);

  for (let col = 1; col < anchoMax; col++) {
    const term = claveId((grilla[filaTerm] || [])[col]);
    const suc = porColumna[col];
    if (!term || !suc) continue;
    const k = claveSuc(suc);
    if (!sucursales.has(k)) sucursales.set(k, { id: suc.id, nombre: suc.nombre, terminales: [] });
    sucursales.get(k).terminales.push(term);
    terminales.set(term, { id: suc.id, nombre: suc.nombre });
  }

  // Establecimientos: fallback cuando la terminal del comprobante no está en el mapa.
  // Un mismo establecimiento se repite en columnas de la misma sucursal (no molesta);
  // si apareciera en dos sucursales distintas se descarta por ambiguo.
  const establecimientos = new Map();
  const ambiguos = new Set();
  const filaMarcas = grilla.findIndex(f => norm(f && f[0]) === MARCA_ESTABLECIMIENTOS);
  if (filaMarcas >= 0) {
    for (let i = filaMarcas + 1; i < grilla.length; i++) {
      const fila = grilla[i] || [];
      if (!String(fila[0] ?? '').trim()) continue;
      for (let col = 1; col < anchoMax; col++) {
        const est = claveId(fila[col]);
        const suc = porColumna[col];
        if (!est || !suc) continue;
        const previo = establecimientos.get(est);
        if (previo && claveSuc(previo) !== claveSuc(suc)) { ambiguos.add(est); continue; }
        establecimientos.set(est, { id: suc.id, nombre: suc.nombre });
      }
    }
    for (const est of ambiguos) establecimientos.delete(est);
  }

  if (!terminales.size) throw new Error('El xlsx no tiene ninguna terminal cargada.');

  return {
    terminales: Object.fromEntries(terminales),
    establecimientos: Object.fromEntries(establecimientos),
    sucursales: [...sucursales.values()].sort((a, b) => (a.id ?? 999) - (b.id ?? 999)),
  };
}

function sucursalDe(mapa, terminal, establecimiento) {
  const m = mapa || {};
  const porTerm = (m.terminales || {})[claveId(terminal)];
  if (porTerm) return { ...porTerm, origen: 'terminal' };
  const porEst = (m.establecimientos || {})[claveId(establecimiento)];
  if (porEst) return { ...porEst, origen: 'establecimiento' };
  return { ...SIN_SUCURSAL, origen: null };
}

// ── Comprobantes normalizados ─────────────────────────────────────────────────
// Las dos plataformas se llevan a la misma forma para poder resumirlas juntas.
function comprobantesPayway(filas) {
  return filasComoObjetos(filas, COLUMNAS_PAYWAY).map(o => ({
    plataforma: 'Payway',
    fecha: fechaAISO(o.FECHA),
    terminal: claveId(o.TERMINAL),
    establecimiento: claveId(o.ESTABLECIMIENTO),
    medio: [o.TIPO, o.MARCA].filter(x => String(x ?? '').trim()).join(' · '),
    tarjeta: String(o['NRO.TARJETA'] ?? '').trim(),
    cuotas: String(o.CUOTAS ?? '').trim(),
    comprobante: String(o['NRO.CUPON'] ?? '').trim(),
    autorizacion: String(o['NRO.AUTORIZACION'] ?? '').trim(),
    monto: montoANumero(o.MONTO_BRUTO),
    estado: String(o.ESTADO ?? '').trim(),
    aprobado: esAprobado(o.ESTADO),
  }));
}

function comprobantesQR(filas) {
  return filasComoObjetos(filas, COLUMNAS_QR).map(o => ({
    plataforma: 'QR',
    fecha: fechaAISO(o.FECHA),
    terminal: claveId(o['TERMINAL LOGICA'] || o.TID),
    establecimiento: '',
    medio: [o['MEDIO DE PAGO'], o.BILLETERA].filter(x => String(x ?? '').trim()).join(' · '),
    tarjeta: String(o['NRO TARJETA'] ?? '').trim(),
    cuotas: '',
    comprobante: String(o['QR ID'] ?? '').trim(),
    autorizacion: '',
    puntoVenta: String(o['PUNTO DE VENTA'] ?? '').trim(),
    monto: montoANumero(o.MONTO),
    estado: String(o.ESTADO ?? '').trim(),
    aprobado: esAprobado(o.ESTADO),
  }));
}

// Un archivo → sus comprobantes, con la plataforma detectada por encabezado.
function comprobantesDeArchivo(texto, nombreArchivo = '') {
  const filas = parseCSV(texto);
  const plataforma = detectarPlataforma(filas);
  if (!plataforma) {
    throw new Error(`No reconozco el formato de "${nombreArchivo || 'el archivo'}": no encontré el encabezado de Payway ni el de QR.`);
  }
  const comprobantes = plataforma === 'qr' ? comprobantesQR(filas) : comprobantesPayway(filas);
  return { plataforma, comprobantes: comprobantes.map(c => ({ ...c, archivo: nombreArchivo })) };
}

// ── Clasificación y resumen ───────────────────────────────────────────────────
function clasificar(comprobantes, mapa) {
  return (comprobantes || []).map(c => {
    const suc = sucursalDe(mapa, c.terminal, c.establecimiento);
    return {
      ...c,
      sucursalId: suc.id,
      sucursal: suc.nombre,
      identificada: suc.origen != null,
      origenSucursal: suc.origen,
    };
  });
}

function celdaResumen() {
  return { cantidad: 0, monto: 0 };
}

function sumar(celda, monto) {
  celda.cantidad += 1;
  celda.monto += monto;
}

const redondear = celda => ({ cantidad: celda.cantidad, monto: Math.round(celda.monto * 100) / 100 });

// Resumen por sucursal y, dentro de cada una, por plataforma. Los montos se redondean
// a 2 decimales recién al final para no arrastrar el error del punto flotante.
function resumenPorSucursal(detalle) {
  const porSuc = new Map();
  for (const c of detalle || []) {
    const clave = c.sucursalId != null ? `id:${c.sucursalId}` : `nom:${norm(c.sucursal)}`;
    if (!porSuc.has(clave)) {
      porSuc.set(clave, {
        sucursalId: c.sucursalId,
        sucursal: c.sucursal,
        aprobados: celdaResumen(),
        noAprobados: celdaResumen(),
        total: celdaResumen(),
        plataformas: new Map(),
      });
    }
    const r = porSuc.get(clave);
    if (!r.plataformas.has(c.plataforma)) {
      r.plataformas.set(c.plataforma, { plataforma: c.plataforma, aprobados: celdaResumen(), noAprobados: celdaResumen() });
    }
    const p = r.plataformas.get(c.plataforma);
    const destino = c.aprobado ? 'aprobados' : 'noAprobados';
    sumar(r[destino], c.monto);
    sumar(r.total, c.monto);
    sumar(p[destino], c.monto);
  }
  return [...porSuc.values()]
    .map(r => ({
      sucursalId: r.sucursalId,
      sucursal: r.sucursal,
      aprobados: redondear(r.aprobados),
      noAprobados: redondear(r.noAprobados),
      total: redondear(r.total),
      plataformas: [...r.plataformas.values()]
        .map(p => ({ plataforma: p.plataforma, aprobados: redondear(p.aprobados), noAprobados: redondear(p.noAprobados) }))
        .sort((a, b) => a.plataforma.localeCompare(b.plataforma)),
    }))
    // Las sucursales identificadas van primero por número; "Sin identificar" al final.
    .sort((a, b) => (a.sucursalId ?? Infinity) - (b.sucursalId ?? Infinity) || a.sucursal.localeCompare(b.sucursal));
}

function totalesGenerales(detalle) {
  const aprobados = celdaResumen();
  const noAprobados = celdaResumen();
  let sinIdentificar = 0;
  for (const c of detalle || []) {
    sumar(c.aprobado ? aprobados : noAprobados, c.monto);
    if (!c.identificada) sinIdentificar += 1;
  }
  return {
    comprobantes: (detalle || []).length,
    aprobados: redondear(aprobados),
    noAprobados: redondear(noAprobados),
    sinIdentificar,
  };
}

// Rango de fechas cubierto por la bajada, para mostrarlo en pantalla y en el xlsx.
function rangoFechas(detalle) {
  const fechas = (detalle || []).map(c => c.fecha).filter(Boolean).sort();
  return { desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null };
}

// Terminales que aparecieron en las bajadas y no están en el mapa: son las que hay que
// dar de alta en el xlsx de distribución.
function terminalesDesconocidas(detalle) {
  const porTerm = new Map();
  for (const c of detalle || []) {
    if (c.identificada) continue;
    const clave = `${c.terminal || '—'}|${c.establecimiento || ''}`;
    if (!porTerm.has(clave)) {
      porTerm.set(clave, { terminal: c.terminal || '', establecimiento: c.establecimiento || '', plataforma: c.plataforma, cantidad: 0, monto: 0 });
    }
    const t = porTerm.get(clave);
    t.cantidad += 1;
    t.monto += c.monto;
  }
  return [...porTerm.values()]
    .map(t => ({ ...t, monto: Math.round(t.monto * 100) / 100 }))
    .sort((a, b) => b.cantidad - a.cantidad);
}

// ── Cobros duplicados entre plataformas ───────────────────────────────────────
// Un mismo cobro con tarjeta puede bajar en las dos plataformas: el QR lo informa como
// venta con tarjeta y Payway lo trae otra vez en la bajada de terminales. Se cruzan por
// día + terminal + monto + los dígitos visibles del número de tarjeta y sobrevive sólo
// el registro de QR. Sin dígitos visibles (transferencias) no hay con qué identificar el
// caso, así que esas filas no se cruzan nunca.
function digitosTarjeta(tarjeta) {
  return String(tarjeta ?? '').replace(/\D/g, '');
}

function claveDuplicado(c) {
  const digitos = digitosTarjeta(c.tarjeta);
  if (!digitos) return '';
  return [c.fecha, c.terminal, (Number(c.monto) || 0).toFixed(2), digitos].join('|');
}

// El descarte es 1 a 1: si una clave tiene 2 comprobantes de QR y 3 de Payway, se
// descartan 2 de Payway y el tercero queda, porque es un cobro más que existió.
function separarDuplicados(detalle) {
  const lista = detalle || [];
  const disponiblesQR = new Map();
  for (const c of lista) {
    if (c.plataforma !== 'QR') continue;
    const k = claveDuplicado(c);
    if (!k) continue;
    if (!disponiblesQR.has(k)) disponiblesQR.set(k, []);
    disponiblesQR.get(k).push(c);
  }

  const usados = new Map(); // clave → cuántos comprobantes de QR ya se aparearon
  const detalleFiltrado = [];
  const duplicados = [];
  for (const c of lista) {
    const k = c.plataforma === 'QR' ? '' : claveDuplicado(c);
    const pares = k ? (disponiblesQR.get(k) || []) : [];
    const usadosK = usados.get(k) || 0;
    if (!pares.length || usadosK >= pares.length) { detalleFiltrado.push(c); continue; }
    const qr = pares[usadosK];
    usados.set(k, usadosK + 1);
    duplicados.push({
      fecha: c.fecha,
      terminal: c.terminal,
      sucursalId: qr.sucursalId,
      sucursal: qr.sucursal,
      monto: Math.round((Number(c.monto) || 0) * 100) / 100,
      tarjeta: digitosTarjeta(c.tarjeta),
      qrComprobante: qr.comprobante,
      qrMedio: qr.medio,
      qrEstado: qr.estado,
      qrArchivo: qr.archivo,
      descartadaPlataforma: c.plataforma,
      descartadoComprobante: c.comprobante,
      descartadoAutorizacion: c.autorizacion,
      descartadoMedio: c.medio,
      descartadoEstado: c.estado,
      descartadoArchivo: c.archivo,
    });
  }
  return { detalle: detalleFiltrado, duplicados };
}

// Punto de entrada: archivos [{ nombre, texto }] + mapa → resultado completo.
function procesarArchivos(archivos, mapa) {
  const lista = Array.isArray(archivos) ? archivos : [];
  if (!lista.length) throw new Error('No llegó ningún archivo para procesar.');
  const resumenArchivos = [];
  const comprobantes = [];
  for (const a of lista) {
    const { plataforma, comprobantes: cs } = comprobantesDeArchivo(a.texto, a.nombre);
    resumenArchivos.push({ nombre: a.nombre, plataforma, comprobantes: cs.length });
    comprobantes.push(...cs);
  }
  const { detalle, duplicados } = separarDuplicados(clasificar(comprobantes, mapa));
  return {
    archivos: resumenArchivos,
    detalle,
    duplicados,
    resumen: resumenPorSucursal(detalle),
    totales: totalesGenerales(detalle),
    rango: rangoFechas(detalle),
    desconocidas: terminalesDesconocidas(detalle),
  };
}

module.exports = {
  SIN_SUCURSAL,
  norm, claveId, montoANumero, fechaAISO, esAprobado,
  parseCSV, detectarPlataforma, filasComoObjetos,
  parseNombreSucursal, parseMapaTerminales, sucursalDe,
  comprobantesPayway, comprobantesQR, comprobantesDeArchivo,
  clasificar, resumenPorSucursal, totalesGenerales, rangoFechas,
  terminalesDesconocidas, claveDuplicado, separarDuplicados, procesarArchivos,
};
