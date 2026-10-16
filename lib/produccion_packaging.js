'use strict';

// ── Packaging que descuenta una carga de producción ────────────────────────────
// Envase, tapa y etiqueta no van en graneles[]: se descuentan aparte. La regla es una sola y
// la usan la conciliación y el movimiento SiGA (rutas_reservas.js); el CSV del front
// (generarCSVProduccion) la replica porque el HTML no puede requerir este módulo.
//   · envase/tapa → sólo con alguien en Envasado (sin envasado no hay alta ni consumo).
//   · etiqueta    → sólo con alguien en Etiquetado, haya o no Envasado.
// Desde la carga se guardan las cantidades ya calculadas con el CantPorUnidad de la fórmula
// (cantEnvase, cantTapa, etiqueta/etiquetaNombre/cantEtiqueta). Las cargas viejas no las
// tienen: envase/tapa caen a 1 por unidad y la etiqueta a la de la fórmula ACTUAL × cantidad.
// Funciones puras: no tocan SQL ni archivos.

const RE_ROL_ENVASADO    = /envasad/i;
const RE_ROL_ETIQUETADO  = /etiquetad/i;
const RE_NOMBRE_ETIQUETA = /^\s*etiquetas?\b/i;

const redondear4 = n => Math.round((Number(n) || 0) * 1e4) / 1e4;

// El rol tiene que existir Y tener a alguien cargado. roles es la clave nueva; responsables, la vieja.
function tieneRol(reg, re) {
  const roles = Array.isArray(reg && reg.roles) ? reg.roles
              : (Array.isArray(reg && reg.responsables) ? reg.responsables : []);
  return roles.some(x => re.test((x && x.rol) || '') && String((x && x.nombre) || '').trim());
}

// Carga sólo de Etiquetado: no da de alta producto ni consume granel/envase/tapa, pero sí la etiqueta.
function esSoloEtiquetado(reg) {
  if (String((reg && reg.plu) || '').trim().toUpperCase() === 'ACT') return false;
  return !tieneRol(reg, RE_ROL_ENVASADO) && tieneRol(reg, RE_ROL_ETIQUETADO);
}

// Etiqueta de la fórmula (comps de componentesFormulaPorPadre): rubro con ETIQUET o nombre "Etiqueta…".
function etiquetaDeFormula(comps) {
  return (comps || []).find(c =>
    String(c.rubro || '').toUpperCase().includes('ETIQUET') || RE_NOMBRE_ETIQUETA.test(String(c.nombre || ''))
  ) || null;
}

const guardada = v => (v === undefined || v === null || v === '' ? null : Number(v));

// Líneas de packaging que consume el registro: [{ tipo, plu, nombre, cantidad }].
// sinEtiqueta = tiene Etiquetado pero no hay etiqueta guardada ni en la fórmula.
function packagingDeRegistro(reg, comps) {
  const cant = Number(reg && reg.cantFraccionada) || 0;
  const lineas = [];
  let sinEtiqueta = false;
  if (tieneRol(reg, RE_ROL_ENVASADO)) {
    for (const [tipo, campoCant] of [['envase', 'cantEnvase'], ['tapa', 'cantTapa']]) {
      if (!reg[tipo]) continue;
      const g = guardada(reg[campoCant]);
      lineas.push({ tipo, plu: String(reg[tipo]).replace(/\D/g, '') || null,
                    nombre: reg[`${tipo}Nombre`] || `PLU ${reg[tipo]}`,
                    cantidad: g != null && Number.isFinite(g) ? g : cant });
    }
  }
  if (tieneRol(reg, RE_ROL_ETIQUETADO)) {
    const g = guardada(reg.cantEtiqueta);
    if (g != null && Number.isFinite(g) && reg.etiqueta) {
      lineas.push({ tipo: 'etiqueta', plu: String(reg.etiqueta).replace(/\D/g, '') || null,
                    nombre: reg.etiquetaNombre || `PLU ${reg.etiqueta}`, cantidad: g });
    } else {
      const et = etiquetaDeFormula(comps);
      if (et) lineas.push({ tipo: 'etiqueta', plu: et.plu, nombre: et.nombre, cantidad: redondear4(cant * (Number(et.cantPorUnidad) || 1)) });
      else sinEtiqueta = true;
    }
  }
  return { lineas, sinEtiqueta };
}

module.exports = { RE_ROL_ENVASADO, RE_ROL_ETIQUETADO, tieneRol, esSoloEtiquetado, etiquetaDeFormula, packagingDeRegistro };
