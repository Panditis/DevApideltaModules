/* Agrega permiso INSERT en las tablas de stock al usuario apidelta_stock.
   Necesario para traslados a depositos donde el producto aun no tiene fila de stock.
   Ejecutar en SSMS conectado como ADMINISTRADOR (Windows auth). */
USE [Siga];
GO
GRANT INSERT ON dbo.ProductosDepositos   TO [apidelta_stock];
GRANT INSERT ON dbo.ProductosUbicaciones TO [apidelta_stock];
GO

-- Verificar permisos resultantes
SELECT  pr.name AS Usuario, perm.permission_name AS Permiso, OBJECT_NAME(perm.major_id) AS Tabla
FROM    sys.database_permissions perm
JOIN    sys.database_principals  pr ON perm.grantee_principal_id = pr.principal_id
WHERE   pr.name = N'apidelta_stock'
ORDER BY Tabla, Permiso;
GO
PRINT 'INSERT agregado en ProductosDepositos y ProductosUbicaciones.';
