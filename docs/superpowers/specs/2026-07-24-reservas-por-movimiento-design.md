# Reservas por número de movimiento — Diseño

**Fecha:** 2026-07-24
**Módulos:** Planificación (`planificacion.html`), Producción (`apidelta_produccion_dia.html`), `server.js`
**Datos:** `data/planes.json`, `data/ordenes.json`, `data/movimientos_stock.json`, SIGA (SQL Server)

## Problema

Hoy `plan.reserva` es un blob único por día. No hay trazabilidad por número de movimiento, las órdenes ya reservadas se pueden eliminar del plan, y la conciliación compara reservado-vs-usado en agregado sin atarlo a cada movimiento SIGA. Se necesita:

- Reservas gestionadas por número de movimiento SIGA.
- Bloquear órdenes ya reservadas (no eliminables) con badge del movimiento.
- Re-habilitar reserva solo para órdenes nuevas (sin badge).
- Reemplazar el botón Movimientos por un resumen de reservas del plan.
- En producción, mostrar el/los código(s) de reserva por orden.
- Conciliar reservado-vs-usado por orden y por movimiento, con un ajuste SIGA por movimiento.
- Evitar movimientos en pendiente: órdenes con reserva sin conciliar visibles en tab Terminados.

## Decisiones tomadas

1. **Código de reserva = número de movimiento SIGA.** No se crea identificador interno adicional.
2. **Resumen de movimientos mantiene la acción revertir** (salida de emergencia actual).
3. **Multi-reserva por producto** ocurre porque el mismo producto aparece en varias órdenes (distinto cliente/presentación); cada orden se reserva por separado → varios movimientos para ese producto.
4. **"Reservar" = auto** sobre todas las órdenes sin badge, en un único movimiento SIGA.
5. **Un ajuste SIGA por movimiento de reserva** (trazabilidad 1:1 reserva→ajuste).
6. **Conciliar = exportar** (conciliar hace el movimiento de carga). Un solo estado: `sin conciliar`.

## Enfoque

**Extender el modelo actual a lista de reservas.** Se reutiliza toda la maquinaria SIGA existente (depósitos, `trasladarStock`, `ejecutarYRegistrar`, `componentesDePlan`, log de movimientos). `plan.reserva` (blob único) pasa a `plan.reservas[]` (varios registros, cada uno su movimiento). Bajo riesgo, migración transparente del formato viejo. Se descarta un subsistema nuevo por orden (invasivo, re-testeo total del flujo SIGA).

## Modelo de datos

### `planes.json` — `plan.reservas[]`

```
plan.reservas = [
  {
    numeroMovimiento,          // SIGA; null hasta confirmar
    idMovimientoLog,           // link a movimientos_stock.json
    fechaPlanificacion,        // fecha del plan (YYYY-MM-DD)
    fechaMovimiento,
    idSucursal, depOrigen, depDestino,
    ordenes: [ordenId, ...],   // órdenes que cubre este movimiento
    productos: [ {plu, nombre, cantidad, tipo} ],  // granel|envase|tapa movidos
    estado: "confirmado" | "pendiente" | "fallido"
  },
  ...
]
```

- Cada orden/ítem del plan se sella con `reservaMovimiento = numeroMovimiento` → badge + candado.
- **Migración:** al leer un plan con `reserva` (formato viejo) y sin `reservas`, convertir `reserva` → `reservas[0]` en memoria.
- `saldoReserva` / `saldoItemReserva` se recalculan iterando `plan.reservas[]`.

### `ordenes.json`

Cada orden hereda `reservaMovimiento` al enviarse a producción. Producción agrupa por producto y muestra todos los números de movimiento asociados.

## Componentes

### 1. Planificación — bloqueo + badge (`planificacion.html` + server)

- Ítem/orden con `reservaMovimiento` → botón eliminar oculto/deshabilitado, badge `#NroMov`.
- "Reservar mercadería": selecciona todas las órdenes sin badge, calcula componentes solo de esas, ejecuta traslado SIGA nuevo (`trasladarStock` vía `ejecutarYRegistrar`), agrega a `plan.reservas[]` y sella esas órdenes.
- Órdenes ya reservadas se excluyen del cálculo (no re-mueven stock).
- Agregar productos nuevos → sin badge → "Reservar" se re-habilita solo para ellos.
- Intento de eliminar orden reservada → bloqueado en UI y validado en backend (`DELETE`/`PUT` de ítem rechaza si tiene `reservaMovimiento`).

### 2. Resumen de reservas del plan (reemplaza botón 🧾 Movimientos)

- Reemplaza el modal actual de historial.
- Tabla por movimiento: productos reservados, cantidades, Nº movimiento, fecha planificación, estado.
- Mantiene acción **revertir**: revierte el movimiento SIGA (`/api/stock/movimientos/:id/revertir`) y limpia los badges de las órdenes de ese movimiento, quitándolas de `plan.reservas[]` y re-habilitándolas para reserva.

### 3. Producción — código(s) de reserva por orden (`apidelta_produccion_dia.html`)

- `ordenes.json` lleva `reservaMovimiento` por orden.
- Mismo producto en varias órdenes → chips con todos los números de movimiento, agrupados por producto.

### 4. Conciliación — por orden y por movimiento (`server.js` conciliación + producción día)

- `conciliacionProduccion` agrupa reservado (desde cada `reservas[]`) vs usado (registros de producción) **por número de movimiento**.
- **Un ajuste SIGA por movimiento de reserva:** por cada movimiento, comprobante propio con consumo real + sobrante→diferencias (reutiliza `lineasProduccionDesdeConciliacion` acotado al subconjunto del movimiento).
- La vista desglosa por orden dentro de cada movimiento.

### 5. Producción — pendientes en tab Terminados

- Órdenes con reserva **sin conciliar** aparecen en Terminados con badge único `⚠ sin conciliar`.
- Al conciliar → movimiento SIGA registrado → sale del estado.

## Flujo de datos

```
Planificación                          SIGA / log                     Producción
-------------                          ----------                     ----------
[Reservar] órdenes sin badge  ──►  trasladarStock ──► NumeroMovimiento
   │                                     │
   └─ sella órdenes + push plan.reservas[]                            enviar-produccion
                                                                        └─ ordenes.json hereda reservaMovimiento
[Resumen] ── revertir ──► revertir SIGA ─┘                            [Conciliar] por movimiento
                                                                        └─ 1 ajuste SIGA / movimiento
                                                                        Terminados: ⚠ sin conciliar
```

## Manejo de errores

- Movimiento SIGA que queda `pendiente` o `fallido`: el registro en `plan.reservas[]` refleja el estado; no se sella la orden como confirmada hasta `confirmado`.
- Backend rechaza eliminación de orden reservada (defensa además del bloqueo UI).
- Revertir limpia badges solo tras confirmar la reversión SIGA.

## Testing

- Reserva de órdenes nuevas genera un nuevo movimiento y no re-mueve las ya reservadas.
- Eliminación de orden reservada rechazada (UI + backend).
- Migración `reserva` → `reservas[0]` no rompe planes viejos.
- Conciliación agrupa y ajusta por movimiento; sobrante→diferencias por movimiento.
- Órdenes sin conciliar aparecen en Terminados con badge.
- Revertir un movimiento re-habilita solo sus órdenes.

## Puntos a verificar en implementación

- Granularidad exacta ítem-vs-orden en `planificacion.html` y si `planes.json` items llevan `cliente`.
- Que el sellado por-orden aplique limpio sobre la estructura actual de items.
- Interacción con `reserva/actualizar` (delta) actual: se reemplaza por el flujo de reserva incremental por movimiento.
