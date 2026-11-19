<div align="center">

# Apidelta SubSystem

### Todo lo que tu ERP Siga no te muestra, en un solo panel.

Producción, compras, distribución, precios y control de sucursales sobre tus propios datos de Siga. Sin migrar nada. Sin cambiar cómo facturás.

![Node.js](https://img.shields.io/badge/Node.js-Express_5-1e1e1e?style=flat-square&logo=node.js&logoColor=white)
![SQL Server](https://img.shields.io/badge/SQL_Server-lee_tu_Siga-405936?style=flat-square&logo=microsoftsqlserver&logoColor=white)
![Instalación](https://img.shields.io/badge/instalación-en_tu_red-FFCC00?style=flat-square&labelColor=1e1e1e)
![Acceso](https://img.shields.io/badge/acceso-por_usuario_y_módulo-405936?style=flat-square)

</div>

---

## El problema

Siga registra todo, pero responder preguntas del día a día todavía se hace a mano:

- ¿Qué producimos hoy y con qué stock de granel?
- ¿Cuánto mandar a cada sucursal para que no se quiebre ni sobre?
- ¿A qué proveedor hay que pedirle ya, y cuánto tarda en entregar?
- ¿Mis precios de Mercado Libre y Tienda Nube siguen alineados con la lista de Siga?
- ¿Qué sucursal se quedó con mercadería por vencer?

Hoy eso significa planillas de Excel, exportaciones y recuentos manuales.

## La solución

**Apidelta SubSystem** se conecta a tu base de Siga y la convierte en pantallas de trabajo listas para usar. Lee tus datos reales, calcula lo que hay que decidir y deja el resultado a un clic: en pantalla o en un Excel.

| | |
|---|---|
| **Sobre tu sistema actual** | Se monta encima de Siga. No lo reemplaza ni te obliga a migrar. |
| **Corre en tu red** | Se instala en un servidor propio. Tus datos no salen de tu empresa. |
| **Cada quien ve lo suyo** | Usuarios con sesión y permisos por módulo. |
| **Se adapta a tu operación** | Se construye módulo a módulo, a partir de cómo trabajás. |

---

## Qué podés hacer

### Producción y distribución
| Módulo | Lo que resuelve |
|---|---|
| **Planificación** | Qué producir según demanda, stock y sugerencias, con reserva de mercadería. |
| **Producción** | Órdenes del día, granel y seguimiento de fabricación. |
| **Productividad** | Lo planificado contra lo producido, y el ritmo por persona en producción y fraccionado. |
| **Distribución** | Reparto a sucursales: almacén, pesables y envasado, con registro de lo fraccionado. |
| **Análisis ABC 80/20** | Qué productos importan en cada sucursal, con mínimos y días de operación. |
| **Fraccionado externo** | Costo de mano de obra por paquete y pedido listo en PDF para tercerizar. |

### Compras
| Módulo | Lo que resuelve |
|---|---|
| **Compras** | Pedidos a proveedores con stock y cobertura en central y sucursales, seguimiento de entrega y tablero OTIF. |
| **Importar a SIGA** | Convierte el pedido en comprobante de Siga, sin volver a cargarlo. |
| **Insumos** | Stock, consumo mensual estimado y cuánto dura lo que hay. |
| **Precios de proveedores** | Compara listas (PDF, URL o carga manual) contra tus costos de Siga. |

### Precios y venta online
| Módulo | Lo que resuelve |
|---|---|
| **Armado de precios** | Costos, márgenes, precio final y simulador por producto, con el costeo del fraccionado. |
| **Cotizador mayorista** | Publica la lista mayorista con vista previa de cambios e historial de versiones. |
| **Control Mercado Libre** | Detecta publicaciones con precio distinto al esperado según Siga, márgenes y gastos de ML. |
| **Control Tienda Nube** | Compara tu catálogo y exporta un CSV listo para reimportar con los precios corregidos. |
| **Histórico de precios** | El precio de cada producto, día por día, descargable en Excel. |

### Finanzas y control
| Módulo | Lo que resuelve |
|---|---|
| **Cuentas corrientes** | Deuda viva por cliente, antigüedad y detalle de comprobantes. |
| **Cruce bancario** | Empareja cada movimiento del banco con su ticket de Siga por importe y hora. |
| **Cruce de terminales** | Asigna cada comprobante de Payway y QR a su sucursal. |
| **Análisis de ventas** | Ticket promedio, días y horas pico, top de productos y comparativa entre sucursales. |
| **Ventas por hora** | Horas pico por sucursal en un rango de fechas. |

### Sucursales y equipo
| Módulo | Lo que resuelve |
|---|---|
| **Vencimientos** | Flujo de oferta y vencido con movimientos de stock en Siga. |
| **Carteles de pesables** | Carteles de precio listos para imprimir. |
| **Mantenimiento** | Pedidos de mantenimiento con calendario y responsables. |
| **Tickets** | Pedidos de cambios al sistema con seguimiento por estado. |
| **RRHH** | Relevamiento de ropa de trabajo y análisis de CV. |

> Más de 25 módulos hoy, y la lista sigue creciendo.

---

## Por qué funciona

**Menos horas en planillas.** Lo que se armaba a mano con exportaciones ahora sale del propio sistema, y cuando hace falta, se baja a Excel.

**Decisiones con datos del día.** Todo se calcula sobre la base viva de Siga, no sobre una copia vieja.

**Un solo lugar.** Un panel de inicio con tarjetas por módulo. Cada usuario ve solo las que tiene permitidas.

**Hecho para escritorio.** Tablas densas y legibles, pensadas para quien trabaja con números todo el día.

**Probado.** El sistema tiene una suite de más de 3.300 pruebas automáticas y validadores de paridad entre entornos, para que cada actualización llegue sin sorpresas.

---

## Cómo se implementa

1. **Relevamiento.** Vemos cómo trabajás hoy y qué decisiones se toman a mano.
2. **Conexión.** Se instala en tu red y se conecta a tu base de Siga.
3. **Módulos a medida.** Se activan los que necesitás y se ajustan a tu operación.
4. **Usuarios y permisos.** Cada persona accede a lo que le corresponde.
5. **Evolución.** Los pedidos de cambio entran por el módulo de tickets y se priorizan.

**Requisitos:** Windows, Node.js y acceso a la base de Siga en SQL Server.

---

## Para el equipo técnico

```bash
npm install
npm run dev      # desarrollo, puerto 8081
npm start        # producción
npm test         # suite de pruebas
```

Stack: Node.js, Express 5, `mssql` / `msnodesqlv8`, `xlsx` y `multer`. Frontend en HTML con tema compartido y sin dependencia de build. Scripts auxiliares en Python. La configuración vive en `config.json` y `.env` (ver `.env.example`).

Documentación interna en [`docs/`](docs/).

---

<div align="center">

**¿Querés verlo funcionando con tus propios datos?**
Coordiná una demostración y lo probamos sobre tu Siga.

**Contacto:** [adrsanabria.it@gmail.com](mailto:adrsanabria.it@gmail.com)

<sub>Apidelta SubSystem · Subsistema operativo sobre Siga</sub>

</div>
