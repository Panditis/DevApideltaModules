'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { parsearTipoProveedor, main } = require('../scripts/importar_tipo_proveedor');

// Libro en memoria como el del usuario: hoja "Listado", encabezado [PLU, Nombre, null], C = Directo | Distribuidor.
const libro = (filas, hoja = 'Listado') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['PLU', 'Nombre', null], ...filas]), hoja);
  return wb;
};
const FILAS = [[1, 'Arroz', 'Directo'], ['22', 'Yerba', 'distribuidor'], [333, 'Té', ' DISTRIBUÍDOR '], [4, 'Sin tipo', null],
  ['x', 'PLU roto', 'Directo'], [5, 'Otro', 'Mayorista'], [6.5, 'Decimal', 'Directo']];

test('parsearTipoProveedor: col A PLU, col C directo/distribuidor (sin mayúsculas ni tildes); inválidas con su fila de Excel', () => {
  const r = parsearTipoProveedor(libro(FILAS));
  assert.deepStrictEqual(r.tipos, { 1: 'directo', 22: 'distribuidor', 333: 'distribuidor' });
  assert.deepStrictEqual(r.invalidas.map(i => i.fila), [5, 6, 7, 8]);
  assert.strictEqual(r.total, 7);
  assert.match(r.invalidas[1].motivo, /PLU/);
});

test('parsearTipoProveedor: sin hoja "Listado" usa la primera; PLU repetido con otro tipo → inválida', () => {
  const r = parsearTipoProveedor(libro([[1, 'A', 'Directo'], [1, 'A', 'Distribuidor'], [1, 'A', 'Directo']], 'Hoja1'));
  assert.deepStrictEqual(r.tipos, { 1: 'directo' });
  assert.deepStrictEqual(r.invalidas.map(i => i.fila), [3]);
});

test('main: escribe costeo.tipoProveedor (merge), backup una vez, tmp+rename, idempotente; conteos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipo-prov-'));
  const xlsx = path.join(dir, 'busca.xlsx');
  const costeo = path.join(dir, 'costeo.json');
  XLSX.writeFile(libro(FILAS), xlsx);
  fs.writeFileSync(costeo, JSON.stringify({ toleranciaPct: 3, tipoProveedor: { 9: 'directo', 1: 'distribuidor' } }));
  const r1 = main(xlsx, costeo);
  assert.deepStrictEqual([r1.directo, r1.distribuidor, r1.invalidas.length, r1.total, r1.cambios], [1, 2, 4, 7, 3]);
  const c = JSON.parse(fs.readFileSync(costeo, 'utf8'));
  assert.deepStrictEqual(c, { toleranciaPct: 3, tipoProveedor: { 9: 'directo', 1: 'directo', 22: 'distribuidor', 333: 'distribuidor' } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${costeo}.bak-tipo-proveedor`, 'utf8')).tipoProveedor, { 9: 'directo', 1: 'distribuidor' });
  assert.ok(!fs.existsSync(`${costeo}.tmp`));
  const r2 = main(xlsx, costeo);
  assert.strictEqual(r2.cambios, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(costeo, 'utf8')), c);
});

test('main: costeo.json ausente o roto → error sin escribir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipo-prov-'));
  const xlsx = path.join(dir, 'busca.xlsx');
  XLSX.writeFile(libro(FILAS), xlsx);
  assert.throws(() => main(xlsx, path.join(dir, 'no.json')), /no existe/);
  fs.writeFileSync(path.join(dir, 'roto.json'), '{');
  assert.throws(() => main(xlsx, path.join(dir, 'roto.json')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'roto.json'), 'utf8'), '{');
});
