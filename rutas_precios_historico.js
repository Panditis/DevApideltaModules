'use strict';
const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const preciosHistorico = require('./lib/precios_historico');

// ── Rutas de precios históricos ───────────────────────────────────────────────
// Qué precio tenía cada producto cada día del mes pedido, en pantalla y en xlsx.
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo y mismas queries. El bloque movido conserva la indentación original a
// propósito: reindentar cambiaría el texto de los SQL multilínea, que son
// template literals.
//
// precios_historico.js es lógica pura sin estado: se requiere directo.
//
// LISTA_PRECIOS_VENTA se queda en server.js con su comentario donde estaba y
// entra por deps: la usan también /api/facturador/catalogo y rutas_productividad,
// y es la misma lista de mostrador en los tres — duplicar el 0 era abrir tres
// verdades sobre la misma lista de precios.
module.exports = function crearRutasPreciosHistorico(deps) {
  const { apiRoute, query, LISTA_PRECIOS_VENTA } = deps;
  const router = express.Router();

router.get('/precios-historico', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'precios_historico.html')));

// ── Precios históricos ─────────────────────────────────────────────────────────
// Qué precio tenía cada producto cada día del mes pedido. HistorialPrecios guarda un
// registro por CAMBIO de precio, así que van dos consultas: el precio vigente al
// arrancar el mes (baseline, que se arrastra hasta el primer cambio) y los cambios de
// adentro del mes. Traer el historial entero y filtrar en JS serían ~124k filas por la
// red para el mismo resultado.
// Sucursal 1 + lista 0 ("Lista de precios SUCURSALES"): el mismo precio de mostrador
// que usan el facturador y la valorización de producción, así los números coinciden.
const SUCURSAL_PRECIOS_HIST = 1;

async function grillaPreciosHistorico(anioRaw, mesRaw) {
  const { anio, mes } = preciosHistorico.validarPeriodo(anioRaw, mesRaw);
  const desde = preciosHistorico.primerDia(anio, mes);
  const hasta = preciosHistorico.primerDiaSiguiente(anio, mes);
  const filtro = `IdSucursal = ${SUCURSAL_PRECIOS_HIST} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA} AND PrecioVenta IS NOT NULL`;

  const [baseline, cambios, vigentes, prods] = await Promise.all([
    query(`
      WITH ult AS (
        SELECT IdProducto, PrecioVenta,
               ROW_NUMBER() OVER (PARTITION BY IdProducto
                                  ORDER BY FechaHora DESC, IdHistorialPrecios DESC) AS rn
        FROM HistorialPrecios
        WHERE ${filtro} AND FechaHora < '${desde}'
      )
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio FROM ult WHERE rn = 1`),
    query(`
      SELECT IdProducto, CONVERT(varchar(10), FechaHora, 23) AS Dia,
             CAST(PrecioVenta AS FLOAT) AS Precio
      FROM HistorialPrecios
      WHERE ${filtro} AND FechaHora >= '${desde}' AND FechaHora < '${hasta}'
      ORDER BY IdProducto, FechaHora, IdHistorialPrecios`),
    // Lista de precios completa de la sucursal: el último valor conocido de cada
    // producto. La planilla trae TODOS los códigos, haya habido cambios o no, y esta
    // consulta es la que cubre al que nunca cambió de precio (a muchos el historial les
    // registró sólo el costo). Sin filtro de precio > 0: un producto en 0 es un código
    // más y tiene que figurar.
    query(`
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio
      FROM ProductosSucursalesPrecios
      WHERE IdSucursal = ${SUCURSAL_PRECIOS_HIST} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA}`),
    // Sin filtro de Activo: un producto dado de baja igual tuvo precio en el mes.
    query(`SELECT IdProducto, NombreProducto FROM Productos`),
  ]);

  const nombres = new Map(prods.map(p => [String(p.IdProducto).trim(), String(p.NombreProducto || '').trim()]));
  return preciosHistorico.armarGrilla({
    anio, mes, nombres,
    baseline: baseline.map(r => ({ plu: String(r.IdProducto).trim(), precio: r.Precio })),
    cambios: cambios.map(r => ({ plu: String(r.IdProducto).trim(), dia: r.Dia, precio: r.Precio })),
    vigentes: vigentes.map(r => ({ plu: String(r.IdProducto).trim(), precio: r.Precio })),
    hoy: new Date().toISOString().slice(0, 10),
  });
}

router.get('/api/precios-historico', apiRoute(async req => grillaPreciosHistorico(req.query.anio, req.query.mes)));

router.get('/api/precios-historico/xlsx', async (req, res) => {
  try {
    const grilla = await grillaPreciosHistorico(req.query.anio, req.query.mes);
    // Layout fijo pedido por quien consume la planilla: A=PLU, B=producto, C y D
    // vacías, precios de E a AJ. El detalle vive en precios_historico.hojaMatriz.
    const ws = XLSX.utils.aoa_to_sheet(preciosHistorico.hojaMatriz(grilla));
    ws['!cols'] = preciosHistorico.anchosHoja();
    // Sin panel congelado: xlsx (community) ignora '!freeze' al escribir, así que no se
    // deja código muerto pretendiendo que lo hace.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, grilla.periodo.slice(0, 31));
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${preciosHistorico.nombreArchivo(grilla)}"`);
    res.send(buffer);
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

  return router;
};
