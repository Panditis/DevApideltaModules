'use strict';
const express = require('express');
const path = require('path');
const comprasControl = require('./compras_control');

// ── Rutas del Control de compras ─────────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. Los bloques movidos conservan la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// compras_control.js es lógica pura sin estado: se requiere directo. Lo que vive
// en server.js (pool SQL, tipos de mssql, disco, DATA_DIR, los pedidos de compra)
// entra por deps.
//
// Se mudan enteros COMPROBANTES_PEDIDO_PATH, leerVinculos(), guardarVinculos(),
// comprasDeProveedor() y numeroOpcional(): no los usa nadie más. leerPedidosCompra()
// se queda en server.js — lo comparte el módulo Compras (rutas_compras.js) — y llega
// por deps. Ojo con comprasDeProveedor(): ya hubo una vez una segunda declaración con
// ese nombre en el módulo Compras y el hoisting dejaba /api/compras/armado vacío en
// silencio; acá vive una sola, en este archivo.
//
// Lo que NO está acá aunque comparta el prefijo /api/compras: /consumo, /urgencias,
// /buscar y /productos son del módulo /consumo y siguen en server.js.
module.exports = function crearRutasComprasControl(deps) {
  const { apiRoute, leerJSON, guardarJSON, getPool, sql, DATA_DIR, leerPedidosCompra } = deps;
  const router = express.Router();

// ── Control de compras ─────────────────────────────────────────────────────────
// Cruza el pedido a proveedor (módulo Compras) contra lo que realmente se cargó en
// SIGA. El vínculo pedido → comprobante(s) vive en un archivo propio: el shape del
// pedido (pedidos_compra.json) pertenece al módulo de Compras y desde acá no se toca.
// La matemática del cruce está en compras_control.js; acá van la query y el disco.
const COMPROBANTES_PEDIDO_PATH = path.join(DATA_DIR, 'pedidos_comprobantes.json');

function leerVinculos()        { return leerJSON(COMPROBANTES_PEDIDO_PATH, {}); }
function guardarVinculos(map)  { guardarJSON(COMPROBANTES_PEDIDO_PATH, map); }

// Comprobantes de compra de un proveedor en una ventana de fechas, con su detalle.
// El JOIN va por las 6 columnas de la clave, IdProveedor incluido: en FACTCOM el
// número lo trae la factura del proveedor (SIGA no lo numera), así que dos
// proveedores comparten sucursal+tipo+letra+centro+número sin problema, y sin esa
// columna se cuelan las líneas del otro e inflan cantidades e importes.
// Las COTIZACION* quedan afuera igual: no son la carga de una compra real.
async function comprasDeProveedor({ idProveedor, proveedor, desde, hasta }) {
  if (!desde || !hasta) return [];
  const pool = await getPool();
  const consulta = pool.request()
    .input('desde', sql.VarChar(10), desde)
    .input('hasta', sql.VarChar(10), hasta);
  let filtroProv;
  if (idProveedor != null && Number.isFinite(Number(idProveedor))) {
    consulta.input('prov', sql.Int, Number(idProveedor));
    filtroProv = 'c.IdProveedor = @prov';
  } else {
    consulta.input('nombre', sql.NVarChar(200), String(proveedor || ''));
    filtroProv = 'c.NombreProveedor = @nombre';
  }
  const r = await consulta.query(`
    SELECT c.IdSucursal, c.IdTipoComprobante, c.Letra, c.CentroEmisor, c.NumeroComprobante,
           CONVERT(varchar(10), c.Fecha, 23) AS Fecha, c.IdProveedor, c.NombreProveedor,
           CAST(c.ImporteTotal AS FLOAT) AS ImporteTotal,
           cp.Orden, cp.IdProducto, cp.NombreProducto,
           CAST(cp.Cantidad AS FLOAT) AS Cantidad,
           CAST(cp.ImporteTotal AS FLOAT) AS ImporteLinea
    FROM Compras c
    INNER JOIN ComprasProductos cp
      ON cp.IdSucursal = c.IdSucursal AND cp.IdTipoComprobante = c.IdTipoComprobante
     AND cp.Letra = c.Letra AND cp.CentroEmisor = c.CentroEmisor
     AND cp.NumeroComprobante = c.NumeroComprobante AND cp.IdProveedor = c.IdProveedor
    WHERE ${filtroProv}
      AND c.Fecha >= @desde AND c.Fecha < DATEADD(day, 1, @hasta)
      AND c.IdTipoComprobante NOT LIKE 'COTIZACION%'
    ORDER BY c.Fecha, c.NumeroComprobante, cp.Orden`);

  // La query devuelve una fila por línea: se reagrupa por comprobante para dárselo
  // ya armado al módulo de cruce.
  const porClave = new Map();
  for (const f of r.recordset) {
    const cab = {
      idSucursal: f.IdSucursal, tipoComprobante: String(f.IdTipoComprobante || '').trim(),
      letra: String(f.Letra || '').trim(), centroEmisor: f.CentroEmisor, numeroComprobante: f.NumeroComprobante,
    };
    const clave = comprasControl.claveComprobante(cab);
    if (!porClave.has(clave)) {
      porClave.set(clave, {
        ...cab, fecha: f.Fecha, idProveedor: f.IdProveedor,
        proveedor: String(f.NombreProveedor || '').trim(),
        importeTotal: f.ImporteTotal != null ? +f.ImporteTotal : null,
        items: [],
      });
    }
    porClave.get(clave).items.push({
      plu: String(f.IdProducto || '').trim(),
      nombre: String(f.NombreProducto || '').trim(),
      cantidad: f.Cantidad != null ? +f.Cantidad : 0,
      importe: f.ImporteLinea != null ? +f.ImporteLinea : 0,
    });
  }
  return [...porClave.values()];
}

const numeroOpcional = (valor, def) => (valor != null && valor !== '' && Number.isFinite(Number(valor)) ? Number(valor) : def);

router.get('/compras/control', (_req, res) => res.sendFile(path.join(__dirname, 'compras_control.html')));

// Listado liviano: no toca SIGA, sólo dice qué pedidos hay y cuáles ya tienen
// vínculo confirmado. La consulta pesada es la del detalle.
router.get('/api/compras/control/pedidos', apiRoute(async (req) => {
  const estado = String(req.query.estado || '').trim().toUpperCase();
  const proveedor = String(req.query.proveedor || '').trim();
  const vinculos = leerVinculos();
  return leerPedidosCompra()
    .filter(p => (!estado || p.estado === estado) && (!proveedor || p.proveedor === proveedor))
    .sort((a, b) => String(b.numero).localeCompare(String(a.numero)))
    .map(p => ({
      numero: p.numero, proveedor: p.proveedor, idProveedor: p.idProveedor != null ? p.idProveedor : null,
      fecha: p.fecha, fechaRetiro: p.fechaRetiro || null, estado: p.estado,
      lineas: Array.isArray(p.items) ? p.items.length : 0,
      vinculados: Array.isArray(vinculos[p.numero]) ? vinculos[p.numero].length : 0,
    }));
}));

// Detalle: candidatos de la ventana + comparación contra los comprobantes elegidos.
// Sin vínculo guardado se compara contra los sugeridos, así la pantalla ya muestra
// algo útil; el usuario confirma y recién ahí queda fijo.
router.get('/api/compras/control/pedidos/:numero', apiRoute(async (req) => {
  const numero = String(req.params.numero);
  const pedido = leerPedidosCompra().find(p => String(p.numero) === numero);
  if (!pedido) throw new Error(`No existe el pedido ${numero}`);

  const opciones = {
    diasAntes: numeroOpcional(req.query.diasAntes, comprasControl.DIAS_ANTES_DEFAULT),
    diasDespues: numeroOpcional(req.query.diasDespues, comprasControl.DIAS_DESPUES_DEFAULT),
  };
  const ventana = comprasControl.ventanaDe(pedido, opciones);
  const comprobantes = await comprasDeProveedor({
    idProveedor: pedido.idProveedor, proveedor: pedido.proveedor, ...ventana,
  });
  const candidatos = comprasControl.candidatosDeCompra(pedido, comprobantes, opciones);

  const guardadas = leerVinculos()[numero];
  const vinculado = Array.isArray(guardadas);
  const claves = new Set(vinculado ? guardadas : candidatos.filter(c => c.sugerido).map(c => c.clave));
  const elegidos = comprobantes.filter(c => claves.has(comprasControl.claveComprobante(c)));

  return {
    ventana, candidatos, vinculado, vinculadas: vinculado ? guardadas : [],
    comparacion: comprasControl.compararPedido(pedido, elegidos, {
      toleranciaPct: numeroOpcional(req.query.toleranciaPct, 0),
    }),
  };
}));

// Confirma (o corrige) contra qué comprobantes se controla el pedido. Una lista
// vacía es una respuesta válida: "ninguno de estos es de este pedido".
router.put('/api/compras/control/pedidos/:numero/comprobantes', (req, res) => {
  const numero = String(req.params.numero);
  const claves = (req.body || {}).claves;
  if (!Array.isArray(claves)) return res.status(400).json({ error: 'Falta la lista de comprobantes' });
  if (!leerPedidosCompra().some(p => String(p.numero) === numero)) {
    return res.status(404).json({ error: `No existe el pedido ${numero}` });
  }
  const limpias = [...new Set(claves.map(c => String(c).trim()).filter(Boolean))];
  guardarVinculos({ ...leerVinculos(), [numero]: limpias });
  res.json({ ok: true, numero, vinculadas: limpias });
});

  return router;
};
