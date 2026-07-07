# Prioridad unificada Almacén/Pesables

**Fecha:** 2026-07-07
**Estado:** Aprobado (validado con ejemplo real, PLU 4467), implementación directa

## Problema

`prioridad` en Pesables usa un `workGate` exponencial (`(trabajo/20)²`) que aplasta
productos de alta facturación cuando el envío puntual es chico. Ejemplo real: PLU 4467
(BG=36.2M, 2do más importante del dataset) quedaba con `prioridad=0.050` (casi invisible)
por tener solo 5.3kg para enviar hoy, mientras productos de importancia media-baja pero
volumen mayor dominaban el ranking. Almacén no tenía problema de gate, pero tampoco
consideraba cantidad a enviar ni stock bajo — solo facturación pura (`impNorm`).

## Diseño acordado

Mismo criterio en ambas tabs: **facturación como driver principal**, sumando urgencia de
stock y cantidad a enviar, sin gate todo-o-nada.

**Pesables** (`pesables.js`, sección prioridad de `calcularPesables`):
```
imp        = BG / maxBG                                    (peso 0.5)
urgencia   = promedio sobre sucursales con min>0 de max(0, 1 - stock/min)   (peso 0.25)
cantidad   = sumTeo / maxTeo  (ya existía como demandaN)    (peso 0.15)
envasar    = D / maxD  (ya existía como envasarN)           (peso 0.1)
prioridad  = 0.5·imp + 0.25·urgencia + 0.15·cantidad + 0.1·envasar
```
`prioridadSala` (ignora envíos a sucursales, per diseño existente): `0.7·imp + 0.3·envasar`.

Se elimina `workGate`/`workGateSala` (gate exponencial) y `granelN` deja de pesar en la
fórmula (queda solo como campo informativo `granelRatio`, sin usarse en el cálculo).

Requiere capturar stock por sucursal en pasada 1 (`stkPorSuc`), hoy solo se calculaba
`mins` — se agrega junto a `mins` en el mismo loop.

**Almacén** (`server.js`, post-procesamiento en `calcularDistribucionAlmacen`, no se
toca `distribucion.js` — todo el dato necesario ya está en la salida de `calcularAlmacen`:
`f.impNorm`, `f.mins`, `f.ideal`):
```
imp        = f.impNorm actual (facturación normalizada, sin cambios)   (peso 0.6)
urgencia   = promedio sobre sucursales con min>0 de max(0, 1 - stock/min)   (peso 0.25)
cantidad   = Σ f.ideal[sucursal] / max(Σ ideal) del dataset             (peso 0.15)
impNorm (nuevo) = 0.6·imp + 0.25·urgencia + 0.15·cantidad
```
El piso de "producto nuevo" (0.8) ya existente sigue aplicando sobre este nuevo
`impNorm` compuesto, sin cambios en esa parte.

## Validación
Con PLU 4467: `imp=0.78` (BG top-2), 6/7 sucursales cómodas (solo Chacabuco bajo mínimo)
→ `urgencia≈0.027`, `cantidad≈0.036` (pedido chico) → `prioridad = 0.5·0.78+0.25·0.027+
0.15·0.036 = 0.402` — vs `0.050` actual. Pasa de invisible a top-tier, reflejando su
importancia real en vez de ser aplastado por el volumen puntual bajo.

## Fuera de alcance
- No se toca `distribucion.js` (Almacén) — todo el cálculo nuevo vive en server.js como
  post-procesamiento, igual patrón que el piso de "producto nuevo".
- No se agrega UI para editar los pesos — quedan hardcodeados en `pesables.js` (`P.prioPesos`/
  `P.prioPesosSala`) y en el post-procesamiento de server.js, mismo criterio que otros
  parámetros del motor.
