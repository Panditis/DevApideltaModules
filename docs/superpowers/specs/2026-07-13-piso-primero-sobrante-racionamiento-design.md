# Piso primero + sobrante por urgencia — racionamiento Almacén

## Problema

`racionarPorPrioridad` hoy da el pedido completo (o lo que alcance) a la sucursal más urgida antes de pasar a la siguiente. Cuando `D` es generoso (PLU 90259: central=99, 7 sucursales piden entre 19 y 74 unidades cada una) esto concentra casi todo en 1-2 sucursales y deja el resto en 0, aunque el pool alcanzaría para darle algo viable a todas. El usuario quiere: cuando hay margen, repartir un piso viable a todas las urgidas primero, y solo después volcar el sobrante hacia las más urgidas.

Confirmado con el usuario: esto aplica **siempre** que haya 2+ sucursales activas (no solo cuando D es "muy generoso") — y **solo a Almacén** (Pesables queda para un diseño aparte).

## Diseño

Dos pasadas, mismo orden de urgencia que ya existe (`pide/S` desc, `pesosRacionado` desempata):

1. **Pasada 1 (piso a todas):** recorre la cola; a cada sucursal con `pide >= piso` y `restante >= piso` le da exactamente su `piso`. Si no alcanza, se la salta — **no vuelve a intentarse en la pasada 2** (una sucursal que no despegó del piso en la pasada 1 se queda en 0 este ciclo; evita el riesgo de terminar dándole una fracción por debajo de su piso en la pasada 2 con lo poco que quede).
2. **Pasada 2 (sobrante por urgencia):** recorre la MISMA cola; solo a las sucursales que **sí** recibieron su piso en la pasada 1 (`racionPorClave[k] > 0`) las completa hacia su pedido total con lo que quede de `restante`, en el mismo orden (la más urgida se lleva el excedente primero). Las que quedaron en 0 en la pasada 1 se ignoran en la pasada 2.

Esta separación es la parte no obvia: sin el filtro "solo las que ya limpiaron su piso", la pasada 2 podría darle a una sucursal saltada en la pasada 1 una cantidad menor a su piso con el resto que sobra al final — exactamente el bug que este sistema entero existe para evitar.

### Código — `racionarPorPrioridad`, reemplaza el cuerpo del loop actual

```javascript
function racionarPorPrioridad(pidePorClave, sPorClave, D, pesosRacionado, ordenClaves, tramos, pisoAbsoluto) {
  const urgencia = (k) => {
    const S = sPorClave[k] || 0;
    return S > 0 ? (pidePorClave[k] || 0) / S : 0;
  };
  const orden = [...ordenClaves].sort((a, b) => {
    const diff = urgencia(b) - urgencia(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return (pesosRacionado[b] || 0) - (pesosRacionado[a] || 0);
  });
  const racionPorClave = {};
  for (const k of ordenClaves) racionPorClave[k] = 0;
  let restante = Math.max(D, 0);
  // Pasada 1: piso mínimo a cada sucursal activa que el pool alcance a cubrir, en orden de
  // urgencia. Si D es "importante" (alcanza para el piso de varias), reparte primero un mínimo
  // viable a todas antes de concentrar en la más urgida. Si no alcanza ni para el piso de una,
  // se la salta (no corta, prueba la siguiente).
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (pide < piso || restante < piso) continue;
    racionPorClave[k] = piso;
    restante -= piso;
  }
  // Pasada 2: con lo que sobra, completa hacia el pedido total — SOLO a las que ya limpiaron su
  // piso en la pasada 1 (racionPorClave[k] > 0). Las que quedaron en 0 no se reintentan acá: con
  // lo poco que sobre al final podría tocarles menos que su piso, y ese es justo el problema que
  // esta función existe para evitar.
  for (const k of orden) {
    if (racionPorClave[k] <= 0 || restante <= 0) continue;
    const pide = pidePorClave[k] || 0;
    const falta = pide - racionPorClave[k];
    if (falta <= 0) continue;
    const dar = round(Math.min(falta, restante), 0);
    racionPorClave[k] += dar;
    restante -= dar;
  }
  return racionPorClave;
}
```

Firma, `pisoMinimo`, la rama `D > pideTotal` de `calcularFilaAlmacen` — sin cambios.

## Ejemplo de referencia (PLU 90259, D=99)

Orden de urgencia: riv(1.07) > sanPedro(0.95) > nacion(0.878) > chaca(0.86) > urq(0.75) > pergamino(0.71) > sucursal9(0.655).

Pisos (tramos `[{5,.6},{15,.4},{40,.25},{null,.1}]`, pisoAbsoluto=1): riv(S43)=4, sanPedro(S78)=8, nacion(S41)=4, chaca(S50)=5, urq(S40)=10, pergamino(S31)=8, sucursal9(S29)=7.

Pasada 1 (restante 99→95→87→83→78→68→60→53): riv=4, sanPedro=8, nacion=4, chaca=5, urq=10, pergamino=8, sucursal9=7 — suma pisos=46, restante=53.

Pasada 2 (completa en el mismo orden): riv falta=42, da 42 (restante 53→11) → riv=46 (completo). sanPedro falta=66, da 11 (restante 11→0) → sanPedro=19. Resto sin cambios (restante ya en 0).

**Resultado: riv=46, sanPedro=19, nacion=4, chaca=5, urq=10, pergamino=8, sucursal9=7.** Suma=99. Las 7 reciben algo viable; riv (la más urgida, stock negativo) sigue completa.

## Impacto en comportamiento ya probado

Esto también cambia escenarios que hoy concentran en la más urgida, no solo los "generosos" — confirmado y aceptado por el usuario. Ejemplo (fixture ya existente en `validar_racionamiento.js`, D=12, riv/chaca/nacion piden 10 c/u + sanPedro pide 2, las 4 empatan en urgencia por partir de stock 0): hoy da `riv=10, sanPedro=2, resto 0`; con este cambio da `riv=4, chaca=4, nacion=4, sanPedro=0` (la pasada 1 reparte piso a riv/chaca/nacion hasta agotar los 12, sanPedro nunca llega a que le alcance ni el piso).

## Testing

Recalcular TODOS los fixtures existentes de `racionarPorPrioridad` y de la integración con `calcularFilaAlmacen` bajo el algoritmo nuevo (no asumir que dan igual — varios cambian, ver tabla en el plan). Agregar el caso PLU 90259 (D=99, 7 sucursales) como fixture de integración nuevo, con los valores de la sección anterior.

## Alcance

Solo Almacén (`racionarPorPrioridad`, `calcularFilaAlmacen` en `distribucion.js`). Pesables queda fuera — mecanismo distinto, diseño aparte si se pide.
