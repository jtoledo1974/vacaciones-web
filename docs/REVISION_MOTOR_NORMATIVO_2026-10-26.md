# Revisión del refactor `policyFor()` antes de la elección anticipada

Fecha: 26/10/2026 · Rama revisada: `claude/vacation-shifts-availability-rpa0cm` (57ac85b) ·
Referencia funcional: PR #86 y su comentario de decisiones (un solo predecesor, las rondas no son frontera,
el propio CTA puede deshacer).

**Veredicto.** El refactor es correcto y va en la buena dirección. Ya no queda ninguna rama
`year===2027` en el código genérico. Lo que falta no es una jerarquía de tipos «genérica»: hay que
**sacar del servicio dos piezas que la elección anticipada necesita**, la secuencia de turnos y la
disponibilidad por persona, y **definir la semántica de lo indeterminado**. Hoy esa semántica es
optimista («si no se ha demostrado, se deja elegir provisionalmente») y la elección anticipada necesita la
contraria.

Leyenda: **[ANTES]** hacer antes de la elección anticipada · **[DEJAR]** puede esperar.

---

## Hallazgos por importancia

### 1. [ANTES] El motor de turnos deduce los turnos del número de adjudicaciones; una adjudicación anticipada se volvería a pedir

`domain/election.ts:157-161`: `remaining = entitlementFor − count` y
`needed = min(1 + credits, remaining)`. El turno no tiene registro de «hueco consumido». Si B se adelanta un
ciclo, al llegar a su posición `currentTurn` le volverá a pedir una elección. En la práctica B obtendría
dos elecciones en esa ronda, por delante de todos los demás, o se saltaría su hueco si ya hubiera terminado.
Eso contradice la especificación: «no se le vuelve a pedir esa misma elección… conservar la prioridad de
cualquier elección pendiente adicional».

**Propuesta.** Vincular cada adjudicación anticipada a un hueco concreto de la secuencia. Por ejemplo,
`ElectionState.earlyChoices: {memberId; round; cursor; awardId; at}[]`, validado en
`validateElectionState` y consumido por el escaneo de turnos: el hueco cuenta como jugado y se descuenta
`needed` si hay créditos. Deshacer o reconstruir elimina la entrada junto con la adjudicación. Es un
cambio de esquema del estado, así que debe hacerse después del módulo de secuencia (hallazgo 2) y
antes de cualquier endpoint.

### 2. [ANTES] «Quién va delante» tiene dos implementaciones, y la del servidor está en `app/` y es incorrecta para la anticipada

- `app/my-election-state.ts:80` `peopleAhead()` usa **un derecho uniforme**. El servidor le pasa
  `ctx.config.cyclesPerPerson` (`server/election-service.ts:237`) e ignora `individualEntitlements`.
  Tampoco tiene en cuenta los créditos por aplazamiento, ni que un turno conjunto es **un** turno con
  varias personas, ni los empates pendientes. Para la tarjeta «quedan N tiradas» es una estimación
  aceptable. Para decidir «queda exactamente una elección por delante» no sirve.
- Además invierte las capas: `server/` importa de `app/` (también lo hace `server/notifications.ts:2`).

**Propuesta.** Crear un módulo `domain/sequence.ts` **independiente de la política**: recibe el derecho por
miembro como función inyectada y no importa `policy.ts`. Su contenido:

```ts
export type TurnSlot = {cursor:number; round:number; participants:string[];
  requiredByMember:Record<string,number>; pendingTie?:string[]};
/** Huecos efectivos desde el cursor hasta el primero de `me` (excluido). null si `me` no vuelve a elegir. */
export function turnsBefore(seq:SequenceInput, me:string): TurnSlot[] | null;
export function nextSlot(seq:SequenceInput): TurnSlot | {complete:true};
export function orderForRound(state:ElectionState, round:number): string[];
```

`currentTurn` se reescribe encima de `nextSlot`. La comprobación final con `rules.evaluateFinal` se
queda en `election.ts`. `peopleAhead` pasa a ser una proyección de `turnsBefore`. La precondición de
la primera iteración queda declarativa: `turnsBefore(...)` tiene longitud 1, ese hueco tiene un solo
participante, `needed === 1` y no hay empate pendiente. En cualquier otro caso, no hay adelanto.

### 3. [ANTES] La disponibilidad por persona está duplicada en el servicio, con heurísticas de 2027 y semántica optimista

- `server/election-service.ts:89-101` (`options()`) y `:182-210` (`view()`) repiten el mismo bucle por
  fecha: `evaluateCandidate` con un presupuesto de 256 en total y 32 por candidato. En ambos,
  `indeterminate` se trata como **disponible y pendiente**.
- `:186-198`: la «heurística de simetría» es un atajo de demostración que solo vale para las reglas de 2027.
  Da por hecho que todo ciclo final tiene ocupante y que la campaña es invariante al permutar CTA con
  el mismo derecho. Es conocimiento normativo dentro del servicio.

Para la elección anticipada hay que calcular el conjunto de **opciones legales del predecesor** y
tratar `indeterminate` como «posiblemente legal». Es la semántica contraria. Si se reutiliza este bucle tal
cual, se puede autorizar un adelanto que sí quita opciones al predecesor.

**Propuesta.** Un único método del motor con la semántica explícita en el resultado, sin mezclarla:

```ts
legalChoices(state, memberId, opts:{selected?:string[]; budget:Budget; witness?:PolicyAward[]}):
  {legal:string[]; illegal:Record<string,RuleProblem[]>; unknown:string[]; checked:number};
```

`options()` y `view()` deciden la presentación: `unknown` se muestra como provisional, igual que
ahora. La elección anticipada trata `unknown` como legal para el predecesor y como bloqueo para el
adelanto. La heurística de simetría se mueve al motor de 2027, dentro de `legalChoices`.

### 4. [ANTES] La «capacidad mínima demostrada» por ciclo no es la primitiva adecuada; el motor debe responder la pregunta exacta

`hasUncontestedLocalSeat` (PR #86, `domain/early-election-capacity.ts`) comprueba
`ocupados + aspirantes < capacidadMínima`. Con las reglas de 2027 la capacidad de un ciclo **no es
local**. Si el predecesor P elige otro ciclo y consume el extracupo del periodo, o una de las cuatro
plazas, la capacidad del ciclo c puede bajar de 3 a 2. Por tanto, la capacidad mínima válida es
`min sobre las elecciones x de P de provenAdditional(S+P:x, c)`, que cuesta lo mismo que la
garantía completa y aun así **no** responde si el adelanto quita opciones a P.

Con un predecesor la condición exacta es sencilla. Sea S el estado actual, `me` el CTA que se adelanta
con el ciclo c, y `Cand_P` los ciclos sin infracción inmediata para P en S. El adelanto es válido si
**para todo** x ∈ Cand_P:

- `S + me:c + P:x` es completable (**demostrado**), o
- `S + me:c + P:x` es imposible **y** `S + P:x` también es imposible (x nunca fue una opción de P).

La primera rama cubre las dos exigencias a la vez. Si `S + me:c + P:x` es completable, x sigue siendo legal
para P después del adelanto, y c sigue siendo legal para `me` después de que P elija x: es el mismo
conjunto de adjudicaciones. Si alguna comprobación da `unknown`, se rechaza el adelanto. Como la
completación es monótona (añadir adjudicaciones nunca hace posible lo imposible), no hace falta nada más.

**Firmas propuestas para `OccupancyRules`:**

```ts
type Budget = {maxChecks:number; deadlineMs?:number};
type Certificate = {choice:PolicyAward; completions:{predecessor:PolicyAward; witness:PolicyAward[]}[];
  refuted:PolicyAward[]; stateKey:string; version:string};
type Guarantee =
  | {status:'guaranteed'; certificate:Certificate}
  | {status:'refused'; reason:'reduces-predecessor'|'not-legal'; detail:RuleProblem[]}
  | {status:'unknown'; checked:number; reason:string};     // CPU, plazo o búsqueda agotada

/** ¿Puede `choice` adjudicarse ya sin quitar ninguna opción a `predecessor` (un ciclo)? */
earlyGuarantee(state, choice:PolicyAward, predecessor:{memberId:string}, budget:Budget): Guarantee;
/** Revalidación en la transacción: sin búsqueda, solo evaluateFinal sobre cada testigo. */
verifyGuarantee(state, certificate:Certificate): boolean;
/** Clave estable del estado (ya existe como availabilityStateKey2027). */
stateKey(state): string;
```

**Coste esperado.** Con 45 ciclos, como mucho unas 45 completaciones por cada c, y unas 2.000 si se marca
todo el mapa. La mayoría se resuelven sin búsqueda trasplantando el testigo de `S + me:c`
(`transplant2027Witness`), y cada c se corta en el primer fallo. Solo existe **un** CTA elegible en cada
momento (el que va justo detrás), así que el cálculo se hace una vez por cambio de estado. Se puede
memorizar por `stateKey` y por versión, o precalcular al confirmar cada turno.

**Fallo seguro.** Se contabiliza un presupuesto de comprobaciones y un plazo de reloj. Al agotarse
cualquiera de los dos, el resultado es `unknown` y no hay adelanto. Al confirmar, `verifyGuarantee`
recorre el certificado con unas 45 llamadas a `evaluateFinal`, sin búsqueda y de forma determinista. Las
ramas refutadas se recalculan con el presupuesto de confirmación. Si cambia `stateKey`, la versión de
campaña o la versión de política, se recalcula. El certificado se guarda en el journal junto a la
adjudicación anticipada.

`hasUncontestedLocalSeat` no es condición necesaria ni suficiente. Propongo retirarla para que no
transmita una falsa seguridad, o dejarla solo como filtro previo documentado.

### 5. [ANTES] El contrato es la forma de las funciones de 2027 (`typeof …`) y tiene parámetros posicionales filtrados

`domain/policy.ts:33-44` tipa casi todo con `typeof evaluate2027Candidate` y similares. En la práctica
aparecen llamadas como `rules.evaluateCandidate(state, choices, 2000, undefined, false, {exact:true})`
(`domain/election.ts:228`, `:256`). Los métodos nuevos (`legalChoices`, `earlyGuarantee`) necesitan
una firma escrita en términos del contrato. Si se derivan con `typeof`, cualquier cambio en el
módulo de 2027 cambia la interfaz sin avisar.

**Respuesta a la pregunta 1:** **no** hace falta una jerarquía genérica, porque solo hay un motor real. Sí
merece la pena un archivo pequeño `domain/occupancy.ts` con tipos **con nombre**: `PolicyState`,
`PolicyAward`, `RuleProblem`, `Completion`, `CandidateAssessment`, `FinalAssessment`,
`AvailabilitySnapshot`, `Budget` y `Guarantee`. `OccupancyRules` se escribe a mano con objetos de
opciones, y `policy-2027.ts` y `availability-2027.ts` importan esos tipos. Cuesta poco y vale la pena.
Lo que sí sería sobreingeniería ahora es generalizar `Permits2027` o `PermitCount`, con sus límites
3/1/2/2/2/1 y sus `period`/`kind`. Pueden seguir en el módulo de 2027 como tipo del informe
(`permitReport`). → [DEJAR] su generalización.

`AvailabilitySnapshot.policyVersion: typeof OCCUPANCY_POLICY_2027` (`availability-2027.ts:35`) es un
literal. Al moverlo a `occupancy.ts` conviene tiparlo como `string`.

### 6. [ANTES] Presupuestos de CPU repartidos por el código genérico

Aparecen literales 256/32 (`election-service.ts:89,183,191,202`), 2000 (`election.ts:228,256`;
`election-service.ts:182`; `service.ts:88,221`), 500 (`vacations.ts:115`;
`election-service.ts:448`) y 300 (`permitCounts2027`). La elección anticipada añade un consumo
grande en la misma petición que `view()`. Sin una contabilidad común, se puede superar el límite de CPU
del Worker.

**Propuesta.** Que el motor exponga `budgets: {interactive, perCandidate, commit, review, report, early}`
y que los llamadores pidan un perfil, no un número. Para `early`, un presupuesto total para todo el
mapa más un plazo con `performance.now()`.

### 7. [ANTES] Cachés globales: correctas, pero no deterministas, y con objetos compartidos

`completionWitnessCache` (`policy-2027.ts:333`, 32 entradas), `partialCache` (`:660`, 16) y
`cache` de disponibilidad (`availability-2027.ts:76`, 96) son globales del módulo y, por tanto, del
isolate.

- **Solidez:** el testigo en caché solo se reutiliza tras `evaluate2027Final(full).valid`, así que
  es un certificado. Bien.
- **Determinismo:** un isolate «caliente» puede responder `possible` donde uno frío responde
  `indeterminate`. Para la anticipada, el mapa podría ofrecer un ciclo que luego falla al confirmar
  en otro isolate. Los certificados del hallazgo 4 lo evitan.
- **Aliasing:** `partialCache` y `cache` devuelven **la misma referencia** a todas las peticiones del
  isolate. Si un llamador la modifica, el cambio se filtra entre campañas. Propuesta: `Object.freeze`
  profundo en desarrollo y tests, o devolver copias.
- **Coste de clave:** cada llamada hace `JSON.stringify` del estado completo. Con unas 2.000 consultas
  de la anticipada eso pesa. Conviene aceptar un `stateKey` precalculado.
- Exportar `resetOccupancyCaches()` para tests de determinismo en frío y en caliente.

### 8. [ANTES, barato] `calculate()` mezcla cuatro responsabilidades y la rama `if(rules)` duplica validaciones

`domain/vacations.ts:20-131`: calendario y puntuación, orden para el año siguiente (`ordering`), cupos
heredados y, en `:86-127`, la revisión normativa. Dentro de esa rama:

- Repite comprobaciones genéricas: «fuera de campaña» aparece en `:83` y de nuevo en `:93`, y también
  se comprueban allí el ciclo repetido y el exceso de derecho.
- Fija semántica de 2027: `min:1, base:2` (`:109`), el texto «cupo máximo autorizado por RRHH»
  (`:107`, cuando existe `rules.authority`) y el presupuesto 500 (`:115`).
- `server/election-service.ts:462` `resultDates()` llama a `calculate()` completo, con su demostración
  parcial, solo para obtener las fechas. La anticipada lo llamaría en bucle.

**Respuesta a la pregunta 3.** Separar sin cambiar el resultado:

1. `cycleTable(y, team, c)`: calendario y puntuación. `resultDates` lo usa directamente.
2. `nextYearOrdering(members, requests, cycles)` en `domain/ordering.ts`.
3. `legacyReview(...)`, con `relationQuotas` y las incidencias heredadas.
4. `rules.review(state, {budget})`, que devuelve `{cycles:{min,base,max}[], issues, warnings, completionStatus}`.
5. Las validaciones estructurales comunes (fuera de campaña, repetido, exceso de derecho) en una sola
   función previa a ambas ramas.
6. `calculate()` queda como fachada que compone las piezas y conserva la forma del resultado.

### 9. [ANTES] Versionado: la garantía necesita su propia versión

`occupancyPolicyVersion` (`'lecs-2027-occupancy-v6'`) invalida revisiones (`service.ts:297`). Una
adjudicación anticipada se justifica con un certificado que depende de la versión de la política
**y** del algoritmo de garantía.

**Propuesta.** Guardar `{policyVersion, earlyVersion, stateKey, certificate}` en el journal. Si cambia
la versión, la anticipada pendiente se reverifica. Si falla, se abre el flujo de conflicto para el
administrador que pide la especificación, sin reorganizar nada automáticamente.

### 10. [DEJAR] Restos menores de política en lugares genéricos

- `app/election-workspace.tsx:364`: el panel `rules2027` se activa por el prefijo `'lecs-2027-'`. Es
  presentación de una política concreta. Basta con que el servidor envíe un `explanationId` y el
  cliente lo traduzca a un componente. No afecta a la anticipada.
- `summerTarget2027` fija `2` (`policy-2027.ts:17`) y `calculate` usa `c.summerPerPerson`
  (`vacations.ts:46`). Son dos definiciones del objetivo de verano. Hoy coinciden, pero conviene un test que lo fije.
- Los imports de tipo de `domain/personal-simulation.ts:3,70-71` siguen apuntando a `*-2027`. Se
  resuelve con el hallazgo 5.

### 11. [ANTES] Pruebas que faltan para fijar el contrato

`tests/policy-registry.test.ts` solo prueba el registro. Faltan:

- **Frontera de imports:** un test que falle si algún archivo fuera de `domain/*-2027.ts`,
  `domain/policy.ts` y `domain/hr-calendars.ts` importa un módulo `*-2027` (salvo `import type` desde
  `occupancy.ts`), o si `server/` importa de `app/`.
- **Propiedades del motor:** monotonía (si S es imposible, S+a también lo es); que `allowed` implique que
  `evaluateFinal(S + choices + witness).valid`; y que la disponibilidad sea coherente con
  `evaluateCandidate`.
- **Determinismo:** el mismo resultado de `legalChoices` y `earlyGuarantee` con cachés vacías y llenas.
- **Secuencia:** `turnsBefore` con derechos individuales, créditos dobles y triples, turnos
  conjuntos, empates pendientes y cambio de ronda (la ronda no es frontera).
- **Ciclos de imports:** hoy no hay ciclo en tiempo de ejecución (`vacations → policy → election-2027 →
  calendar → hr-calendars → hr-2027`; los demás son `import type`). Convendría activar
  `@typescript-eslint/consistent-type-imports` para que siga así. → [DEJAR], es barato.

---

## Segundo paso de refactor (commits pequeños, sin cambio de comportamiento)

1. `refactor(policy): contrato explícito en domain/occupancy.ts`. Tipos con nombre;
   `OccupancyRules` sin `typeof`; objetos de opciones en lugar de los seis parámetros posicionales
   (el envoltorio de 2027 los adapta).
2. `refactor(policy): presupuestos con nombre`. `rules.budgets` y sustitución de los literales
   256/32/2000/500/300.
3. `refactor(policy): legalChoices() en el motor`. Unifica los bucles de `options()` y `view()` y
   mueve la heurística de simetría al motor de 2027. Mismos resultados y mensajes.
4. `refactor(vacations): separar calculate()`. `cycleTable`, `nextYearOrdering`, `legacyReview`,
   `rules.review` y la validación común. `resultDates` usa `cycleTable`.
5. `refactor(election): domain/sequence.ts`. Mueve `orderForRound` y el escaneo de turnos, y añade
   `turnsBefore`. `peopleAhead` y `turnsUntil` pasan a ser proyecciones con **la misma semántica que hoy**.
   `server/` deja de importar de `app/`.
6. `test(policy): contrato, frontera de imports y determinismo`. Incluye `resetOccupancyCaches()`.
7. *(con cambio de comportamiento, en commit aparte y marcado `fix:`)* `peopleAhead` pasa a usar
   `entitlementFor`, créditos, turnos conjuntos y empates.

Después, ya dentro de la elección anticipada: `ElectionState.earlyChoices` vinculado a un hueco
(hallazgo 1), `earlyGuarantee` y `verifyGuarantee` (hallazgo 4), el journal con certificado y versión
(hallazgo 9) y, por último, el endpoint transaccional.
