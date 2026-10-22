'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  metaDeEntrada, metaDeGranel, granelPlusDe, aplicarMetaGrupo, aplicarMetaGranel, migrarPlanificacionCentro,
} = require('../lib/plan_catalogo_meta');

const ctx = { clientes: [{ id: 7, nombre: 'Melar' }], responsables: [{ nombre: 'Ana', corto: 'ANA' }, { nombre: 'Juan', corto: 'JUAN' }] };

test('metaDeEntrada: defaults desde el formato viejo (true/false/objeto con reqGranel/activo)', () => {
  assert.deepStrictEqual(metaDeEntrada(undefined), { tipo: 'directo', estado: 'activo', motivo: '', clienteId: null, responsables: [], proximaFecha: null });
  assert.strictEqual(metaDeEntrada(false).estado, 'discontinuado');
  assert.strictEqual(metaDeEntrada({ activo: false }).estado, 'discontinuado');
  assert.strictEqual(metaDeEntrada({ reqGranel: true, granelPlu: '7033' }).tipo, 'granel');
  assert.strictEqual(metaDeEntrada({ tipo: 'directo', reqGranel: true }).tipo, 'directo');
  assert.strictEqual(metaDeEntrada({ estado: 'pausado', motivo: 'x' }).estado, 'pausado');
});

test('granelPlusDe: lista granelPlus o el granelPlu suelto', () => {
  assert.deepStrictEqual(granelPlusDe({ granelPlu: '9610', granelPlus: ['9610', '90739'] }), ['9610', '90739']);
  assert.deepStrictEqual(granelPlusDe({ granelPlu: ' 7033 ' }), ['7033']);
  assert.deepStrictEqual(granelPlusDe(true), []);
});

test('aplicarMetaGrupo: merge, normaliza y sincroniza activo/reqGranel sin perder campos viejos', () => {
  const out = aplicarMetaGrupo({ activo: true, granelPlu: '7033', esMiel: false, mpManual: [{ nombre: 'x' }] },
    { tipo: 'granel', responsables: ['Ana', 'Nadie', 'Ana'], proximaFecha: '2026-10-28' }, ctx);
  assert.deepStrictEqual(out, {
    activo: true, granelPlu: '7033', esMiel: false, mpManual: [{ nombre: 'x' }],
    tipo: 'granel', estado: 'activo', motivo: '', clienteId: null, responsables: ['Ana'], proximaFecha: '2026-10-28', reqGranel: true,
  });
  const directo = aplicarMetaGrupo(out, { tipo: 'directo', estado: 'discontinuado' }, ctx);
  assert.strictEqual(directo.reqGranel, undefined);
  assert.strictEqual(directo.activo, false);
  assert.strictEqual(aplicarMetaGrupo(true, {}, ctx).tipo, 'directo');
});

test('aplicarMetaGrupo: granelPlus reemplaza granelPlu/granelPlus', () => {
  assert.deepStrictEqual(granelPlusDe(aplicarMetaGrupo({ granelPlu: '1' }, { granelPlus: ['9610', '90739'] }, ctx)), ['9610', '90739']);
  const sinGranel = aplicarMetaGrupo({ granelPlu: '1' }, { granelPlus: [] }, ctx);
  assert.strictEqual(sinGranel.granelPlu, undefined);
  assert.strictEqual(sinGranel.granelPlus, undefined);
});

test('aplicarMetaGrupo: pausado limpia el motivo al reactivar', () => {
  const p = aplicarMetaGrupo({}, { estado: 'pausado', motivo: '  Falta MP ' }, ctx);
  assert.strictEqual(p.motivo, 'Falta MP');
  assert.strictEqual(aplicarMetaGrupo(p, { estado: 'activo' }, ctx).motivo, '');
});

test('aplicarMetaGrupo: errores 400 con mensaje', () => {
  const err = (patch, entrada = {}) => assert.throws(() => aplicarMetaGrupo(entrada, patch, ctx), e => e.status === 400 && e.message.length > 0);
  err({ tipo: 'otro' });
  err({ estado: 'roto' });
  err({ estado: 'pausado' });                 // sin motivo
  err({ estado: 'pausado', motivo: '   ' });
  err({ proximaFecha: '2026-02-30' });
  err({ proximaFecha: '28/10/2026' });
  err({ clienteId: 99 });
  err({ tipo: 'granel' });                    // sin granel
  err({ responsables: 'Ana' });
  err({ granelPlus: ['abc'] });
  err({ esMiel: 'si' });
  err({ activo: false });                     // campo no editable
});

test('aplicarMetaGrupo: clienteId acepta el id como texto y "" = propio', () => {
  assert.strictEqual(aplicarMetaGrupo({}, { clienteId: '7' }, ctx).clienteId, 7);
  assert.strictEqual(aplicarMetaGrupo({ clienteId: 7 }, { clienteId: '' }, ctx).clienteId, null);
});

test('aplicarMetaGranel: nombre, estado y responsables; rechaza tipo/clienteId', () => {
  assert.deepStrictEqual(aplicarMetaGranel({}, { nombre: ' Masa pepas ', responsables: ['Juan'] }, ctx),
    { nombre: 'Masa pepas', estado: 'activo', motivo: '', responsables: ['Juan'], proximaFecha: null });
  assert.throws(() => aplicarMetaGranel({}, { tipo: 'granel' }, ctx), e => e.status === 400);
  assert.deepStrictEqual(metaDeGranel(undefined), { nombre: '', estado: 'activo', motivo: '', responsables: [], proximaFecha: null });
});

test('migrarPlanificacionCentro: completa meta, crea graneles base y es idempotente', () => {
  const cfg = {
    'Apimani Clasico': { activo: true, granelPlu: '7033', granelDirecto: false, reqGranel: true },
    Apimax: true, Viejo: false,
    'Yogurt Batido': { activo: true, granelPlu: '9610', granelPlus: ['9610', '90739'], reqGranel: true },
  };
  const r = migrarPlanificacionCentro(cfg, {});
  assert.deepStrictEqual(r.gruposCfg['Apimani Clasico'], {
    activo: true, granelPlu: '7033', granelDirecto: false, reqGranel: true,
    tipo: 'granel', estado: 'activo', motivo: '', clienteId: null, responsables: [], proximaFecha: null,
  });
  assert.deepStrictEqual(r.gruposCfg.Apimax, { activo: true, tipo: 'directo', estado: 'activo', motivo: '', clienteId: null, responsables: [], proximaFecha: null });
  assert.strictEqual(r.gruposCfg.Viejo.estado, 'discontinuado');
  assert.strictEqual(r.gruposCfg.Viejo.activo, false);
  assert.deepStrictEqual(Object.keys(r.granelesBase).sort(), ['7033', '90739', '9610']);
  assert.deepStrictEqual(r.granelesBase['7033'], { nombre: '', estado: 'activo', motivo: '', responsables: [], proximaFecha: null });
  assert.ok(r.cambios > 0);
  const otra = migrarPlanificacionCentro(r.gruposCfg, r.granelesBase);
  assert.strictEqual(otra.cambios, 0);
  assert.deepStrictEqual(otra.gruposCfg, r.gruposCfg);
});

test('migrarPlanificacionCentro: no pisa graneles ni meta ya cargados', () => {
  const r = migrarPlanificacionCentro(
    { A: { tipo: 'granel', estado: 'pausado', motivo: 'x', granelPlu: '1', reqGranel: true } },
    { 1: { nombre: 'Masa', estado: 'activo', motivo: '', responsables: ['Ana'], proximaFecha: null } });
  assert.strictEqual(r.cambios, 0);
  assert.strictEqual(r.granelesBase['1'].nombre, 'Masa');
  assert.strictEqual(r.gruposCfg.A.estado, 'pausado');
});

test('migrarPlanificacionCentro: granelPlu no numérico no crea granel; una clave propia existente se conserva', () => {
  const r = migrarPlanificacionCentro(
    {
      A: { tipo: 'granel', estado: 'activo', granelPlu: 'constructor', reqGranel: true },
      B: { tipo: 'granel', estado: 'activo', granelPlu: 'abc', reqGranel: true },
      C: { tipo: 'granel', estado: 'activo', granelPlu: '7', reqGranel: true },
    },
    { 7: { nombre: 'Siete', estado: 'activo', motivo: '', responsables: [], proximaFecha: null } });
  assert.deepStrictEqual(Object.keys(r.granelesBase), ['7']);
  assert.strictEqual(r.granelesBase['7'].nombre, 'Siete');
  assert.strictEqual(r.cambios, 0);
  assert.ok(!Object.hasOwn(r.granelesBase, 'constructor'));
});

test('aplicarMetaGrupo: solo valida lo editado — responsables y cliente guardados no se tocan', () => {
  const guardada = { tipo: 'directo', estado: 'activo', responsables: ['Ana', 'Baja'], clienteId: 99 };
  // responsables.json ilegible (ctx sin lista) y cliente 99 ya borrado: un PATCH de otro campo pasa igual
  const out = aplicarMetaGrupo(guardada, { proximaFecha: '2026-10-28' }, { clientes: [], responsables: [] });
  assert.deepStrictEqual(out.responsables, ['Ana', 'Baja']);
  assert.strictEqual(out.clienteId, 99);
  assert.strictEqual(out.proximaFecha, '2026-10-28');
  // si el PATCH los trae, siguen validándose
  assert.deepStrictEqual(aplicarMetaGrupo(guardada, { responsables: ['Ana', 'Baja'] }, { clientes: [], responsables: ctx.responsables }).responsables, ['Ana']);
  assert.throws(() => aplicarMetaGrupo(guardada, { clienteId: 99 }, ctx), e => e.status === 400);
});

test('aplicarMetaGranel: solo valida lo editado — responsables guardados no se tocan', () => {
  const guardado = { nombre: 'Masa', estado: 'activo', responsables: ['Juan', 'Baja'] };
  const out = aplicarMetaGranel(guardado, { proximaFecha: '2026-10-28' }, { responsables: [] });
  assert.deepStrictEqual(out.responsables, ['Juan', 'Baja']);
  assert.strictEqual(out.proximaFecha, '2026-10-28');
  assert.deepStrictEqual(aplicarMetaGranel(guardado, { responsables: ['Juan', 'Baja'] }, ctx).responsables, ['Juan']);
});
