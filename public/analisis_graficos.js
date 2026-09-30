// Gráficos del módulo de Análisis de Ventas: la torta de artículos por ticket, las barras
// de día y hora, y la tendencia diaria con su lectura mes contra mes. Se carga antes que
// analisis_front.js, que es quien las llama al pintar cada pestaña.

// Blanco sobre los tonos oscuros y gris oscuro sobre los claros: sobre el amarillo el
// texto blanco no se lee. Umbral de luminancia percibida (ITU-R BT.601).
function textoSobre(hex){
  const n = parseInt(String(hex).replace('#',''), 16);
  const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return lum > 150 ? '#1C1B1F' : '#FFFFFF';
}

// Chart.js 4 no trae datalabels y no se puede sumar un plugin por CDN, así que la etiqueta
// y el porcentaje se dibujan a mano dentro de cada porción (por eso la leyenda externa está
// apagada). En porciones muy finas no entra el texto: primero se cae la etiqueta y después
// el porcentaje, que igual siguen disponibles en el tooltip.
const PCT_MIN_PORCENTAJE = 3;
const PCT_MIN_ETIQUETA = 7;
const pluginPorcentajes = {
  id: 'porcentajes',
  afterDatasetsDraw(chart){
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    const ds = chart.data.datasets[0];
    const datos = ds.data || [];
    const total = datos.reduce((a, v) => a + (Number(v) || 0), 0);
    if (!total) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    meta.data.forEach((arco, i) => {
      const pct = (Number(datos[i]) || 0) * 100 / total;
      if (pct < PCT_MIN_PORCENTAJE) return;
      const { x, y } = arco.getCenterPoint();
      const conEtiqueta = pct >= PCT_MIN_ETIQUETA;
      ctx.fillStyle = textoSobre(ds.backgroundColor[i]);
      if (conEtiqueta) {
        ctx.font = 'bold 14px Inter, system-ui, sans-serif';
        ctx.fillText(String(chart.data.labels[i]), x, y - 9);
        ctx.font = '13px Inter, system-ui, sans-serif';
        ctx.fillText(`${fmtDec(pct)}%`, x, y + 9);
      } else {
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.fillText(`${fmtDec(pct)}%`, x, y);
      }
    });
    ctx.restore();
  }
};

// ── Tendencia ────────────────────────────────────────────────────────────────
// Media móvil centrada, para alisar antes de buscar la tendencia. La venta diaria tiene dos
// ciclos fuertes —el semanal y el intramensual (arranca alta con el cobro y cae al cierre)—
// y ajustar la recta sobre la serie cruda hace que esos ciclos manden por encima del rumbo
// real: dos meses que suben uno respecto del otro pueden dar pendiente negativa si cada uno
// baja por dentro. Los bordes usan la ventana que alcanza, así la serie no se acorta.
const VENTANA_SUAVIZADO = 7;
function mediaMovil(serie, ventana = VENTANA_SUAVIZADO){
  const radio = Math.floor(ventana / 2);
  return serie.map((_v, i) => {
    const tramo = serie.slice(Math.max(0, i - radio), Math.min(serie.length, i + radio + 1));
    return tramo.reduce((a, v) => a + v, 0) / tramo.length;
  });
}

// La tendencia se mide mes contra mes, no día contra día. Dentro de un mes la venta dibuja
// una U: pico de cobro al arrancar, valle al medio, otro pico al cerrar. Con esa forma el
// signo de cualquier ajuste sobre la serie diaria lo decide cuál de los dos picos es más
// alto, no si el negocio crece: medido sobre un mes sintético con la apertura 8% más pesada
// que el cierre, la recta da −8,82% y la comparación entre mitades −4,62%, sobre un mes que
// puede estar 6% arriba del anterior. Comparar el promedio diario de un mes calendario
// contra el de otro no tiene ese problema: cada mes contiene un ciclo de cobro completo.
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Un mes con pocos días en el rango es un pedazo de ciclo, no un mes: entra recortado por
// donde cayó el filtro y su promedio diario no es comparable. Se descarta y se avisa.
const MIN_DIAS_MES = 10;

function nombreMes(clave){
  const [anio, mes] = String(clave).split('-');
  return `${NOMBRE_MES[Number(mes) - 1] || clave} ${anio}`;
}

// Promedio diario por mes calendario, en orden cronológico. Por día y no por total: los meses
// traen distinta cantidad de días hábiles y los domingos cerrados ni siquiera aparecen.
function promediosPorMes(rows){
  const porMes = new Map();
  (rows || []).forEach(r => {
    const mes = String(r.fecha).slice(0, 7);
    const acc = porMes.get(mes) || { total: 0, dias: 0 };
    porMes.set(mes, { total: acc.total + Number(r.facturacion || 0), dias: acc.dias + 1 });
  });
  return [...porMes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([mes, v]) => ({ mes, dias: v.dias, promedio: v.total / v.dias }));
}

// Variación del promedio diario entre el primer y el último mes completo del rango. Con dos
// meses es la comparación mes a mes; con más, el recorrido punta a punta del período.
function tendenciaMensual(rows){
  const todos = promediosPorMes(rows);
  const meses = todos.filter(m => m.dias >= MIN_DIAS_MES);
  const descartados = todos.filter(m => m.dias < MIN_DIAS_MES);
  if (meses.length < 2) return { meses, descartados, variacion: null };
  const primero = meses[0], ultimo = meses[meses.length - 1];
  return {
    meses, descartados, primero, ultimo,
    variacion: primero.promedio > 0 ? (ultimo.promedio - primero.promedio) * 100 / primero.promedio : null,
  };
}

// Recta de tendencia por mínimos cuadrados sobre los días que devuelve la consulta (los que
// facturaron). Devuelve el valor ajustado de cada día: es la recta que mejor sigue la serie,
// así se ve si el rango viene subiendo o cayendo, cosa que un promedio plano no muestra.
// Con menos de dos días no hay recta posible y se devuelve vacío.
function rectaTendencia(serie){
  const n = serie.length;
  if (n < 2) return [];
  const sumX = n * (n - 1) / 2;
  const sumY = serie.reduce((a, v) => a + v, 0);
  const sumXY = serie.reduce((a, v, i) => a + i * v, 0);
  const sumXX = serie.reduce((a, _v, i) => a + i * i, 0);
  const denom = n * sumXX - sumX * sumX;
  if (!denom) return [];
  const pendiente = (n * sumXY - sumX * sumY) / denom;
  const inicio = (sumY - pendiente * sumX) / n;
  return serie.map((_v, i) => inicio + pendiente * i);
}

// Debajo de medio punto se llama estable: con esa diferencia el mes no se movió.
function rumboTendencia(variacion){
  if (variacion === null || Math.abs(variacion) < 0.5) return { txt:'estables', color: MUTED };
  return variacion > 0 ? { txt:'↑ subiendo', color: GREEN_UP } : { txt:'↓ bajando', color: RED_DOWN };
}

// Bajo el gráfico: el veredicto y de dónde sale. Se muestran los dos promedios diarios que
// se compararon, para que el porcentaje sea auditable sin tener que creerle.
function pintarResumenTendencia(tend, pref){
  const el = $(`tendResumen-${pref}`);
  if (!el) return;
  const aviso = tend.descartados.length
    ? ` <span class="nota">No entra ${tend.descartados.map(m => nombreMes(m.mes)).join(' ni ')}:
        el rango lo corta (menos de ${MIN_DIAS_MES} días).</span>` : '';
  if (tend.variacion === null){
    el.innerHTML = `El rango no llega a dos meses completos: dentro de un mes
      manda el ciclo de cobro, no la tendencia. Ampliá el rango para medirla.${aviso}`;
    return;
  }
  const v = tend.variacion, rumbo = rumboTendencia(v);
  const signo = v > 0 ? '+' : '';
  el.innerHTML = `Las ventas vienen <b style="color:${rumbo.color}">${rumbo.txt}</b>:
    ${nombreMes(tend.ultimo.mes)} vs ${nombreMes(tend.primero.mes)}
    <b style="color:${rumbo.color}">${signo}${fmtDec(v)}%</b>
    (${fmtMoney(tend.primero.promedio)} → ${fmtMoney(tend.ultimo.promedio)} por día).${aviso}`;
}

// altoFijo: el gráfico va dentro de un .chart-box (alto por CSS, no por relación de
// aspecto). Sólo lo usa la pestaña de la central, donde la tendencia ocupa todo el ancho.
// "Excluir sábados": el sábado vende muy distinto al resto y deforma la curva. Se guardan las
// filas de la última consulta para repintar al tildar sin volver a pedir datos. Sin sábados
// cambian también la media móvil, la recta y el veredicto mensual (promedio por día hábil).
const tendenciaCargada = {};
function esSabado(fecha){
  return new Date(`${String(fecha).slice(0, 10)}T00:00:00Z`).getUTCDay() === 6;
}
function repintarTendencia(pref){
  const t = tendenciaCargada[pref];
  if (t) renderTendencia(t.rows, pref, t.altoFijo);
}

function renderTendencia(rowsTodas, pref, altoFijo){
  destroyChart(`tend-${pref}`);
  tendenciaCargada[pref] = { rows: rowsTodas, altoFijo };
  const chk = $(`sinSab-${pref}`);
  const rows = chk && chk.checked ? (rowsTodas || []).filter(r => !esSabado(r.fecha)) : rowsTodas;
  const serie = (rows || []).map(r => Number(r.facturacion || 0));
  // La recta se ajusta sobre la serie alisada, no sobre la cruda: con menos días que la
  // ventana no hay nada que alisar y se usa tal cual.
  const suave = serie.length >= VENTANA_SUAVIZADO ? mediaMovil(serie) : serie;
  const recta = rectaTendencia(suave);
  // El veredicto sale de comparar meses calendario, nunca de la pendiente de la recta.
  pintarResumenTendencia(tendenciaMensual(rows), pref);
  const datasets = [
    { label:'Facturación', data: serie, borderColor: GREEN, backgroundColor:'rgba(64,89,54,.1)', fill:true, tension:.25 },
  ];
  if (recta.length){
    // La recta queda como referencia visual de la forma de la serie, en dorado neutro: si se
    // la pintara según el rumbo, una línea que baja en pantalla podría salir verde.
    datasets.push({ label:`Ajuste lineal (media móvil ${VENTANA_SUAVIZADO} días)`, data: recta,
      borderColor: YELLOW, borderDash:[6,4], borderWidth:2, pointRadius:0, pointHitRadius:0, fill:false });
  }
  charts[`tend-${pref}`] = new Chart($(`chTendencia-${pref}`), {
    type:'line',
    data:{ labels: (rows || []).map(r=>r.fecha), datasets },
    options:{
      maintainAspectRatio: !altoFijo,
      plugins:{
        // La leyenda ahora sí aporta: distingue la serie real de la recta y lleva la variación
        // del rango, que de otro modo habría que deducir mirando el dibujo.
        legend:{ display:true, position:'bottom', labels:{ boxWidth:18, boxHeight:2, font:{ size:11 } } },
        tooltip:{ callbacks:{ label: c => `${c.dataset.label.split(':')[0]}: ${fmtMoney(c.parsed.y)}` } }
      },
      scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } }
    }
  });
}

function renderDow(rows, pref){
  destroyChart(`dow-${pref}`);
  charts[`dow-${pref}`] = new Chart($(`chDow-${pref}`), {
    type:'bar',
    data:{ labels: rows.map(r=>r.nombre),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: MID }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
}

function renderHora(rows, pref){
  destroyChart(`hora-${pref}`);
  charts[`hora-${pref}`] = new Chart($(`chHora-${pref}`), {
    type:'bar',
    data:{ labels: rows.map(r=>`${r.hora}h`),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: YELLOW }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
}

function renderComparativa(rows){
  destroyChart('comp-suc');
  charts['comp-suc'] = new Chart($('chComparativa-suc'), {
    type:'bar',
    data:{ labels: rows.map(r=>r.nombre),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: GREEN }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
  $('tblComparativa-suc').innerHTML = tabla([
    {key:'nombre',label:'Sucursal'},
    {key:'facturacion',label:'Facturación',num:true,fmt:fmtMoney},
    {key:'tickets',label:'Tickets',num:true,fmt:fmtNum},
    {key:'ticketProm',label:'Ticket prom.',num:true,fmt:fmtMoney},
  ], rows);
}

