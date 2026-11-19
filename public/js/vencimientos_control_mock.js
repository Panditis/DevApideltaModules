// MOCK del contrato de GET /api/vencimientos/centro-control. Solo se carga con ?mock=1; borrar este archivo
// cuando el endpoint real responda con esta forma. Todas las listas pueden venir vacías.
window.VENCIMIENTOS_CONTROL_MOCK = {
  generado: new Date().toISOString(),
  reglaOferta: { diasAntes: 3 },
  kpis: { lotesActivos: 84, unidadesRiesgo: 132, vencidosSinResolver: 6, sinLote: 11, sucursalesSinCarga: 2 },
  proximos: {
    porSucursal: [
      { idSucursal: 1, nombre: 'Centro', v7: { lotes: 3, unidades: 60 }, v15: { lotes: 5, unidades: 110 }, v30: { lotes: 9, unidades: 190 } },
      { idSucursal: 2, nombre: 'Norte', v7: { lotes: 3, unidades: 72 }, v15: { lotes: 4, unidades: 98 }, v30: { lotes: 6, unidades: 140 } },
    ],
    // Artículos cargados por sucursal (hoy = 2026-11-19; dias = días hasta la fecha). v7/v15/v30 son ACUMULADOS;
    // por rango: Centro 3/2/4 lotes (60/50/80 u), Norte 3/1/2 lotes (72/26/42 u).
    lotes: [
      { idSucursal: 1, producto: 'Yogur natural 1 L', plu: '1042', fecha: '2026-11-21', dias: 2, unidadesCargadas: 48, pendiente: 24 },
      { idSucursal: 1, producto: 'Queso cremoso', plu: '2210', fecha: '2026-11-25', dias: 6, unidadesCargadas: 30, pendiente: 18 },
      { idSucursal: 1, producto: 'Jamón cocido', plu: '3300', fecha: '2026-11-26', dias: 7, unidadesCargadas: 30, pendiente: 18 },
      { idSucursal: 1, producto: 'Leche entera 1 L', plu: '1001', fecha: '2026-12-01', dias: 12, unidadesCargadas: 60, pendiente: 35 },
      { idSucursal: 1, producto: 'Manteca', plu: '2300', fecha: '2026-12-03', dias: 14, unidadesCargadas: 20, pendiente: 15 },
      { idSucursal: 1, producto: 'Crema de leche', plu: '2105', fecha: '2026-12-08', dias: 19, unidadesCargadas: 40, pendiente: 24 },
      { idSucursal: 1, producto: 'Salchichón primavera', plu: '3412', fecha: '2026-12-14', dias: 25, unidadesCargadas: 24, pendiente: 20 },
      { idSucursal: 1, producto: 'Mortadela', plu: '5100', fecha: '2026-12-16', dias: 27, unidadesCargadas: 12, pendiente: 10 },
      { idSucursal: 1, producto: 'Dulce de leche', plu: '4001', fecha: '2026-12-18', dias: 29, unidadesCargadas: 30, pendiente: 26 },
      { idSucursal: 1, producto: 'Aceite de oliva 500 ml', plu: '6100', fecha: '2026-12-29', dias: 40, unidadesCargadas: 18, pendiente: 12 }, // +30 d: no entra en v30
      { idSucursal: 2, producto: 'Yogur natural 1 L', plu: '1042', fecha: '2026-11-23', dias: 4, unidadesCargadas: 48, pendiente: 30 },
      { idSucursal: 2, producto: 'Queso cremoso', plu: '2210', fecha: '2026-11-24', dias: 5, unidadesCargadas: 36, pendiente: 18 },
      { idSucursal: 2, producto: 'Leche entera 1 L', plu: '1001', fecha: '2026-11-25', dias: 6, unidadesCargadas: 48, pendiente: 24 },
      { idSucursal: 2, producto: 'Manteca', plu: '2300', fecha: '2026-11-30', dias: 11, unidadesCargadas: 40, pendiente: 26 },
      { idSucursal: 2, producto: 'Jamón cocido', plu: '3300', fecha: '2026-12-09', dias: 20, unidadesCargadas: 30, pendiente: 22 },
      { idSucursal: 2, producto: 'Crema de leche', plu: '2105', fecha: '2026-12-17', dias: 28, unidadesCargadas: 24, pendiente: 20 },
      { idSucursal: 2, producto: 'Aceite de oliva 500 ml', plu: '6100', fecha: '2026-12-24', dias: 35, unidadesCargadas: 12, pendiente: 8 }, // +30 d
      { idSucursal: 2, producto: 'Fideos secos 500 g', plu: '7100', fecha: '2027-01-10', dias: 52, unidadesCargadas: 40, pendiente: 30 }, // +30 d
    ],
    urgentes: [
      { idSucursal: 1, nombre: 'Centro', producto: 'Yogur natural 1 L', plu: '1042', fecha: '2026-11-21', dias: 2, unidades: 24 },
      { idSucursal: 2, nombre: 'Norte', producto: 'Queso cremoso', plu: '2210', fecha: '2026-11-24', dias: 5, unidades: 18 },
    ],
  },
  vencidos: {
    lotes: [{ idSucursal: 2, nombre: 'Norte', producto: 'Leche entera 1 L', plu: '1001', diasAtraso: 4, unidades: 12 }],
    unidadesRegistradas: [{ idSucursal: 1, nombre: 'Centro', unidades: 40 }, { idSucursal: 2, nombre: 'Norte', unidades: 65 }],
  },
  sinLote: { disponible: true, porSucursal: [{ idSucursal: 1, nombre: 'Centro', cantidad: 7, antiguedadMax: 9 }, { idSucursal: 2, nombre: 'Norte', cantidad: 4, antiguedadMax: 3 }] },
  ranking: [
    { idSucursal: 2, nombre: 'Norte', unidadesVencidas: 65, lotesSinResolver: 3 },
    { idSucursal: 1, nombre: 'Centro', unidadesVencidas: 40, lotesSinResolver: 1 },
  ],
  atrasados: [{ idSucursal: 1, nombre: 'Centro', producto: 'Jamón cocido', plu: '3300', tipo: 'PARA OFERTA', dias: 12, falta: 'Asignar' }],
  cumplimiento: { diasLimite: 7, porSucursal: [
    { idSucursal: 1, nombre: 'Centro', ultimaActividad: '2026-11-18', diasSinActividad: 1 },
    { idSucursal: 2, nombre: 'Norte', ultimaActividad: '2026-11-05', diasSinActividad: 14 },
    { idSucursal: 3, nombre: 'Sur', ultimaActividad: null, diasSinActividad: null },
  ] },
  merma: [{ idSucursal: 1, nombre: 'Centro', vendido: 900, vencido: 40, pct: 4.3 }, { idSucursal: 2, nombre: 'Norte', vendido: 500, vencido: 65, pct: 11.5 }],
  topProductos: [
    { producto: 'Yogur natural 1 L', plu: '1042', unidades: 48 },
    { producto: 'Leche entera 1 L', plu: '1001', unidades: 31 },
    { producto: 'Queso cremoso', plu: '2210', unidades: 20 },
  ],
  pendientes: [
    { idSucursal: 1, nombre: 'Centro', producto: 'Jamón cocido', plu: '3300', tipo: 'Oferta', estado: 'corregir', origenSistema: true },
    { idSucursal: 2, nombre: 'Norte', producto: 'Manteca', plu: '2300', tipo: 'Vencido', estado: null, origenSistema: false },
  ],
  enOferta: [
    { idSucursal: 2, nombre: 'Norte', producto: 'Leche entera 1 L', plu: '1001', fechaOferta: '2026-11-02', diasEnOferta: 17, diasMaxOferta: 10, unidadesOferta: 24, pendiente: 12, estado: 'vencida', diasVencido: 4, vence: '2026-11-15', limite: '2026-11-12', diasParaLimite: -7 },
    { idSucursal: 3, nombre: 'Sur', producto: 'Dulce de leche', plu: '4001', fechaOferta: '2026-11-06', diasEnOferta: 13, diasMaxOferta: null, unidadesOferta: 20, pendiente: 14, estado: 'vencida', diasVencido: null, vence: null, limite: null, diasParaLimite: null },
    { idSucursal: 1, nombre: 'Centro', producto: 'Jamón cocido', plu: '3300', fechaOferta: '2026-11-04', diasEnOferta: 15, diasMaxOferta: 14, unidadesOferta: 30, pendiente: 18, estado: 'atrasada', vence: '2026-11-21', limite: '2026-11-18', diasParaLimite: -1 },
    { idSucursal: 2, nombre: 'Norte', producto: 'Yogur natural 1 L', plu: '1042', fechaOferta: '2026-11-12', diasEnOferta: 7, diasMaxOferta: 9, unidadesOferta: 48, pendiente: 20, estado: 'por-vencer-plazo', vence: '2026-11-24', limite: '2026-11-21', diasParaLimite: 2 },
    { idSucursal: 3, nombre: 'Sur', producto: 'Queso cremoso', plu: '2210', fechaOferta: '2026-11-17', diasEnOferta: 2, diasMaxOferta: 20, unidadesOferta: 24, pendiente: 22, estado: 'en-plazo', vence: '2026-12-10', limite: '2026-12-07', diasParaLimite: 18 },
    { idSucursal: 1, nombre: 'Centro', producto: 'Leche entera 1 L', plu: '1001', fechaOferta: '2026-11-05', diasEnOferta: 14, diasMaxOferta: 52, unidadesOferta: 60, pendiente: 35, estado: 'en-plazo', vence: '2026-12-30', limite: '2026-12-27', diasParaLimite: 38 },
    { idSucursal: 2, nombre: 'Norte', producto: 'Manteca', plu: '2300', fechaOferta: '2026-11-12', diasEnOferta: 7, diasMaxOferta: 5, unidadesOferta: 16, pendiente: 9, estado: 'atrasada', vence: '2026-11-20', limite: '2026-11-17', diasParaLimite: -2 },
    { idSucursal: 3, nombre: 'Sur', producto: 'Salchichón primavera', plu: '3412', fechaOferta: '2026-11-11', diasEnOferta: 8, diasMaxOferta: 9, unidadesOferta: 12, pendiente: 5, estado: 'por-vencer-plazo', vence: '2026-11-23', limite: '2026-11-20', diasParaLimite: 1 },
    { idSucursal: 4, nombre: 'Oeste', producto: 'Crema de leche', plu: '2105', fechaOferta: null, diasEnOferta: 0, diasMaxOferta: null, unidadesOferta: 10, pendiente: 10, estado: 'en-plazo', vence: '2026-12-15', limite: '2026-12-12', diasParaLimite: 23 },
  ],
  tendencia: [
    { mes: '2026-06', unidades: 30 }, { mes: '2026-07', unidades: 45 }, { mes: '2026-08', unidades: 38 },
    { mes: '2026-09', unidades: 60 }, { mes: '2026-10', unidades: 52 }, { mes: '2026-11', unidades: 25 },
  ],
};
