// ── Desglose del precio esperado: lo usan el diálogo de Control y la vista previa de Costos ──

// Costo de envío por peso: primer tramo con topeKg >= pesoKg; sin peso, <= 0 o sobre el último tope -> defecto.
function tramoEnvio(tabla, pesoKg, defecto) {
  const p = num(pesoKg);
  const t = p !== null && p > 0 ? (tabla || []).find(x => Number(x.topeKg) >= p) : null;
  return t ? { monto: Number(t.valor) || 0, topeKg: Number(t.topeKg), origen: 'tabla' } : { monto: Number(defecto) || 0, topeKg: null, origen: 'defecto' };
}

// Recargo % de la fila de la tabla con esa cantidad exacta de cuotas; sin fila o cantidad inválida -> 0.
function recargoCuotas(tabla, qty) {
  const q = num(qty);
  const t = q !== null && Number.isInteger(q) && q >= 1 && q <= 24 ? (tabla || []).find(x => Number(x.cuotas) === q) : null;
  return t ? Number(t.recargoPct) || 0 : 0;
}

// Cargo fijo por precio: primer tramo con precioMax >= precio; sin tramo (precio mayor al último) -> defecto.
function tramoCostoFijo(tabla, precio, defecto) {
  const p = num(precio);
  const t = p !== null ? (tabla || []).find(x => Number(x.precioMax) >= p) : null;
  return t ? { monto: Number(t.valor) || 0, precioMax: Number(t.precioMax), origen: 'tabla' } : { monto: Number(defecto) || 0, precioMax: null, origen: 'defecto' };
}

// Mismo cálculo que precioEsperado de lib/ml_precios.js (solo para mostrar; el esperado oficial lo calcula el server).
// `cuotas` (4.º) es el viejo esquema y se ignora: ahora manda cuotasQty. El envío por umbral y el tramo de cargo fijo
// se evalúan sobre el mismo precio de referencia: el esperado sin envío y sin cargo fijo.
// precioPorKg: la carta de SIGA es por kilo y la base es carta x peso de la publicación; sin peso > 0 no hay esperado (null).
function calcularEsperado(carta, unidades, envio, cuotas, cfg, pesoKg, cuotasQty, precioPorKg = false) {
  const pKg = num(pesoKg);
  if (precioPorKg && !(pKg !== null && pKg > 0)) return null;
  const E = PreciosEsquema;
  const sumaExtras = tipo => (cfg.extras || []).filter(x => x.tipo === tipo).reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const tr = tramoEnvio(cfg.tablaEnvio, pesoKg, cfg.envioMonto);
  const bonif = !!cfg.envioBonificado; // ML bonifica la mitad del envío (solo el monto)
  const envioEfectivo = bonif ? E.r2(tr.monto * 0.5) : tr.monto;
  const qty = num(cuotasQty) === null ? 1 : num(cuotasQty);
  const cuotasPct = E.r2((Number(cfg.cuotasBasePct) || 0) + recargoCuotas(cfg.tablaCuotas, qty));
  const base = E.r2(precioPorKg ? carta * pKg : carta * unidades);
  const calc = (aplicaEnvio, fijoMonto) => {
    const gastosPct = E.r2(cfg.comisionPct + (aplicaEnvio ? cfg.envioGratisPct || 0 : 0) + cuotasPct + (cfg.impuestosPct || 0) + sumaExtras('%'));
    const gastosFijos = E.r2((aplicaEnvio ? envioEfectivo : 0) + fijoMonto + sumaExtras('$'));
    const exacto = E.costoConGastos(E.r2(base + gastosFijos), gastosPct, 'precio');
    return { gastosPct, gastosFijos, esperado: exacto == null ? null : E.redondearMultiplo(exacto, cfg.redondeoPaso) };
  };
  const ref = calc(false, 0).esperado;
  const cf = ref == null ? { monto: Number(cfg.costoFijoMonto) || 0, precioMax: null, origen: 'defecto' } : tramoCostoFijo(cfg.tablaCostoFijo, ref, cfg.costoFijoMonto);
  const gratis = envio === 'gratis';
  const umbral = Number(cfg.envioGratisDesde) || 0;
  const porUmbral = !gratis && umbral > 0 && ref != null && ref >= umbral;
  const aplica = gratis || porUmbral;
  const r = calc(aplica, cf.monto);
  return {
    carta, unidades, envio, cuotas, base, precioPorKg: !!precioPorKg, pesoKg: pKg, envioMonto: aplica ? envioEfectivo : 0, envioMontoLista: aplica ? tr.monto : 0, envioBonificado: aplica && bonif, envioTopeKg: aplica ? tr.topeKg : null, envioOrigen: aplica ? tr.origen : null, envioPorUmbral: porUmbral,
    cuotasQty: qty, cuotasPct, costoFijoTabla: cf.monto, costoFijoPrecioMax: cf.precioMax, costoFijoOrigen: cf.origen, ...r,
  };
}

const fmtKg = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });
const filaDesglose = (txt, det, monto, clase) => `<tr${clase ? ` class="${clase}"` : ''}><td>${txt}</td><td class="det">${det || ''}</td><td>${monto}</td></tr>`;
const filaSec = txt => `<tr class="sec"><td colspan="3">${txt}</td></tr>`;

// Líneas de costo en $ y en % de la publicación (según envío y cuotas). cfg puede faltar: entonces solo van los totales.
function lineasCostos(f, cfg) {
  const extras = tipo => ((cfg && cfg.extras) || []).filter(x => x.tipo === tipo && Number(x.valor) > 0).map(x => [escHtml(x.nombre || 'Extra'), Number(x.valor)]);
  const gratis = f.envio === 'gratis' || !!f.envioPorUmbral;
  const cfgFijo = !cfg ? 0 : f.costoFijoOrigen === 'tabla' ? Number(f.costoFijoTabla) || 0 : Number(cfg.costoFijoMonto) || 0;
  const cuotasTot = Number(f.cuotasPct ?? f.cuotasTotalPct) || 0;
  const cuotasBase = cfg ? Number(cfg.cuotasBasePct) || 0 : 0;
  const pctTxt = n => `${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })} %`;
  const fijos = cfg ? [
    ...(gratis && f.envioMonto > 0 ? [[(f.envioOrigen === 'tabla' ? `Envío (hasta ${escHtml(f.envioTopeKg)} kg)` : 'Envío (por defecto)') + (f.envioBonificado ? ` &middot; 50 % bonificado (lista ${fmtMoney(f.envioMontoLista)})` : '') + (f.envioPorUmbral ? ' &middot; por umbral de envío gratis' : ''), f.envioMonto]] : []),
    ...(cfgFijo > 0 ? [[f.costoFijoOrigen === 'tabla' ? `Cargo fijo (hasta ${fmtMoney(f.costoFijoPrecioMax)})` : f.costoFijoOrigen ? 'Cargo fijo (sin tramo)' : 'Cargo fijo de ML', cfgFijo]] : []),
    ...extras('$'),
  ] : [];
  const pcts = cfg ? [
    ['Comisión por venta', cfg.comisionPct],
    ...(gratis && cfg.envioGratisPct > 0 ? [['Envío gratis (heredado)', cfg.envioGratisPct]] : []),
    [`Cuotas ${escHtml(f.cuotasQty ?? 1)} (${pctTxt(cuotasBase)} + ${pctTxt(Math.max(0, cuotasTot - cuotasBase))})`, cuotasTot],
    ['Impuestos', cfg.impuestosPct || 0],
    ...extras('%'),
  ].filter(([, v]) => v > 0) : [];
  const ok = (arr, total) => Math.abs(arr.reduce((s, [, v]) => s + v, 0) - total) < 0.01;
  return {
    fijos: ok(fijos, f.gastosFijos) ? fijos : [['Costos fijos (total)', f.gastosFijos]],
    pcts: ok(pcts, f.gastosPct) ? pcts : [['Gastos (total)', f.gastosPct]],
  };
}

// Desglose: precio SIGA, un solo bloque de gastos (cada uno en $ sobre el esperado), esperado y control de la regla.
// siempreEnvio (simulador): muestra el envío aunque no aplique ("no aplica", $0).
function desgloseHtml(f, cfg, siempreEnvio) {
  if (f.esperado == null) return '<p class="empty">Los porcentajes de gastos suman 100 % o más: no hay un precio posible. Revisá Costos.</p>';
  const { fijos, pcts } = lineasCostos(f, cfg);
  const lineasFijas = siempreEnvio && !(f.envioMonto > 0) ? [['Envío &mdash; no aplica', 0], ...fijos] : fijos;
  const totalGastos = f.esperado * f.gastosPct / 100 + f.gastosFijos;
  const ajuste = f.esperado - f.base - totalGastos; // lo que deja el redondeo del esperado
  const filas = [
    filaSec('Precio SIGA'),
    f.precioPorKg
      ? filaDesglose(`Precio SIGA por kg &times; peso <span class="t-gris">${fmtMoney2(f.carta)} /kg &times; ${escHtml(fmtKg(f.pesoKg))} kg</span>`, '', fmtMoney2(f.base), 'sub')
      : filaDesglose(`Carta SIGA <span class="t-gris">${fmtMoney2(f.carta)} &times; ${fmtInt(f.unidades)} un.</span>`, '', fmtMoney2(f.base), 'sub'),
    filaSec('Gastos (sobre el precio esperado)'),
  ];
  for (const [nombre, v] of pcts) filas.push(filaDesglose(nombre, fmtPct(v), '+' + fmtMoney2(f.esperado * v / 100)));
  for (const [nombre, v] of lineasFijas) filas.push(filaDesglose(nombre, '', '+' + fmtMoney2(v)));
  filas.push(filaDesglose('Total gastos', f.gastosPct > 0 ? fmtPct(f.gastosPct) : '', fmtMoney2(totalGastos), 'sub'));
  if (Math.abs(ajuste) >= 0.005) filas.push(filaDesglose('Redondeo', '', signo(ajuste) + fmtMoney2(Math.abs(ajuste))));
  filas.push(filaDesglose('Precio esperado en ML', '', fmtMoney2(f.esperado), 'tot'));
  // Control de la regla: precio final - comisiones ~ precio SIGA.
  filas.push(filaSec('Control de la regla'));
  filas.push(filaDesglose(f.precioPorKg ? 'Precio SIGA (por kg &times; peso)' : 'Precio SIGA (carta &times; unidades)', '', fmtMoney2(f.base)));
  filas.push(filaDesglose('Neto tras comisiones', '', fmtMoney2(f.esperado - totalGastos), 'sub'));
  return `<table class="desglose"><tbody>${filas.join('')}</tbody></table>`;
}

// ── Diálogo de una publicación ───────────────────────────────────────────────
const NOTAS_ESTADO = {
  sin_vincular: 'Todavía no está vinculada a un producto de SIGA, así que no hay precio esperado. Vinculala desde la fila.',
  sin_carta: 'El producto vinculado no tiene precio de carta en SIGA (lista minorista). Cargalo en SIGA o revisá el código.',
  sin_precio: 'La publicación no tiene precio en la bajada de ML.',
  sin_peso: 'Falta el peso de la publicación (el precio de SIGA es por kg). Cargalo en Editar; el estimado "~" también sirve.',
};

function abrirDetalle(id) {
  const f = ((datos && datos.filas) || []).find(x => String(x.id) === String(id));
  if (!f) return;
  $('dlg-tit').textContent = f.titulo || f.id;
  $('dlg-sub').textContent = [f.id, f.nombreProducto && `${f.nombreProducto} (cód. ${f.codigo} × ${f.unidades}${f.precioPorKg ? ', precio por kg' : ''})`, ENVIO[f.envio], num(f.cuotasQty) > 1 && `${f.cuotasQty} cuotas`].filter(Boolean).join(' · ');
  const d = num(f.desvioPct);
  const dif = num(f.esperado) !== null && num(f.precioMl) !== null ? f.precioMl - f.esperado : null;
  const claseDif = f.estado === 'ok' ? 't-ok' : f.estado === 'desviada' ? 't-crit' : '';
  let html = `<div class="comparar">
    <div><div class="l">Precio en ML</div><div class="v">${num(f.precioMl) === null ? '-' : fmtMoney(f.precioMl)}</div></div>
    <div><div class="l">Esperado</div><div class="v">${num(f.esperado) === null ? '-' : fmtMoney(f.esperado)}</div></div>
    <div><div class="l">Diferencia</div><div class="v ${claseDif}">${dif === null ? '-' : fmtDif(dif)}</div><div class="text-xs ${claseDif}">${d === null ? '' : signo(d) + fmtPct(Math.abs(d))}</div></div>
  </div>`;
  if (f.precioPromo) html += `<p class="text-sm t-gris mb-3">Hay promo activa: se compara el precio promocional (${fmtMoney(f.precioPromo)}) y no el de lista (${fmtMoney(f.precioLista)}).</p>`;
  if (f.estado === 'desviada') html += `<div class="mb-3"><button type="button" class="btn btn-primario" data-copiar="${escHtml(f.id)}">Copiar precio sugerido (${fmtMoney(f.esperado)})</button></div>`;
  html += num(f.esperado) !== null ? desgloseHtml(f, config) : `<p class="empty">${escHtml(NOTAS_ESTADO[f.estado] || 'No se pudo calcular el esperado.')}</p>`;
  $('dlg-cuerpo').innerHTML = html;
  $('dlg-calc').showModal();
}

$('dlg-cerrar').addEventListener('click', () => $('dlg-calc').close());
$('dlg-calc').addEventListener('click', e => { if (e.target === $('dlg-calc')) $('dlg-calc').close(); }); // clic en el fondo
$('dlg-cuerpo').addEventListener('click', e => {
  const b = e.target.closest('[data-copiar]');
  if (b) copiarPrecioSugerido(b.dataset.copiar, b);
});
