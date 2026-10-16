const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { packagingDeRegistro, esSoloEtiquetado } = require('../lib/produccion_packaging');

// ── Packaging que descuenta una carga (envase / tapa / etiqueta) ──────────────
// La carga guarda las cantidades con el CantPorUnidad de la fórmula; la conciliación las lee de
// ahí y sólo recalcula (1 por unidad / fórmula actual) para las cargas viejas que no las tienen.

const ENV = { rol: 'Envasado', nombre: 'Ana' };
const ETQ = { rol: 'Etiquetado', nombre: 'Karen' };
const FORMULA = [{ plu: '9614', nombre: 'Etiqueta Vinagre', rubro: 'ETIQUETAS', cantPorUnidad: 1 }];

test('usa las cantidades guardadas en la carga (factor distinto de 1)', () => {
  // Arrange: 100 u con 2 envases y 2 etiquetas por unidad, ya calculados al guardar.
  const reg = { plu: '5298', cantFraccionada: 100, roles: [ENV, ETQ],
                envase: '700', envaseNombre: 'Envase 1L', cantEnvase: 200,
                tapa: '800', tapaNombre: 'Tapa', cantTapa: 100,
                etiqueta: '9614', etiquetaNombre: 'Etiqueta Vinagre', cantEtiqueta: 200 };

  // Act: la fórmula actual dice 1 por unidad, pero manda lo guardado.
  const { lineas } = packagingDeRegistro(reg, FORMULA);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.tipo, l.plu, l.cantidad]),
    [['envase', '700', 200], ['tapa', '800', 100], ['etiqueta', '9614', 200]]);
});

test('carga sólo de Etiquetado: consume la etiqueta y nada de envase/tapa', () => {
  // Arrange: caso real PLU 5298 (vinagre), 1100 u, sólo Etiquetado:Karen.
  const reg = { plu: '5298', cantFraccionada: 1100, ordenId: null, roles: [ETQ], envase: '700', tapa: '800' };

  // Act
  const { lineas } = packagingDeRegistro(reg, FORMULA);

  // Assert
  assert.strictEqual(esSoloEtiquetado(reg), true);
  assert.deepStrictEqual(lineas.map(l => [l.tipo, l.plu, l.cantidad]), [['etiqueta', '9614', 1100]]);
});

test('carga vieja sin cantidades: envase/tapa 1 por unidad y etiqueta de la fórmula actual', () => {
  // Arrange
  const reg = { plu: '5298', cantFraccionada: 50, roles: [ENV, ETQ], envase: '700', tapa: '800' };
  const formula = [{ ...FORMULA[0], cantPorUnidad: 2 }];

  // Act
  const { lineas, sinEtiqueta } = packagingDeRegistro(reg, formula);

  // Assert
  assert.strictEqual(sinEtiqueta, false);
  assert.deepStrictEqual(lineas.map(l => [l.tipo, l.cantidad]), [['envase', 50], ['tapa', 50], ['etiqueta', 100]]);
});

test('sin Etiquetado no hay etiqueta, y la tarea extra no es sólo-Etiquetado', () => {
  // Arrange / Act
  const { lineas } = packagingDeRegistro({ plu: '1', cantFraccionada: 10, roles: [ENV, { rol: 'Etiquetado', nombre: ' ' }] }, FORMULA);

  // Assert
  assert.deepStrictEqual(lineas, []);
  assert.strictEqual(esSoloEtiquetado({ plu: 'ACT', roles: [ETQ] }), false);
});

// ── Guardado desde el modal de carga (función inline del HTML) ─────────────────
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'apidelta_produccion_dia.html'), 'utf8');
function fuenteDe(nombre) {
  const ini = HTML.indexOf(`function ${nombre}(`);
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  let nivel = 0, visto = false;
  for (let i = ini; i < HTML.length; i++) {
    if (HTML[i] === '{') { nivel++; visto = true; }
    else if (HTML[i] === '}') { nivel--; if (visto && nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`no se pudo cerrar function ${nombre}(`);
}
function lineaDe(nombre) {
  const ini = HTML.indexOf(`const ${nombre} =`);
  assert.notStrictEqual(ini, -1, `no se encontró const ${nombre}`);
  return HTML.slice(ini, HTML.indexOf('\n', ini));
}
const pfPackagingGuardado = new Function('_pfPackPorElem', [
  fuenteDe('_tieneRolCarga'), lineaDe('_esEtiquetaComp'), fuenteDe('_pfPackagingGuardado'),
  'return _pfPackagingGuardado;'].join('\n'));

test('al guardar, el envase elegido fuera de la fórmula toma el factor del que reemplaza', () => {
  // Arrange: la fórmula lleva 2 envases 700 por unidad; se eligió el 701 (no está en la fórmula).
  const comps = [
    { IdComponente: 700, Componente: 'Envase A', Rubro: 'ENVASES', CantPorUnidad: '2' },
    { IdComponente: 9614, Componente: 'Etiqueta Vinagre', Rubro: 'ETIQUETAS', CantPorUnidad: '3' },
  ];
  const fn = pfPackagingGuardado([{ comps, sugerido: { envase: { codigo: 700 } } }]);

  // Act
  const conEtq = fn({ eidx: 0, envase: '701', tapa: '' }, 10, [ENV, ETQ]);
  const sinEtq = fn({ eidx: 0, envase: '701', tapa: '999' }, 10, [ENV]);

  // Assert
  assert.deepStrictEqual(conEtq, { cantEnvase: 20, etiqueta: '9614', etiquetaNombre: 'Etiqueta Vinagre', cantEtiqueta: 30 });
  assert.deepStrictEqual(sinEtq, { cantEnvase: 20, cantTapa: 10 });   // tapa desconocida → 1 por unidad
});
