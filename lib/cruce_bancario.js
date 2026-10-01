'use strict';
// Cruce bancario: ubica cada movimiento de la bajada del banco (xls) en un ticket de SIGA
// por importe + hora, y de ahí saca la sucursal.
// Módulo de cálculo puro: sin fs, sin SQL, sin express. La grilla entra ya leída
// (sheet_to_json con header:1 y raw:true) y los tickets entran como filas de la consulta.
const { montoANumero, norm } = require('./cruce_terminales');

const TOL_MONTO_DEFAULT = 5;        // pesos
const TOL_MIN_DEFAULT = 3;          // minutos (en el caso real los desfases llegaron a 145 s)
// Topes de tolerancia: el costo del cruce crece con la ventana (tickets × movimientos), así
// que sin tope un valor enorme en el formulario agota la memoria del server.
const TOL_MONTO_MAX = 100;          // pesos
const TOL_MIN_MAX = 15;             // minutos
const MAX_OTROS_CANDIDATOS = 10;    // SheetJS no escribe celdas de más de 32767 caracteres
// Movimientos a atender que viajan en el resumen de la pantalla: una bajada real tiene un puñado y
// el tope acota la respuesta ante un archivo con miles. El xlsx trae todos los movimientos igual.
const MAX_ATENCION = 200;
// Movimientos sin ticket dentro de la ventana de un mismo ticket: pasado este tope no se buscan
// pagos divididos en esa ventana (las parejas crecen con el cuadrado y una bajada real tiene un
// puñado). Cota contra un archivo armado para agotar el CPU del server compartido.
const MAX_VENTANA_PAGO_DIVIDIDO = 200;
const MAX_DIAS = 93;                // tope de rango por archivo (protege la consulta a Ventas)
const FILAS_BUSCA_ENCABEZADO = 15;
const SEGUNDOS_POR_DIA = 86400;
const DIAS_SERIAL_A_EPOCH = 25569;  // 1899-12-30 → 1970-01-01
const SERIAL_EXCEL_MIN = 36526;     // 2000-01-01: por debajo no es una fecha de la bajada
const SERIAL_EXCEL_MAX = 73050;     // 2099-12-31: el total del pie (millones) queda afuera

const RESULTADO = Object.freeze({
  UBICADO: 'UBICADO',
  AMBIGUO: 'AMBIGUO',
  PAGO_DIVIDIDO: 'PAGO DIVIDIDO',
  A_REVISAR: 'A REVISAR',
  SIN_UBICAR: 'SIN UBICAR',
  NO_APLICA: 'NO APLICA',
});

// Error pensado para el usuario (archivo o parámetros inválidos): el router lo devuelve con su
// mensaje. Cualquier otro error es un fallo interno y no se refleja al cliente.
class ErrorCruce extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorCruce';
  }
}

// ── Fecha ─────────────────────────────────────────────────────────────────────
// Fecha sin zona → segundos desde 1970 tomando los componentes tal cual (como UTC). Sólo
// sirve para comparar y restar: la hora de pared del banco y de SIGA no se toca.
function segundosDe(anio, mes, dia, hora, min, seg) {
  if (hora > 23 || min > 59 || seg > 59) return null;
  const ms = Date.UTC(anio, mes - 1, dia, hora, min, seg);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return ms / 1000;
}

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
const RE_DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

// Texto "aaaa-mm-dd hh:mm:ss", "dd/mm/aaaa hh:mm[:ss]" o serial de Excel → segundos; si no
// es una fecha con hora, null. Una fecha sin hora no sirve para cruzar por minuto.
function parseFechaHora(valor) {
  if (typeof valor === 'number') {
    if (!(valor >= SERIAL_EXCEL_MIN && valor <= SERIAL_EXCEL_MAX)) return null;
    return Math.round((valor - DIAS_SERIAL_A_EPOCH) * SEGUNDOS_POR_DIA);
  }
  const txt = String(valor ?? '').trim();
  let m = RE_ISO.exec(txt);
  if (m) return segundosDe(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  m = RE_DMY.exec(txt);
  if (m) return segundosDe(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] || 0));
  return null;
}

function segundosATexto(seg) {
  return new Date(seg * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// ── Columnas y pie ────────────────────────────────────────────────────────────
// "Nº Referencia" → "N REFERENCIA", "Método de pago" → "METODO DE PAGO".
const normEnc = txt => norm(txt).replace(/[º°]/g, '').replace(/\s+/g, ' ').trim();
const texto = v => String(v ?? '').trim();

// Encabezado exacto: "IMPORTE" no debe agarrar "IMPORTE PROPINA".
const ENCABEZADOS = {
  fecha: 'FECHA',
  importe: 'IMPORTE',
  estado: 'ESTADO',
  tipo: 'TIPO',
  marca: 'MARCA TARJETA',
  metodo: 'METODO DE PAGO',
  referencia: 'N REFERENCIA',
  autorizacion: 'N AUTORIZACION',
  terminal: 'ID TERMINAL',
};

function columnasDe(fila) {
  const nombres = (fila || []).map(normEnc);
  const cols = {};
  for (const [campo, encabezado] of Object.entries(ENCABEZADOS)) cols[campo] = nombres.indexOf(encabezado);
  return cols;
}

function ubicarEncabezado(filas) {
  const limite = Math.min(filas.length, FILAS_BUSCA_ENCABEZADO);
  for (let i = 0; i < limite; i++) {
    const cols = columnasDe(filas[i]);
    if (cols.fecha >= 0 && cols.importe >= 0) return { indice: i, cols };
  }
  // Se muestra la primera fila con contenido: si el archivo arranca con filas vacías, la fila 0 no dice nada.
  const primera = filas.slice(0, limite).find(f => (f || []).some(v => texto(v) !== ''));
  const vistos = (primera || []).map(texto).filter(Boolean).join(', ') || '(fila vacía)';
  throw new ErrorCruce(`No encontré las columnas "Fecha" e "Importe" en las primeras filas del archivo. Encabezados leídos: ${vistos}`);
}

// El pie es una tabla aparte: "Moneda | Total bruto | …" y debajo sus valores.
function esEncabezadoPie(fila) {
  const nombres = (fila || []).map(normEnc);
  return nombres[0] === 'MONEDA' && nombres.includes('TOTAL BRUTO');
}

function totalBrutoDePie(filaEncabezado, filaValores) {
  const i = filaEncabezado.map(normEnc).indexOf('TOTAL BRUTO');
  if (i < 0 || !filaValores || texto(filaValores[i]) === '') return null;
  return montoANumero(filaValores[i]);
}

// ── Parse de la bajada ────────────────────────────────────────────────────────
// Devuelve { movimientos, descartadas, totalControl }. Sólo participan del cruce las
// ventas aprobadas con importe positivo (aplica); el resto se conserva para informarlo.
function parseBajada(grilla) {
  const filas = Array.isArray(grilla) ? grilla : [];
  const { indice, cols } = ubicarEncabezado(filas);
  const celda = (f, campo) => (cols[campo] >= 0 ? texto(f[cols[campo]]) : '');
  const movimientos = [];
  let descartadas = 0;
  let totalControl = null;

  for (let i = indice + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (!f.some(v => texto(v) !== '')) continue;
    if (esEncabezadoPie(f)) {
      totalControl = totalBrutoDePie(f, filas[i + 1]);
      break;
    }
    const segundos = parseFechaHora(f[cols.fecha]);
    if (segundos == null) { descartadas += 1; continue; }

    const centavos = Math.round(montoANumero(f[cols.importe]) * 100);
    const estado = celda(f, 'estado');
    const tipo = celda(f, 'tipo');
    const aprobada = cols.estado < 0 || norm(estado) === 'APROBADA';
    const esVenta = cols.tipo < 0 || norm(tipo) === 'VENTA';
    movimientos.push({
      fila: i + 1,
      segundos,
      fecha: segundosATexto(segundos),
      importe: centavos / 100,
      centavos,
      marca: celda(f, 'marca'),
      metodo: celda(f, 'metodo'),
      autorizacion: celda(f, 'autorizacion'),
      referencia: celda(f, 'referencia'),
      terminal: celda(f, 'terminal'),
      estado,
      tipo,
      aplica: aprobada && esVenta && centavos > 0,
    });
  }

  if (!movimientos.length) throw new ErrorCruce('El archivo no tiene movimientos con fecha y hora válidas.');
  return { movimientos, descartadas, totalControl };
}

// ── Tickets de SIGA ───────────────────────────────────────────────────────────
// Filas de sqlTickets → tickets con la fecha ya en segundos. La hora llega como texto
// (CONVERT … 120) justamente para no depender de cómo el driver convierte datetime a Date.
function normalizarTickets(filasSql) {
  const tickets = [];
  (filasSql || []).forEach((r, orden) => {
    const segundos = parseFechaHora(r.FechaTxt);
    const importe = Number(r.ImporteTotal);
    if (segundos == null || !Number.isFinite(importe)) return;
    const centavos = Math.round(importe * 100);
    const tipoLetra = [r.IdTipoComprobante, r.Letra].map(texto).filter(Boolean).join(' ');
    tickets.push({
      orden,
      segundos,
      fecha: segundosATexto(segundos),
      importe: centavos / 100,
      centavos,
      idSucursal: r.IdSucursal ?? null,
      sucursal: texto(r.NombreSucursal),
      etiqueta: `${tipoLetra} ${texto(r.CentroEmisor)}-${texto(r.NumeroComprobante)}`.trim(),
    });
  });
  return tickets;
}

// ── Matching ──────────────────────────────────────────────────────────────────
// Número ≥ 0 (acepta coma decimal); vacío, negativo o no numérico → valor por defecto.
// Un número válido que pasa el máximo no se recorta en silencio: se rechaza.
function tolerancia(valor, porDefecto, max, nombre) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return porDefecto;
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return porDefecto;
  if (n > max) throw new ErrorCruce(`La tolerancia de ${nombre} no puede superar ${max}.`);
  return n;
}

// Tolerancias normalizadas (defaults y topes aplicados). El router la llama antes de leer el
// archivo para fallar rápido; cruzar y rangoConsulta aplican los mismos topes por su cuenta.
function validarTolerancias({ tolMonto, tolMin } = {}) {
  return {
    tolMonto: tolerancia(tolMonto, TOL_MONTO_DEFAULT, TOL_MONTO_MAX, 'importe'),
    tolMin: tolerancia(tolMin, TOL_MIN_DEFAULT, TOL_MIN_MAX, 'hora'),
  };
}

// Primer índice cuyo ticket es de `segundos` en adelante (los tickets vienen ordenados).
function primerIndiceDesde(ordenados, segundos) {
  let lo = 0;
  let hi = ordenados.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ordenados[mid].segundos < segundos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Pares candidatos de un movimiento: tickets dentro de la ventana de hora y de importe.
function candidatosDe(mov, mi, ordenados, tolCent, tolSeg) {
  const lista = [];
  for (let ti = primerIndiceDesde(ordenados, mov.segundos - tolSeg); ti < ordenados.length; ti++) {
    const t = ordenados[ti];
    if (t.segundos > mov.segundos + tolSeg) break;
    const dCent = Math.abs(t.centavos - mov.centavos);
    if (dCent <= tolCent) lista.push({ mi, t, dCent, dSeg: Math.abs(t.segundos - mov.segundos) });
  }
  return lista;
}

// Campos de una fila sin ticket. Función y no constante: cada fila necesita su propio array `otros`.
function filaSinTicket() {
  return { ticket: null, difImporte: null, difSegundos: null, otros: [], pareja: null };
}

// Asignación uno a uno: todos los pares candidatos se ordenan por (diferencia de importe,
// diferencia de hora, movimiento, ticket) y se asignan de menor a mayor costo mientras el
// movimiento y el ticket estén libres. El importe pesa antes que la hora porque el desfase
// de 1–3 min de la acreditación es esperable, y una diferencia de centavos es la señal fina.
// ponytail: asignación voraz, suficiente para este volumen; húngaro si hiciera falta óptimo global.
function asignarUnoAUno(movimientos, ordenados, tolCent, tolSeg) {
  const pares = [];
  const candidatosPorMov = new Map();
  movimientos.forEach((m, mi) => {
    if (!m.aplica) return;
    const lista = candidatosDe(m, mi, ordenados, tolCent, tolSeg);
    candidatosPorMov.set(mi, lista);
    for (const p of lista) pares.push(p);
  });
  pares.sort((a, b) => a.dCent - b.dCent || a.dSeg - b.dSeg || a.mi - b.mi || a.t.orden - b.t.orden);

  const asignado = new Map();   // índice de movimiento → par
  const usados = new Set();     // orden de los tickets ya asignados
  for (const p of pares) {
    if (asignado.has(p.mi) || usados.has(p.t.orden)) continue;
    asignado.set(p.mi, p);
    usados.add(p.t.orden);
  }
  return { asignado, usados, candidatosPorMov };
}

// Parejas de movimientos de una ventana que juntas pagan el ticket: la suma difiere del total
// hasta la tolerancia de importe y cada movimiento, solo, no alcanza para pagarlo.
function parejasQueSumanElTicket(t, ventana, movimientos, tolCent) {
  const parejas = [];
  for (let i = 0; i < ventana.length; i++) {
    for (let j = i + 1; j < ventana.length; j++) {
      const a = movimientos[ventana[i]];
      const b = movimientos[ventana[j]];
      const dCent = Math.abs(t.centavos - (a.centavos + b.centavos));
      if (dCent > tolCent || a.centavos >= t.centavos || b.centavos >= t.centavos) continue;
      const dSeg = Math.max(Math.abs(t.segundos - a.segundos), Math.abs(t.segundos - b.segundos));
      parejas.push({ t, ia: ventana[i], ib: ventana[j], dCent, dSeg });
    }
  }
  return parejas;
}

// Pago dividido: el cliente pagó un ticket con dos transferencias. Segunda pasada, sólo con lo que
// la asignación 1 a 1 dejó libre (movimientos sin ticket y tickets sin usar). Se agrupa por ticket
// con su ventana de hora (candidatosDe sin tope de importe) y sólo se arman parejas dentro de cada
// ventana, nunca entre todos los movimientos del archivo. Mismo criterio de costo que el 1 a 1:
// primero la diferencia de importe de la suma y después el mayor de los dos desfases de hora.
// Devuelve índice de movimiento → { t: ticket, pareja: índice del otro movimiento }.
// ponytail: sólo de a dos movimientos; con tres o más habría que resolver subconjuntos.
function ubicarPagosDivididos(movimientos, ordenados, { asignado, usados }, tolCent, tolSeg) {
  const libres = ordenados.filter(t => !usados.has(t.orden));
  const ventanas = new Map();   // orden del ticket → índices de los movimientos sin ticket de su ventana
  movimientos.forEach((m, mi) => {
    if (!m.aplica || asignado.has(mi)) return;
    for (const { t } of candidatosDe(m, mi, libres, Infinity, tolSeg)) {
      const ventana = ventanas.get(t.orden) || [];
      ventana.push(mi);
      ventanas.set(t.orden, ventana);
    }
  });

  const candidatas = [];
  for (const t of libres) {
    const ventana = ventanas.get(t.orden) || [];
    if (ventana.length > MAX_VENTANA_PAGO_DIVIDIDO) continue;
    for (const p of parejasQueSumanElTicket(t, ventana, movimientos, tolCent)) candidatas.push(p);
  }
  candidatas.sort((x, y) => x.dCent - y.dCent || x.dSeg - y.dSeg || x.t.orden - y.t.orden || x.ia - y.ia || x.ib - y.ib);

  const divididos = new Map();
  const ticketsUsados = new Set();
  for (const c of candidatas) {
    if (ticketsUsados.has(c.t.orden) || divididos.has(c.ia) || divididos.has(c.ib)) continue;
    ticketsUsados.add(c.t.orden);
    divididos.set(c.ia, { t: c.t, pareja: c.ib });
    divididos.set(c.ib, { t: c.t, pareja: c.ia });
  }
  return divididos;
}

// Día calendario de unos segundos "naive local" (tratados como UTC en toda la lib).
const diaDe = segundos => Math.floor(segundos / SEGUNDOS_POR_DIA);
const claveDiaImporte = ({ segundos, centavos }) => `${diaDe(segundos)}|${centavos}`;

// Agrupa los elementos por su clave: clave → lista de elementos.
function agruparPor(items, claveDe) {
  const grupos = new Map();
  for (const item of items) {
    const clave = claveDe(item);
    const lista = grupos.get(clave);
    if (lista) lista.push(item); else grupos.set(clave, [item]);
  }
  return grupos;
}

// Tercera pasada: importe idéntico al centavo (sin tolerancia) y mismo día, sin importar cuánto
// difiera la hora (en SIGA el ticket a veces se registra horas después del cobro). Sólo con lo que
// el 1 a 1 y el pago dividido dejaron libre. El par se acepta únicamente si es único en ambos
// sentidos: un solo ticket para el movimiento y un solo movimiento para el ticket; si hay más de uno
// de cualquier lado no hay forma segura de elegir y el movimiento queda sin ubicar.
// Agrupa por día|importe (Map): una pasada lineal, nunca todos los movimientos contra todos los tickets.
// Devuelve índice de movimiento → ticket.
function ubicarPorImporteExacto(movimientos, ordenados, ocupados, resueltos) {
  const ticketsLibres = ordenados.filter(t => !ocupados.has(t.orden));
  const ticketsPorClave = agruparPor(ticketsLibres, claveDiaImporte);
  const indicesLibres = movimientos.map((_, mi) => mi).filter(mi => movimientos[mi].aplica && !resueltos.has(mi));
  const movsPorClave = agruparPor(indicesLibres, mi => claveDiaImporte(movimientos[mi]));

  const aRevisar = new Map();
  for (const [clave, indices] of movsPorClave) {
    const tickets = ticketsPorClave.get(clave);
    if (indices.length === 1 && tickets && tickets.length === 1) aRevisar.set(indices[0], tickets[0]);
  }
  return aRevisar;
}

// Fila de un movimiento asignado 1 a 1. Los otros candidatos son los tickets de su ventana que
// no se llevó ningún otro movimiento.
function filaUbicada(movimiento, p, candidatos, ocupados) {
  const otros = candidatos
    .filter(c => c.t.orden !== p.t.orden && !ocupados.has(c.t.orden))
    .sort((a, b) => a.dCent - b.dCent || a.dSeg - b.dSeg)
    .map(c => c.t);
  return {
    movimiento,
    resultado: otros.length ? RESULTADO.AMBIGUO : RESULTADO.UBICADO,
    ticket: p.t,
    difImporte: (p.t.centavos - movimiento.centavos) / 100,
    difSegundos: p.t.segundos - movimiento.segundos,
    otros,
    pareja: null,
  };
}

// Fila de un movimiento de un pago dividido. Dif. importe es el total del ticket menos la suma
// de los dos movimientos (igual en las dos filas); Dif. segundos es propio de cada movimiento.
function filaPagoDividido(movimientos, mi, { t, pareja }) {
  const movimiento = movimientos[mi];
  return {
    movimiento,
    resultado: RESULTADO.PAGO_DIVIDIDO,
    ticket: t,
    difImporte: (t.centavos - (movimiento.centavos + movimientos[pareja].centavos)) / 100,
    difSegundos: t.segundos - movimiento.segundos,
    otros: [],
    pareja: movimientos[pareja],
  };
}

// Fila de un movimiento que un ticket de importe idéntico y mismo día pero hora lejana dejó a revisar.
function filaARevisar(movimiento, t) {
  return {
    movimiento,
    resultado: RESULTADO.A_REVISAR,
    ticket: t,
    difImporte: 0,
    difSegundos: t.segundos - movimiento.segundos,
    otros: [],
    pareja: null,
  };
}

// La asignación 1 a 1 va primero y tiene prioridad; los pagos divididos sólo se buscan con lo
// que ella dejó libre, y el importe exacto del mismo día (A REVISAR) con lo que dejaron las dos.
function cruzar(movimientos, tickets, opciones = {}) {
  const { tolMonto, tolMin } = validarTolerancias(opciones);
  const tolCent = Math.round(tolMonto * 100);
  const tolSeg = Math.round(tolMin * 60);
  const ordenados = [...tickets].sort((a, b) => a.segundos - b.segundos || a.orden - b.orden);

  const unoAUno = asignarUnoAUno(movimientos, ordenados, tolCent, tolSeg);
  const divididos = ubicarPagosDivididos(movimientos, ordenados, unoAUno, tolCent, tolSeg);
  // Un ticket que se llevó otro movimiento (1 a 1 o pago dividido) no cuenta como alternativo. Un
  // A REVISAR es una coincidencia débil: no saca su ticket de los otros candidatos de nadie.
  const ocupados = new Set([...unoAUno.usados, ...[...divididos.values()].map(d => d.t.orden)]);
  const resueltos = new Set([...unoAUno.asignado.keys(), ...divididos.keys()]);
  const aRevisar = ubicarPorImporteExacto(movimientos, ordenados, ocupados, resueltos);

  const filas = movimientos.map((movimiento, mi) => {
    if (!movimiento.aplica) return { movimiento, resultado: RESULTADO.NO_APLICA, ...filaSinTicket() };
    if (divididos.has(mi)) return filaPagoDividido(movimientos, mi, divididos.get(mi));
    const p = unoAUno.asignado.get(mi);
    if (p) return filaUbicada(movimiento, p, unoAUno.candidatosPorMov.get(mi) || [], ocupados);
    if (aRevisar.has(mi)) return filaARevisar(movimiento, aRevisar.get(mi));
    return { movimiento, resultado: RESULTADO.SIN_UBICAR, ...filaSinTicket() };
  });
  return { filas, tolMonto, tolMin };
}

// ── Consulta a SIGA ───────────────────────────────────────────────────────────
// Rango de la consulta: los días completos de los movimientos que aplican (el ticket de un A REVISAR
// puede estar horas lejos del cobro), y si el margen de la tolerancia de hora cruza la medianoche, el
// rango se extiende hasta ahí. null si ninguno aplica (no hay nada que buscar).
function rangoConsulta(movimientos, tolMin) {
  const margen = Math.round(tolerancia(tolMin, TOL_MIN_DEFAULT, TOL_MIN_MAX, 'hora') * 60);
  const segs = movimientos.filter(m => m.aplica).map(m => m.segundos);
  if (!segs.length) return null;
  const min = segs.reduce((a, b) => Math.min(a, b));
  const max = segs.reduce((a, b) => Math.max(a, b));
  const dias = (max - min) / SEGUNDOS_POR_DIA;
  if (dias > MAX_DIAS) {
    throw new ErrorCruce(`El archivo abarca ${Math.ceil(dias)} días y el máximo es ${MAX_DIAS}: partilo en archivos más chicos.`);
  }
  const inicioDelDia = diaDe(min) * SEGUNDOS_POR_DIA;
  const finDelDia = (diaDe(max) + 1) * SEGUNDOS_POR_DIA - 1;   // 23:59:59
  return {
    desde: segundosATexto(Math.min(min - margen, inicioDelDia)),
    hasta: segundosATexto(Math.max(max + margen, finDelDia)),
  };
}

const RE_FECHA_SQL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Mismo criterio de "ticket válido" que analisis_ventas.js (whereVentas): sin anulados y con
// importe positivo. Las fechas se validan por formato antes de interpolarlas.
function sqlTickets(desde, hasta) {
  if (!RE_FECHA_SQL.test(desde) || !RE_FECHA_SQL.test(hasta)) throw new Error('Rango de fechas inválido para consultar SIGA.');
  return `
    SELECT v.IdSucursal, s.Nombre AS NombreSucursal, v.IdTipoComprobante, v.Letra,
           v.CentroEmisor, v.NumeroComprobante,
           CONVERT(varchar(19), v.Fecha, 120) AS FechaTxt, v.ImporteTotal
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    WHERE v.Fecha >= '${desde}' AND v.Fecha <= '${hasta}'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
      AND v.ImporteTotal > 0
  `;
}

// ── Salida: hojas del xlsx ────────────────────────────────────────────────────
const COLUMNAS_DETALLE = [
  'Fecha banco', 'Importe banco', 'Marca tarjeta', 'Método de pago', 'Nº Autorización',
  'Nº Referencia', 'ID Terminal', 'Estado banco', 'Tipo banco', 'Resultado',
  'Sucursal ID', 'Sucursal', 'Ticket', 'Fecha ticket', 'Importe ticket',
  'Dif. importe', 'Dif. segundos', 'Otros candidatos', 'Observación',
];

function textoCandidato(t) {
  const donde = t.sucursal || `Sucursal ${t.idSucursal ?? '?'}`;
  return `${donde} · ${t.etiqueta} · ${t.fecha.slice(11)} · $${t.importe.toFixed(2)}`;
}

// Los primeros MAX_OTROS_CANDIDATOS y, si hay más, cuántos se omitieron.
function textoOtros(otros) {
  const mostrados = otros.slice(0, MAX_OTROS_CANDIDATOS).map(textoCandidato);
  if (otros.length > MAX_OTROS_CANDIDATOS) mostrados.push(`y ${otros.length - MAX_OTROS_CANDIDATOS} más`);
  return mostrados.join(' | ');
}

// "7 h 20 min", o "45 min" si es menos de una hora. Los segundos se descartan (hacia abajo).
function textoDuracion(segundos) {
  const minutos = Math.floor(segundos / 60);
  return minutos >= 60 ? `${Math.floor(minutos / 60)} h ${minutos % 60} min` : `${minutos} min`;
}

// Sólo el pago dividido y el A REVISAR llevan observación. El pago dividido dice con qué otro
// movimiento se pagó el ticket; el A REVISAR, cuánto difiere la hora del ticket de la del banco.
function textoObservacion({ resultado, pareja, difSegundos }) {
  if (resultado === RESULTADO.PAGO_DIVIDIDO) {
    return `Pago dividido con el movimiento de ${pareja.fecha.slice(11)} por $${pareja.importe.toFixed(2)} (fila ${pareja.fila}).`;
  }
  if (resultado === RESULTADO.A_REVISAR) {
    const cuando = difSegundos < 0 ? 'antes' : 'después';
    return `Importe idéntico, pero la hora difiere: el ticket de SIGA está ${textoDuracion(Math.abs(difSegundos))} ${cuando} del banco. Revisar.`;
  }
  return '';
}

// Una fila por movimiento del banco, en el orden del archivo. Dif. = ticket − banco (en un pago
// dividido, ticket − suma de los dos movimientos).
function filasDetalle(filas) {
  return filas.map(({ movimiento: m, resultado, ticket: t, difImporte, difSegundos, otros, pareja }) => ({
    'Fecha banco': m.fecha,
    'Importe banco': m.importe,
    'Marca tarjeta': m.marca,
    'Método de pago': m.metodo,
    'Nº Autorización': m.autorizacion,
    'Nº Referencia': m.referencia,
    'ID Terminal': m.terminal,
    'Estado banco': m.estado,
    'Tipo banco': m.tipo,
    'Resultado': resultado,
    'Sucursal ID': t ? (t.idSucursal ?? '') : '',
    'Sucursal': t ? t.sucursal : '',
    'Ticket': t ? t.etiqueta : '',
    'Fecha ticket': t ? t.fecha : '',
    'Importe ticket': t ? t.importe : '',
    'Dif. importe': difImporte ?? '',
    'Dif. segundos': difSegundos ?? '',
    'Otros candidatos': textoOtros(otros),
    'Observación': textoObservacion({ resultado, pareja, difSegundos }),
  }));
}

// ── Salida: resumen estructurado ──────────────────────────────────────────────
// Resultados que alguien tiene que mirar, en orden de prioridad (es el orden de la lista de atención).
const RESULTADOS_ATENCION = [RESULTADO.A_REVISAR, RESULTADO.AMBIGUO, RESULTADO.SIN_UBICAR];
// De los que sí tienen sucursal, los que no son una coincidencia firme: la sucursal es una pista.
const RESULTADOS_CON_DUDA = new Set([RESULTADO.AMBIGUO, RESULTADO.A_REVISAR]);

// Los importes se suman en centavos enteros para no arrastrar error de punto flotante.
const sumaCentavos = movimientos => movimientos.reduce((a, m) => a + m.centavos, 0);

// No se sabe si el Total bruto del banco incluye las anuladas: alcanza con que coincida con
// la suma de las aprobadas o con la de todos los movimientos leídos.
function controlContraTotal(totalBruto, sumaCent, sumaTodosCent) {
  if (totalBruto == null) return 'SIN TOTAL';
  const totalCent = Math.round(totalBruto * 100);
  return totalCent === sumaCent || totalCent === sumaTodosCent ? 'OK' : 'NO COINCIDE';
}

// Por sucursal del ticket, de los movimientos ubicados (UBICADO, AMBIGUO, PAGO DIVIDIDO y A REVISAR).
function resumenPorSucursal(filas) {
  const porSucursal = new Map();
  for (const f of filas) {
    if (!f.ticket) continue;
    const clave = `${f.ticket.idSucursal ?? ''}|${f.ticket.sucursal}`;
    const s = porSucursal.get(clave) || { id: f.ticket.idSucursal ?? '', nombre: f.ticket.sucursal, cantidad: 0, centavos: 0, revisar: 0 };
    s.cantidad += 1;
    s.centavos += f.movimiento.centavos;
    if (RESULTADOS_CON_DUDA.has(f.resultado)) s.revisar += 1;
    porSucursal.set(clave, s);
  }
  return [...porSucursal.values()]
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.nombre.localeCompare(b.nombre))
    .map(s => ({ id: s.id, nombre: s.nombre, cantidad: s.cantidad, importe: s.centavos / 100, revisar: s.revisar }));
}

// Movimientos que piden una mirada humana: A REVISAR, AMBIGUO y SIN UBICAR (en ese orden y, dentro
// de cada uno, por fecha). `total` es la cantidad real; la lista se recorta a MAX_ATENCION.
// Observación y Otros candidatos son los mismos textos de la hoja Detalle.
function resumenAtencion(filas) {
  const prioridad = resultado => RESULTADOS_ATENCION.indexOf(resultado);
  const todas = filas
    .filter(f => prioridad(f.resultado) >= 0)
    .sort((a, b) => prioridad(a.resultado) - prioridad(b.resultado) || a.movimiento.segundos - b.movimiento.segundos);
  const mostradas = todas.slice(0, MAX_ATENCION).map(f => ({
    fila: f.movimiento.fila,
    fecha: f.movimiento.fecha,
    importe: f.movimiento.importe,
    resultado: f.resultado,
    sucursal: f.ticket ? f.ticket.sucursal : '',
    ticket: f.ticket ? f.ticket.etiqueta : '',
    fechaTicket: f.ticket ? f.ticket.fecha : '',
    observacion: textoObservacion(f),
    otros: textoOtros(f.otros),
  }));
  return { total: todas.length, omitidas: todas.length - mostradas.length, filas: mostradas };
}

// Datos del resumen, JSON puro: los consume la pantalla y, vía matrizResumen, la hoja Resumen del
// xlsx. Importes en pesos; desde/hasta como texto "aaaa-mm-dd hh:mm:ss" ('' si no hay movimientos).
function armarResumen({ filas, parse, tolMonto, tolMin }) {
  const movs = parse.movimientos;
  const sumaCent = sumaCentavos(movs.filter(m => m.aplica));
  const sumaTodosCent = sumaCentavos(movs);
  const segs = movs.map(m => m.segundos);
  const totalBruto = parse.totalControl ?? null;

  return {
    parametros: { tolMonto, tolMin },
    archivo: {
      leidos: movs.length,
      descartadas: parse.descartadas,
      desde: segs.length ? segundosATexto(segs.reduce((a, b) => Math.min(a, b))) : '',
      hasta: segs.length ? segundosATexto(segs.reduce((a, b) => Math.max(a, b))) : '',
      sumaAprobadas: sumaCent / 100,
      sumaTodos: sumaTodosCent / 100,
      totalBruto,
      control: controlContraTotal(totalBruto, sumaCent, sumaTodosCent),
    },
    porResultado: Object.values(RESULTADO).map(resultado => {
      const delResultado = filas.filter(f => f.resultado === resultado);
      return { resultado, cantidad: delResultado.length, importe: delResultado.reduce((a, f) => a + f.movimiento.centavos, 0) / 100 };
    }),
    porSucursal: resumenPorSucursal(filas),
    atencion: resumenAtencion(filas),
  };
}

// Hoja Resumen como matriz de filas (aoa_to_sheet), a partir del resumen ya armado: así el xlsx y
// la pantalla muestran los mismos números. La lista de atención no va en la hoja (está en el Detalle).
function matrizResumen({ parametros, archivo, porResultado, porSucursal }) {
  return [
    ['Cruce bancario — resumen'],
    [],
    ['Parámetros'],
    ['Tolerancia de importe ($)', parametros.tolMonto],
    ['Tolerancia de hora (min)', parametros.tolMin],
    [],
    ['Archivo'],
    ['Movimientos leídos', archivo.leidos],
    ['Filas descartadas (sin fecha válida)', archivo.descartadas],
    ['Desde', archivo.desde],
    ['Hasta', archivo.hasta],
    ['Suma de ventas aprobadas ($)', archivo.sumaAprobadas],
    ['Suma de todos los movimientos leídos ($)', archivo.sumaTodos],
    ['Total bruto del archivo ($)', archivo.totalBruto ?? 'No informado'],
    ['Control contra Total bruto', archivo.control === 'SIN TOTAL' ? 'Sin total en el archivo' : archivo.control],
    [],
    ['Resultado', 'Cantidad', 'Importe ($)'],
    ...porResultado.map(r => [r.resultado, r.cantidad, r.importe]),
    [],
    ['Sucursal ID', 'Sucursal', 'Cantidad', 'Importe ($)'],
    ...porSucursal.map(s => [s.id, s.nombre, s.cantidad, s.importe]),
  ];
}

const filasResumen = datos => matrizResumen(armarResumen(datos));

// Sufijo del nombre del archivo de salida: el día, o "desde_a_hasta" si abarca varios.
function sufijoRango(movimientos) {
  const dias = movimientos.map(m => m.fecha.slice(0, 10)).sort();
  const desde = dias[0];
  const hasta = dias[dias.length - 1];
  return desde === hasta ? desde : `${desde}_a_${hasta}`;
}

module.exports = {
  TOL_MONTO_DEFAULT, TOL_MIN_DEFAULT, TOL_MONTO_MAX, TOL_MIN_MAX, MAX_OTROS_CANDIDATOS, MAX_ATENCION,
  MAX_VENTANA_PAGO_DIVIDIDO, MAX_DIAS, RESULTADO, COLUMNAS_DETALLE, ErrorCruce,
  parseFechaHora, segundosATexto, parseBajada,
  normalizarTickets, validarTolerancias, cruzar, rangoConsulta, sqlTickets,
  filasDetalle, armarResumen, matrizResumen, filasResumen, sufijoRango,
};
