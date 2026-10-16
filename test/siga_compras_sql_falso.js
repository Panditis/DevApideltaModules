'use strict';
// mssql FALSO para los tests de lib/siga_compras/repo.js. PROHIBIDO conectarse a SIGA desde los tests: este
// doble reemplaza a mssql entero. Registra cada sentencia con sus parámetros y el pool que la ejecutó
// ('lectura' = getPool, 'stock' = getPoolStock / transacción) y responde con responder(texto, params).
// Transaction imita a mssql: es un EventEmitter que emite 'rollback' (aborted = true si lo abortó el servidor;
// el responder lo simula tirando un error con abortaTransaccion: true) y rollback() sobre una transacción ya
// terminada falla como en mssql.
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

function crearSqlFalso(responder = () => ({})) {
  const registro = [];
  const tipo = nombre => Object.assign((...args) => ({ tipo: nombre, args }), { tipo: nombre });

  class Request {
    constructor(origen) {
      this.origen = origen && origen.etiqueta ? origen.etiqueta : 'stock';
      this.tx = origen instanceof Transaction ? origen : null;
      this.params = {};
    }

    input(nombre, tipoSql, valor) {
      if (arguments.length !== 3) throw new Error(`input(${nombre}) sin tipo explícito`);
      this.params = { ...this.params, [nombre]: valor };
      return this;
    }

    async query(texto) {
      registro.push({ texto, params: this.params, pool: this.origen });
      try {
        const r = (await responder(texto, this.params)) || {};
        return { recordset: r.recordset || [], rowsAffected: r.rowsAffected || [1] };
      } catch (err) {
        if (err && err.abortaTransaccion && this.tx) this.tx.terminar(true);
        throw err;
      }
    }
  }

  class Transaction extends EventEmitter {
    constructor(pool) {
      super();
      this.etiqueta = pool.etiqueta;
      this.terminada = false;
    }

    async begin() { registro.push({ texto: 'BEGIN TRAN', params: {}, pool: this.etiqueta }); }

    async commit() {
      if (this.terminada) throw new Error('Transaction has been aborted.');
      this.terminada = true;
      registro.push({ texto: 'COMMIT', params: {}, pool: this.etiqueta });
      this.emit('commit');
    }

    async rollback() {
      if (this.terminada) throw new Error('Transaction has been aborted.');
      this.terminar(false);
    }

    terminar(abortada) {
      this.terminada = true;
      registro.push({ texto: 'ROLLBACK', params: {}, pool: this.etiqueta });
      this.emit('rollback', abortada);
    }
  }

  const crearPool = etiqueta => ({ etiqueta, request: () => new Request({ etiqueta }) });
  const lectura = crearPool('lectura');
  const stock = crearPool('stock');
  const sql = {
    Int: tipo('Int'), BigInt: tipo('BigInt'), Bit: tipo('Bit'), VarChar: tipo('VarChar'), Decimal: tipo('Decimal'),
    Request, Transaction,
  };
  return { sql, registro, getPool: async () => lectura, getPoolStock: async () => stock };
}

// Toda @marca del texto tiene su parámetro y ningún valor string de 4+ caracteres aparece literal en el SQL.
function assertParametrizado(registro) {
  for (const { texto, params } of registro) {
    for (const marca of texto.match(/@\w+/g) || []) {
      assert.ok(Object.prototype.hasOwnProperty.call(params, marca.slice(1)), `falta el parámetro ${marca} en: ${texto}`);
    }
    for (const valor of Object.values(params)) {
      if (typeof valor === 'string' && valor.length >= 4) assert.ok(!texto.includes(valor), `valor literal "${valor}" en: ${texto}`);
    }
  }
}

module.exports = { crearSqlFalso, assertParametrizado };
