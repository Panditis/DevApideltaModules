'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

// ── Rutas del Cotizador Mercado Libre ─────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. El bloque movido conserva la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// COMISIONES_PATH, VINCULACIONES_PATH y calcularPrecioML —la fórmula que despeja
// el precio de publicación a partir del precio SIGA, la comisión, las cuotas, el
// IVA y el envío— no tienen un solo uso fuera del cotizador: se mudan enteros.
//
// Las dos rutas /api/facturador/* quedaron físicamente en medio del bloque pero
// son de otro módulo (el facturador que corre como archivo local): se quedan en
// server.js, junto con LISTA_PRECIOS_VENTA y PRECIOS_FACTURADOR_DIR. Por eso el
// bloque se movió en tramos, salteándolas.
module.exports = function crearRutasCotizador(deps) {
  const { apiRoute, query, leerJSON, guardarJSON } = deps;
  const router = express.Router();

router.get('/cotizador',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'cotizador.html')));

// ── Cotizador Mercado Libre ───────────────────────────────────────────────────
const COMISIONES_PATH = path.join(__dirname, 'data', 'comisiones_mercadolibre.json');
const VINCULACIONES_PATH = path.join(__dirname, 'data', 'vinculaciones_mercadolibre.json');

router.get('/api/cotizador/comisiones', (_req, res) => {
  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  res.json(comisiones);
});

router.get('/api/cotizador/vinculaciones', (_req, res) => {
  const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
  res.json(vinculaciones);
});

router.post('/api/cotizador/vinculaciones', (req, res) => {
  try {
    const datos = Array.isArray(req.body) ? req.body : [req.body];
    guardarJSON(VINCULACIONES_PATH, datos);
    res.json({ ok: true, guardadas: datos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct = 0, costoEnvio = 0) {
  // Precio ML para que neto después de comisión+cuotas+IVA+envío = precioVentaSIGA
  const descuentoTotal = comisionPct / 100 + cuotasPct / 100;
  const precioML = (precioVentaSIGA + costoEnvio) / ((1 - descuentoTotal) * (1 - iva / 100));
  const comisionMonto = precioML * (comisionPct / 100);
  const cuotasMonto = precioML * (cuotasPct / 100);
  const ivaMonto = (precioML - comisionMonto - cuotasMonto) * (iva / 100);
  return { precioML, comisionMonto, cuotasMonto, ivaMonto };
}

router.post('/api/cotizador/calcular', apiRoute(async req => {
  const { idProductoSIGA, categoriaMercadoLibre, provincia, cuotasPct = 0, costoEnvio = 0 } = req.body;
  if (!idProductoSIGA || !categoriaMercadoLibre || !provincia) {
    throw new Error('Faltan parámetros: idProductoSIGA, categoriaMercadoLibre, provincia');
  }

  const rows = await query(`
    SELECT TOP 1 p.IdProducto, p.NombreProducto, psp.PrecioVenta, ps.PrecioCosto
    FROM Productos p
    LEFT JOIN ProductosSucursalesPrecios psp ON psp.IdProducto=p.IdProducto AND psp.IdSucursal=1
    LEFT JOIN ProductosSucursales ps ON ps.IdProducto=p.IdProducto AND ps.IdSucursal=1
    WHERE p.IdProducto='${idProductoSIGA.replace(/'/g, "''")}'
  `);

  if (!rows.length) throw new Error('Producto no encontrado: ' + idProductoSIGA);

  const producto = rows[0];
  const precioVentaSIGA = producto.PrecioVenta || 0;

  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  const provinciaData = comisiones.provincias[provincia] || comisiones.provincias.DEFAULT;
  const comisionPct = provinciaData[categoriaMercadoLibre] || provinciaData.DEFAULT || 14.80;
  const iva = comisiones.metadata?.iva_aplicable || 21;

  const { precioML, comisionMonto, cuotasMonto, ivaMonto } = calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct, costoEnvio);

  return {
    idProductoSIGA,
    nombreProducto: producto.NombreProducto,
    precioVentaSIGA: parseFloat(precioVentaSIGA.toFixed(2)),
    categoriaMercadoLibre,
    provincia,
    comisionPct: parseFloat(comisionPct.toFixed(2)),
    comisionMonto: parseFloat(comisionMonto.toFixed(2)),
    cuotasPct: parseFloat(cuotasPct),
    cuotasMonto: parseFloat(cuotasMonto.toFixed(2)),
    costoEnvio: parseFloat(costoEnvio),
    ivaAplicable: iva,
    ivaMonto: parseFloat(ivaMonto.toFixed(2)),
    precioFinalMercadoLibre: parseFloat(precioML.toFixed(2))
  };
}));

router.get('/api/cotizador/calcular-todos', apiRoute(async () => {
  const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
  const activas = vinculaciones.filter(v => v.activo && v.idProductoSIGA);
  if (!activas.length) return [];

  const ids = activas.map(v => `'${v.idProductoSIGA.replace(/'/g, "''")}'`).join(',');
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, psp.PrecioVenta
    FROM Productos p
    LEFT JOIN ProductosSucursalesPrecios psp ON psp.IdProducto=p.IdProducto AND psp.IdSucursal=1
    WHERE p.IdProducto IN (${ids})
  `);

  const preciosMap = new Map(rows.map(r => [String(r.IdProducto), r]));
  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  const iva = comisiones.metadata?.iva_aplicable || 21;

  return activas.map(v => {
    const prod = preciosMap.get(String(v.idProductoSIGA));
    const precioVentaSIGA = prod?.PrecioVenta || 0;
    const provinciaData = comisiones.provincias[v.provincia] || comisiones.provincias.DEFAULT;
    const comisionPct = provinciaData[v.categoriaMercadoLibre] || provinciaData.DEFAULT || 14.80;
    const cuotasPct = parseFloat(v.cuotasPct) || 0;
    const costoEnvio = parseFloat(v.costoEnvio) || 0;
    const { precioML, comisionMonto, cuotasMonto, ivaMonto } = calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct, costoEnvio);

    return {
      skuMercadoLibre: v.skuMercadoLibre,
      idProductoSIGA: v.idProductoSIGA,
      nombreProducto: prod?.NombreProducto || v.nombreProducto,
      categoriaMercadoLibre: v.categoriaMercadoLibre,
      provincia: v.provincia,
      precioVentaSIGA: parseFloat(precioVentaSIGA.toFixed(2)),
      comisionPct: parseFloat(comisionPct.toFixed(2)),
      comisionMonto: parseFloat(comisionMonto.toFixed(2)),
      cuotasPct,
      cuotasMonto: parseFloat(cuotasMonto.toFixed(2)),
      costoEnvio,
      ivaAplicable: iva,
      ivaMonto: parseFloat(ivaMonto.toFixed(2)),
      precioFinalMercadoLibre: parseFloat(precioML.toFixed(2))
    };
  });
}));

router.post('/api/cotizador/importar', multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Sin archivo' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const datos = XLSX.utils.sheet_to_json(ws);

    const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
    let agregadas = 0;

    datos.forEach(row => {
      const sku = String(row['SKU'] || row['sku'] || row['Código'] || '').trim();
      const nombre = String(row['Nombre'] || row['nombre'] || '').trim();
      const categoria = String(row['Categoría'] || row['categoria'] || 'Alimentos y Bebidas').trim();
      const provincia = String(row['Provincia'] || row['provincia'] || 'Buenos Aires').trim();

      if (!sku) return;

      const existe = vinculaciones.find(v => v.skuMercadoLibre === sku);
      if (!existe) {
        vinculaciones.push({
          skuMercadoLibre: sku,
          idProductoSIGA: '',
          nombreProducto: nombre,
          categoriaMercadoLibre: categoria,
          provincia,
          activo: true,
          ultimaActualizacion: new Date().toISOString()
        });
        agregadas++;
      }
    });

    guardarJSON(VINCULACIONES_PATH, vinculaciones);
    res.json({ ok: true, agregadas, total: vinculaciones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  return router;
};
