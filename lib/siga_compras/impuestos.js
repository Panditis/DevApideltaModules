'use strict';
// Filas de ComprasImpuestos, totales de cabecera y ProporcionalImp de SiGA. Puro: sin SQL ni fs.
// Fuente: docs/siga_compras_carga_descompilado.md (DOC). Coeficiente 1: la v1 no importa notas de crédito.
const C = require('./constantes');
const { redondear, sinRuido } = require('./lineas');

// DOC Parte I §5.1 (ReCalculaImpuestos L23925-23950): una fila IVA por alícuota; el IVA se redondea POR LÍNEA y
// después se suma. Bruto = importe antes del desc./rec. general; BaseImponible = después.
// Orden de las filas = primera aparición de cada alícuota (FirstOrDefault sobre la lista).
function filasIVA(lineas, decimalesPrecio) {
  const acumulado = lineas.reduce((mapa, l) => {
    const alicuota = Number(l.porcentajeIVA) || 0;
    const previa = mapa.get(alicuota) || { bruto: 0, baseImponible: 0, importe: 0 };
    return new Map(mapa).set(alicuota, {
      bruto: previa.bruto + redondear(l.importeTotal, decimalesPrecio),
      baseImponible: previa.baseImponible + redondear(l.importeTotal + l.descRecGeneral, decimalesPrecio),
      importe: previa.importe + redondear(l.iva, decimalesPrecio),
    });
  }, new Map());
  return [...acumulado.entries()].map(([alicuota, s]) => ({
    idTipoImpuesto: 'IVA', tipoTipoImpuesto: C.TIPO_TIPO_IMPUESTO.IVA, idProvincia: null, alicuota,
    bruto: sinRuido(s.bruto), baseImponible: sinRuido(s.baseImponible), importe: sinRuido(s.importe),
  }));
}

// DOC Parte I §5.2 (L23466-23515): PIIBB (una por provincia, con base y alícuota), PGANA, PIVA, PVAR (solo
// Importe) e IMINT (TipoTipoImpuesto INTERNO), en ese orden. Bruto queda en 0.
function filasPercepciones(percepciones) {
  const lista = Array.isArray(percepciones) ? percepciones : [];
  return C.TIPOS_PERCEPCION.flatMap(tipo => lista.filter(p => p && p.tipo === tipo).map(p => {
    const esIIBB = tipo === 'PIIBB';
    return {
      idTipoImpuesto: tipo, tipoTipoImpuesto: C.TIPO_TIPO_IMPUESTO[tipo],
      idProvincia: esIIBB ? (String(p.idProvincia || '').trim() || null) : null,
      alicuota: esIIBB ? Number(p.alicuota) || 0 : 0,
      bruto: 0,
      baseImponible: esIIBB ? sinRuido(Number(p.baseImponible) || 0) : 0,
      importe: sinRuido(Number(p.importe) || 0),
    };
  }));
}

// DOC Parte III §4.1 (C L2128-2151): se graban solo las filas con BaseImponible + Importe != 0, con Orden 1..n
// solo entre las grabadas.
function filasImpuestos({ lineas, percepciones, decimalesPrecio = C.DEFAULTS_PARAMETROS.decimalesPrecio }) {
  return [...filasIVA(lineas, decimalesPrecio), ...filasPercepciones(percepciones)]
    .filter(f => sinRuido(f.baseImponible + f.importe) !== 0)
    .map((f, i) => ({ ...f, orden: i + 1 }));
}

// DOC Parte I §6.2 / Parte II §3.1 (C L2017-2035): PERCEPCION → TotalPercepciones; el resto salvo INTERNO →
// Bruto, Neto e IVA. IMINT no suma a ningún total (va aparte en Compras.ImpuestosInternos).
function totalesCabecera(filas) {
  const suma = (filtro, campo) => sinRuido(filas.filter(filtro).reduce((s, f) => s + f[campo], 0));
  const esIVA = f => f.tipoTipoImpuesto !== 'PERCEPCION' && f.tipoTipoImpuesto !== 'INTERNO';
  return {
    totalBruto: suma(esIVA, 'bruto'),
    totalNeto: suma(esIVA, 'baseImponible'),
    totalIVA: suma(esIVA, 'importe'),
    totalPercepciones: suma(f => f.tipoTipoImpuesto === 'PERCEPCION', 'importe'),
    impuestosInternos: suma(f => f.tipoTipoImpuesto === 'INTERNO', 'importe'),
  };
}

// DOC Parte I §6.1-§6.2: Neto + IVA + Percepciones + ImpInternos (retenciones: 0 en v1), parseado del texto
// formateado a ComprasDecimalesEnTotalGeneral. SIGA-INFERIDO: el formato de .NET redondea "lejos del cero";
// con sumandos de 2 decimales y decimalesTotal >= 2 no hay punto medio, así que coincide con redondear().
function importeTotal(totales, decimalesTotal = C.DEFAULTS_PARAMETROS.decimalesTotal) {
  return redondear(totales.totalNeto + totales.totalIVA + totales.totalPercepciones + totales.impuestosInternos, decimalesTotal);
}

// DOC Parte I §5.2 (L23384-23388): percepciones de cabecera de Compras y MovimientosStock, un total por tipo.
function percepcionesCabecera(percepciones) {
  const lista = Array.isArray(percepciones) ? percepciones : [];
  const deTipo = tipo => sinRuido(lista.filter(p => p && p.tipo === tipo).reduce((s, p) => s + (Number(p.importe) || 0), 0));
  return {
    percepcionIVA: deTipo('PIVA'), percepcionIB: deTipo('PIIBB'), percepcionGanancias: deTipo('PGANA'),
    percepcionVarias: deTipo('PVAR'), impuestosInternos: deTipo('IMINT'),
  };
}

// DOC Parte II §3.3 (C L2086-2107): (|ImporteTotal| − Σ(neto + ROUND(iva, 2))) × ROUND((neto + iva) / Σ, 2).
// Nadie absorbe la diferencia y el resultado no se redondea: el producto de dos números de 2 decimales tiene 4,
// sinRuido solo limpia el float. Reproduce 955,19 × 0,92 = 878,7748 y × 0,08 = 76,4152.
function proporcionalImp(lineas, total) {
  const base = sinRuido(lineas.reduce((s, l) => s + l.importeTotalNeto + redondear(l.iva, 2), 0));
  const resto = sinRuido(Math.abs(total) - base);
  return lineas.map(l => (base !== 0 ? sinRuido(resto * redondear((l.importeTotalNeto + l.iva) / base, 2)) : 0));
}

// DOC Parte II §3.3 (C L2100-2107).
function montoSaldo(linea, proporcional, pasajeIncluyeImpuestos) {
  return pasajeIncluyeImpuestos ? sinRuido(linea.importeTotalNeto + linea.iva + proporcional) : linea.importeTotalNeto;
}

module.exports = { filasImpuestos, totalesCabecera, importeTotal, percepcionesCabecera, proporcionalImp, montoSaldo };
