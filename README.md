<div align="center">

# 🐼 Apidelta SubSystem · `dev`

### Subsistema web operativo sobre el ERP **Siga** 🐼

Blanco y negro, como un panda. Pedidos, producción, planificación, compras y distribución — todo en un solo hub local.

<br>

![Node](https://img.shields.io/badge/Node.js-000000?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express_5-000000?style=for-the-badge&logo=express&logoColor=white)
![SQL Server](https://img.shields.io/badge/SQL_Server_2022-FFFFFF?style=for-the-badge&logo=microsoftsqlserver&logoColor=black)
![Python](https://img.shields.io/badge/Python-FFFFFF?style=for-the-badge&logo=python&logoColor=black)

![Status](https://img.shields.io/badge/estado-activo-000000?style=flat-square)
![Versión](https://img.shields.io/badge/versión-1.0.0-000000?style=flat-square)
![Licencia](https://img.shields.io/badge/uso-interno-555555?style=flat-square)
![Tema](https://img.shields.io/badge/🐼-blanco_y_negro-000000?style=flat-square)

</div>

---

```
🐼 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 🐼
   "Como un panda: simple por fuera, todo músculo por dentro."
🐼 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 🐼
```


## ◼️ ¿Qué es?

**Apidelta SubSystem** es una capa web local montada sobre el ERP **Siga** (SQL Server 2022, ~548 tablas). Sirve un **hub de operaciones** (`inicio.html`) desde un único servidor **Express** que expone cada módulo de negocio como una ruta y una API REST.

Pensado para correr en red interna. Negro sobre blanco, sin ruido.

---

## ◻️ Módulos 🐼

| 🐼 | Módulo | Ruta | Qué hace |
|:--:|--------|------|----------|
| ◼️ | **A8020 Calculado** | `/distribucion/a8020` | Análisis ABC 80/20 por sucursal: clasificación, mínimos y días de operación. |
| ◻️ | **Pedidos** | `/pedidos` | Pedidos pendientes de Siga: clientes, productos y resumen por localidad. |
| ◼️ | **Planificación** | `/planificacion` | Producción a partir de demanda, stock y sugerencias. |
| ◻️ | **Producción** | `/produccion` | Órdenes del día, granel y seguimiento de fabricación. |
| ◼️ | **Compras** | `/compras` | Consumo, urgencias y cobertura de insumos. |
| ◻️ | **Compras Carlos** | `/consumo` | Consumo vs stock del proveedor Carlos: cobertura y reposición. |
| ◼️ | **Distribución y Fraccionado** | `/distribucion` | Almacén, pesables, envasado y registro de producción fraccionada. |
| ◻️ | **Cotizador** | `/cotizador` | Cálculo de cotizaciones de productos. |
| ◼️ | **Ventas por Hora** | `/ventas-hora` | Dashboard de horas pico por sucursal con filtro de fechas. |

---

## ◼️ Arquitectura 🐼

```
                          🐼  NAVEGADOR  🐼
                                 │
                  ┌──────────────┴──────────────┐
                  │      inicio.html (hub)       │
                  │   Tailwind · Lucide · SPA    │
                  └──────────────┬──────────────┘
                                 │  fetch /api/*
                  ┌──────────────┴──────────────┐
                  │        server.js             │
                  │   Express 5 · ~80 rutas      │
                  │   multer · xlsx · mssql      │
                  └──────────────┬──────────────┘
                                 │  msnodesqlv8 (Windows Auth)
                  ┌──────────────┴──────────────┐
                  │   SQL Server 2022 · "Siga"   │
                  │   ~548 tablas · ERP completo │
                  └─────────────────────────────┘
```

- **Multi-server por rama git (worktrees):** `dev` (puerto **8081**) y `produccion`. Diferenciación vía `config.json` + scripts batch.
- **Deploy:** `publicar.bat` → `publicar-APLICAR.bat` (con confirmación de seguridad).
- **Datos runtime:** carpeta `data/` (untracked).

---

## ◻️ Stack técnico

```
┌─ Runtime ─────────────────────────────────────────────┐
│  Node.js · Express 5.2          → server.js            │
│  msnodesqlv8 + mssql            → SQL Server 2022      │
│  multer                         → upload de archivos   │
│  xlsx                           → export/import Excel  │
├─ Frontend ────────────────────────────────────────────┤
│  HTML + Tailwind (CDN)          → cada módulo          │
│  Lucide icons · Chart.js        → UI / dashboards      │
├─ Scripts auxiliares (Python) ─────────────────────────┤
│  generar_catalogo · importar_distribucion             │
│  export_etiquetas · export_ventas_casa_central        │
└────────────────────────────────────────────────────────┘
```

---

## ◼️ Estructura 🐼

```
dev/
├── 🐼 server.js                      Backend Express (~80 rutas)
├── 🐼 inicio.html                    Hub / centro de operaciones
├── config.json                       Puerto, umbrales, grupos granel
├── package.json
│
├── ▸ Módulos (HTML)
│   ├── apidelta_produccion_dev.html  Producción
│   ├── planificacion.html
│   ├── distribucion.html  · distribucion.js
│   ├── carga-produccion.html
│   ├── pedidos_web.html
│   ├── dashboard_compras.html
│   ├── dashboard_consumo.html
│   ├── cotizador.html
│   ├── ventas_hora.html
│   └── a8020.html  · a8020.js
│
├── ▸ Lógica (JS)
│   ├── pesables.js
│   └── listas_universo.js
│
├── ▸ test/                           Tests y validadores
│   ├── *.test.js                     Suite de node:test (npm test)
│   ├── validar_almacen.js            Paridad del motor vs fixture golden
│   ├── validar_racionamiento.js      Piso mínimo y racionamiento por prioridad
│   ├── validar_ranking.js            Scores de ranking A8020
│   ├── validar_paridad_entornos.js   Diff dev(8081) vs producción(8080)
│   └── validar_paridad_config.js     Helpers de diff de configuración
│
├── ▸ Scripts (Python)
│   ├── generar_catalogo.py
│   ├── importar_distribucion.py
│   ├── export_etiquetas_necesarias.py
│   └── export_ventas_casa_central.py
│
└── data/                             Datos runtime (untracked)
```

---

## ◻️ Puesta en marcha

```bash
# 1. Instalar dependencias
npm install

# 2. Levantar en modo dev (recarga con nodemon)
npm run dev          # → http://localhost:8081

# 3. Producción
npm start
```

> 🐼 **Requiere** SQL Server 2022 con la base **Siga** accesible vía Windows Auth
> (`servidorapidelta\sqlstandard`). Ajustá puerto/host en `config.json`.

En Windows existe acceso directo: `iniciar_servidor_dev.bat`.

---

## ◼️ API REST — endpoints destacados

| Grupo | Ejemplos |
|-------|----------|
| **Salud / config** | `/api/health` · `/api/config` |
| **Pedidos** | `/api/pedidos` · `/api/clientes` · `/api/productos` · `/api/resumen` |
| **Compras** | `/api/compras/consumo` · `/api/compras/urgencias` · `/api/compras/buscar` |
| **Producción** | `/api/ordenes` · `/api/formulas/:plu` · `/api/stock/granel` · `/api/stock/terminados` |
| **Distribución** | `/api/distribucion/almacen` · `/api/distribucion/pesables` · `/api/distribucion/a8020` |
| **Catálogo** | `/api/catalogo` · `/api/catalogo/grupos` · `/api/siga/buscar` |

---

## ◻️ Paleta 🐼 (blanco y negro, con un toque de miel)

```
  ◼️  #000000   Negro          ◻️  #FFFFFF   Blanco
  ▓   #65684C   Oliva          ░   #BDBDB7   Gris
                  🍯  #FFCC00   Ámbar (acento)
```

---

<div align="center">

```
   🐼        🐼        🐼        🐼        🐼
   ╲        Apidelta · Subsistema local        ╱
            Hecho en blanco y negro
```

**Repo:** [`Panditis/DevApideltaModules`](https://github.com/Panditis/DevApideltaModules) · rama `dev`

</div>
