// Pestaña Rotación del Análisis de Ventas: un puntaje 0..100 por producto que dice qué tan
// dispar se vende entre las sucursales tildadas, dónde se vende más y las unidades de cada
// sucursal, con la celda pintada según el peso del producto ahí. Se carga antes que
// analisis_front.js, que declara la pestaña en PANELES y le pasa la respuesta a rotPintar;
// los helpers de ese archivo ($, fmtNum, escHtml, cmpValores, SUCURSALES...) se usan recién
// al pintar, cuando ya están definidos.
let rot = { rows: [], sucursales: [], filtro: '', key: 'puntaje', desc: true };
// Umbral del KPI "muy dispares": a partir de acá la diferencia entre sucursales es marcada.
const ROT_PUNTAJE_ALTO = 50;

function rotPintar(d){
  rot = { ...rot, rows: d.productos || [], sucursales: d.sucursales || [], filtro: '' };
  $('buscTop-rot').value = '';
  $('kpis-rot').innerHTML = [
    ['Productos analizados', fmtNum(rot.rows.length)],
    [`Puntaje ≥ ${ROT_PUNTAJE_ALTO}`, fmtNum(rot.rows.filter(r => r.puntaje >= ROT_PUNTAJE_ALTO).length)],
  ].map(([lbl, val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`).join('');
  rotTabla();
}

function rotNombreSuc(id){
  return (SUCURSALES.find(s => s.id === Number(id)) || {}).nombre || `Suc. ${id}`;
}

// Pesables con un decimal (son kilos); el resto en unidades enteras.
function rotCant(n, pesable){
  return pesable ? fmtDec(n) : fmtNum(n);
}

function rotValor(r, key){
  if (key === 'nombre') return r.nombre;
  if (key === 'unidades') return r.unidades;
  return r.puntaje;
}

// Primer clic en una columna numérica ordena de más a menos; de nuevo sobre la misma, invierte.
function rotOrdenar(key){
  rot = { ...rot, desc: rot.key === key ? !rot.desc : key !== 'nombre', key };
  rotTabla();
}

function rotBuscar(texto){
  rot = { ...rot, filtro: texto };
  rotTabla();
}

// Búsqueda y orden vigentes. Lo usan la tabla y el Excel: se descarga lo que se ve.
function rotFilas(){
  const terminos = normalizarBusqueda(rot.filtro).split(/\s+/).filter(Boolean);
  const signo = rot.desc ? -1 : 1;
  return rot.rows
    .filter(r => terminos.every(t => normalizarBusqueda(r.nombre).includes(t)))
    .sort((a, b) => signo * cmpValores(rotValor(a, rot.key), rotValor(b, rot.key)));
}

function rotTh(key, etiqueta, clase){
  const activa = rot.key === key;
  const flecha = activa ? (rot.desc ? ' ▼' : ' ▲') : '';
  return `<th class="orden ${clase}${activa ? ' activa' : ''}" onclick="rotOrdenar('${key}')">${escHtml(etiqueta)}${flecha}</th>`;
}

// Verde del theme (--green, #405936) con más opacidad cuanto más alto el valor (0..1). El
// piso hace que hasta lo más bajo se distinga del blanco de una celda vacía.
function rotVerde(valor){
  return `rgba(64,89,54,${(0.08 + 0.55 * valor).toFixed(2)})`;
}

function rotPill(puntaje){
  const v = (puntaje || 0) / 100;
  const texto = v > 0.55 ? '#fff' : 'var(--green-dark)';
  return `<span class="rot-pill" style="background:${rotVerde(v)};color:${texto}">${fmtNum(puntaje)}</span>`;
}

function rotCelda(c, pesable){
  if (!c || !c.unidades) return '<td class="num sin-dato">—</td>';
  const titulo = `Facturación: ${fmtMoney(c.facturacion)}\nParticipación: ${fmtDec(c.participacion * 100)}% de lo que factura la sucursal`;
  return `<td class="num" style="background:${rotVerde(c.intensidad)}" title="${escHtml(titulo)}">${rotCant(c.unidades, pesable)}</td>`;
}

function rotTabla(){
  const el = $('tblRotacion-rot');
  if (rot.sucursales.length < 2){
    el.innerHTML = '<div class="empty">Tildá al menos 2 sucursales para comparar.</div>';
    return;
  }
  const filas = rotFilas();
  if (!filas.length){
    el.innerHTML = `<div class="empty">${rot.filtro ? 'Ningún producto coincide con la búsqueda.' : 'No hay productos con ventas suficientes en el rango.'}</div>`;
    return;
  }
  const cuerpo = filas.map((r, i) => `<tr>
      <td class="num">${fmtNum(i + 1)}</td>
      <td>${escHtml(r.nombre)}</td>
      <td class="num">${rotPill(r.puntaje)}</td>
      <td>${escHtml(rotNombreSuc(r.masVende.suc))} <span class="rot-porc">${fmtNum(r.masVende.porc)}%</span></td>
      <td class="num">${rotCant(r.unidades, r.pesable)}</td>
      ${rot.sucursales.map(s => rotCelda(r.porSucursal[s], r.pesable)).join('')}
    </tr>`).join('');
  el.innerHTML = `<table><thead><tr>
      <th class="num">#</th>
      ${rotTh('nombre', 'Producto', '')}
      ${rotTh('puntaje', 'Puntaje', 'num')}
      <th>Se vende más en</th>
      ${rotTh('unidades', 'Unidades', 'num')}
      ${rot.sucursales.map(s => `<th class="num">${escHtml(rotNombreSuc(s))}</th>`).join('')}
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
}

// Números sin formatear para que Excel pueda sumarlos.
function rotExportar(){
  const filas = rotFilas();
  if (!filas.length){ apdAvisar('No hay productos para exportar con la búsqueda actual.'); return; }
  const encabezado = ['Producto', 'Rubro', 'Puntaje', 'Se vende más en',
    ...rot.sucursales.map(s => `${rotNombreSuc(s)} unidades`)];
  const cuerpo = filas.map(r => [
    r.nombre, r.rubro, r.puntaje ?? '', rotNombreSuc(r.masVende.suc),
    ...rot.sucursales.map(s => (r.porSucursal[s] || {}).unidades || 0),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezado, ...cuerpo]), 'Rotación');
  const rango = `${$('desde').value || ''}_${$('hasta').value || ''}`;
  XLSX.writeFile(wb, `rotacion_${rango}.xlsx`);
}
