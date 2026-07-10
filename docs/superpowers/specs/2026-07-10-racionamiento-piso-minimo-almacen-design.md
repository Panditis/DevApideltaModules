# Piso mínimo con cola de prioridad fija — racionamiento Almacén

## Problema

Cuando el stock central no alcanza para cubrir el pedido de todas las sucursales (`D <= pideTotal`), `calcularFilaAlmacen` (`distribucion.js:120-193`) prorratea el stock disponible proporcional a `pesoEfectivo = urgencia*10 + pesoFijo`. La urgencia (0-1, cuán por debajo del mínimo está cada sucursal) domina casi siempre frente al peso fijo (máx 0.50) porque su escala es 10x mayor. Cuando el central estuvo bajo un tiempo, todas las sucursales llegan a su punto de pedido casi juntas → urgencias parecidas → el prorrateo las trata casi igual → reparte en fracciones de 1 a 5 unidades a cada una.

Esto no es viable logísticamente: abrir cajas, mandar bultos sueltos, más paradas de transporte por menos unidades.

Ya existe un piso de micro-envío (`umbralMicroEnvio: 0.20` + `UMBRAL_UNIDADES_MICRO=6`, `distribucion.js:230-244`), pero solo oculta el envío chico en el texto ("Micro") — no devuelve esas unidades al pool ni las concentra en otra sucursal. El stock que le tocaba a la sucursal suprimida se pierde ese ciclo en vez de reasignarse.

## Alcance

- Aplica solo al motor Almacén (`distribucion.js` / `calcularFilaAlmacen`). Pesables (`pesables.js`) usa un mecanismo distinto (umbral binario por sucursal, sin pool compartido) y queda fuera de este cambio.
- Reemplaza el algoritmo de reparto en el caso `D <= pideTotal` (líneas 159-193). El caso `D > pideTotal` (línea 160-161, stock alcanza para todos) no cambia de rama, pero pasa por el mismo piso mínimo escalonado al final (ver Componente 3) para seguir filtrando micro-envíos naturales (pide chico de una sucursal casi llena, sin relación con escasez).
- Prioridad pasa a ser 100% orden fijo por sucursal (ya no mezcla urgencia). `pesoEfectivo` y la urgencia como criterio de reparto se eliminan del bloque de racionamiento — no se usan en ningún otro lugar de la función.
- El piso mínimo por sucursal deja de ser un único % fijo (20%) y pasa a escalonar según el S de esa sucursal para ese PLU: S alto → % más bajo (no espera acumular de más), S bajo → % más alto (no manda una unidad suelta). Se elimina el passthrough fijo de `UMBRAL_UNIDADES_MICRO=6` (redundante una vez que el % escala en ambos extremos — mantenerlo duplicaría la lógica sin agregar cobertura real).

## Componentes

### 1. `ordenPrioridad(pesosRacionado)` — distribucion.js (nuevo helper)

Pura. Recibe el mismo objeto `pesosRacionado` que ya existe en config (`{riv:0.50, chaca:0.20, nacion:0.12, urq:0.08, pergamino:0.06, sucu9:0.03, sanpedro:0.01, sucu8:0, sucu11:0}`) y devuelve `ORDEN_CLAVES` reordenado por valor descendente, con empate resuelto por la posición original en `ORDEN_CLAVES` (estable). El *valor* numérico deja de representar una proporción de reparto — solo importa el orden relativo. Se reinterpreta el mismo config existente, no se migra su forma.

Se calcula una sola vez por corrida completa (no depende del PLU), no por fila — se puede memoizar fuera de `calcularFilaAlmacen` y pasar por `opts`.

### 2. `pisoMinimo(S, tramos, pisoAbsoluto)` — distribucion.js (nuevo helper)

Pura. Busca en `tramos` (array ordenado por `hastaS` ascendente, último tramo con `hastaS: null` = catch-all) el primer tramo donde `S <= hastaS`, aplica su `pct`, y devuelve `Math.max(pisoAbsoluto, round(S * pct))`. Reemplaza el cálculo inline `umbralAbs` de la línea 241 y la constante `UMBRAL_UNIDADES_MICRO`.

Es la ÚNICA fuente de verdad del piso — la usan tanto el asignador de prioridad (Componente 3) como la función `piso()` de UI/texto (línea 238-244, ajustada para llamar a este helper en vez de su cálculo inline). Si quedaran desalineados, la cola de prioridad podría asignarle a una sucursal una cantidad que el paso de texto after vuelve a marcar "Micro" — se evita compartiendo la función.

### 3. Asignación por cola de prioridad — reemplaza líneas 159-193

```
racionPorClave = {}
if (D > pideTotal) {
  para cada k en ORDEN_CLAVES: racionPorClave[k] = pidePorClave[k] || 0   // sin cambios, cubre a todos
} else {
  restante = max(D, 0)
  para cada k en ordenPrioridad (Componente 1), en orden:
    pide = pidePorClave[k] || 0
    if (pide <= 0) continue
    piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto)
    if (restante < piso) continue        // no alcanza ni el piso de esta — probar la siguiente en la cola, NO cortar
    asignado = min(pide, restante)
    racionPorClave[k] = round(asignado)  // pide puede no ser entero (S/stock fraccionario)
    restante -= racionPorClave[k]
  para cualquier k no asignado en el loop: racionPorClave[k] = 0
}
```

Sin prorrateo simultáneo, sin `pesoEfectivo`, sin waterfall iterativo, sin redondeo por resto mayor (`largestremainder`, líneas 179-192) — cada sucursal recibe su pedido completo o nada, así que no queda remanente fraccionario que repartir. Se elimina ese bloque completo.

`sPorClave` es nuevo, mismo patrón que `minPorClave`/`stockPorClave` (línea 149-150): `{ riv: sRiv, urq: sUrq, nacion: sNac, chaca: sCha, pergamino: sPer, sanpedro: sSan, sucu8: sSu8, sucu9: sSu9, sucu11: sS11 }`.

El resto de la función (líneas 194-227, construcción de `eRiv`/`eUrq`/etc. vía `racion(key)`) no cambia — sigue leyendo de `racionPorClave` igual que hoy.

### 4. `piso()` (línea 238-244) — usa el helper del Componente 2

Misma firma y mismo rol (filtra/marca "Micro" para UI y para el gate de importancia legacy), pero su cálculo interno de umbral pasa a `pisoMinimo(S, tramos, pisoAbsoluto)` en vez del inline `round(Math.max(umbralMicro * S, 1), 0)` + chequeo de `UMBRAL_UNIDADES_MICRO`. Para las sucursales que salieron de la cola de prioridad, esto es un no-op (ya vienen en 0 o ≥ piso, por construcción del Componente 3) — sigue siendo necesario para el caso `D > pideTotal`, donde una sucursal puede tener un pide propio chico sin que haya escasez de por medio.

No cambia la interacción ya existente con importancia real (líneas 275-311: el peso por sucursal usa el rank y el gate `min>0`, no la cantidad enviada) ni con importancia legacy (líneas 262-273: sigue penalizando 5% por `eXxxM` no-numérico, o sea por "Micro"/"Fact"/etc.) — ambas seguían funcionando sobre los valores post-piso (`eXxxM`), que se preservan igual.

### 5. `distribucion_config.json` — nueva forma de `umbralMicroEnvio`

```json
"umbralMicroEnvio": {
  "tramos": [
    { "hastaS": 5,    "pct": 0.60 },
    { "hastaS": 15,   "pct": 0.40 },
    { "hastaS": 40,   "pct": 0.25 },
    { "hastaS": null, "pct": 0.10 }
  ],
  "pisoAbsoluto": 1
}
```

Reemplaza el valor numérico plano actual (`0.20`, línea 24). Números de arranque — se ajustan viendo resultados reales antes de dar por cerrado. `pesosRacionado` (línea 2) no cambia de forma, solo de interpretación (Componente 1).

### 6. `server.js` — `calcularDistribucionAlmacen()` (~línea 1543-1599)

- Línea 1548 (`umbralMicroEnvio = distCfg.umbralMicroEnvio || 0`): pasa a leer el objeto completo (`tramos` + `pisoAbsoluto`) en vez de un número; default si falta config: `{ tramos: [{hastaS: null, pct: 0.20}], pisoAbsoluto: 1 }` (paridad con el comportamiento viejo si alguien borra la config).
- Línea 1599 (`opts` pasado a `calcularAlmacen`): sin cambios de forma, solo lo que ya viaja (`pesosRacionado`, `umbralMicroEnvio`) ahora tiene el nuevo shape.

## Flujo de datos

```
calcularDistribucionAlmacen()
  ├─ lee distCfg.umbralMicroEnvio (nuevo shape: tramos + pisoAbsoluto)
  ├─ lee distCfg.pesosRacionado (mismo shape, nueva interpretación: orden, no proporción)
  └─ calcularAlmacen(productos, a8020, listas, opts) → calcularFilaAlmacen() por PLU
       ├─ pidePorClave, minPorClave, stockPorClave, sPorClave (nuevo)  — sin cambios de fuente
       ├─ D > pideTotal  → racionPorClave = pidePorClave completo
       ├─ D <= pideTotal → cola de prioridad (Componente 3): recorre ordenPrioridad, asigna
       │                    pide completo o 0 por sucursal según pisoMinimo(sPorClave[k])
       ├─ piso() (Componente 4) sobre el resultado final → eXxxM (UI "Micro" + gate importancia)
       └─ return { enviar, ideal, enviarTexto, enviarMicro, importancia, ... }  — misma forma que hoy
```

## Errores / edge cases

- Ninguna sucursal alcanza su piso (D muy chico incluso para la de menor piso) → nadie recibe nada, D queda sin usar en central. Se recalcula solo la próxima corrida (el pide no desaparece, el stock central seguirá bajo o subirá si hay compra).
- `sucu8`/`sucu11` (peso 0 en `pesosRacionado`) → siempre al final de la cola, mismo comportamiento de hoy (raramente reciben cuando hay escasez real), pero ahora pueden recibir su pedido COMPLETO si sobra stock después de servir al resto, en vez de una fracción proporcional minúscula.
- PLU con `esNuevo` (empuje de producto nuevo, líneas 84-89, sube min/S de todas las sucursales al stock del central `D`) → sigue generando `pide` alto y simultáneo en todas; con la cola de prioridad esto ahora concentra el `D` en Rivadavia/Chacabuco primero en vez de fragmentarlo — comportamiento deseado, coherente con el resto del diseño.
- Sucursales gateadas (`GATEADO`, líneas 131-141: Fact/Restringido) → siguen excluidas del pool antes de calcular `pidePorClave`, sin cambios.
- `pide` fraccionario (S o stock no enteros) → se redondea (`round`) al asignar, no antes — evita arrastrar error de redondeo entre sucursales ya que cada una se resuelve una sola vez (a diferencia del prorrateo viejo, que sí necesitaba reparto de resto por ser simultáneo).

## Testing

Nuevo `validar_racionamiento.js` (mismo patrón manual que `validar_ranking.js`, sin test runner en el repo):

- D cubre pideTotal → cada sucursal recibe su pide exacto (rama sin cambios).
- D alcanza para el pide completo de la #1 en prioridad y sobra → #1 completo, resto evaluado con lo que queda.
- D alcanza para #1 + parte de #2, pero esa parte no llega al piso de #2 → #2 en 0, sigue probando #3 en adelante (cascada, no corta el loop).
- D tan chico que ni el piso de la #1 se alcanza, pero sí el de una sucursal con S bajo más abajo en la cola → esa recibe, las de mayor prioridad quedan en 0 (verifica que el loop no corta prematuro).
- D por debajo del piso de todas → `racionPorClave` todo en 0, D no se asigna.
- Caso mixto con `esNuevo` (min/S empujado a D) → confirma que concentra en las primeras de la cola en vez de fragmentar.
- `piso()` (Componente 4) con un pide chico bajo `D > pideTotal` (sin escasez) → sigue marcando "Micro" igual que hoy, ahora con el umbral escalonado.

Verificación end-to-end: pegarle a `/api/distribucion/almacen` contra datos reales, comparar antes/después en un subconjunto de PLUs con escasez conocida (los que hoy salen fragmentados 1-5 unidades) y confirmar que concentran en menos sucursales sin perder unidades del total repartido.
