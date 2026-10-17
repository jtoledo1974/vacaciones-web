# Site público con administración protegida

URL: https://<site>.chatgpt.site
Repositorio privado: https://github.com/jtoledo1974/vacaciones-web
Proyecto de Sites: appgprj_6acd43ada448819191e64de437e92b74.

Primer despliegue confirmado: appgdep_6acd4da16cc881918a2a6ab897290624, versión appgprj_6acd43ada448819191e64de437e92b74~appgver_1fa42cae9b208191b6374e390ca5dd69.

Se verificó en Chrome la sesión de superadministrador del propietario y la inicialización de ocho equipos en D1 alojado. El navegador embebido del usuario no completó el login; Chrome sí. No se sustituye ese mecanismo por un acceso inseguro.

Los dos superadministradores solicitados se configuran en el entorno privado de Sites. La lista de visitantes de la plataforma es independiente del rol de la aplicación.

La versión desplegada añade edición conjunta/importación de plantillas, retirada de trabajadores y nombres de equipo. La importación del Excel original y sus datos fue autorizada por el usuario. Los archivos de importación contienen datos personales y quedan fuera de los repositorios y paquetes de despliegue.


Actualización final: versión 3, despliegue appgdep_6acd557af6508191b53d6cd77bf364bc, código 14a0942e6f447f093609e3ee32d3144a6bbaeda3. Site público por petición del propietario; superadministradores toledo@lazaro.es y otro-superadmin@ejemplo.es. Sin otras concesiones de escritura en la base comprobada.

Importación real comprobada en Chrome y persistente tras recargar: equipo C de 2026, 16 nombres y nicks coincidentes, 16 antigüedades vacías, 81 solicitudes y 81 adjudicaciones copiadas. No se ha publicado el borrador como resultado definitivo. Los otros siete equipos conservan ejemplos: faltan sus fuentes. El Excel de Descargas es idéntico al de fuentes y solo incluye la plantilla C.

La copia descargada por el usuario antes de importar tiene SHA-256 válida; contiene ocho equipos y 128 personas de ejemplo. Conviene descargar una nueva copia tras la importación.

La versión 4 incorporó Deshacer/Rehacer y reinicio reversible, con 28 pruebas automatizadas y tipos correctos. Despliegue confirmado: appgdep_6acd56f2621881918ac31c9b16565e30. Las 81 selecciones de C permanecieron tras la actualización.


## Acceso local de emergencia (opcional)

Se ha añadido un acceso de **superadministrador de pruebas** mediante usuario y contraseña estática configurados únicamente como secretos del despliegue. No altera ChatGPT Sites ni Firebase. Por defecto está desactivado.

Consultar [docs/ADMIN_LOCAL.md](docs/ADMIN_LOCAL.md) para `LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD` y `LOCAL_ADMIN_SESSION_SECRET`, medidas de seguridad y procedimiento para ChatGPT Work. La identidad local se puede desactivar retirando los secretos; nunca escribir contraseñas en GitHub.
