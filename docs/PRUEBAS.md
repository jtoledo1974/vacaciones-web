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

El servidor de pruebas arranca automáticamente en `127.0.0.1:5199` y se detiene al terminar. No se reutiliza un servidor existente ni se admite una URL remota. Las migraciones se aplican a una carpeta nueva `.sites-runtime/e2e-state/run-<uuid>` en cada ejecución, separada de `.wrangler/state` y de producción. Así no se reutilizan sesiones ni límites de intentos de login. La ruta de la última ejecución queda en `.sites-runtime/e2e-latest-state.txt`. La sesión ficticia local es `seedy@sites.test`; no valida el acceso real a ChatGPT.

Cada prueba crea una simulación con cuatro controladores ficticios. No modifica la campaña real, incluso dentro de la base de pruebas. Las restauraciones afectan exclusivamente a esta base aislada. Los escenarios se ejecutan secuencialmente porque la restauración es global; cada ejecución crea escenarios nuevos y admite repetirse.

Se comprueban en escritorio y en un viewport móvil de Chromium:

- Consulta pública, bloqueo de escritura anónima y privacidad de simulaciones.
- Activación del orden mediante UI, aplazamiento, elección doble en calendario y deshacer/rehacer.
- Preferencias introducidas por un administrador y asignación automática al llegar el turno.
- Cierre de campaña desde UI, rechazo de cambios, descarga de backup y restauración por API.

La suite usa la API para preparar datos y comprobar persistencia; utiliza los controles reales para las acciones de usuario. La revisión visual exploratoria sigue siendo útil, pero no sustituye a estas regresiones. Quedan fuera el inicio de sesión real de ChatGPT, Safari nativo y la validación de las normas todavía pendientes.

## Revisión de preferencias responsive

La suite `tests/e2e/preferences.spec.ts` recorre 375 × 667, 390 × 844, 768 × 1024 y 1440 × 900. En local conserva nueve capturas por tamaño: lista vacía, primera selección sin guardar, revisión, orden modificado, guardado, modificación posterior, salida con cambios, ciclos sin cupo y confirmación de adjudicación inmediata. También verifica persistencia mediante API y recarga, cancelación del cambio de controlador/campaña/equipo, fallo de guardado, conservación de ciclos ocultos y acceso al botón de guardar con listas largas. También se comprueba que guardar tras deshacer conserva la pausa de automatismos y no adjudica otra vez. El foco queda dentro del panel móvil y Escape lo cierra sin descartar la lista.

El editor lateral permite consultar el calendario mientras se ordena en escritorio. Hasta 900 px, una barra inferior muestra cantidad y estado, y abre la revisión. Seleccionar y reordenar solo cambia el borrador; guardar es una acción explícita. Salir del modo, cambiar de controlador, equipo, ejercicio, escenario o apartado pide descartar si hay cambios pendientes. Cerrar/recargar la página activa el aviso del navegador. Los borradores no se guardan en el almacenamiento del navegador.

Las capturas quedan en `test-results/`, excluido de Git. Con `CI` no se generan estas capturas ni se suben artefactos. Para repetir la revisión en Chrome instalado:

```powershell
$env:PLAYWRIGHT_CHANNEL='chrome'
node node_modules/playwright/cli.js test tests/e2e/preferences.spec.ts
```
