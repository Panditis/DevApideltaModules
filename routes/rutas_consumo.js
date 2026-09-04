'use strict';
const express = require('express');
const path = require('path');

// ── Rutas del dashboard de Consumo ────────────────────────────────────────────
// GET /consumo sirve dashboard_consumo.html. Las rutas /api/compras/consumo,
// /urgencias, /buscar y /productos comparten el prefijo /api/compras/ por
// historia, pero no son del módulo Compras: las consume este dashboard, tal
// como ya señalaban los comentarios de rutas_compras.js y
// rutas_compras_control.js antes de esta extracción (actualizados acá para
// apuntar a este archivo).
//
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo
// orden relativo entre ellas y mismas queries. Los bloques movidos conservan
// la indentación original a propósito: reindentar cambiaría el texto de los
// SQL multilínea, que son template literals.
//
// analizarConsumoCompras(), COMPRAS_EXCL_TC y COMPRAS_PROD_PATH no los usa
// nadie más fuera de este dashboard: se mudan enteros. query, cfg y DATA_DIR
// siguen viviendo en server.js (los usa medio sistema) y llegan por deps.
module.exports = function crearRutasConsumo(deps) {
  const { apiRoute, leerJSON, guardarJSON, query, cfg, DATA_DIR } = deps;
  const router = express.Router();

router.get('/consumo',       (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard_consumo.html')));

// ── Dashboard de compras: consumo por ventas (presentaciones) vs producción (componente) ──
const COMPRAS_EXCL_TC = "'DEV-COTIZACION','eNCRED','eNCRED-Web','eNCCE-Web','ePRE-NCRED','PRESUP','ePRE-FACT','ePRE-FACTX','ePRE-NDEBCHEQR','REMITOTRANSP','NCFICHAS','NCRED','LIQUIDACION'";

async function analizarConsumoCompras(target, meses) {
  const tgt = String(target).replace(/[^0-9A-Za-z_-]/g, '');
  if (!tgt) throw new Error('Producto inválido');
  const M = Math.min(Math.max(parseInt(meses) || 24, 1), 60);

  const info = await query(`
    SELECT TOP 1 p.IdProducto, p.NombreProducto,
      COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd
                INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
                WHERE s.SoyLaCentral=1 AND pd.IdProducto=p.IdProducto),0) AS StockCentral
    FROM Productos p WHERE p.IdProducto='${tgt}'`);
  if (!info.length) throw new Error('Producto no encontrado');

  const reach = await query(`
    ;WITH R AS (
      SELECT DISTINCT IdProducto FROM ProductosComponentes WHERE IdProductoComponente='${tgt}'
      UNION ALL
      SELECT pc.IdProducto FROM ProductosComponentes pc JOIN R ON pc.IdProductoComponente=R.IdProducto
    )
    SELECT DISTINCT IdProducto FROM R OPTION (MAXRECURSION 32)`);
  const idSet = new Set(reach.map(r => String(r.IdProducto)));
  idSet.add(tgt);
  if (idSet.size <= 1) {
    return { producto: { id: tgt, nombre: info[0].NombreProducto }, stockCentral: +info[0].StockCentral,
             meses: M, resumen: { ventasKgMes: 0, produccionKgMes: 0, totalKgMes: 0, coberturaMeses: null, compraSugerida: 0 },
             mensual: [], detalle: { ventas: [], produccion: [] } };
  }
  const inList = [...idSet].map(s => `'${s.replace(/'/g, "''")}'`).join(',');

  const [edges, prods] = await Promise.all([
    query(`SELECT pc.IdProducto, pc.IdFormula, pc.IdProductoComponente, CAST(pc.Cantidad AS FLOAT) AS Cantidad
           FROM ProductosComponentes pc WHERE pc.IdProducto IN (${inList})`),
    query(`SELECT p.IdProducto, p.NombreProducto, p.IdFormula, CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
           FROM Productos p LEFT JOIN ProductosSucursales ps ON ps.IdProducto=p.IdProducto AND ps.IdSucursal=1
           WHERE p.IdProducto IN (${inList})`)
  ]);
  const nombre = new Map(prods.map(p => [String(p.IdProducto), p.NombreProducto]));
  const activa = new Map(prods.map(p => [String(p.IdProducto), p.IdFormula == null ? null : Number(p.IdFormula)]));
  const costoMap = new Map(prods.map(p => [String(p.IdProducto), p.PrecioCosto == null ? null : Number(p.PrecioCosto)]));
  const formulas = new Map();
  for (const e of edges) {
    const p = String(e.IdProducto), f = Number(e.IdFormula);
    if (!formulas.has(p)) formulas.set(p, new Map());
    const fm = formulas.get(p);
    if (!fm.has(f)) fm.set(f, []);
    fm.get(f).push({ id: String(e.IdProductoComponente), qty: Number(e.Cantidad) });
  }

  const reachMemo = new Map();
  function reaches(p, stack) {
    if (p === tgt) return true;
    if (reachMemo.has(p)) return reachMemo.get(p);
    if (stack.has(p)) return false;
    stack.add(p);
    let r = false; const fm = formulas.get(p);
    if (fm) for (const comps of fm.values()) { if (comps.some(c => reaches(c.id, stack))) { r = true; break; } }
    stack.delete(p); reachMemo.set(p, r); return r;
  }
  const solveMemo = new Map();
  function solve(p, stack) {
    if (p === tgt) return { content: 1, tipo: null };
    if (solveMemo.has(p)) return solveMemo.get(p);
    if (stack.has(p)) return { content: 0, tipo: null };
    stack.add(p);
    let res = { content: 0, tipo: null };
    const fm = formulas.get(p);
    if (fm) {
      const cand = [...fm.entries()].filter(([f, comps]) => comps.some(c => reaches(c.id, new Set())));
      if (cand.length) {
        const chosen = cand.find(([f, comps]) => comps.some(c => c.id === tgt))
                    || cand.find(([f]) => f === activa.get(p)) || cand[0];
        const comps = chosen[1];
        const directComp = comps.find(c => c.id === tgt);
        let content = 0, tipo = null;
        for (const c of comps) { const r = solve(c.id, stack); if (r.content > 0) { content += c.qty * r.content; if (r.tipo) tipo = r.tipo; } }
        if (directComp) tipo = (comps.length === 1) ? 'Presentacion' : 'Componente';
        res = { content, tipo };
      }
    }
    stack.delete(p); solveMemo.set(p, res); return res;
  }

  const ventas = await query(`
    SELECT vp.IdProducto, YEAR(v.Fecha) AS Anio, MONTH(v.Fecha) AS Mes, SUM(vp.Cantidad) AS U
    FROM VentasProductos vp
    JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
                 AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    WHERE v.Fecha >= DATEADD(MONTH,-${M},GETDATE()) AND v.Fecha < GETDATE()
      AND (v.IdEstadoComprobante IS NULL OR v.IdEstadoComprobante NOT IN ('ANULADO'))
      AND (v.IdCategoria IS NULL OR v.IdCategoria != 5)
      AND v.IdTipoComprobante NOT IN (${COMPRAS_EXCL_TC})
      AND vp.IdProducto IN (${inList})
    GROUP BY vp.IdProducto, YEAR(v.Fecha), MONTH(v.Fecha)`);

  const det = new Map();
  const mensualMap = new Map();
  let presTot = 0, compTot = 0;
  for (const v of ventas) {
    const p = String(v.IdProducto), u = Number(v.U) || 0;
    const r = (p === tgt) ? { content: 1, tipo: 'Presentacion' } : solve(p, new Set());
    if (r.content <= 0 || !r.tipo) continue;
    const kg = u * r.content;
    if (r.tipo === 'Presentacion') presTot += kg; else compTot += kg;
    const ym = `${v.Anio}-${String(v.Mes).padStart(2, '0')}`;
    if (!mensualMap.has(ym)) mensualMap.set(ym, { ventas: 0, produccion: 0 });
    const m = mensualMap.get(ym);
    if (r.tipo === 'Presentacion') m.ventas += kg; else m.produccion += kg;
    if (!det.has(p)) det.set(p, { id: p, nombre: nombre.get(p) || p, tipo: r.tipo, factor: +r.content.toFixed(5), unid: 0, kg: 0 });
    const d = det.get(p); d.unid += u; d.kg += kg;
  }

  const mensual = [...mensualMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, x]) => ({ ym, ventas: +x.ventas.toFixed(1), produccion: +x.produccion.toFixed(1), total: +(x.ventas + x.produccion).toFixed(1) }));
  const detalle = { ventas: [], produccion: [] };
  for (const d of det.values()) {
    const row = { id: d.id, nombre: d.nombre, factor: d.factor, unid: +d.unid.toFixed(2), kg: +d.kg.toFixed(1), kgMes: +(d.kg / M).toFixed(1) };
    (d.tipo === 'Presentacion' ? detalle.ventas : detalle.produccion).push(row);
  }
  detalle.ventas.sort((a, b) => b.kg - a.kg);
  detalle.produccion.sort((a, b) => b.kg - a.kg);

  const ventasKgMes = +(presTot / M).toFixed(1), produccionKgMes = +(compTot / M).toFixed(1);
  const totalKgMes = +(ventasKgMes + produccionKgMes).toFixed(1);
  const stockCentral = +Number(info[0].StockCentral).toFixed(1);
  const coberturaMeses = totalKgMes > 0 ? +(stockCentral / totalKgMes).toFixed(1) : null;

  const LEAD = cfg.comprasLeadTimeDias != null ? cfg.comprasLeadTimeDias : 7;
  const SEGP = (cfg.comprasStockSeguridadPct != null ? cfg.comprasStockSeguridadPct : 20) / 100;
  const COBM = cfg.comprasCoberturaMeses != null ? cfg.comprasCoberturaMeses : 1;
  const stockSeguridad = +(totalKgMes * SEGP).toFixed(1);
  const demandaLead = totalKgMes / 30 * LEAD;
  const nivelObjetivo = totalKgMes * COBM + stockSeguridad + demandaLead;
  const compraSugerida = Math.max(0, Math.round(nivelObjetivo - stockCentral));
  const criticidad = totalKgMes > 0 ? Math.max(1, Math.min(100, Math.round(100 * (1 - stockCentral / nivelObjetivo)))) : 0;

  let costoKg = null;
  const ownCost = costoMap.get(tgt);
  if (ownCost != null && ownCost > 100) costoKg = ownCost;
  else {
    let bestDiff = Infinity;
    for (const d of detalle.ventas) {
      const c = costoMap.get(d.id);
      if (c != null && c > 100 && d.factor > 0) {
        const diff = Math.abs(d.factor - 1);
        if (diff < bestDiff) { bestDiff = diff; costoKg = c / d.factor; }
      }
    }
  }
  costoKg = costoKg == null ? null : +costoKg.toFixed(2);
  const valorMensual = costoKg == null ? null : Math.round(costoKg * totalKgMes);
  const compraSugeridaValor = costoKg == null ? null : Math.round(costoKg * compraSugerida);
  const stockValor = costoKg == null ? null : Math.round(costoKg * stockCentral);

  return {
    producto: { id: tgt, nombre: info[0].NombreProducto },
    stockCentral, meses: M, costoKg,
    resumen: { ventasKgMes, produccionKgMes, totalKgMes, coberturaMeses, criticidad,
               stockSeguridad, leadDias: LEAD, compraSugerida,
               valorMensual, compraSugeridaValor, stockValor },
    mensual, detalle
  };
}

const COMPRAS_PROD_PATH  = path.join(DATA_DIR, 'compras_productos.json');

// ── Rutas API dashboard de compras ───────────────────────────────────────────────
router.get('/api/compras/consumo', apiRoute(async req => {
  const id = (req.query.id || '').trim();
  if (!id) return { error: 'Falta el parámetro id' };
  return analizarConsumoCompras(id, req.query.meses);
}));
router.get('/api/compras/urgencias', apiRoute(async req => {
  const meses = req.query.meses;
  const lista = leerJSON(COMPRAS_PROD_PATH, []);
  const CONC = 5;
  const out = [];
  for (let i = 0; i < lista.length; i += CONC) {
    const chunk = lista.slice(i, i + CONC);
    const res = await Promise.all(chunk.map(async p => {
      try {
        const r = await analizarConsumoCompras(p.id, meses);
        return {
          id: r.producto.id, nombre: r.producto.nombre, stock: r.stockCentral, costoKg: r.costoKg,
          ventasKgMes: r.resumen.ventasKgMes, produccionKgMes: r.resumen.produccionKgMes,
          totalKgMes: r.resumen.totalKgMes, cobertura: r.resumen.coberturaMeses,
          criticidad: r.resumen.criticidad, stockSeguridad: r.resumen.stockSeguridad,
          compra: r.resumen.compraSugerida,
          valorMensual: r.resumen.valorMensual, compraValor: r.resumen.compraSugeridaValor, stockValor: r.resumen.stockValor
        };
      } catch (e) { return { id: String(p.id), nombre: p.nombre, error: e.message }; }
    }));
    out.push(...res);
  }
  const usarValor = out.some(x => x.valorMensual != null);
  const peso = x => usarValor ? (x.valorMensual || 0) : (x.totalKgMes || 0);
  const totalPeso = out.reduce((s, x) => s + peso(x), 0) || 1;
  const porPeso = [...out].sort((a, b) => peso(b) - peso(a));
  let acum = 0;
  for (const x of porPeso) {
    x.shareConsumo = +(100 * peso(x) / totalPeso).toFixed(1);
    acum += peso(x);
    const acumShare = 100 * acum / totalPeso;
    x.clase = peso(x) <= 0 ? '-' : acumShare <= 80 ? 'A' : acumShare <= 95 ? 'B' : 'C';
  }
  const factorImp = { A: 1, B: 0.65, C: 0.4, '-': 0.2 };
  out.forEach(x => {
    const f = factorImp[x.clase] != null ? factorImp[x.clase] : 0.2;
    x.prioridad = (x.totalKgMes > 0) ? Math.max(1, Math.min(100, Math.round((x.criticidad || 0) * f))) : 0;
  });
  const clasif = x => x.error ? 'error' : x.totalKgMes <= 0 ? 'sin' : x.prioridad >= 67 ? 'critico' : x.prioridad >= 34 ? 'atencion' : 'ok';
  out.forEach(x => { x.estado = clasif(x); });
  out.sort((a, b) => ((b.prioridad || 0) - (a.prioridad || 0)) || (peso(b) - peso(a)));
  const conteo = { critico: 0, atencion: 0, ok: 0, sin: 0, error: 0, A: 0, B: 0, C: 0 };
  out.forEach(x => { conteo[x.estado]++; if (x.clase === 'A' || x.clase === 'B' || x.clase === 'C') conteo[x.clase]++; });
  const totalCompraValor = out.reduce((s, x) => s + (x.compraValor || 0), 0);
  const totalValorMensual = out.reduce((s, x) => s + (x.valorMensual || 0), 0);
  return { meses: Math.min(Math.max(parseInt(meses) || 24, 1), 60), usarValor, conteo, totalCompraValor, totalValorMensual, productos: out };
}));
router.get('/api/compras/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const safe = q.replace(/'/g, "''");
  const porId = /^\d+$/.test(q) ? `p.IdProducto='${safe}' OR ` : '';
  return query(`SELECT TOP 25 p.IdProducto, p.NombreProducto, COALESCE(r.NombreRubro,'') AS NombreRubro
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE (${porId}p.NombreProducto LIKE '%${safe}%') AND p.Activo=1
    ORDER BY CASE WHEN p.IdProducto='${safe}' THEN 0 ELSE 1 END, p.NombreProducto`);
}));
router.get('/api/compras/productos', (_req, res) => res.json(leerJSON(COMPRAS_PROD_PATH, [])));
router.post('/api/compras/productos', (req, res) => {
  const o = req.body || {};
  if (!o.id) return res.status(400).json({ error: 'Falta id' });
  const id = String(o.id).trim();
  const arr = leerJSON(COMPRAS_PROD_PATH, []).filter(x => String(x.id) !== id);
  arr.push({ id, nombre: o.nombre || id });
  guardarJSON(COMPRAS_PROD_PATH, arr);
  res.json(arr);
});
router.delete('/api/compras/productos/:id', (req, res) => {
  const arr = leerJSON(COMPRAS_PROD_PATH, []).filter(x => String(x.id) !== String(req.params.id));
  guardarJSON(COMPRAS_PROD_PATH, arr);
  res.json(arr);
});

  return router;
};
