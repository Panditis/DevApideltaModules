# Reservar componentes — diseño

**Fecha:** 2026-07-06
**Módulo:** `planificacion.html`, tab "Plan del día"
**Depende de:** `POST /api/stock/movimiento` (ya implementado, ver `server.js`)

## Contexto

`planificacion.html` ya tiene un botón "📦 Resumen MP" que calcula, para el plan del día,
qué materias primas (componentes) hacen falta y compara contra el stock actual
(`calcularMPParaItems(items)` + `/api/stock/plus`). Este diseño agrega un botón hermano
"🔒 Reservar componentes" que permite mover esas cantidades de un depósito "vendible"
(ej. Casa Central) a un depósito "reservado" (ej. Reservado Casa Central, id 99) en Siga,
para que no se vendan mientras se preparan para producción.

El mecanismo de movimiento de stock en Siga (sin SPs ni triggers, transacción manual:
reservar número, insertar cabecera+línea, actualizar `ProductosDepositos`/`ProductosUbicaciones`)
ya está investigado en `pruebas_stock_claude/README.md` e implementado como endpoint genérico
de un movimiento por llamada en `POST /api/stock/movimiento`.

## Backend — endpoints nuevos

Todos de solo lectura (usan el pool existente `getPool()`, no el pool de escritura).

### `GET /api/stock/empleados`
Lista personas activas para elegir quién hace el movimiento. Un solo dropdown resuelve
tanto `Usuario` (login, varchar) como `IdEmpleado` (int) — evita pedir dos cosas separadas.

```sql
SELECT e.IdEmpleado, e.NombreEmpleado, e.IdUsuario AS Usuario
FROM Empleados e
INNER JOIN Usuarios u ON u.Id = e.IdUsuario
WHERE u.Activo = 1 AND e.IdUsuario IS NOT NULL
ORDER BY e.NombreEmpleado
```

**Nunca** seleccionar ni exponer `Usuarios.Clave` (contraseña en texto plano).

Respuesta: `[{ IdEmpleado, NombreEmpleado, Usuario }]`

### `GET /api/stock/ubicaciones?idSucursal=&idDeposito=`
Ubicaciones activas de un depósito, para poblar el selector de ubicación origen/destino.

```sql
SELECT IdUbicacion, RTRIM(NombreUbicacion) AS NombreUbicacion
FROM SucursalesUbicaciones
WHERE IdSucursal=@idSucursal AND IdDeposito=@idDeposito AND Activo=1
ORDER BY IdUbicacion
```

Validar `idSucursal`/`idDeposito` como enteros positivos (`{error}` si no).

### `GET /api/stock/producto-deposito?ids=<csv>&idSucursal=&idDeposito=`
Stock exacto de una lista de productos en un depósito puntual (no agregado por
"disponible para venta" como `/api/stock/plus`) — para verificar contra la cantidad
a reservar en el depósito origen elegido, que puede no ser el default.

```sql
SELECT IdProducto, Stock
FROM ProductosDepositos
WHERE IdSucursal=@idSucursal AND IdDeposito=@idDeposito AND IdProducto IN (@ids...)
```

Respuesta: `[{ IdProducto, Stock }]`. Productos sin fila → ausentes en la respuesta
(el frontend los trata como stock 0).

### `POST /api/stock/movimiento` (reusado, sin cambios)
Ya valida whitelist de tipo, enteros positivos, cantidad≠0. Se llama 2 veces por
componente (baja origen, alta destino).

## Frontend — planificacion.html

### Botón
Junto a `#btnResumenMP`, mismo estilo y misma condición de `disabled` (`items.length === 0`):

```html
<button class="btn btn-secondary btn-sm" id="btnReservarComp" disabled
  title="Reservar componentes de materia prima para este plan">🔒 Reservar componentes</button>
```

### Modal `overlayReservarComp`
Estructura similar a `overlayMPResumen`.

**Controles superiores** (fila de selects, sucursal fija = 1, Casa Central — no seleccionable):

| Campo | Fuente | Default |
|---|---|---|
| Depósito origen | `GET /api/stock/depositos?idSucursal=1` | `IdDeposito=1` (Casa Central) |
| Ubicación origen | `GET /api/stock/ubicaciones?idSucursal=1&idDeposito={origen}` | primera de la lista |
| Depósito destino | mismo endpoint que origen | `IdDeposito=99` si existe en la lista, si no la primera distinta de origen |
| Ubicación destino | `GET /api/stock/ubicaciones?idSucursal=1&idDeposito={destino}` | primera de la lista |
| Empleado | `GET /api/stock/empleados` | ninguno (obligatorio elegir) |

Cambiar depósito origen/destino repuebla su select de ubicación correspondiente.
Cambiar depósito origen también refresca la columna "Stock" de la tabla (ver abajo).

**Tabla de componentes** — fuente: el mismo `mpList` que ya calcula
`calcularMPParaItems(items)` (usado por Resumen MP):

| Columna | Detalle |
|---|---|
| ☑ | checked por default si `total > 0` |
| Componente | nombre + PLU |
| Cantidad a reservar | `<input type="number">`, precargado con `total` (el "necesario"), editable |
| Stock en origen | vía `/api/stock/producto-deposito`, batched una sola llamada al abrir el modal y cada vez que cambia el depósito origen |
| Estado | ⚠ si `cantidad > stock` (solo visual, **no bloquea** — decisión ya tomada: se permite reservar igual, con advertencia) |

**Footer:**
- Botón "Confirmar reserva" — deshabilitado hasta que depósito origen, ubicación origen,
  depósito destino, ubicación destino y empleado estén todos elegidos.
- Botón "Cerrar".

### Flujo de confirmación

Al hacer click en "Confirmar reserva":

1. El botón se deshabilita inmediatamente (guardia básica anti-doble-click; no persiste
   entre recargas ni entre reaperturas del modal — limitación aceptada explícitamente).
2. Por cada fila marcada con cantidad > 0, **secuencialmente** (no en paralelo, para no
   saturar el pool de escritura ni mezclar números de comprobante de forma confusa):
   a. `POST /api/stock/movimiento` — baja en origen:
      `{ idSucursal:1, idDeposito:origen, idUbicacion:ubicOrigen, idTipoMovimiento:'BIENESUSO', idProducto:plu, cantidad:-cant, usuario, idEmpleado, observacion:"Reserva componentes plan {fecha}" }`
   b. `POST /api/stock/movimiento` — alta en destino: mismo body con `idDeposito:destino`,
      `idUbicacion:ubicDestino`, `cantidad:+cant`.
   c. Si ambas llamadas devuelven `ok:true` → fila ✅. Si cualquiera falla → fila ❌ con el
      mensaje de error. **Se continúa con el resto de los componentes** (independiente,
      decisión ya tomada) — un fallo no aborta los siguientes.
3. Al terminar, mostrar resumen "X de Y componentes reservados correctamente".
4. El usuario cierra el modal manualmente (no hay auto-cierre ni refresco automático de
   Resumen MP — si quiere ver el stock actualizado, reabre Resumen MP).

## Fuera de alcance (explícito)

- Sin persistencia de "componente ya reservado" entre sesiones/recargas — solo guardia
  en memoria durante la vida del modal abierto.
- Sin selector de sucursal (fijo Casa Central, sucursal 1 — coincide con el alcance actual
  del módulo de planificación, que no maneja otras sucursales).
- Sin rollback cruzado entre componentes (cada componente es independiente).
- No se valida contra "stock negativo prohibido" — Siga permite stock negativo en estas
  tablas (confirmado en `pruebas_stock_claude`), por eso la advertencia es solo visual.

## Testing / verificación manual

- Probar con depósito origen/destino default (1→99) y cantidades chicas antes de uso real.
- Probar caso de error controlado: elegir un `idTipoMovimiento` fuera de whitelist a nivel
  API (no aplica desde UI, que solo usa BIENESUSO) para confirmar que el endpoint sigue
  rechazando bien.
- Probar componente con cantidad > stock en origen: debe reservar igual y mostrar ⚠, no
  bloquear.
- Probar doble click en "Confirmar reserva": el botón debe quedar deshabilitado tras el
  primer click.
