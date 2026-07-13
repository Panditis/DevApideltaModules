# Urgencia relativa a S como criterio de prioridad en racionamiento

## Problema

`racionarPorPrioridad` (`distribucion.js`, Tarea 3 de la spec `2026-07-10-racionamiento-piso-minimo-almacen`) ordena la cola de prioridad por `pesosRacionado` fijo (riv > chaca > nacion > urq > ...), sin mirar el stock actual de cada sucursal. En producción esto da resultados contraintuitivos: PLU 91298, central=18 — `urq` (stock=1, el más vacío de todas) quedó en 0, mientras `riv` (stock=3) y `nacion` (stock=4, parcial) se llevaron todo, solo por ser más "importantes" en el ranking fijo.

## Alcance

- Cambia únicamente el criterio de orden dentro de `racionarPorPrioridad` — de `pesosRacionado desc` a `urgencia desc, empate → pesosRacionado desc`.
- No cambia: `pisoMinimo`, la asignación parcial-si-supera-piso (confirmado aceptable, no se fuerza "completo o nada"), la rama `D > pideTotal`, el cálculo de `pide`/`pideTeorico`.
- Fuera de alcance: la config de "depósito propio" por sucursal (tema separado, se brainstorming después).

## Diseño

`urgencia(k) = S>0 ? clamp(0,1, (S - stock) / S) : 0` — 0 = sucursal a su objetivo o por encima, 1 = sin stock. Relativiza al **S** (order-up-to) de esa sucursal para ese PLU, no al `min` (punto de pedido) — así una sucursal chica (S=12) y una grande (S=50) se comparan por cuánto les falta proporcionalmente, no por unidades crudas.

`pesosRacionado` deja de ser el criterio primario y pasa a desempate exclusivo: si dos sucursales empatan en urgencia (diferencia < 1e-9, para evitar ruido de punto flotante), gana la de mayor peso fijo.

### `racionarPorPrioridad` — firma nueva

```javascript
function racionarPorPrioridad(pidePorClave, sPorClave, stockPorClave, D, pesosRacionado, ordenClaves, tramos, pisoAbsoluto) {
  const urgencia = (k) => {
    const S = sPorClave[k] || 0;
    if (S <= 0) return 0;
    return Math.max(0, Math.min(1, (S - (stockPorClave[k] || 0)) / S));
  };
  const orden = [...ordenClaves].sort((a, b) => {
    const diff = urgencia(b) - urgencia(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return (pesosRacionado[b] || 0) - (pesosRacionado[a] || 0);
  });
  const racionPorClave = {};
  for (const k of ordenClaves) racionPorClave[k] = 0;
  let restante = Math.max(D, 0);
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (pide < piso || restante < piso) continue;
    const asignado = round(Math.min(pide, restante), 0);
    racionPorClave[k] = asignado;
    restante -= asignado;
  }
  return racionPorClave;
}
```

(Único cambio real: el `.sort()`. Agrega el parámetro `stockPorClave` y la función `urgencia`. El resto del cuerpo es idéntico al actual.)

### `calcularFilaAlmacen` — call site

Se vuelve a armar `stockPorClave` (existía antes de la Tarea 3, se sacó junto con `pesoEfectivo`; ahora hace falta de nuevo, con otro propósito):

```javascript
const stockPorClave = { riv: st.riv||0, urq: st.urq||0, nacion: st.nacion||0, chaca: st.chaca||0, pergamino: st.pergamino||0, sanpedro: st.sanpedro||0, sucu8: st.sucu8||0, sucu9: st.sucu9||0, sucu11: st.sucu11||0 };
```

Y el call site pasa a:
```javascript
: racionarPorPrioridad(pidePorClave, sPorClave, stockPorClave, D, pesosRacionado, ORDEN_CLAVES, tramosMicro, pisoAbsolutoMicro);
```

## Verificación contra caso real (PLU 91298)

Con `D=18`, `S`/`stock` derivados de `ideal`/`stkSuc` de la API real:

| suc | stock | S | urgencia | pide |
|---|---|---|---|---|
| urq | 1 | 12 | 0.917 | 11 |
| sanPedro | 3 | 16 | 0.813 | 13 |
| riv | 3 | 15 | 0.800 | 12 |
| sucursal9 | 4 | 17 | 0.765 | 13 |
| pergamino | 5 | 19 | 0.737 | 14 |
| nacion | 4 | 14 | 0.714 | 10 |

Orden esperado: urq primero (recibe su pedido completo o lo que alcance), sanPedro segundo con el remanente. Resultado esperado con el fix: `urq≈11, sanPedro≈7 (18-11), resto 0` — en vez de `riv=12, nacion=6` (hoy). Este caso se vuelve el fixture de test de integración.

## Testing

Extiende `validar_racionamiento.js`:
- Reemplaza los fixtures existentes de `racionarPorPrioridad` (Casos 1-4) para pasar `stockPorClave` — recalcular expectativas si el criterio de orden cambia el resultado esperado (posible que algunos casos viejos, armados con S implícitamente ligado a pesos fijos, cambien de resultado; hay que revisar caso por caso, no asumir que siguen iguales).
- Nuevo caso: fixture de PLU 91298 (tabla de arriba) contra `calcularFilaAlmacen` — `urq` recibe su pedido completo, `sanPedro` el remanente, resto 0.
- Caso de empate en urgencia (dos sucursales con mismo `%` de faltante) → desempata por `pesosRacionado`.

## Errores / edge cases

- `S=0` (sucursal no vende ese PLU o sin objetivo) → `urgencia=0`, no rompe (ya de por sí `pide=0` en ese caso, el loop la salta por `pide<=0` antes de importar el orden).
- Sucursal sobre-stockeada (`stock > S`) → urgencia clampeada a 0, no negativa (no le da ventaja "negativa" rara en el sort).
