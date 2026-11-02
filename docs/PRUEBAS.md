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

## Integración continua

GitHub Actions no necesita credenciales del Site ni de producción. En cada push a una pull request propia del mismo repositorio y a `main` ejecuta dos jobs en runners propios, sin alternativa alojada en GitHub:

1. **Checks rápidos** (`checks`), en cualquiera de los runners con la etiqueta compartida `vacaciones-ci-v2`. Una sola instalación y, en este orden: Prettier, tipos, los mismos archivos unitarios de `pnpm test` ejecutados secuencialmente, `pnpm build` y `pnpm lint:ratchet`, obligatorio: bloquea cualquier incremento de errores ESLint por archivo y regla respecto a `lint-baseline.json`. El job tiene un límite total de 20 minutos, compartido por todos esos pasos. Node usa un timeout predeterminado de 90 segundos por prueba y cada archivo tiene un límite externo de 120 segundos, con terminación forzada 10 segundos después; el primer fallo detiene el job e identifica el archivo. El margen total permite variaciones de carga del runner sin desactivar la detección de pruebas bloqueadas.
2. **Playwright** (`browser`), solo si los checks rápidos pasan, en el mismo grupo `vacaciones-ci-v2`: el servidor `pve-playwright-01` o cualquiera de los dos runners del portátil. Un check rojo no ocupa un runner de Playwright.

Cada runner atiende un job a la vez, con su propio workspace y caché persistente de pnpm en `/pnpm/store`. Se usan Node 24 y pnpm 11.25.0 ya instalados en la imagen; no se reinstalan globalmente en cada job. El selector manual de runner, si se elige uno, se aplica a los dos jobs. Las PR externas y de otros autores no ejecutan código en estos runners. GitHub asigna cada job a un runner online y libre del grupo, sin prioridad entre sistemas. Si el portátil está apagado, el servidor puede ejecutar ambos jobs; si todos están ocupados, los trabajos esperan en cola.

Playwright tiene dos niveles:

- **Smoke** en cada push de una pull request: los tests etiquetados `@smoke`, que cubren acceso, consulta de la campaña, elección en un turno y preferencias. `pnpm exec playwright test --list --grep @smoke` muestra el subconjunto.
- **Suite completa** solo en cada push a `main` y al lanzar el workflow a mano (`workflow_dispatch`, que sirve para validar una rama concreta antes del merge si hace falta). Si falla en `main`, se corrige con una pull request nueva. No se suben capturas, vídeos ni trazas: los resultados quedan en la consola del job.

`pnpm install` activa un hook `pre-push` (`.githooks/pre-push`) que ejecuta `pnpm format:check` y bloquea el push si hay errores de formato; se corrige con `pnpm format`. `git push --no-verify` lo omite una vez.

Para marcar un test como smoke se añade `@smoke` a su `tag`, sin cambiar lo que comprueba. El subconjunto debe seguir siendo pequeño: cada test añadido se ejecuta en cada push de cada pull request.

### Trinquete de ESLint

La deuda existente queda registrada en `lint-baseline.json`, con un contador de errores por archivo y por regla. El estado inicial (commit `7de875c`) contiene **752 errores en 64 archivos** (715 de `@typescript-eslint/no-explicit-any`) y 46 advertencias, que no bloquean. El contador se genera mediante la salida JSON de ESLint usando las mismas opciones que `pnpm lint` (ignorando `dist` y `.next`).

- `pnpm lint`: informe normal de ESLint, puede terminar con código 1 por la deuda heredada.
- `pnpm lint:ratchet`: permite mantener o reducir cada contador, pero falla si crece uno cualquiera, aunque baje el total.
- `pnpm lint:ratchet:update`: **regenera** la línea base a partir del código actual. Debe utilizarse **solo tras corregir deuda existente**; revisa su diff y versiona el JSON junto a las correcciones. No se ejecuta en CI.

Si se corrigen errores, la comprobación muestra los contadores reducidos y sugiere actualizar el JSON. Una regla nueva o un error en un archivo nuevo parte de cero y bloquea el PR. Una avería de ESLint o un JSON inválido no puede superar la comprobación.
