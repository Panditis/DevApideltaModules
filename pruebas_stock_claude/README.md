# Pruebas — Movimientos de stock en Siga vía código

Scripts usados para investigar y probar la creación de **movimientos de stock** en Siga
(SQL Server `servidorapidelta\SQLSTANDARD`, base `Siga`) directamente desde Node, sin la app.

> ⚠️ **Seguridad:** los `.js` tienen credenciales en texto plano (`apidelta` lectura, `apidelta_stock` escritura).
> Antes de dejar esto productivo, mover las claves a variables de entorno.

---

## Cómo correr
Desde esta carpeta (usa el `node_modules` de `dev/` por herencia):
```
cd C:\Users\Adriel\ApideltaSubSystem\dev\pruebas_stock_claude
node <script>.js
```

---

## Orden cronológico / propósito de cada archivo

### Descubrimiento (solo lectura)
| Archivo | Qué hace |
|---|---|
| `_descubrir_stock.js`  | Lista tablas y stored procedures de stock. **Hallazgo: no hay SPs.** |
| `_descubrir_stock2.js` | Columnas de `MovimientosStock` / `...Productos`, tipos de movimiento, **no hay triggers**. |
| `_descubrir_stock3.js` | Numeración (`MovimientosNumeros`), depósitos, patrón real de un BIENESUSO. |
| `_descubrir_stock4.js` | `ProductosUbicaciones` (2ª tabla de stock), cabecera real, contador = máx número. |
| `_ver_usuarios.js`     | Columnas y contenido de `Usuarios` (la columna de login es `Id`). |
| `_descubrir_reserva_transfer.js` | Cómo se modelan reservas y traslados (2 líneas, sin `IdDeposito2`). |
| `_descubrir_depositos.js` | Nombres reales de depósitos: 1=Casa Central, 2=Reservador Mayorista, 99=Reservado. |
| `_verificar_reserva_signo.js` | Confirma que el reservado (dep 99) guarda stock **positivo**. |
| `_descubrir_tipo_traslado.js` | Qué tipo usa Siga para traslados (solo RESERVA 1↔99; dep 2 sin uso). |

### Permisos (ejecutar en SSMS como admin Windows)
| Archivo | Qué hace |
|---|---|
| `_crear_usuario_stock.sql`   | Crea login SQL `apidelta_stock`: lectura total + escritura solo en 5 tablas de stock. |
| `_agregar_permiso_insert.sql`| Agrega INSERT en `ProductosDepositos`/`ProductosUbicaciones` (traslado a depósito vacío). |

### Movimiento interno simple
| Archivo | Qué hace |
|---|---|
| `_prueba_movimiento_DRYRUN.js` | Movimiento +2.5 dentro de transacción con **ROLLBACK** (no escribe). |
| `_prueba_movimiento_REAL.js`   | **REAL** net-zero: +2.5 y −2.5 (comprobantes 16411/16412). |
| `_verificar.js`                | Verifica contador, stock y últimos movimientos. |

### Traslado entre depósitos
| Archivo | Qué hace |
|---|---|
| `_traslado_DRYRUN.js`     | Traslado dep 1→2 con **ROLLBACK** (crea fila destino si falta). |
| `_traslado_REAL.js`       | **REAL** net-zero: 1→2 y 2→1 (comprobantes 16414/16415). |
| `_verificar_traslado.js`  | Verifica stock por depósito y el detalle de los comprobantes. |

---

## Mecanismo de un movimiento de stock (resumen técnico)

Siga **no usa stored procedures ni triggers** para stock: la app escribe a mano, en transacción:

1. `UPDATE MovimientosNumeros SET Numero = Numero+1` (reserva atómica del número, por sucursal+tipo)
2. `INSERT MovimientosStock` (cabecera: Neto/Total/percepciones en 0)
3. `INSERT MovimientosStockProductos` (1 línea por ítem; `Precio` puede ir 0)
4. `UPDATE ProductosDepositos   SET Stock = Stock + Cantidad*CoeficienteStock`
5. `UPDATE ProductosUbicaciones SET Stock = Stock + Cantidad*CoeficienteStock`

**Tipos:** `BIENESUSO` = "Movimientos internos" (coef +1). Casa Central = Sucursal 1, Depósito 1, Ubicación 1.

**Traslado / reserva = 1 comprobante con 2 líneas:** origen `−Q` (Orden 1) + destino `+Q` (Orden 2).
- Reserva: dep 1 (vendible) → dep 99 (reservado). Las reservas reales se generan desde un PEDIDO.
- Traslado genérico: usar `BIENESUSO` con 2 líneas; si el depósito destino no tiene fila, se hace INSERT.
