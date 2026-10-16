'use strict';
// Fechas de la carga de compras de SiGA. Puro. El server corre en hora argentina: se usan getters locales.
// Fuente: docs/siga_compras_carga_descompilado.md (DOC).

const dos = n => String(n).padStart(2, '0');

// 'YYYY-MM-DD' local de un Date.
function fechaLocalISO(d) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

// DOC Parte III §2.1 columna 6: Compras.Fecha conserva la hora. SIGA-INFERIDO: dtpFecha nace en DateTime.Now
// (Nuevo(), DOC Parte I §1.3) y el usuario cambia solo el día, así que la hora es la del momento de cargar.
function fechaHoraComprobante(fechaISO, ahora) {
  const [a, m, d] = String(fechaISO).split('-').map(Number);
  return new Date(a, m - 1, d, ahora.getHours(), ahora.getMinutes(), ahora.getSeconds());
}

// DOC Parte II §3.4 (CCP L236-239): si el comprobante es de hoy, la cta. cte. lleva la hora de grabación.
function fechaCtaCte(fechaComprobante, ahora) {
  return fechaLocalISO(fechaComprobante) === fechaLocalISO(ahora) ? ahora : fechaComprobante;
}

// DOC Parte II §3.4 (ME L431): FechaVencimiento = DateAdd("d", FormaPago.Dias, Compra.Fecha). Conserva la hora.
function vencimiento(fechaComprobante, dias) {
  const d = new Date(fechaComprobante.getTime());
  d.setDate(d.getDate() + (Number(dias) || 0));
  return d;
}

// DOC Parte I §8.1: sin GrabaLibro, PeriodoFiscal = yyyyMM de la fecha.
function periodoDeFecha(fechaISO) {
  return Number(String(fechaISO).slice(0, 7).replace('-', ''));
}

// DOC Parte I §8.1 / Parte III §2.1 columna 23: con GrabaLibro, el período elegido en el combo; si no, el de la fecha.
function periodoFiscalDe(borrador, tipo) {
  return tipo && tipo.grabaLibro ? Number(borrador.periodoFiscal) || 0 : periodoDeFecha(borrador.fecha);
}

// DOC Anexo (Comunes.ObtenerFecha): literal 'AAAAMMDD HH:mm:ss'. Se pasa como parámetro varchar: SQL Server lo
// convierte a datetime sin depender del DATEFORMAT ni del huso horario del driver.
function fechaSiga(d) {
  return `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

module.exports = { fechaLocalISO, fechaHoraComprobante, fechaCtaCte, vencimiento, periodoDeFecha, periodoFiscalDe, fechaSiga };
