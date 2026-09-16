-- 0044 — Los permisos que les faltaban a las tablas de las migraciones 0041 y
-- 0043, y la red para que no vuelva a pasar.
--
-- La aplicación se conecta como `gestion_app`, no como el dueño del esquema.
-- Cada tabla nueva necesita su `GRANT`, y las de categorías y retenciones
-- salieron sin él: la pantalla de productos fallaba con "permiso denegado a la
-- tabla producto_categoria" apenas se abría, porque el `CAMPOS` del producto
-- lee el nombre de la categoría.
--
-- Nunca se otorga `DELETE`: en este sistema nada se borra, se archiva. Es la
-- misma lista de privilegios que usan todas las tablas desde `0002`.

GRANT SELECT, INSERT, UPDATE ON producto_categoria  TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON retencion_concepto  TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON venta_retencion     TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON uvt                 TO gestion_app, gestion_provision;

-- La red: de acá en adelante, cualquier tabla que cree el dueño del esquema
-- nace con estos permisos. Olvidarse del `GRANT` deja de ser un error que
-- aparece recién al abrir la pantalla en desarrollo —o peor, en producción—.
--
-- No reemplaza al `GRANT` explícito en cada migración: sigue escribiéndose,
-- porque leer la migración tiene que alcanzar para saber quién puede tocar la
-- tabla. Esto es lo que salva cuando alguien se olvida.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO gestion_app, gestion_provision;
