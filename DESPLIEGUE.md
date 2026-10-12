# Site privado

Proyecto: `appgprj_6acd43ada448819191e64de437e92b74`.

La identidad y el enlace se conservan en `.openai/hosting.json` y en el resultado nativo de Sites. El despliegue usa el archivo Worker construido y las migraciones de `drizzle/`; no importa el Excel ni datos reales.

Superadministradores autorizados por configuración de entorno: las dos cuentas solicitadas por el usuario. La pertenencia a la lista de visitantes de Sites no concede el rol de administrador por sí sola. El propietario conserva el acceso; el segundo visitante necesita aceptar el acceso de la plataforma.

Las comprobaciones técnicas de la aplicación se describen en `VALIDACION.md`. El resultado de la verificación alojada se añadirá a este registro después del despliegue.
