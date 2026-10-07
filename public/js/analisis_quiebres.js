// Pestaña Quiebres del Análisis de Ventas: sólo los productos con algún día en quiebre, con
// el total sumado de las sucursales tildadas y una columna por sucursal. Se carga antes que
// analisis_front.js, que declara la pestaña en PANELES y le pasa la respuesta a quiPintar;
// los helpers de ese archivo ($, fmtNum, escHtml, cmpValores...) se usan recién al pintar,
// cuando ya están definidos.
let qui = { rows: [], sucursales: [], filtro: '', key: 'dias', desc: true };

function quiPintar(d){
  qui = { ...qui, rows: d.productos || [], sucursales: d.sucursales || [], filtro: '' };
  $('buscTop-qui').value = '';
  const dias = qui.rows.reduce((a, r) => a + (r.dias || 0), 0);
  $('kpis-qui').innerHTML = [
    ['Productos con quiebre', fmtNum(qui.rows.length)],
    ['Días-sucursal en quiebre', fmtNum(dias)],
  ].map(([lbl, val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`).join('');
  quiTabla();
}

// Valor por el que ordena cada columna: 'nombre', 'dias' (total) o el id de una sucursal.
// La sucursal que no trabajó el producto (null) va al fondo en el orden descendente.
function quiValor(r, key){
  if (key === 'nombre') return r.nombre;
  if (key === 'dias') return r.dias;
  if (key === 'facturacion') return r.facturacion;
  const s = r.porSucursal[key];
  return s ? s.dias : -1;
}

// Primer clic en una columna numérica ordena de más a menos; de nuevo sobre la misma, invierte.
function quiOrdenar(key){
  qui = { ...qui, desc: qui.key === key ? !qui.desc : key !== 'nombre', key };
  quiTabla();
}

function quiBuscar(texto){
  qui = { ...qui, filtro: texto };
  quiTabla();
}

function quiCelda(s){
  if (!s) return '<td class="num sin-dato" title="No vendió ni tuvo stock del producto en el rango">—</td>';
  return `<td class="num ${s.dias ? 'quiebre' : ''}">${fmtNum(s.dias)}<span class="pct">${fmtDec(s.porc)}%</span></td>`;
}

function quiTh(key, etiqueta, clase){
  const activa = qui.key === key;
  const flecha = activa ? (qui.desc ? ' ▼' : ' ▲') : '';
  return `<th class="orden ${clase}${activa ? ' activa' : ''}" onclick="quiOrdenar('${key}')">${escHtml(etiqueta)}${flecha}</th>`;
}

function quiTabla(){
  const el = $('tblQuiebres-qui');
  const terminos = normalizarBusqueda(qui.filtro).split(/\s+/).filter(Boolean);
  const signo = qui.desc ? -1 : 1;
  const filas = qui.rows
    .filter(r => terminos.every(t => normalizarBusqueda(r.nombre).includes(t)))
    .sort((a, b) => signo * cmpValores(quiValor(a, qui.key), quiValor(b, qui.key)));
  if (!filas.length){
    el.innerHTML = `<div class="empty">${qui.filtro ? 'Ningún producto coincide con la búsqueda.' : 'Ningún producto tuvo quiebres en el rango.'}</div>`;
    return;
  }
  const nombreSuc = id => (SUCURSALES.find(s => s.id === id) || {}).nombre || `Suc. ${id}`;
  const cuerpo = filas.map((r, i) => `<tr>
      <td class="num">${fmtNum(i + 1)}</td>
      <td>${escHtml(r.nombre)}</td>
      <td>${escHtml(r.rubro)}</td>
      <td class="num">${fmtMoney(r.facturacion)}</td>
      <td class="num quiebre" title="${fmtNum(r.dias)} días-sucursal en quiebre de ${fmtNum(r.base)} evaluados: los días del rango sin domingos, sumados por cada sucursal que vendió o tuvo stock del producto (6 días × 7 sucursales = 42)">${fmtNum(r.dias)}<span class="pct">${fmtDec(r.porc)}%</span></td>
      ${qui.sucursales.map(s => quiCelda(r.porSucursal[s])).join('')}
    </tr>`).join('');
  el.innerHTML = `<table><thead><tr>
      <th class="num">#</th>
      ${quiTh('nombre', 'Producto', '')}
      <th>Rubro</th>
      ${quiTh('facturacion', 'Facturación', 'num')}
      ${quiTh('dias', 'Total', 'num')}
      ${qui.sucursales.map(s => quiTh(String(s), nombreSuc(s), 'num')).join('')}
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
}
