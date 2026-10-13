# Pruebas automatizadas

Las reglas de negocio se verifican con `pnpm test`. La interfaz completa se prueba con Playwright:

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:e2e
```

En equipos donde Chromium descargado no arranque, puede usarse Chrome instalado, con un perfil temporal independiente:

```powershell
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm test:e2e
```

`pnpm test:e2e:ui` abre el explorador interactivo de las pruebas. `pnpm exec playwright show-report` muestra el informe HTML. Los fallos conservan captura y traza en `test-results`; el informe queda en `playwright-report`. Ambos directorios se excluyen de Git.

GitHub Actions ejecuta las pruebas de negocio y Playwright en cada push a `main`, en las pull requests y bajo petición manual. Conserva informes y trazas durante siete días. No necesita credenciales del Site ni de producción.

El servidor de pruebas arranca automáticamente en `127.0.0.1:5199` y se detiene al terminar. No se reutiliza un servidor existente ni se admite una URL remota. Las migraciones se aplican a `.sites-runtime/e2e-state`, separado de `.wrangler/state` y de producción. La sesión ficticia local es `seedy@sites.test`; no valida el acceso real a ChatGPT.

Cada prueba crea una simulación con cuatro controladores ficticios. No modifica la campaña real, incluso dentro de la base de pruebas. Las restauraciones afectan exclusivamente a esta base aislada. Los escenarios se ejecutan secuencialmente porque la restauración es global; cada ejecución crea escenarios nuevos y admite repetirse.

Se comprueban en escritorio y en un viewport móvil de Chromium:

- Consulta pública, bloqueo de escritura anónima y privacidad de simulaciones.
- Activación del orden mediante UI, aplazamiento, elección doble en calendario y deshacer/rehacer.
- Preferencias introducidas por un administrador y asignación automática al llegar el turno.
- Cierre de campaña desde UI, rechazo de cambios, descarga de backup y restauración por API.

La suite usa la API para preparar datos y comprobar persistencia; utiliza los controles reales para las acciones de usuario. La revisión visual exploratoria sigue siendo útil, pero no sustituye a estas regresiones. Quedan fuera el inicio de sesión real de ChatGPT, Safari nativo y la validación de las normas todavía pendientes.
