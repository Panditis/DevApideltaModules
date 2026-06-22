/* ============================================================================
   Crea un usuario SQL dedicado para movimientos de stock automatizados.
   - Puede LEER todo (db_datareader), igual que el usuario actual.
   - Puede ESCRIBIR solo en las 5 tablas de movimientos de stock.
   Ejecutar en SQL Server Management Studio conectado como ADMINISTRADOR (sa o equivalente).
   ⚠️ CAMBIA la contraseña de la linea de abajo antes de ejecutar.
   ============================================================================ */

-------------------------------------------------------------------------------
-- 1) LOGIN a nivel servidor (autenticacion SQL)
-------------------------------------------------------------------------------
USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'apidelta_stock')
BEGIN
    CREATE LOGIN [apidelta_stock]
        WITH PASSWORD = N'Apd_Stock_2026#Cambiar',   -- <<< CAMBIAR ESTA CLAVE
             CHECK_POLICY = ON;
END
GO

-------------------------------------------------------------------------------
-- 2) USER dentro de la base Siga, mapeado al login
-------------------------------------------------------------------------------
USE [Siga];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'apidelta_stock')
BEGIN
    CREATE USER [apidelta_stock] FOR LOGIN [apidelta_stock];
END
GO

-------------------------------------------------------------------------------
-- 3) Lectura general (igual que el usuario actual de los dashboards)
-------------------------------------------------------------------------------
ALTER ROLE [db_datareader] ADD MEMBER [apidelta_stock];
GO

-------------------------------------------------------------------------------
-- 4) Escritura ACOTADA: solo las 5 tablas de movimientos de stock
-------------------------------------------------------------------------------
GRANT INSERT, UPDATE ON dbo.MovimientosNumeros        TO [apidelta_stock];
GRANT INSERT, UPDATE ON dbo.MovimientosStock          TO [apidelta_stock];
GRANT INSERT, UPDATE ON dbo.MovimientosStockProductos TO [apidelta_stock];
GRANT UPDATE         ON dbo.ProductosDepositos        TO [apidelta_stock];
GRANT UPDATE         ON dbo.ProductosUbicaciones      TO [apidelta_stock];
GO

-------------------------------------------------------------------------------
-- 5) (Opcional) Verificar los permisos otorgados
-------------------------------------------------------------------------------
SELECT  pr.name                AS Usuario,
        perm.permission_name   AS Permiso,
        OBJECT_NAME(perm.major_id) AS Tabla
FROM    sys.database_permissions perm
JOIN    sys.database_principals  pr ON perm.grantee_principal_id = pr.principal_id
WHERE   pr.name = N'apidelta_stock'
ORDER BY Tabla, Permiso;
GO

PRINT 'Usuario apidelta_stock creado. Lectura total + escritura solo en tablas de stock.';
