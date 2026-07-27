# Circuito de reserva de mercadería y movimientos hacia SIGA

Resumen de lo que se agregó para reservar mercadería y que esos movimientos queden reflejados en SIGA.

## La idea en una línea
Cuando se reserva mercadería para producción, esa mercadería queda **apartada** en el sistema con un **número de movimiento** propio. Ese número acompaña todo el circuito, desde la reserva hasta el cierre, de modo que siempre se sabe qué se apartó, cuánto se usó y qué sobró.

---

## El circuito, paso a paso

### 1. Se reserva la mercadería
Al reservar, el sistema:
- Aparta la mercadería en el **depósito de reserva** (queda separada, no disponible para otra cosa).
- Genera un **número de movimiento de SIGA** que identifica esa reserva.
- Deja anotado el detalle: qué productos y qué cantidades se apartaron.

Cada orden de producción queda **etiquetada con su número de movimiento**, visible de un vistazo.

### 2. Se trabaja en producción
Con la mercadería ya apartada, producción usa lo que necesita. El sistema mantiene, por cada número de movimiento, lo que se había reservado.

### 3. Se cierra (conciliación)
Al cerrar, el sistema compara **lo reservado contra lo realmente usado** y muestra el desglose por movimiento:
- **Usado**: lo que efectivamente se consumió.
- **Sobrante**: lo que se había apartado de más.

Con eso genera **un solo movimiento de ajuste en SIGA por cada reserva**:
- Lo **usado** se descuenta del depósito de reserva (salió a producción).
- Lo **sobrante** vuelve del depósito de reserva al **depósito de diferencias** (queda disponible de nuevo).

Así SIGA queda cuadrado: nada se pierde ni queda apartado de más.

### 4. Si hace falta anular
Si una reserva se hizo por error, se puede **revertir**: el sistema anula el movimiento y libera la mercadería apartada.

---

## Controles que se agregaron para no perder información
- **No se puede borrar ni modificar** una orden que ya está reservada o ya trabajada.
- Al **borrar un plan completo**, las órdenes reservadas se conservan.
- Las órdenes con **reserva pendiente de cerrar** quedan marcadas para que no se pasen por alto.
- Las reservas ya cerradas pasan a un **historial** y dejan de mezclarse con las pendientes.
- El ajuste de SIGA es **a prueba de repeticiones**: si se reintenta un cierre, no genera el movimiento dos veces.

---

**En resumen:** cada reserva nace con su número de movimiento, ese número la acompaña hasta el cierre, y al cerrar se genera automáticamente el ajuste en SIGA con lo usado y lo sobrante. Todo queda trazado y cuadrado.
