// ponytail: one-off audit export, not a shared module.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql/msnodesqlv8');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = { connectionString:
  `Driver={ODBC Driver 17 for SQL Server};Server=${process.env.SIGA_DB_SERVER};` +
  `Database=${process.env.SIGA_DB_NAME};UID=${process.env.SIGA_READ_UID};PWD=${process.env.SIGA_READ_PWD};TrustServerCertificate=yes;` };

const OUT_DIR = path.join(__dirname, 'audit_out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n;]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(';')];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(';'));
  return lines.join('\n');
}

(async () => {
  const pool = await sql.connect(DB_CONFIG);

  // 1. Funciones (permisos/funciones del sistema)
  const funciones = (await pool.request().query(
    `SELECT Id, Nombre, Descripcion, EsMenu, EsBoton, Enabled, Visible, IdPadre, Pantalla, IdModulo
     FROM Funciones ORDER BY Id`)).recordset;
  fs.writeFileSync(path.join(OUT_DIR, '1_funciones.csv'), toCsv(funciones));

  // 2. Roles -> Funciones (con nombres legibles)
  const rolesFunciones = (await pool.request().query(
    `SELECT r.Id AS IdRol, r.Nombre AS Rol, f.Id AS IdFuncion, f.Nombre AS Funcion, f.Descripcion AS DescripcionFuncion
     FROM RolesFunciones rf
     JOIN Roles r ON r.Id = rf.IdRol
     JOIN Funciones f ON f.Id = rf.IdFuncion
     ORDER BY r.Nombre, f.Nombre`)).recordset;
  fs.writeFileSync(path.join(OUT_DIR, '2_roles_funciones.csv'), toCsv(rolesFunciones));

  // 3. Usuarios -> Roles (sin datos sensibles: se excluye Clave/MailPassword)
  const usuariosRoles = (await pool.request().query(
    `SELECT u.Id AS IdUsuario, u.Nombre AS Usuario, u.Activo, ur.IdRol, r.Nombre AS Rol, ur.IdSucursal
     FROM UsuariosRoles ur
     JOIN Usuarios u ON u.Id = ur.IdUsuario
     JOIN Roles r ON r.Id = ur.IdRol
     ORDER BY u.Nombre, r.Nombre`)).recordset;
  fs.writeFileSync(path.join(OUT_DIR, '3_usuarios_roles.csv'), toCsv(usuariosRoles));

  // extra: listado de roles solo (catalogo)
  const roles = (await pool.request().query(`SELECT Id, Nombre, Descripcion FROM Roles ORDER BY Id`)).recordset;
  fs.writeFileSync(path.join(OUT_DIR, '0_roles.csv'), toCsv(roles));

  console.log('Funciones:', funciones.length);
  console.log('RolesFunciones:', rolesFunciones.length);
  console.log('UsuariosRoles:', usuariosRoles.length);
  console.log('Roles:', roles.length);
  console.log('Archivos escritos en', OUT_DIR);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
