'use strict';
// Centro de control de vencimientos: vista de todas las sucursales reales (solo lectura).
// armarCentroControl es pura (lotes + config + hoy + sin lote ya leído); solo sinLoteDeSucursal toca SIGA.
const { diasParaVencer, pendiente, vencidoEfectivo, ofertaEstado, vencidoEstado } = require('./vencimientos');
const { esSucursalReal } = require('./sucursales_no_reales');
const { consultarMovimientosClase, marcarAsignados } = require('./vencimientos_siga');

const CLASES_SIN_LOTE = ['oferta', 'vencido'];
const VENTANAS = [7, 15, 30];
const DIAS_RANKING = 90;
const MESES_TENDENCIA = 6;
const DIAS_SIN_CARGA = 7; // cumplimiento: alerta si la sucursal no registra actividad en estos días
const TOPE_URGENTES = 20;
const TOPE_LOTES_PROXIMOS = 3000; // detalle por sucursal para el modal de la UI
const DIAS_ANTES_VENCIMIENTO_OFERTA = 3; // default si la config no trae diasAntesVencimientoOferta
const TOPE_PRODUCTOS = 500; // la UI muestra el top 10 y busca sobre toda esta lista

// Movimientos SIGA (oferta y vencido) de una sucursal sin registro asignado y de productos sin registro activo.
// Lanza si SIGA falla (cada llamador decide: /sin-lote responde 502, el centro marca no disponible).
async function sinLoteDeSucursal(getPool, { lotes, config, hoy, idSucursal, rubros }) {
  const porClase = await Promise.all(CLASES_SIN_LOTE.map(async clase =>
    (await consultarMovimientosClase(getPool, { clase, idSucursal, config, hoy, rubros })).map(m => ({ clase, ...m }))));
  const suc = String(idSucursal);
  const activos = new Set(lotes.filter(l => { const col = l.sucursales[suc]; return col && !(col.vencidosSistema || []).length && pendiente(col) > 0; }).map(l => Number(l.idProducto)));
  return porClase.flat()
    .filter(m => !activos.has(m.idProducto) && !marcarAsignados([m], lotes, m.idProducto, idSucursal, m.clase)[0].asignadoA)
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.numeroMovimiento - a.numeroMovimiento);
}

const fecha10 = f => String(f || '').slice(0, 10);
const porUnidades = (a, b) => b.unidades - a.unidades;

// Unidades vencidas con fecha: movimientos manuales 'vencido' + OFERTA VENCIDO asignados (fecha SIGA).
const eventosVencido = col => [
  ...(col.movimientos || []).filter(m => m.tipo === 'vencido').map(m => ({ fecha: fecha10(m.fecha), cantidad: Number(m.cantidad) || 0 })),
  ...(col.vencidosSistema || []).map(o => ({ fecha: fecha10(o.fecha), cantidad: Number(o.cantidad) || 0 })),
];

function mesesHasta(hoy, n) {
  const [a, m] = hoy.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(a, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

// sinLotePorSucursal: { [idSucursal]: movimientos[] } o null si SIGA no respondió. nombres: { [idSucursal]: nombre }.
function armarCentroControl(lotes, config, hoy, sinLotePorSucursal, nombres = {}) {
  const nom = id => nombres[id] || `Sucursal ${id}`;
  const desdeRanking = new Date(Date.parse(`${hoy}T00:00:00Z`) - DIAS_RANKING * 864e5).toISOString().slice(0, 10);
  const meses = mesesHasta(hoy, MESES_TENDENCIA);
  const tendencia = new Map(meses.map(m => [m, 0]));
  const porSuc = new Map();
  const sucDe = id => {
    if (!porSuc.has(id)) porSuc.set(id, { idSucursal: id, ventanas: VENTANAS.map(() => ({ lotes: 0, unidades: 0 })),
      vencidas90: 0, sinResolver: 0, vendido: 0, vencido: 0, ultimaActividad: null });
    return porSuc.get(id);
  };
  const productos = new Map();
  const urgentes = [], sinResolver = [], atrasados = [], pendientesDecision = [], enOferta = [], proximosLotes = [];
  let lotesActivos = 0, enRiesgo7 = 0;
  const diasAntes = config.diasAntesVencimientoOferta ?? DIAS_ANTES_VENCIMIENTO_OFERTA; // la oferta cierra este plazo antes del vencimiento

  for (const l of lotes || []) {
    const dias = diasParaVencer(l.vencimiento, hoy);
    const base = { producto: l.nombre || null, plu: String(l.idProducto) };
    for (const [sucTxt, col] of Object.entries(l.sucursales || {})) {
      if (!esSucursalReal(sucTxt)) continue;
      const idSucursal = Number(sucTxt);
      const s = sucDe(idSucursal);
      const pend = pendiente(col);
      const fila = { idSucursal, nombre: nom(idSucursal), ...base };
      const venc = vencidoEfectivo(col);
      s.vendido += col.vendido || 0;
      s.vencido += venc;
      for (const m of col.movimientos || []) { const f = fecha10(m.fecha); if (f && (!s.ultimaActividad || f > s.ultimaActividad)) s.ultimaActividad = f; }
      for (const e of eventosVencido(col)) {
        if (e.fecha >= desdeRanking) s.vencidas90 += e.cantidad;
        const mes = e.fecha.slice(0, 7);
        if (tendencia.has(mes)) tendencia.set(mes, tendencia.get(mes) + e.cantidad);
      }
      if (venc > 0) {
        const p = productos.get(l.idProducto) || { ...base, unidades: 0 };
        productos.set(l.idProducto, { ...p, unidades: p.unidades + venc });
      }
      for (const [tipo, lista, estado] of [['Oferta', col.ofertasSistema, ofertaEstado(col)], ['Vencido', col.vencidosSistema, vencidoEstado(col)]]) {
        if ((lista || []).length && estado !== 'ok') pendientesDecision.push({ ...fila, tipo, estado: estado || null, origenSistema: !!col.origenSistema });
      }
      if (pend <= 0) continue;
      lotesActivos++;
      const ofSis = col.ofertasSistema || [];
      // En oferta ahora: oferta SIGA asignada y sin OFERTA VENCIDO (incluye lotes ya vencidos).
      if (ofSis.length && !(col.vencidosSistema || []).length) {
        const fechaOferta = ofSis.map(o => fecha10(o.fecha)).filter(Boolean).sort()[0] || null;
        const diasEnOferta = fechaOferta ? 0 - diasParaVencer(fechaOferta, hoy) : null; // 0 - evita -0
        const vence = fecha10(l.vencimiento);
        const limite = Number.isFinite(dias) ? new Date(Date.parse(`${vence}T00:00:00Z`) - diasAntes * 864e5).toISOString().slice(0, 10) : null;
        const diasParaLimite = limite ? diasParaVencer(limite, hoy) : null;
        const max = limite && fechaOferta ? Math.max(0, diasParaVencer(limite, fechaOferta)) : null;
        const diasVencido = dias < 0 ? -dias : null;
        const estado = diasVencido ? 'vencida' : limite == null ? 'en-plazo'
          : diasParaLimite < 0 ? 'atrasada' : diasParaLimite <= 2 ? 'por-vencer-plazo' : 'en-plazo';
        enOferta.push({ ...fila, vence, limite, diasParaLimite, diasVencido, fechaOferta, diasEnOferta, diasMaxOferta: max,
          unidadesOferta: ofSis.reduce((t, o) => t + (Number(o.cantidad) || 0), 0), pendiente: pend, estado });
      }
      if (dias < 0) {
        s.sinResolver++;
        sinResolver.push({ ...fila, diasAtraso: -dias, unidades: pend });
        // Vencido sin cerrar pasado diasMaxVencido: falta asignar el OFERTA VENCIDO.
        if (-dias > config.diasMaxVencido) atrasados.push({ ...fila, tipo: config.tipoOfertaVencida, dias: -dias, falta: 'Asignar', exceso: -dias - config.diasMaxVencido });
        continue;
      }
      // Sin fecha de vencimiento válida no hay días para vencer: fuera de ventanas, riesgo, próximos y urgentes.
      if (Number.isFinite(dias)) {
        VENTANAS.forEach((v, i) => { if (dias <= v) { s.ventanas[i].lotes++; s.ventanas[i].unidades += pend; } });
        if (dias <= VENTANAS[0]) enRiesgo7 += pend;
        proximosLotes.push({ idSucursal, ...base, fecha: l.vencimiento, dias, unidadesCargadas: col.unidades, pendiente: pend });
        if (dias <= VENTANAS[VENTANAS.length - 1]) urgentes.push({ ...fila, fecha: l.vencimiento, dias, unidades: pend });
      }
      const ofertas = (col.ofertasSistema || []).map(o => fecha10(o.fecha)).filter(Boolean).sort();
      if (ofertas.length) {
        const desdeOferta = -diasParaVencer(ofertas[0], hoy);
        // Oferta asignada y sin cerrar pasado diasMaxOferta.
        if (desdeOferta > config.diasMaxOferta) atrasados.push({ ...fila, tipo: config.tipoOferta, dias: desdeOferta, falta: 'Cerrar', exceso: desdeOferta - config.diasMaxOferta });
      }
    }
  }

  const disponible = sinLotePorSucursal != null;
  const sinLoteFilas = disponible ? Object.entries(sinLotePorSucursal).filter(([id]) => esSucursalReal(id)).map(([id, movs]) => {
    sucDe(Number(id));
    return { idSucursal: Number(id), nombre: nom(Number(id)), cantidad: movs.length, antiguedadMax: movs.reduce((mx, m) => Math.max(mx, -diasParaVencer(m.fecha, hoy)), 0) };
  }).sort((a, b) => a.idSucursal - b.idSucursal) : [];

  const sucs = [...porSuc.values()].sort((a, b) => a.idSucursal - b.idSucursal);
  const conNombre = s => ({ idSucursal: s.idSucursal, nombre: nom(s.idSucursal) });
  const cumplimiento = sucs.map(s => ({ ...conNombre(s), ultimaActividad: s.ultimaActividad,
    diasSinActividad: s.ultimaActividad ? -diasParaVencer(s.ultimaActividad, hoy) : null }));
  const sinCarga = cumplimiento.filter(c => c.diasSinActividad === null || c.diasSinActividad > DIAS_SIN_CARGA).length;

  return {
    generado: new Date().toISOString(),
    reglaOferta: { diasAntes },
    kpis: { lotesActivos, unidadesRiesgo: enRiesgo7, vencidosSinResolver: sinResolver.length,
      sinLote: disponible ? sinLoteFilas.reduce((t, s) => t + s.cantidad, 0) : null, sucursalesSinCarga: sinCarga },
    proximos: {
      porSucursal: sucs.map(s => ({ ...conNombre(s), v7: { ...s.ventanas[0] }, v15: { ...s.ventanas[1] }, v30: { ...s.ventanas[2] } })),
      urgentes: urgentes.sort((a, b) => a.dias - b.dias || b.unidades - a.unidades).slice(0, TOPE_URGENTES),
      lotes: proximosLotes.sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.producto ?? '').localeCompare(String(b.producto ?? ''))).filter(((n) => l => (n[l.idSucursal] = (n[l.idSucursal] || 0) + 1) <= TOPE_LOTES_PROXIMOS)({})), // tope por sucursal
    },
    vencidos: {
      lotes: sinResolver.sort((a, b) => b.diasAtraso - a.diasAtraso),
      unidadesRegistradas: sucs.map(s => ({ ...conNombre(s), unidades: s.vencido })),
    },
    sinLote: { disponible, porSucursal: sinLoteFilas },
    ranking: sucs.map(s => ({ ...conNombre(s), unidadesVencidas: s.vencidas90, lotesSinResolver: s.sinResolver }))
      .sort((a, b) => b.unidadesVencidas - a.unidadesVencidas || b.lotesSinResolver - a.lotesSinResolver || a.idSucursal - b.idSucursal),
    atrasados: atrasados.sort((a, b) => b.exceso - a.exceso).map(({ exceso, ...a }) => a),
    cumplimiento: { diasLimite: DIAS_SIN_CARGA, porSucursal: cumplimiento },
    merma: sucs.map(s => ({ ...conNombre(s), vendido: s.vendido, vencido: s.vencido,
      pct: s.vendido + s.vencido > 0 ? Math.round(s.vencido / (s.vendido + s.vencido) * 1000) / 10 : null })),
    topProductos: [...productos.values()].sort(porUnidades).slice(0, TOPE_PRODUCTOS),
    pendientes: pendientesDecision,
    enOferta: enOferta.sort((a, b) => (b.diasVencido ?? 0) - (a.diasVencido ?? 0) || (b.estado === 'atrasada') - (a.estado === 'atrasada') || (a.diasParaLimite ?? 1e9) - (b.diasParaLimite ?? 1e9)).slice(0, TOPE_PRODUCTOS),
    tendencia: meses.map(mes => ({ mes, unidades: tendencia.get(mes) })),
  };
}

module.exports = { armarCentroControl, sinLoteDeSucursal, DIAS_SIN_CARGA };
