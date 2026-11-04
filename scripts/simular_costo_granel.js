'use strict';
// ── Simula precios de Fraccionado con un costo nuevo por granel (planilla del usuario). SOLO LECTURA ──
//   node scripts/simular_costo_granel.js <costos.xlsx> [--salida <resultado.xlsx>] [--copia <planilla_con_precio.xlsx>] [--datos <carpeta data>]
// Planilla: hoja 1, columnas PLU, Nombre, Granel ("7000 · nombre"), Costo nuevo ($/kg del granel). Arma el listado de Fraccionado
// igual que GET /api/precios/esquema/listado (mismo motor, SIGA con el usuario de lectura, data/costeo.json sin escribir) poniendo
// el costo nuevo como costo de "última compra" del granel: sugeridos.sistema = precio con costo actual, sugeridos.ultimaCompra =
// precio con costo nuevo. No escribe en data/ ni en SIGA.
// ponytail: copia las constantes SQL de server.js (no se puede requerir: arranca el server); si cambian allá, actualizarlas acá.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const sql = require('mssql/msnodesqlv8');
const cfgEsq = require('../lib/precios_config_esquema');
const L = require('../lib/precios_listado_esquema');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const { normalizarCosteoFraccionado, plusInsumos } = require('../lib/precios_fraccionado_costo');
const { formulasPesables } = require('../lib/formulas_pesables');

const FORMULA_ACTIVA_SQL = `pc.IdFormula = COALESCE(
    (SELECT TOP 1 fa.IdFormula FROM dbo.ProductosComponentes fa
       INNER JOIN dbo.Productos fp ON fp.IdProducto = fa.IdProducto
      WHERE fa.IdProducto = pc.IdProducto AND fa.IdFormula = fp.IdFormula),
    (SELECT MIN(fb.IdFormula) FROM dbo.ProductosComponentes fb WHERE fb.IdProducto = pc.IdProducto))`;
const SIN_FORMULA_GENERICO_SQL = `p.NombreProducto NOT LIKE '%FORMULA GENERICO%'
    AND p.NombreProducto NOT LIKE '%FORMULA GENÉRICO%'`;
const leerJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const delta = (n, b) => (n != null && b > 0 ? Math.round(((n - b) / b) * 10000) / 10000 : null);
const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/\./g, '').replace(',', '.')) : NaN);

// Planilla → { porGranel: Map granel → costo, filas, avisos }. Conflicto dentro de un granel: mayoría si ≥ 80 % de sus filas, si no sin costo.
function leerPlanilla(rows) {
  const avisos = [], grupos = new Map();
  const filas = rows.map((r, i) => {
    const plu = r.PLU == null ? '' : String(r.PLU).trim(), granel = (String(r.Granel || '').match(/^\s*(\d+)\s*·/) || [])[1] || '';
    const c = num(r['Costo nuevo']);
    const valido = Number.isFinite(c) && c > 0;
    if (!valido) avisos.push(['Costo inválido', i + 2, plu, r.Nombre, granel, `"${r['Costo nuevo'] ?? ''}" (vacío, no numérico o <= 0)`]);
    if (valido && granel) grupos.set(granel, [...(grupos.get(granel) || []), c]);
    return { fila: i + 2, plu, nombre: r.Nombre, granelTxt: r.Granel, granel, costo: valido ? c : null };
  });
  const porGranel = new Map();
  for (const [g, cs] of grupos) {
    const cuenta = new Map();
    cs.forEach(c => cuenta.set(c, (cuenta.get(c) || 0) + 1));
    const [top, n] = [...cuenta].sort((a, b) => b[1] - a[1])[0];
    if (cuenta.size === 1) { porGranel.set(g, top); continue; }
    const abrumador = n / cs.length >= 0.8;
    avisos.push(['Conflicto de costo en granel', null, null, null, g,
      `valores ${[...cuenta].map(([v, k]) => `${v} (×${k})`).join(', ')} → ${abrumador ? `se usa ${top} (mayoría)` : 'sin costo nuevo (no se adivina)'}`]);
    if (abrumador) porGranel.set(g, top);
  }
  return { porGranel, filas, avisos };
}

async function main(argv) {
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const entrada = argv.find(a => !a.startsWith('--') && a !== val('--salida') && a !== val('--copia') && a !== val('--datos'));
  const DATA = val('--datos') || path.join(__dirname, '..', 'data'); // --datos: leer data/ de otro worktree (p. ej. produccion), solo lectura
  if (!fs.existsSync(path.join(DATA, 'costeo.json'))) throw new Error(`no existe ${path.join(DATA, 'costeo.json')}`);
  if (!entrada || !fs.existsSync(entrada)) throw new Error(`no existe la planilla ${entrada || '(falta la ruta)'}`);
  const hoy = new Date().toISOString().slice(0, 10);
  const salida = val('--salida') || path.join(require('os').homedir(), 'Desktop', `precios_costo_nuevo_${hoy}.xlsx`);
  const copia = val('--copia') || entrada.replace(/\.xlsx$/i, '_con_precio.xlsx');

  const wbIn = XLSX.readFile(entrada), hoja = wbIn.Sheets[wbIn.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(hoja, { defval: null });
  const { porGranel, filas, avisos } = leerPlanilla(rows);

  const pool = await new sql.ConnectionPool({ connectionString: 'Driver={ODBC Driver 17 for SQL Server};'
    + `Server=${process.env.SIGA_DB_SERVER || 'servidorapidelta\\SQLSTANDARD'};Database=${process.env.SIGA_DB_NAME || 'Siga'};`
    + `UID=${process.env.SIGA_READ_UID};PWD=${process.env.SIGA_READ_PWD};TrustServerCertificate=yes;`, requestTimeout: 120000 }).connect();
  try {
    const query = async q => (await pool.request().query(q)).recordset;
    const consultas = crearConsultasPrecios({ query, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL });
    // Como leerCosteoVigente pero sin guardar la poda (no se escribe data/).
    const vigentes = await consultas.preciosVigentesAlmacen();
    const { costeo } = L.podarDecisiones(leerJSON(path.join(DATA, 'costeo.json'), {}), vigentes);
    const costeoF = cfgEsq.fraccionadoMigrado(costeo) ? normalizarCosteoFraccionado(costeo.fraccionado) : null;
    const formulas = await formulasPesables({ query, FORMULA_ACTIVA_SQL, respaldo: (leerJSON(path.join(DATA, 'pesables_listas.json'), {}) || {}).formulas });
    const pb = costeo.packBulto || {};
    const [{ vinculos }, { graneles, presentaciones, costos }] = await Promise.all([consultas.vinculosPackBulto(pb.vinculosManuales || {}),
      consultas.universoFraccionado(formulas, costeoF ? plusInsumos(costeoF) : [])]);
    const ctx = { cfg: cfgEsq.configEsquemaDe(costeo, 'fraccionado'), vigentes, mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes, ventaPesable: pb.ventaPesable || {} }) };
    const grupos = L.agruparPorGranel({ graneles, presentaciones, formulas, costos });
    // Escenario: el costo nuevo entra como "última compra" del granel (solo graneles del listado: los insumos no se tocan).
    const plusGranel = new Set(grupos.map(g => g.plu).filter(p => p != null));
    const costosSim = new Map([...costos].map(([plu, f]) => [plu, plusGranel.has(plu) ? { ...f, costoMercaderia: porGranel.get(plu) ?? null } : f]));
    const lista = L.listadoFraccionado({ grupos, costos: costosSim, costeo, costeoF, ...ctx });

    const enUniverso = new Map(lista.flatMap(g => g.presentaciones.map(p => [String(p.plu), { g, p }])));
    const enPlanilla = new Map(filas.map(f => [f.plu, f]));
    for (const g of [...porGranel.keys()].filter(g => !plusGranel.has(g))) avisos.push(['Granel del Excel fuera del listado', null, null, null, g, 'no es un granel de Fraccionado: su costo no se usa']);
    for (const f of filas.filter(f => !enUniverso.has(f.plu))) avisos.push(['PLU no existe en Fraccionado', f.fila, f.plu, f.nombre, f.granel, '']);
    for (const f of filas.filter(f => enUniverso.has(f.plu) && (enUniverso.get(f.plu).g.plu ?? '') !== f.granel)) {
      avisos.push(['Granel distinto al del sistema', f.fila, f.plu, f.nombre, f.granel, `el sistema lo agrupa en ${enUniverso.get(f.plu).g.plu ?? 'sin granel'}: se simula con el costo de ese granel`]);
    }

    const precio = s => (s && s.minorista ? s.minorista.precio : null);
    const mayor = (p, s, tipo) => { // pack/bulto: vigente y neto sin IVA (como se carga en SIGA) del primer vínculo de ese tipo
      const m = (p.mayoristas || []).find(x => x.tipo === tipo);
      const n = m && s ? (s.mayoristas || []).find(x => x.plu === m.plu) : null;
      return { vig: m ? m.vigente ?? null : null, nuevo: n ? n.neto : null, plu: m ? m.plu : null };
    };
    const enc = ['PLU', 'Nombre', 'Granel', 'Estado', 'Costo actual del granel', 'Costo nuevo del granel', 'Δ% costo',
      'Minorista: precio actual', 'Minorista: precio con costo actual', 'Minorista: precio nuevo', 'Minorista: Δ% (vs actual)', 'Minorista: Δ% (vs precio con costo actual)',
      'Pack PLU', 'Pack: precio actual (sin IVA)', 'Pack: precio nuevo (sin IVA)', 'Pack: Δ%',
      'Bulto PLU', 'Bulto: precio actual (sin IVA)', 'Bulto: precio nuevo (sin IVA)', 'Bulto: Δ%', 'Extra $/kg (insumos+MO+máquina)', 'Avisos de costeo'];
    const resultado = [];
    const filaDe = (g, p, estadoForzado) => {
      const sis = p.sugeridos.sistema, nue = p.sugeridos.ultimaCompra;
      const vig = p.vigente ?? null, pn = precio(nue);
      const estado = estadoForzado || (nue == null ? 'sin costo nuevo' : pn === precio(sis) ? 'sin cambio' : 'cambia');
      const pk = mayor(p, nue, 'pack'), bu = mayor(p, nue, 'bulto');
      const r = [/^\d+$/.test(p.plu) ? Number(p.plu) : p.plu, p.nombre, g.plu == null ? g.nombre : `${g.plu} · ${g.nombre}`, estado,
        g.costoSistema ?? null, g.costoUltimaCompra ?? null, delta(g.costoUltimaCompra, g.costoSistema),
        vig, precio(sis), pn ?? (nue == null ? precio(sis) : null), delta(pn ?? (nue == null ? precio(sis) : null), vig), delta(pn, precio(sis)),
        pk.plu, pk.vig, pk.nuevo, delta(pk.nuevo, pk.vig), bu.plu, bu.vig, bu.nuevo, delta(bu.nuevo, bu.vig), p.costeoPresentacion ? p.costeoPresentacion.extraKg ?? null : null,
        [...(p.avisosCosto || []), ...(p.faltantesCosto || []).map(x => `falta ${typeof x === 'string' ? x : JSON.stringify(x)}`),
          ...(nue && nue.error ? [`motor: ${nue.error}`] : [])].join(' | ') || null];
      resultado.push({ plu: String(p.plu), estado, pn, vig, dCosto: r[6], dPrecio: r[10], dVsCosto: r[11] });
      return r;
    };
    const aoa = [enc, ...lista.flatMap(g => g.presentaciones.map(p => filaDe(g, p, enPlanilla.has(String(p.plu)) ? null : 'sin costo nuevo'))),
      ...filas.filter(f => !enUniverso.has(f.plu)).map(f => [/^\d+$/.test(f.plu) ? Number(f.plu) : f.plu, f.nombre, f.granelTxt, 'PLU no existe',
        null, f.costo, ...Array(enc.length - 6).fill(null)])];
    const sinCostoNuevo = lista.flatMap(g => g.presentaciones).filter(p => !enPlanilla.has(String(p.plu)));
    avisos.push(['Presentaciones sin costo nuevo', null, null, null, null, `${sinCostoNuevo.length} del listado no están en el Excel: se simulan con su costo actual`]);
    const cambianCosto = lista.filter(g => g.plu != null && g.costoUltimaCompra != null && g.costoUltimaCompra !== g.costoSistema).length;
    avisos.push(['Graneles que cambian de costo', null, null, null, null, `${cambianCosto} de ${porGranel.size} graneles con costo nuevo`]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Precios');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Tipo', 'Fila Excel', 'PLU', 'Nombre', 'Granel', 'Detalle'], ...avisos]), 'Avisos');
    XLSX.writeFile(wb, salida);

    // Copia de la planilla con "Precio nuevo" (minorista) a la derecha de "Costo nuevo", mismo orden de filas.
    const porPlu = new Map(resultado.map(r => [r.plu, r]));
    const aoaIn = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });
    const col = aoaIn[0].indexOf('Costo nuevo') + 1;
    const ins = (fila, v) => [...fila.slice(0, col), v, ...fila.slice(col)];
    const wbC = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbC, XLSX.utils.aoa_to_sheet([ins(aoaIn[0], 'Precio nuevo'),
      ...aoaIn.slice(1).map(f => { const r = porPlu.get(String(f[0] ?? '').trim()); return ins(f, r && r.estado !== 'sin costo nuevo' ? r.pn ?? null : null); })]), wbIn.SheetNames[0]);
    XLSX.writeFile(wbC, copia);

    const ds = resultado.filter(r => r.estado === 'cambia' && r.dVsCosto != null).map(r => r.dVsCosto);
    const dv = resultado.filter(r => r.estado !== 'sin costo nuevo' && r.dPrecio != null).map(r => r.dPrecio);
    const est = resultado.reduce((a, r) => ({ ...a, [r.estado]: (a[r.estado] || 0) + 1 }), {});
    console.log(JSON.stringify({ presentaciones: resultado.length, estados: est, plusNoExisten: filas.filter(f => !enUniverso.has(f.plu)).length,
      dPrecioPorCosto: ds.length ? { prom: ds.reduce((a, b) => a + b, 0) / ds.length, max: Math.max(...ds), min: Math.min(...ds) } : null,
      dVsVigente: dv.length ? { prom: dv.reduce((a, b) => a + b, 0) / dv.length, max: Math.max(...dv), min: Math.min(...dv) } : null,
      avisos: avisos.length, salida, copia }, null, 1));
    avisos.forEach(a => console.log('aviso:', a.filter(x => x != null).join(' · ')));
  } finally { await pool.close(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error('[simular_costo_granel]', err.message); process.exitCode = 1; });
}
