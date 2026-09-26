# Implementación completa del sistema de migraciones

Estado: handoff de implementación actualizado con U01–U11: decisiones iniciales, tres categorías, transformaciones SQL, SSOT obligatorio y resolución separada de conflictos. Describe trabajo por implementar; no afirma que las APIs nuevas o el consumidor ya existan.

Comenzar por [MIGRACIONES.md](../MIGRACIONES.md). Registrar progreso y evidencias en la [checklist compartida T01–T23](migraciones-checklist.md); este documento define requisitos, no estados de avance.

Leer conjuntamente [contratos y pruebas](migraciones-contratos.md), [autoría de las tres categorías](migraciones-autoria.md), [contratos y algoritmos de autoría/resolución](migraciones-autoria-contratos.md) y [procedencia de las decisiones](migraciones-trazabilidad.md). Los cinco documentos describen un único alcance coherente.

## 1. Resultado y decisiones adoptadas

El sistema describe su estado actual una sola vez, conserva cada versión instalable, ejecuta scripts explícitos entre versiones y verifica que actualizar produce el mismo estado estructural que instalar el destino desde cero. También verifica datos y metadatos administrados. Si falla cualquier verificación requerida, **se bloquean tanto la aplicación de la migración como el despliegue de la aplicación**.

| ID | Decisión explícita del usuario | Consecuencia |
| --- | --- | --- |
| U01 | PostgreSQL **18.6** | Entornos de verificación y destino usan esa versión; no sustituirla silenciosamente por 18, latest u otra patch |
| U02 | Consumidor separado | El núcleo conserva descripciones/operaciones puras; generación SQL, inspección y ejecución viven en un paquete consumidor |
| U03 | Un mismo runner para verificación y ejecución, invocado por despliegue | Evitar un algoritmo de migración para tests y otro para instalaciones reales |
| U04 | Ventana de mantenimiento con escrituras de aplicación detenidas | La integración de despliegue establece y mantiene esa condición durante toda la operación |
| U05 | Una secuencia lineal de versiones | Una transición por par de versiones consecutivas; una instalación antigua ejecuta el segmento necesario en orden |
| U06 | Verificación bloqueante y una transacción por migración | El runner controla BEGIN/COMMIT/ROLLBACK; operaciones incompatibles se rechazan |
| U07 | La verificación fallida también bloquea deployment | El pipeline no activa/promueve la aplicación sin evidencia vigente de verificación y estado de DB destino confirmado |
| U08 | Estructura inferida, datos explícitos y estructura destructiva con decisión del desarrollador | Generar upgrades desde SSOT; comando de datos con tipos/validaciones; resolver cada columna que se elimina mediante discard o migrate |
| U09 | Transformaciones SQL; reutilizar TypeScript para validación | Sin transformaciones de filas implementadas en TypeScript; funciones existentes siguen validando datos |
| U10 | SSOT obligatorio; generar desde estado de las últimas migraciones, permitir SQL manual y fallar ante DB inconsistente | Historia reconstruida define origen, SSOT define destino, inspección real detecta drift; SQL manual no sustituye SSOT |
| U11 | Resolver conflictos con comando separado; deployment nunca pregunta | infer/apply producen reportes y fallo no cero; migration resolve recoge decisiones y genera artifacts revisables |

U07 es la precisión añadida por el usuario al aceptar la recomendación 6. No basta con imprimir un warning ni con devolver un error de migración que el pipeline ignore.

Las funciones, archivos y formas nuevas que concretan esas decisiones son inferencias técnicas identificadas en la trazabilidad. Los números de timeout no se inventan: son configuración de la instalación, validada y registrada. Se preservan recursos escritos por el autor y SQL generado durante autoría; ambos se publican como scripts históricos explícitos y verificables.

## 2. Fuentes, límites y regla de completitud

Fuentes del diseño:

- [Actualización de estructura DB](referencias/ideas/src/mantener-actualizada-estructura-db.md): versiones, scripts, estructura canónica, verificación automática, ensayo con datos y tags instalables.
- [SSOTIGAD](referencias/ideas/src/SSOTIGAD.md): descripción tipada/serializable, comportamiento por nombre y entidades que pueden no persistir.
- [Representaciones físicas](referencias/ideas/src/SSOTIGAD-details/definición-entidades.md): mappings por motor y completitud; el documento es borrador y las APIs actuales prevalecen.
- [CLAUDE.md](../CLAUDE.md) y código actual de `src/common`: Def/Info, contexto, inferencia y tests.

El alcance completo incluye núcleo descriptivo, consumidor PostgreSQL, creación desde cero, inferencia de upgrades, autoría de transformaciones, resolución destructiva, recursos históricos, scripts transaccionales, historial lineal, verificación estructural y de datos, ejecución sobre instalaciones y bloqueo efectivo del despliegue. Las etapas son orden de trabajo, no una definición de MVP. [Autoría](migraciones-autoria.md) precisa U08 y su integración con los contratos siguientes.

No forman parte de este acuerdo las ramas/merges de releases, migraciones online, backfills con commits parciales, efectos remotos, downgrades automáticos ni una plataforma de restore. Se puede transformar cualquier cantidad de datos dentro de una migración atómica conforme a la capacidad del entorno; no convertir eso en checkpoints confirmados por lotes. La generación automática de SQL de upgrade durante autoría sí es requerida por U08; no se infiere la intención de negocio ni se genera SQL nuevo durante deployment.

El alcance físico incluye lo declarado/generado por el sistema: tablas, campos, claves, restricciones, vistas, procedimientos/funciones y metadatos. La inspección no puede ignorar objetos adicionales ni propiedades desconocidas dentro del alcance administrado. No se exige construir un DSL universal para toda característica PostgreSQL; un objeto adicional se incorpora con contrato de creación/inspección/comparación explícito o se informa como no verificable y se bloquea el despliegue.

## 3. Patrones existentes que se deben reutilizar

| Patrón | Referencia actual | Aplicación a migraciones |
| --- | --- | --- |
| Def mínima e Info explícita | `ssot-types.ts`, `ssot-entity.ts` | `MigrationDef` / `MigrationInfo`, `PersistenceDef` / `PersistenceInfo` |
| Contexto como registro de capacidades | `defineTypes`, `withRecords`, `withValidators` | Contexto de snapshots; contexto de migraciones con releases y recursos nombrados |
| Referencias serializables por nombre | `EntityDef.record`, `FkDef.entity`, `validators` | `from`, `to`, `run`, nombres de comprobaciones |
| Constructores que preservan literales | `defineEntity`, `defineEntities` | `defineMigration` y constructores de colecciones |
| Exactitud de propiedades | `ExactFieldsOf` | Rechazar errores como `befor` y `stepps`, también en objetos inferidos |
| Completar sin mutar la Def | `completeCoreField`, `completeRecord`, `completeEntity` | Copiar y completar descripciones; ninguna operación de I/O |
| Tipos precisos derivados | `EntityInfoOf`, `RecordInfoOf` | `SystemSnapshotInfoOf` y `MigrationInfoOf` |
| Diagnósticos localizables | `Problem`, `ValidationResult`, `problem` | Errores de artefactos, catálogo y planes |
| Asignabilidad en ambos sentidos | `test/aida-test.ts` | Tests del tipo exacto deducido, además de rechazos |
| Snapshot generado | `test/aida-test.ts`, bloque `aida design snapshot` | Punto de partida para capturar entidades completas |

Leer esos archivos antes de editar. No copiar sus comentarios históricos como contratos actuales: el README y algunos comentarios aún describen versiones anteriores de la API. Por ejemplo, hoy `defineEntity` recibe `{name, record, pk, ...}` y resuelve `fields` desde el contexto.

Reglas de implementación:

- Código y nombres del framework en inglés; este plan en castellano, como pide `CLAUDE.md`.
- Cada concepto descriptivo depende de un contexto con las capacidades mínimas que usa. No obligar a una migración que sólo conoce releases a depender de campos, validadores y tipos de dominio.
- Las funciones pueden tener parámetros de inferencia adicionales, como los constructores actuales. No agregar defaults genéricos que oculten el contexto.
- Sin `any`. Usar `unknown` en entradas externas y decodificarlas antes de operar.
- Un cast localizado para recuperar la relación clave→valor perdida por `Object.entries` es admisible si se explica y prueba. Un cast de JSON sin validación no lo es.
- No usar `@ts-expect-error` en `src` ni `examples`. En tests, seguir el criterio de `CLAUDE.md`: una construcción por línea; usar relaciones de tipos cuando ésa sea la afirmación real.
- No crear otro framework de serialización, errores o ejecución de reglas de filas para esta funcionalidad.
- Reutilizar `Problem` para diagnósticos; no reutilizar `validateInstance` para scripts SQL: su contrato es una regla sincrónica sobre una fila, no una tarea de base de datos.
- Los formatos persistidos necesitan decodificadores estrictos. `instanceProblems` por sí solo no valida objetos anidados, propiedades extra ni formatos versionados.

### 3.1 Matriz obligatoria de reutilización por componente

Esta tabla es parte del contrato de implementación. **R** significa importar/llamar al código existente; **P** significa reutilizar el patrón con tipos nuevos porque su semántica es distinta; **N** significa que no hay implementación equivalente y debe crearse. No confundir P con copiar y renombrar todo un módulo ni N con permiso para reemplazar una abstracción existente.

| Componente a implementar | Reutilización exacta | Aplicación concreta y límite |
| --- | --- | --- |
| Contexto de captura | **R:** `SystemEntityContext`, `EntityDef` en `src/common/ssot-entity.ts` | Aceptar el contexto existente; no crear una segunda colección de campos/tipos para completar entidades |
| Captura de entidad | **R:** `completeEntity` en `ssot-entity.ts` | Obtener name, record, fields, PK deduplicada, UK, FK normalizadas y nombres de validators de su retorno |
| Tipo preciso de entidad capturada | **R:** `EntityInfoOf<TContext, TEntityDef>` | Mapped type por key concreta de `TEntities`; no ensanchar a `EntityInfo<SystemEntityContext>` |
| Captura de records independientes | **R:** `completeRecord`, `RecordInfoOf` en `src/common/ssot-record.ts` | Completar el mapa de records recibido sin asumir persistencia |
| Atributos custom de campo | **R:** `FieldInfo`, `FieldDef`, completador del contexto | Conservar la forma concreta; no imponer `AidaFieldDef` al framework |
| Defaults/nullability | **R:** `completeCoreField`, invocado por el completador del sistema; `completeEntity` para PK | No duplicar `nullable ?? true` en el migrador; no llamar sólo a `completeRecord` para decidir nullability física de una entidad |
| Tipos de filas en fixtures/tareas tipadas | **R:** `EntityInstanceType`, `RecordInstanceType` | Deducir filas desde las Def históricas del fixture, no escribir a mano interfaces paralelas de filas |
| Reutilización de claves en nuevas Def de ejemplo | **R:** `extractPk`, `PkFieldsOf`, `mergePk`, `MergedPk` | Construir relaciones como Aida; no crear un helper de deduplicación de PK alternativo |
| Contextos por etapas de ejemplos | **R:** `withRecords`, `withValidators`, `defineTypes` | Añadir records/reglas en su nivel; no aplanar artificialmente las etapas existentes |
| Selección de persistencia | **R:** `TypeCollection`, `AnyEntityDef`; **N:** `PersistenceDef/Info` | Extender por composición `{...context, entities}`; no convertir todas las keys de `context.records` en tablas |
| Cobertura de mappings por tipo | **P:** mapped type exhaustivo de `TypeProvider` en `src/common/type-behaviour.ts` | Aplicar exhaustividad a cada representación física; no usar `TypeProvider` directamente, porque guarda comportamiento, no mappings |
| Nuevos constructores de Def | **P:** `defineRecord`, `defineEntity` | Preservar literales y devolver Def sin I/O; inferir tipos desde parámetros como hacen esos constructores |
| Rechazo de propiedades extra | **P:** `ExactFieldsOf` en `ssot-record.ts` | Adaptar `Record<Exclude<keyof TActual, keyof TExpected>, never>` a cada variante de migración; no importar `ExactFieldsOf` como si funcionara sobre cualquier objeto plano |
| Tipos Info de migración | **P:** `EntityInfoOf`, `RecordInfoOf` | Derivar el resultado preciso de la Def, completar defaults en runtime y atar ambas cosas con tests bidireccionales |
| Correspondencia key→ID | **P:** `ValidatedEntities`, `defineEntities` | Exigir key igual a `id` de migración/recurso cuando ese objeto declara su propia identidad |
| Registro de recursos por nombre | **P:** `behaviours` en `SystemTypeContext`, `validators` en `SystemValidatorContext` | Map descriptivo separado del map ejecutable; no meter funciones en `MigrationDef` |
| Nombres de recurso por kind | **P:** `ValidatorNamesFor` de `validate.ts` | Adaptar el mapped type a `ResourceNamesFor` para sql/check; no reutilizar reglas de fila como ejecutores SQL |
| Resultado de decoder, compleción y plan | **R:** `ValidationResult<TValue>` de `src/common/problem.ts` | Unión `{ok:true,value}` / `{ok:false,problems}`; no crear `Result`, `Either` o `MigrationValidationResult` equivalentes |
| Diagnósticos | **R:** `Problem`, `problem`, `Severity`, `hasBlocking` | `messageKey` estable, details string; errores que impiden ejecutar son blocking; no agregar severidades operativas a `Severity` sin necesidad |
| Checks de filas ya decodificadas | **R:** `instanceProblems`, `isRecordInstance`, y `validateInstance` cuando corresponda | Validar estructura/semántica de filas con contexto histórico; SQL checks usan contratos nuevos, no estas funciones |
| Codecs de valores de dominio | **R:** `TypeBehaviour`, `TypeProvider`, `behaviourOf`, `parsed`, `notParsed` | Reutilizar el par máquina por tipo del bundle histórico; jamás `parseRecord`/`formatFields` para hashes o valores almacenados |
| Importación de texto con semántica de formulario existente | **R:** `deserializeRecord` / `deserializeProblems`, `TextRecord` | Sólo si `''` significa ausencia conforme al contrato de entrada; ver advertencia de la sección 3.3 |
| Exportación de campos a texto | **R:** `serializeFields` cuando aplica su contrato | Usar codecs existentes; preservar null/empty string mediante un envelope de almacenamiento específico cuando sea necesario |
| Snapshot de referencia | **P:** función local `designSnapshot`, tipos `FieldInfoRow`/`DesignSnapshot` en `test/aida-test.ts` | Promover el recorrido por entidad a producción con contratos nuevos; no importar código desde tests |
| JSON estricto/canónico | **N:** `json-value.ts`; **R:** `ValidationResult`/`problem` | TOON `encode` es formato legible del test, no canonicalización JSON ni función de hash |
| Hash y publicación de bundles | **N:** `artifact.ts`; **R:** canonicalización nueva compartida | No existe hashing en el núcleo; mantener `node:crypto` y filesystem en consumidor |
| Adaptador/DDL/inspector | **N:** módulos PostgreSQL de sección 4; **R:** `FkInfo`, `EntityInfoOf` en proyección | No existe generador SQL actual para reutilizar; no introducir dependencias inversas hacia el consumidor |
| Datos administrados | **N:** `ManagedDataInfo` y checker; **R:** tipos de filas, PK/FK y codecs existentes | Reutilizar verdad de entidad/valores; scripts explícitos cargan o transforman y el checker verifica las filas/columnas declaradas |
| Journal/runner/locks | **N:** `journal.ts`, `runner.ts`, `execute-migration.ts`; **R:** planes/errores compartidos | No existe runner previo; `validateInstance` no es un scheduler ni gestor transaccional |
| Verificador de dos rutas | **N:** `verify.ts`; **R:** mismo create plan, runner, inspector y comparer | El harness crea entornos; no reimplementar la ejecución de migraciones dentro de tests |
| Tests de tipos | **P:** `test/aida-test.ts`, `ExpandType` si facilita assertions | Dos sentidos de asignabilidad, tuplas literales y errores específicos; no debilitar a `unknown` para que pase |
| Tests de codecs/reglas | **P:** `test/serialize-and-validate-test.ts`, `test/aida-behaviour-test.ts`, `test/human-test.ts` | Mantener distinción de máquina/humano; agregar regresiones de almacenamiento sin modificar semántica existente por accidente |
| Build, exports y documentación | **R:** `src/common/index.ts`, `examples/common/index.ts`, scripts raíz, `LEEME.md`/multilang | Extender puntos de entrada existentes; no agregar otro barrel paralelo ni editar README raíz a mano |

### 3.2 Variables concretas de Aida y dónde usarlas

| Variable o tipo existente | Archivo | Uso exacto en esta implementación |
| --- | --- | --- |
| `aida` (alias de `aida6`) | `examples/common/aida.ts` | Contexto completo de captura/proyección en tests de integración con el ejemplo actual |
| `entityDefs` | `examples/common/aida.ts` | Mapa de entidades fuente para snapshot y selección persistida; es la lista autorizada, no todos los exports |
| `recordDefs` | `examples/common/aida.ts` | Mapa de records independientes a capturar cuando se solicita el sistema completo del ejemplo |
| `aidaTypeDefs`, `AidaTypeName` | `examples/common/aida-context.ts` | Keys exactas de mappings de Aida; no sustituirlas por `commonTypeDefs` al perder `fecha`/`email` |
| `aidaTypes` | `examples/common/aida-context.ts` | Contexto mínimo para definir nuevos records de prueba con tipos/atributos de Aida |
| `AidaFieldDef` y `aidaTypes.completeField` | `examples/common/aida-context.ts` | Test de conservación de `label`, `description`, `isName`; nunca importar ese tipo desde `src/common` |
| `aidaConReglas` | `examples/common/aida-context.ts` | Base de contextos de fixtures que usan reglas nombradas, antes de `withRecords` |
| `alumno`, `alumnos` | `examples/common/aida.ts` | Referencia concreta de estructura/PK/nullability para diseñar el fixture histórico email; no mutarlos ni reemplazarlos globalmente |
| `docentes`, `mesas` | `examples/common/aida.ts` | FK reflexiva y dos FK con renombre de campos hacia la misma entidad |
| `cursos`, `clases`, `inscripciones`, `presencias` | `examples/common/aida.ts` | PK compuestas, herencia de claves y solapamiento; fixtures de transformación/proyección |
| `materias` | `examples/common/aida.ts` | UK `denominacion`; agregar un fixture de referencia a esa UK para cubrir destino no PK |
| `cargos` | `examples/common/aida.ts` | Caso negativo de selección: existe como export pero no en `entityDefs`; no se persiste por descubrimiento implícito |
| `alumnoSearchParams` | `examples/common/aida.ts` | Record sin tabla: puede agregarse al snapshot de records y debe seguir fuera de la proyección física |
| `aidaFieldInfo`, `aidaMetaContext` | `examples/common/aida.ts`, `aida-context.ts` | Patrón de metadescripción/autodescripción para futuras pantallas del plan; no usarlos como decoder suficiente de cualquier MigrationInfo |
| `DefinedType<TEntityDef>` | `examples/common/aida.ts` | Alias de filas de Aida en sus tests; la biblioteca genérica usa `EntityInstanceType` |
| `fechaBehaviour`, `typeBehaviours` | `examples/common/aida-behaviour.ts` | Casos reales de codec de máquina con tipo propio; congelar recursos históricos al publicar, no resolverlos desde el módulo vivo durante upgrade |
| `fechaHumana`, `humanBehaviours` | `examples/common/aida-behaviour.ts` | Sólo presentación humana de CLI/UI cuando se necesita locale; nunca almacenamiento/identidad |
| `emailRazonable`, `ordenPositivo`, `validadores` | `examples/common/aida-validators.ts` | Reutilizar checks de filas de ejemplo cuando sus contratos coinciden; no asumir que cubren conservación de datos o constraints SQL |

### 3.3 Reutilización que necesita una adaptación explícita

Hay una diferencia importante encontrada al leer el código real: `walkTextRecord`, usado por `deserializeRecord`, convierte tanto null como string vacío en ausencia. Eso sirve a su contrato actual, pero una transformación o un backup puede necesitar distinguir `''` de null. Por lo tanto:

1. Los envelopes de datos persistidos conservan null como null y los strings vacíos como valores presentes.
2. Para un valor presente, llamar directamente a `behaviourOf(context, typeName).deserialize(raw)` con el codec histórico, y manejar null mediante la Info de nullability; no pasar ese valor por el camino de formulario que colapsa `''`.
3. Reutilizar `TypeBehaviour` y sus implementaciones donde su semántica coincida; crear un envelope/recorrido de almacenamiento específico cuando haga falta, sin cambiar de paso `walkTextRecord`.
4. Agregar un test de ida y vuelta con `''`, null, `'null'`, fecha y clave compuesta. No afirmar que reutilizar una función por su nombre garantiza un round-trip que su contrato no ofrece.

Del mismo modo, `Optional<T>` de `type-utils.ts` hace opcionales campos nullable. No usarlo para permitir omitir propiedades obligatorias de un manifest/Info completo. `ExpandType<T>` es una ayuda de tipos/lectura, no una validación en runtime.

### 3.4 Regla de trazabilidad para cada entrega

En la descripción de cada entrega de implementación, incluir una tabla corta con: funcionalidad, símbolos reutilizados/importados, patrón adaptado, código nuevo y test que lo demuestra. Si se introduce algo equivalente a una fila marcada R, explicar por qué el código existente no sirve y añadir la prueba del límite. Si no existe tal límite, importar/reutilizar la implementación existente.

Los consumidores importan símbolos públicos desde `system-definition`. Los archivos del núcleo importan desde el módulo propietario mediante rutas relativas, siguiendo el código actual; no importar el barrel raíz desde dentro del propio núcleo y crear ciclos. Ningún archivo de producción importa de `test/` ni del sistema concreto `examples/common/aida.ts`.

## 4. Archivos y dependencias

Archivos del núcleo a implementar:

```text
src/common/json-value.ts           decoder/copia JSON y canonicalización
src/common/system-snapshot.ts      captura de entidades y records completos
src/common/system-persistence.ts   selección de entidades y mappings
src/common/migration.ts            Def/Info y referencias de recursos
src/common/migration-plan.ts       catálogo lineal y segmento de upgrade
src/common/index.ts                exportaciones públicas nuevas
examples/common/aida-persistence.ts
```

Tests correspondientes en `test/*-test.ts`, usando Mocha y compilación `tsc` como el resto del repo. Los fixtures históricos del consumidor no se exportan como parte de la API pública de Aida.

Consumidor separado, ubicación técnica elegida para hacerlo revisable en este checkout:

```text
consumers/postgres-migrations/
  package.json, package-lock.json, tsconfig.json, README.md
  src/
    index.ts
    artifact.ts                   cargar/publicar bundles inmutables
    pg-schema.ts                  proyección de entidades y objetos administrados
    generate-create.ts           SQL de instalación limpia
    inspect-schema.ts            catálogo PostgreSQL normalizado
    compare-schema.ts            diferencias estructurales legibles
    sql-resource.ts              resolver/validar recursos SQL
    journal.ts                   head, historia, intentos y evidencias
    execute-migration.ts          única unidad transaccional de ejecución
    runner.ts                    instalación y secuencia de upgrades
    verify.ts                    dos rutas, fixtures y copia de datos
    deployment-gate.ts           comprobación bloqueante antes de activar aplicación
    cli.ts
  test/
    artifact-test.ts, schema-test.ts, runner-test.ts
    verification-test.ts, deployment-gate-test.ts, integration-test.ts
  fixtures/aida-email/
```

No agregar ese directorio a los globs del `tsconfig.json` raíz. El paquete consumidor tiene su build y dependencia local del paquete raíz compilado; importa desde `system-definition`, no de sus fuentes privadas. La raíz no incorpora `pg`, `node:crypto`, filesystem o conexiones como dependencias de `src/common`.

Dependencias permitidas en una dirección: tipos → records → entidades → snapshots/persistencia. Migraciones y planes leen descripciones de releases/recursos. El consumidor lee la API pública del núcleo y usa PostgreSQL. Evitar que el núcleo importe su propio barrel y cree ciclos.

## 5. Snapshot del sistema

`captureSystemSnapshot(context, {systemId, entities, records?})` obtiene una copia serializable del diseño completado. No crear una segunda Def de snapshot escrita a mano: las fuentes son las Def originales.

Algoritmo:

1. Validar `systemId` no vacío y que las keys de entidades coincidan con `name`.
2. Completar cada entidad mediante `completeEntity`, conservando campos propios del sistema, PK, UK, FK normalizadas y validators nombrados.
3. Completar los records independientes solicitados mediante `completeRecord`.
4. Capturar las keys de tipos; no serializar `tsType`, completadores ni implementaciones de comportamiento.
5. Validar/copiar recursivamente el resultado como JSON estricto; desligarlo de arrays/objetos mutables de las Def originales.
6. Validar referencias locales/globales también en runtime para soportar snapshots importados.

El resultado es `ValidationResult<SystemSnapshotInfoOf<TContext,TInput>>`. `entities[E]` conserva `EntityInfoOf<TContext,TInput['entities'][E]>`, no una unión ensanchada de todas las entidades. Records usan `RecordInfoOf`. `records` omitido se completa como `{}`; `formatVersion` es literal `1`. El anexo precisa las formas persistidas.

Errores runtime: PK/UK vacías, campos inexistentes, tipos desconocidos, FK con destino no existente o no correspondiente a una clave completa, destino repetido dentro de una FK, keys/names discordantes, PK nullable en Info importada y datos no JSON. La captura usa la deduplicación existente de `completeEntity`; no cambia lo que hoy admite una Def. El decoder de Info exige forma ya normalizada.

Un archivo JSON importado se decodifica a `SystemSnapshotInfo` amplio. No afirmar que una lectura runtime recupera literales de compilación. Un cambio de label puede modificar el snapshot sin requerir DDL.

## 6. Descripción de persistencia

La aplicación entrega `definePersistence({...context, entities}, def)`. Def contiene `entities` (selección de entidades persistidas) y `representations` (por representación, mapping exhaustivo de tipos de dominio). Las claves de tipos y entidades se chequean contra el contexto; se rechazan extras y faltantes.

```ts
const aidaPersistence = definePersistence({...aida, entities: entityDefs}, {
    entities: [
        'docentes', 'materias', 'periodos', 'cursos', 'clases', 'alumnos',
        'preguntas', 'opciones', 'inscripciones', 'presencias', 'mesas',
    ],
    representations: {
        postgres: {
            text: 'text', integer: 'integer', boolean: 'boolean',
            fecha: 'date', email: 'text',
        },
    },
});
```

`completePersistence` devuelve Info copiada y validada. La selección es única, ordenada canónicamente, y está cerrada respecto de FK: no persistir implícitamente una entidad no seleccionada. `recordDefs` y `alumnoSearchParams` pueden estar en snapshot sin convertirse en tablas. `cargos` existe como export del ejemplo pero no pertenece hoy a `entityDefs`; no agregarlo mediante discovery.

Las representaciones nombran tipos físicos registrados por el consumidor. La aplicación registra descriptores de tipo con schema/nombre/parámetros, y el generador los valida/cita; un string del mapping no se concatena como SQL arbitrario. Los ejemplos usan tipos built-in `text`, `integer`, `boolean`, `date`. Su catálogo se puede ampliar con descriptores validados para los tipos declarados por una aplicación.

Las vistas/rutinas/otras restricciones y la carga de metadatos que todavía no tienen vocabulary propio en el núcleo se describen en el consumidor mediante recursos de creación nombrados y dependencias explícitas. No agregar funciones a `EntityDef` ni inventar un DSL universal para poder describir SQL que el autor ya sabe escribir. Sus objetos resultantes se incluyen en la verificación estructural.

## 7. JSON canónico e integridad

`JsonValue` admite null, boolean, number finito, string, arrays densos y objetos planos con valores JSON. `toJsonValue(unknown)` valida y copia, devolviendo `ValidationResult<JsonValue>`. Rechaza undefined, bigint, símbolos, funciones, NaN/infinito, instancias de clases, getters/setters, ciclos, huecos de arrays y propiedades que se perderían al serializar. Inspeccionar descriptores sin ejecutar getters ni `toJSON`.

`canonicalJson(JsonValue)` emite sin indentación ni newline final, ordenando keys lexicográficamente por unidades UTF-16 sin locale. Preserva el orden de arrays; cada productor ordena previamente sólo las colecciones que sean conjuntos. Emitir keys una a una: reconstruir un objeto y usar JSON.stringify no preserva necesariamente el orden elegido para keys numéricas. Escapar strings/números mediante JSON.stringify; -0 se representa como 0. No normalizar Unicode dentro de strings. Rechazar entrada inválida de un cast externo con TypeError.

Compartir referencias acíclicas es válido; detectar ciclos mediante pila de ancestros. Crear copias sin que una key `__proto__` altere el prototipo. Los tests incluyen keys numéricas, string vacío, null, símbolos, arrays y getters que lanzarían si fueran ejecutados.

El consumidor calcula SHA-256 de bytes UTF-8, hex minúscula. Separar hashes:

| Nombre | Contenido |
| --- | --- |
| `snapshotHash` | Snapshot JSON canónico |
| `schemaHash` | Inspección estructural canónica |
| `contentHash` | Bytes exactos de cada recurso/archivo |
| `releaseHash` | Manifest de release sin su propio hash |
| `migrationHash` | Manifest de transición sin su propio hash |
| `planHash` | Plan ordenado resuelto sin su propio hash |
| `candidateApplicationHash` | Artefacto concreto de aplicación que se pretende desplegar |

No incluir timestamps de ejecución ni secretos en los hashes de contenido. Los hashes no autentican por sí mismos un resultado de verificación; el gate consume evidencia del runner/CI confiable, no un JSON arbitrario suministrado por quien quiere desplegar.

SQL publicado usa UTF-8 sin BOM y LF; registrar bytes exactos y fijar `.gitattributes` para evitar cambios por checkout. Después de publicar no se normalizan recursos al leer ni se reescriben con el mismo ID. Paths de artifacts son relativos, sin `..`, absolutos ni escapes por symlink; detectar colisiones de case en Windows.

## 8. Releases y recursos históricos

Cada release tiene ID opaco, `systemId`, snapshot, persistence info, plan de creación, recursos SQL, checks invariantes, contrato de entorno y esquema normalizado esperado. Las descripciones completas y los bytes históricos se publican juntos; instalar A no recompila A con defaults/generador actual.

```text
releases/aida_001/
  manifest.json, snapshot.json, persistence.json, schema.json
  create-plan.json, environment.json
  resources/...
migrations/alumnos_email_required/
  manifest.json, migration.json
  resources/...
```

El manifest de migración referencia los hashes de releases origen/destino. El de release no referencia el hash de la migración entrante: evita circularidad. El catálogo lineal referencia ambos. Guardar identidad/hash del generador y del inspector para reproducibilidad.

El contrato de entorno lleva `engine:'postgresql'`, `version:'18.6'`, `serverVersionNum:180006`, namespaces administrados y características ambientales que afectan semántica (encoding, collations y dependencias externas declaradas). `server_version_num` es la comprobación del servidor; no aceptar cualquier 18.x por coincidencia del major. El número 180006 concreta el formato de versión PostgreSQL para el objetivo elegido. Consultar [parámetros preset](https://www.postgresql.org/docs/18/runtime-config-preset.html). Esto fija un requisito de entorno; no afirma que una imagen concreta esté disponible en el entorno del implementador.

El build de la aplicación produce el bundle y manifiesta `candidateApplicationHash`. Es posible que dos builds usen la misma release de DB: el deployment gate igualmente verifica la asociación correcta con cada candidato. Versiones de app, formato, DB, librería y release de esquema son conceptos distintos.

Para metadatos administrados declarar tabla, clave estable, columnas administradas y filas esperadas mediante valores/recursos versionados. La verificación compara sólo esas filas/columnas; no exige igualdad de todas las tablas de usuario entre instalación limpia y actualizada. El script de upgrade decide cómo modificar metadatos; no hay reconciliador automático que borre filas no declaradas.

Publicar en temporal, validar paths/formato/hashes, verificar en scratch, y sólo entonces materializar artifact final. Mismo ID+contenido idéntico es repetible; mismo ID+contenido diferente es error. Una corrección crea una nueva release/transición o corrige un borrador aún no publicado, preservando las instalaciones históricas.

## 9. Migraciones y checks por nombre

Una Def contiene `id`, `from`, `to`, `steps`, `before?`, `after?`, `description?`. No necesita `mode`, alternativas online, grupos de transacción ni flags `transaction`: U04/U06 son invariantes del sistema aprobado. Todos los pasos de una migración se ejecutan dentro de la misma transacción.

```ts
const migrationDef = defineMigration(migrationContext, {
    id: 'alumnos_email_required',
    from: 'aida_001',
    to: 'aida_002',
    before: ['email_source_complete_v1'],
    steps: [
        {id: 'fill_email', run: 'backfill_alumno_email_v1'},
        {id: 'require_email', run: 'require_alumno_email_v1'},
    ],
    after: ['alumno_email_required_v1'],
});
```

`migrationContext` conoce releases y recursos descriptivos de kind `sql` o `check`. La Def guarda nombres; el consumidor resuelve bytes/implementaciones fuera de ella. Los check names deben referenciar `check`; `steps.run` debe referenciar `sql`. En TypeScript se preservan literales y se rechazan extras por el patrón `ExactFieldsOf`; al importar JSON se validan las mismas relaciones.

`completeMigration` completa `description:''`, `before:[]`, `after:[]`, resuelve referencias y hashes, y copia. Rechaza IDs vacíos/duplicados de pasos, origen igual a destino, recursos faltantes y extremos de sistemas distintos. No hacer I/O en el constructor del núcleo. El plan de consumidor contiene todos los archivos resueltos y checks validados antes de ejecutar.

Un check SQL devuelve exactamente una fila con `ok:boolean` no null. False, ninguna fila, varias filas o shape distinto son fallo. Checks de release se ejecutan tras creación/upgrade; checks de transición, antes/después dentro de la transacción; checks exclusivos de fixture sólo se ejecutan en su escenario, nunca sobre producción por accidente.

Para comparar antes/después, el autor puede agregar un step SQL que capture evidencia en tablas temporales dentro de la transacción y un check posterior que la lea. Los recursos check son SQL de lectura, y los recursos sql hacen los cambios; no se introduce un kind de tarea remota ni un segundo gestor de transacciones. Los validadores de filas existentes siguen siendo reutilizables en los tests y codecs del consumidor cuando sus contratos coinciden.

## 10. Historial lineal y planificación

El catálogo describe `releases` mediante un array explícitamente ordenado y `migrations` mediante exactamente una transición por cada par consecutivo. El orden no se deduce de timestamps, tags, strings de versión ni nombre de archivo. IDs únicos; mismo sistema; hashes y extremos exactos. Una release inicial puede ser baseline de instalación directa sin historia ficticia.

Algoritmo puro de `resolveMigrationPath(catalog, from, to)`:

1. Validar todo el catálogo y su contigüidad.
2. Encontrar índices de origen/destino; si faltan, error con el ID concreto.
3. Destino anterior al origen: `migration.downgradeUnsupported`.
4. Mismo índice: plan vacío; se mantienen checks de hashes, drift, invariantes y despliegue.
5. Si destino está después, devolver el segmento de transiciones consecutivas entre ambos.
6. El consumidor llama después a `buildMigrationPlan` para resolver todos los recursos y calcular `planHash`; ejecución usa ese plan, sin regenerar SQL de upgrade.

Agregar una release sólo extiende el final del catálogo publicado; no insertar versiones entre releases históricas ni editar sus hashes. El catálogo completo puede crecer, por lo que el plan firma el segmento y sus artefactos exactos; un append ajeno al segmento no invalida su identidad de contenido.

Transiciones de sólo datos o metadatos son válidas aunque `schemaHash` sea igual. También son válidas transiciones sin steps cuando cambian descripciones: verifican invariantes y registran nueva release. No inferir versión por schemaHash únicamente.

## 11. Creación e inspección PostgreSQL

### 11.1 Creación desde el SSOT

`projectSchema(snapshot, persistence, storageContext)` produce un plan de creación determinístico. Para tablas/campos/PK/UK/FK lee Info completadas. Nombres físicos = nombres declarados, citados por componente; tipos provienen de la representación PostgreSQL. No agregar defaults de nulleabilidad en el generador: `completeEntity` ya marca PK no nullable.

Orden de creación:

1. Schemas/tipos externos declarados: verificar precondiciones; crear sólo objetos que el plan declara propios.
2. Todas las tablas y sus columnas.
3. PK/UK/restricciones locales.
4. FK, incluyendo ciclos/reflexivas; las tablas y claves destino ya existen.
5. Recursos de vistas/rutinas/restricciones adicionales según dependencias declaradas.
6. Carga de metadatos administrados y checks de release.

Las dependencias entre recursos adicionales forman un orden de creación de objetos, no un grafo de releases. Si no se puede ordenar, mostrar ciclo y fallar; no usar CASCADE para resolverlo silenciosamente. El mismo generador fija nombres determinísticos para constraints, verifica longitud en bytes contra el motor y detecta colisiones. Los datos usan parámetros/codecs; los identifiers usan quoting; no confundir ambos.

La instalación limpia es una transacción sobre un scope vacío que ya existe o se crea transaccionalmente. La creación de la base scratch pertenece al harness y ocurre fuera de ese scope; `CREATE DATABASE` no es un paso de migración.

### 11.2 Inspección que ve cambios sin confirmar

`inspectSchema(session, scope)` usa **la misma sesión** de la migración para ver DDL y datos antes de COMMIT. No invocar otro proceso/conexión `pg_dump` para la postcondición dentro de esa transacción: no observaría sus cambios sin confirmar.

Implementar extractores por clase, con queries contra catálogos PostgreSQL y funciones `pg_get_*` según corresponda. Las funciones de información/deparsing se describen en la [documentación oficial](https://www.postgresql.org/docs/18/functions-info.html). Configurar igual `search_path`, options de deparsing y entorno en ambos lados. No normalizar cuerpos SQL con regex de whitespace.

Contrato de cobertura:

| Objeto | Propiedades que deben compararse |
| --- | --- |
| Tabla | Schema/nombre, clase/persistencia, columnas; detectar partición/herencia/RLS no representadas |
| Columna | Nombre, identidad de tipo y parámetros, collation, nullability, default y propiedades generated/identity si aparecen |
| PK/UK | Nombre, columnas ordenadas, deferrability y semántica de nulls |
| FK | Nombre, destino, pares origen→destino en correspondencia, acciones, match, deferrability, estado de validación |
| Check | Nombre, expresión normalizada, validación y propiedades que cambien enforcement |
| Índice | Definición normalizada, validez, propiedad de constraint o índice independiente |
| Vista | Definición normalizada, columnas y opciones que alteran semántica |
| Función/procedimiento | Identidad por schema/nombre/argumentos, definición normalizada completa, opciones de seguridad/ejecución |
| Metadatos | Tabla/clave/columnas declaradas y valores de máquina, comprobados aparte del esquema |

Las características aparecidas sin extractor/comparador completo producen `migration.unsupportedSchemaFeature`. El inventario debe detectar objetos adicionales dentro del scope, no consultar sólo nombres esperados. Los objetos internos que respaldan constraints se representan una vez con ownership explícito. Si una aplicación declara secuencias, triggers, dominios u otra clase adicional, debe registrar su contrato de creación/inspección/comparación antes de poder verificar ese alcance; no aprobar una base omitiendo esos objetos.

Un scope administrado identifica schemas y objetos propios explícitamente. El journal tiene un schema separado y se excluye por identidad exacta. Dependencias externas (roles/extensions/tipos globales) se validan como precondiciones del entorno; no crear o tomar propiedad de objetos globales por inferencia.

### 11.3 Normalización y diferencias

Comparar identidades, no OIDs ni números de archivo. Ordenar objetos por identidad y columnas visibles por nombre; ignorar orden físico de creación y columnas eliminadas. Preservar orden de columnas de índices/claves y asociación de pares FK. No ordenar arrays de una FK por separado. Excluir tamaños, estadísticas y timestamps operativos; no excluir defaults, acciones FK, validación, cuerpo de rutinas o seguridad de objetos administrados.

Owners, permisos y settings externos al alcance declarado se enumeran en el reporte como entorno/exclusiones; nunca decir que se verificó todo PostgreSQL. La igualdad no demuestra equivalencia de programas SQL arbitrarios: compara representaciones del mismo motor/configuración.

`compareSchemas` devuelve diferencias con path y before/after, además de igualdad; no sólo un hash. Un objeto extra o no comprendido es fallo bloqueante. El artefacto publica el esquema esperado observado desde instalación limpia, pero antes comprueba que la proyección SSOT esté representada: PK, UK, FK, tipos y nullability esperadas no pueden faltar por un bug del generador. Los tests del inspector crean también objetos con SQL independiente del generador.

## 12. Ejecución, atomicidad e historial

### 12.1 Mantenimiento y coordinación

La integración de despliegue detiene y drena escritores de aplicación antes de entrar al runner, y no reactiva tráfico mientras no finalice el deployment gate. El runner recibe un `maintenanceId` verificable por esa integración; no lo trata como un booleano libre que cualquier invocación pueda afirmar. El test usa un proveedor falso que mantiene estado de mantenimiento y detecta activación prematura.

Un advisory lock PostgreSQL de **sesión** coordina migradores durante varios commits sobre el mismo scope. La conexión se dedica a esa ejecución y nunca retorna al pool con el lock adquirido. La clave se deriva de identidad de base/scope, no de release destino. Liberar en finally y cerrar; pérdida de sesión detiene la ejecución. Consultar [semántica de locks PostgreSQL](https://www.postgresql.org/docs/18/explicit-locking.html). El lock no detiene por sí solo escritores de aplicación: esa condición la cumple mantenimiento.

### 12.2 Journal mínimo suficiente

| Tabla lógica | Identidad | Contenido |
| --- | --- | --- |
| installation | installationId y scope únicos | systemId, baseline, current release/hash, versión de journal |
| migration_history | instalación + ordinal de transición | migrationId/hash, from/to hashes y confirmación |
| execution_attempt | attemptId | deploymentId, planHash, candidato de aplicación, estado y diagnóstico |
| verification_run | verificationId | binding exacto, checks requeridos, resultado y reportes |
| deployment_readiness | deploymentId | candidato, target, estado pending/blocked/ready/consumed, referencias a resultados |

Los errores que revierten una transacción se registran fuera de ella después de ROLLBACK. El éxito de migración y actualización del head se escriben **dentro de la misma transacción que los cambios de aplicación**. No deducir head desde timestamps o `MAX(version)`. Fresh install B registra baseline B; no inventa migraciones A→B que no se ejecutaron.

El schema del journal es propio del consumidor. Bootstrap/versionado de sus tablas son explícitos e independientes del scope administrado de aplicación; un runner antiguo rechaza un formato de journal que no entiende. El historial confirmado forma el segmento contiguo desde el baseline, con IDs y hashes preservados.

### 12.3 Unidad transaccional exacta

```text
verificar artefactos y elegibilidad del intento de despliegue
abrir sesión dedicada y adquirir lock
releer instalación/historia después del lock
verificar mantenimiento, entorno 18.6 y plan/hash
para cada migración pendiente:
    BEGIN
    aplicar límites operativos configurados con SET LOCAL
    verificar head esperado y estructura origen en esta sesión
    ejecutar checks before
    ejecutar todos los steps SQL en orden
    ejecutar checks after, invariantes destino y metadatos administrados
    inspeccionar estructura destino en esta sesión y comparar
    insertar historia y actualizar head
    COMMIT
validar nuevamente target confirmado e invariantes finales
registrar resultado para deployment gate
liberar lock y cerrar sesión
```

`BEGIN` delimita una transacción, pero las garantías efectivas dependen de los comandos usados; consultar [BEGIN](https://www.postgresql.org/docs/18/sql-begin.html). El runner no ofrece subgrupos con commits parciales ni retries automáticos. Un retry explícito primero reconcilia historia y estado.

Si A→B confirma y B→C falla, el head queda en B. C no se despliega; mantenimiento permanece activo, y el reporte identifica B como última release confirmada. No prometer rollback de toda la cadena ni asumir que la aplicación anterior sigue siendo compatible con B. Una nueva ejecución usa el head real y repite verificación para el segmento pendiente.

### 12.4 Scripts admitidos y límites de atomicidad

Los recursos no contienen COMMIT/ROLLBACK/BEGIN propios, comandos prohibidos dentro de transacción ni efectos fuera de la DB transaccional. El loader valida statements mediante parser PostgreSQL compatible y lista explícita de comandos permitidos/prohibidos; no usar regex ni separar scripts por `;` ignorando strings/cuerpos.

Caso negativo obligatorio: `CREATE INDEX CONCURRENTLY` se rechaza; el autor puede usar un índice normal compatible con mantenimiento. La restricción transaccional se documenta en [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html). No convertirlo silenciosamente en una fase no transaccional.

También deben considerarse efectos que PostgreSQL no revierte aunque ocurran dentro de una transacción: por ejemplo, avances de secuencias vía nextval/setval. La [documentación de secuencias](https://www.postgresql.org/docs/18/functions-sequence.html) describe esa limitación. Para cumplir el contrato estricto de migraciones atómicas, el autor declara que sus recursos no dependen de esos efectos no reversibles; el preflight rechaza los usos conocidos y verifica defaults/rutinas involucradas. Si no puede establecer compatibilidad, el recurso se informa no soportado y se bloquea. No afirmar que un parser demuestra ausencia de efectos de cualquier código SQL arbitrario.

La creación de una rutina puede describir su comportamiento futuro sin ejecutarlo en el upgrade; su definición y la invocación de una rutina son operaciones distintas. Los scripts son código confiable del autor, no consultas de usuarios finales. No ampliar el alcance a compensaciones remotas para resolver una incompatibilidad con U06.

### 12.5 Fallos y commit ambiguo

| Fallo | Estado y acción |
| --- | --- |
| Preflight, checksum, entorno, drift o check antes de cambios | No aplicar; readiness blocked |
| SQL/check/inspección durante migración | ROLLBACK; head permanece origen de esa migración; bloquear deployment |
| Conexión perdida antes/durante COMMIT | Resultado unknown; reconectar/adquirir lock y leer journal antes de decidir |
| Journal confirma misma migración/hash | No repetir SQL; verificar estado/checks antes de completar el intento |
| Journal no confirma y DB coincide con origen | Transacción no aplicada; intento falla y puede reintentarse explícitamente |
| No se puede probar origen ni destino | Deployment blocked; diagnóstico; no marcar éxito ni repetir a ciegas |
| Falla registro de diagnóstico | Mantener fallo original y adjuntar error de registro; nunca devolver éxito |

La atomización de datos+historia permite resolver el commit ambiguo para recursos admitidos. Un test debe reiniciar proceso/runner; conservar flags en memoria no prueba recuperación.

## 13. Verificación de estructuras y datos

### 13.1 Dos rutas con el mismo runner

No crear una dependencia circular «para verificar hay que haber verificado». El motor compartido contiene `executeCreatePlan`/`executeMigration` y la secuenciación; el verificador los invoca únicamente sobre handles scratch creados y registrados por su harness. `install`/`apply` son wrappers públicos para instalaciones que exigen los gates. No exponer un `skipVerification` que permita usar el camino scratch sobre una DB destino. Ambos caminos ejecutan los mismos recursos y verificaciones de cada transacción; difiere el requisito de autorización de un despliegue real.

Al verificar un release borrador, ejecutar su create plan compartido en scratch, comprobar la proyección y obtener el esquema esperado; recién entonces calcular los hashes finales del artifact. Así no se necesita conocer el hash final del propio esquema antes de inspeccionarlo. Instalar un release publicado sí exige todos sus hashes y escribe su baseline en journal.

```text
scratchTarget: instalar B desde su artefacto → inspect → expectedB
scratchUpgrade: instalar A → cargar fixture A → ejecutar runner A→B → inspect → actualB
comparar actualB con expectedB y schema publicado de B
comprobar invariantes, metadatos y contratos de transformación
```

Verificar cada transición consecutiva y cada segmento soportado desde baselines desplegables. La serie es lineal: enumerar prefijos/segmentos requeridos no exige un algoritmo de selección de ramas. Guardar en el reporte qué segmentos/fixtures se probaron; un test de una arista no se presenta como prueba de todos los upgrades posibles.

La instalación limpia de B no carga usuarios artificiales de A. La comparación general es estructura + metadatos administrados; los datos de usuario se validan mediante postcondiciones/fixtures específicos. Conteos iguales no prueban conservación de claves o valores.

### 13.2 Tres niveles de comprobación

1. Proyección SSOT contra instalación limpia para detectar omisiones del generador.
2. A→B contra instalación limpia B para detectar scripts incompletos.
3. Instalación real contra su head antes de cambios y target tras cambios, bajo mantenimiento.

Un cambio de tipos compartidos o records reutilizados afecta todas las entidades persistidas correspondientes. Usar `cursos`, `clases`, `inscripciones`, `presencias`, `docentes` y `mesas` para probar FK y PK reales de Aida, además de fixtures locales simples.

### 13.3 Ensayo con copia/backup

Para actualizar una instalación de producción existente, ensayar el segmento real sobre una copia/backup identificada, como propone `ideas`. Una instalación nueva sobre un scope vacío no tiene datos previos que restaurar: se exige verificación de creación e invariantes, sin fabricar un backup de origen. El verificador recibe un entorno de ensayo aislado y referencia a la copia; no implementa un servicio de backup ni decide retención de producción. Guarda procedencia de la copia, versión/hash origen y reporte redactado.

Una prueba de datos pasada no garantiza que los datos en producción no hayan cambiado: mantenimiento + precondiciones/checks reales se vuelven a ejecutar. Si falla ensayo, validación estructural o datos, se bloquean apply y deployment. Si la copia requerida está ausente, no existe evidencia suficiente y el gate permanece bloqueado.

El harness registra IDs únicos de sus bases scratch y sólo limpia esas bases, verificando identidad. No derivar un DROP DATABASE de un DSN genérico. Fallo de cleanup se reporta separadamente sin convertir una verificación fallida en exit 0.

## 14. Bloqueo de despliegue obligatorio

### 14.1 Dos gates diferentes

**Gate de entrada a apply:** exige verificación satisfactoria de artefactos/segmento, datos requeridos y ensayo aplicable, ligados al candidato de despliegue. Sin ello no empieza el upgrade real.

**Gate de activación de aplicación:** exige además el éxito confirmado de install/apply, head exacto destino, invariantes finales y mantenimiento vigente hasta el relevo al pipeline. Sin ello no se inicia/promueve el nuevo proceso ni se conmuta tráfico a él.

La comprobación de despliegue no forma parte del hash de la release: es evidencia de un intento de despliegue concreto. Un build nuevo con igual esquema necesita el binding correcto a su artefacto de aplicación; no reutilizar por coincidencia de schemaHash.

### 14.2 Identidad de la evidencia

El binding inmutable incluye `deploymentId`, `installationId`, `candidateApplicationHash`, origen/hash observado, target/hash, `planHash`, hashes de recursos/inspector, PostgreSQL 18.6, scope y digest de configuración no secreta. Credenciales se resuelven fuera; no almacenarlas en logs ni manifests.

El binding distingue `operation:'install'` con `from:null` de `operation:'upgrade'` con una release origen real. Para install, `planHash` se deriva del create plan y release destino; para upgrade, del segmento de migraciones. No inventar una release cero para instalar desde vacío. La integración reserva deploymentId/maintenanceId antes de verificar; el ID reservado no acredita mantenimiento activo, que se comprueba al operar sobre target.

Cada intento crea estado pending, que por sí mismo bloquea deployment. Una verificación negativa/incompleta/abortada lo deja blocked. Un resultado pasado de otra app, instalación, target, plan, recurso o configuración no lo vuelve ready. El gate consume el resultado más reciente del intento y consulta su journal confiable; no confía en un archivo `passed:true` recibido del usuario.

Para avanzar de blocked/pending a ready se requiere una ejecución nueva de todas las comprobaciones fallidas/invalidantes y estado final correcto. Un fallo posterior invalida cualquier readiness previa no consumida del mismo intento. No hay `--force`, `--skip-verification` ni camino warning-only.

### 14.3 Contrato de integración de pipeline

```text
build candidato y bundle inmutable
verificar candidato/segmento en scratch y datos requeridos
si falla o falta evidencia: terminar con error; no promover aplicación
entrar en mantenimiento, detener y drenar escritores
preparar/actualizar ensayo requerido y revalidar condiciones reales
ejecutar install/apply mediante runner compartido
si falla: mantener mantenimiento; no promover aplicación
deployment-gate: comprobar binding, evidencia vigente y head destino
si no ready: terminar con error; no promover aplicación
activar candidato exacto manteniendo exclusividad del deployment
confirmar activación y consumo del recibo; levantar mantenimiento
```

El pipeline mantiene una exclusión por instalación durante gate→activación; ningún otro despliegue modifica la DB en ese intervalo. Si se pierde control o se reanuda la sesión de despliegue, revalidar gate. El runner no puede impedir una activación manual fuera del pipeline integrado; la garantía se cumple implementando el gate como dependencia obligatoria del proceso real de deployment, no sólo como documentación.

En GitHub Actions o equivalente, los jobs de activación dependen de la verificación/ejecución/gate y sólo corren con éxito. No usar `continue-on-error`, `|| true` o condiciones `always()` que eludan ese resultado. Se puede usar `always()` para limpieza/reportes, nunca para promoción.

Este repositorio tiene un workflow de build/test, no un pipeline real de despliegue de una aplicación concreta. El handoff exige entregar un ejemplo de integración y un test ejecutable de pipeline simulado. Cuando una aplicación lo adopta debe conectar su punto real de activación; no afirmar que el deployment productivo quedó bloqueado sólo por añadir tests a esta biblioteca.

### 14.4 Tests del gate que son obligatorios

- Verificación estructural fallida: contador de llamadas a apply = 0 y contador de activaciones = 0.
- Datos/ensayo fallidos: ambos contadores = 0.
- Preflight real fallido después de verificación CI pasada: activaciones = 0.
- Falla una migración tras otras confirmadas: activaciones = 0; mantenimiento sigue activo; head = última confirmada.
- Migraciones exitosas pero falla check final: activaciones = 0 y readiness blocked.
- Evidencia faltante, de otra instalación/app/target/plan o checksum alterado: activaciones = 0.
- Un resultado viejo pasado seguido de uno fallido no habilita activación.
- Camino completo exitoso: una activación del hash exacto; consumo del recibo y salida de mantenimiento después.
- Reinicio entre apply y gate: consultar journal; no duplicar SQL; reevaluar readiness.
- Plan vacío porque DB ya está en B: igualmente comprobar candidate binding, hashes, drift y datos antes de activar.
- La activación de aplicación lanza error tras apply exitoso: conservar head destino, no consumir el recibo como despliegue confirmado y mantener mantenimiento; una reanudación reevalúa gate.

## 15. CLI y errores

La librería exporta funciones equivalentes a los comandos. CLI comparte sus resultados; no implementa otro runner.

| Comando | Efecto |
| --- | --- |
| `capture` | Capturar snapshot/persistencia del módulo de aplicación |
| `build-release` | Generar plan de creación y bundle borrador |
| `migration infer` | Inferir cambios desde SSOT A/B y generar borrador de upgrade con pendientes explícitos |
| `migration resolve` | Leer reporte de generación/aplicación, preguntar al desarrollador y producir resolución; no modifica DB |
| `migration add-data` | Seleccionar fuentes opcionales, transformaciones y destinos con contratos tipados |
| `migration resolve-destructive` | Resolver cada columna afectada como discard o migrate antes de publicar |
| `migration validate` | Validar contratos del borrador; distinguir pruebas de datos pendientes de evidencia pasada |
| `verify` | Ejecutar comparación de rutas/fixtures y producir evidencia; sólo scratch |
| `publish` | Materializar artifact local inmutable que pasó verificación |
| `plan` | Resolver segmento lineal; ninguna mutación en DB destino |
| `status` | Leer head/historia/estado de intento y drift cuando se solicita |
| `install` | Crear estado inicial en scope vacío, usando gate de entrada |
| `apply` | Ejecutar segmento verificado dentro de mantenimiento |
| `deployment-gate` | Comprobar elegibilidad de activación del candidato concreto |

`rehearse` puede ser una opción de `verify` que recibe conexión a copia aislada y referencia de backup. No introducir downgrade, edición manual del journal ni adopción forzada. U11 incorpora resolution de conflictos y preparación verificable del estado de origen, especificadas en [contratos de autoría, sección 13](migraciones-autoria-contratos.md#13-reportes-y-resolución-separada-de-conflictos). No equivale a aceptar drift como nueva historia. Una DB preexistente sin baseline verificable requiere incorporación explícita; no inventar su versión ni sobrescribir su historial.

Código de salida 0 significa éxito completo del comando. Cualquier fallo, evidencia incompleta o bloqueo devuelve un código distinto de 0. La diferenciación técnica de códigos se documenta en el anexo; el pipeline decide sólo con éxito verdadero más la comprobación de evidencia. JSON output incluye `ok`, `problems`, IDs y referencias de reportes; un reporte creado con resultado fallido nunca devuelve 0.

Reutilizar `Problem`/`ValidationResult`; `field` identifica propiedad de entrada o null. `details` sólo admite strings. Diferencias grandes van en un reporte aparte. Los logs llevan deployment/installation/migration/step IDs, fase y diagnóstico redactado; no DSNs, secretos ni contenido completo de filas.

## 16. Fixture obligatorio de Aida

Crear fixture histórico local `aida-email` con Def A/B usando `defineRecord`, `withRecords`, `defineEntity`, `defineEntities`. No mutar el ejemplo actual ni usar imports vivos para reconstruir un artifact publicado.

Release A tiene `alumnos` (PK `alumno`; apellido/nombres obligatorios; email nullable) y `contactos_alumnos` (PK/FK alumno; email obligatorio como fuente existente verificada del fixture). Release B conserva ambos y exige `alumnos.email NOT NULL`. La FK y los registros se declaran con los patrones actuales, no como interfaces paralelas sin chequeo.

| Alumno | Email original | Contacto | Resultado esperado |
| --- | --- | --- | --- |
| a001 | ana@example.test | alternativo@example.test | ana@example.test |
| a002 | null | luis@example.test | luis@example.test |
| a003 | null | eva@example.test | eva@example.test |

Precondición `email_source_complete_v1`:

```sql
SELECT NOT EXISTS (
    SELECT 1 FROM app.alumnos AS a
    LEFT JOIN app.contactos_alumnos AS c ON c.alumno = a.alumno
    WHERE a.email IS NULL AND c.email IS NULL
) AS ok;
```

Paso `backfill_alumno_email_v1`:

```sql
UPDATE app.alumnos AS a SET email = c.email
FROM app.contactos_alumnos AS c
WHERE a.alumno = c.alumno AND a.email IS NULL;
```

Paso `require_alumno_email_v1`:

```sql
ALTER TABLE app.alumnos ALTER COLUMN email SET NOT NULL;
```

Check `alumno_email_required_v1`:

```sql
SELECT NOT EXISTS (SELECT 1 FROM app.alumnos WHERE email IS NULL) AS ok;
```

Ese check valida datos; la inspección valida que exista el constraint. Quitar el paso ALTER en un bundle negativo debe hacer fallar comparación aunque los datos no tengan null. La prueba de conservación compara PK/valores exactos y las columnas sin cambios, no sólo número de filas.

Casos: vacío; positivo; falta contacto de a003; check fallido después de UPDATE; script sin ALTER; bytes de script alterados; columna extra manual; segunda ejecución cuando ya está B; A→B→C con fallo en C. Cada negativo verifica también deployment bloqueado según sección 14.

Agregar fixtures de vistas, rutinas y metadatos para verificar los otros objetos exigidos por `ideas`; incluir una rutina/vista modificada por script y un dato administrado incorrecto aunque el esquema sea idéntico. Cambiar el orden de creación sin cambiar semántica no debe producir drift.

## 17. Orden detallado de implementación

Cada tarea incluye lectura de su fila de reutilización, test rojo, implementación mínima que satisface el contrato y validación del conjunto afectado. Respetar el flujo TDD/revisión de `CLAUDE.md` y la autorización vigente de la sesión de implementación. Este handoff no modifica código ejecutable.

| ID | Dependencias | Entregable y primer oráculo |
| --- | --- | --- |
| T01 | — | JSON estricto/copia; getter no se ejecuta; canonicalización de keys numéricas produce bytes esperados |
| T02 | T01 | Captura de Aida; PK de clases conserva tupla y campos PK no nullable; tests estáticos bidireccionales |
| T03 | T02 | Persistencia exhaustiva; falta mapping fecha falla estática/runtime; record HTTP no crea tabla |
| T04 | T01 | Recursos sql/check y Def/Info; typo/kind incorrecto falla; defaults completos y literales preservados |
| T05 | T04 | Catálogo lineal; A→C produce [A→B,B→C]; gap/rama/reversa rechazados |
| T06 | T02–T05 | Bundles/hashes; editar byte SQL falla antes de cualquier acceso de escritura |
| T07 | T03,T06 | Proyección y creación PostgreSQL 18.6; claves compuestas y FK reflexivas/circulares correctas |
| T08 | T07 | Inspector misma sesión; SQL independiente y DDL sin commit visibles; diferencias semánticas detectadas |
| T09 | T08 | Vistas/rutinas/restricciones/metadatos; inventario desconocido bloquea en lugar de ignorarse |
| T10 | T06 | Journal y locks; fresh install B tiene baseline B; dos runners no ejecutan en paralelo |
| T11 | T05,T08–T10 | Ejecutar migración atómica; check tardío revierte update+DDL+historia/head |
| T12 | T11 | Commit ambiguo; nuevo runner consulta historia y no duplica cambios; fallo de C deja head B |
| T13 | T07–T12 | Verificador de ambas rutas usa mismo runner; sin SET NOT NULL falla estructura, no sólo datos |
| T14 | T13 | Ensayo con copia y reportes; copia ausente/fallida bloquea cuando requerida |
| T15 | T06,T10,T13,T14 | Binding/evidencia de despliegue; mismatch/resultado viejo no habilita apply |
| T16 | T11,T12,T15 | Gate final + pipeline simulado; cada negativo tiene cero activaciones |
| T17 | T01–T16 | CLI/CI/docs operativas del motor; matrices correspondientes pasan y pipeline respeta bloqueo; T22/T23 integran y verifican extensiones de autoría/resolución |

T15/T16 son parte del producto acordado, no documentación opcional ni trabajo de una versión posterior. Entregar sólo un verificador que devuelve false sin una integración probada de bloqueo de deployment no cumple U07.

T18–T22, detalladas con dependencias y oráculos en [autoría, sección 8](migraciones-autoria.md#8-tareas-y-aceptación-adicionales-obligatorias), completan U08: inferencia, comando de datos, validaciones reutilizadas y resolución destructiva. Son igualmente obligatorias. La compilación a MigrationInfo incorpora el manifest de autoría y los módulos históricos de validación en hashes, evidencia y gates.

T23, con dependencias T12 y T20–T22, implementa reportes y resolución separada de generación/deployment, y preparación del origen sin reescribir historia. Sus contratos y oráculos están en la sección 13 del anexo de autoría. El resultado completo incluye U09–U11 y T23.

## 18. Matriz de aceptación

| Área | Casos obligatorios |
| --- | --- |
| Tipos | Asignabilidad en dos sentidos, literales de nombres/tipos/PK, referencias válidas y rechazo de extras |
| Serialización | JSON estricto, getter/símbolo/ciclo/hueco rechazado, referencias compartidas acíclicas, null vs string vacío |
| Def/Info | Constructor devuelve Def sin I/O; completador produce Info/defaults y copia; datos importados decodificados |
| Historial | Lineal, gap, duplicado, origen desconocido, downgrade, metadata-only, data-only, append, baseline B |
| Artefactos | Paths dentro de bundle, checksums, immutable IDs, recursos históricos sin Def actuales |
| Entorno | Aceptar exactamente 18.6; otra versión falla y bloquea; no fallback silencioso |
| Esquema | PK/UK/FK orden y acciones, tipos/nullability/defaults, vistas/rutinas, metadatos, objetos extra/desconocidos |
| Transacciones | Error de SQL/check/postcondición revierte; ningún éxito fuera de la transacción de cambios |
| Restricciones SQL | COMMIT embebido, operación no transaccional, recurso de efecto no reversible detectado: rechazo |
| Locks | Dos runners, pérdida de sesión, no devolver al pool conexión con lock |
| Recuperación | Commit con respuesta perdida; nueva instancia reconoce journal; no flags de memoria como prueba |
| Datos | Valores exactos preservados, nulls/faltantes, rangos, duplicados/huérfanos y checks antes/después |
| Autoría | Las tres categorías U08, generación inferida, contratos fuente→transformación→destino, reglas runtime y decisiones exhaustivas de pérdida; matriz adicional de autoría sección 8 |
| Verificación | Creación SSOT vs proyección; A→B vs B directo; checks reales bajo mantenimiento |
| Despliegue | Todos los negativos sección 14, resultado vigente ligado a candidato, no activación prematura |
| Operación | Mantenimiento sigue activo tras fallo, head parcial claro, secretos redactados, cleanup sólo scratch propio |

Usar `IsAssignable<A,B> = [A] extends [B] ? true : false` para afirmar relaciones de tipos. `@ts-expect-error` queda para una llamada/literal inválido por línea. No suprimir errores de aridad al probar otra propiedad. Los tests de runtime prueban una propiedad real; no copiar la implementación en el expected.

## 19. Build, CI y verificación del handoff

El package raíz actual tiene `build`, `test`, `test-ci`:

```powershell
npm run build
npm test
npm run test-ci
npm --prefix consumers/postgres-migrations run build
npm --prefix consumers/postgres-migrations test
npm --prefix consumers/postgres-migrations run test-integration
```

Los últimos tres scripts se crean en el consumidor. No cambiar el compilador/runner actuales ni introducir ts-node. Compilar raíz antes del consumidor. Fijar dependencias mediante lockfile; las versiones de bibliotecas no se inventan en este documento.

CI puro en Windows/Linux; integración con servidor PostgreSQL **18.6** y comprobación real `server_version_num`. Si la herramienta/imagen requerida no está disponible, el job informa requisito incumplido y falla; no reporta pruebas omitidas como éxito ni sustituye el servidor por otra versión.

Mantener el workflow raíz reusable de build/test y agregar job/ejemplo del consumidor. El pipeline de deployment debe depender de verificación y readiness según sección 14. Las pruebas de integración son obligatorias para validar el consumidor; compilar tipos no verifica transacciones ni bloqueo de deploy.

Esta revisión del handoff verifica referencias locales, estructura Markdown, coherencia con U01–U11 y ausencia de instrucciones del alcance descartado. No se afirma haber compilado las nuevas firmas, ejecutado PostgreSQL ni probado el handoff con otro modelo. Esas verificaciones forman parte de T01–T23. Los últimos chequeos del entorno de preparación no encontraron node/npm/tsc ni node_modules; el implementador debe comprobar su entorno antes de correr los comandos.

## 20. Criterio de terminación y entrega

El trabajo de implementación está terminado cuando todas las T01–T23 y la matriz de aceptación pasan, incluyendo scripts explícitos para estructuras/datos reales de prueba, historial lineal, atomicidad y bloqueo de despliegue. El README del consumidor documenta uso y fallos con ejemplos obtenidos de tests; documentación pública raíz se modifica vía `LEEME.md`/multilang, no editando README a mano.

Cada entrega informa tareas terminadas, símbolos reutilizados, código nuevo, pruebas efectivamente ejecutadas y limitaciones observadas. Una discrepancia entre compilador/motor y un detalle técnico se resuelve con un caso mínimo y una corrección documentada; no volver a pedir las decisiones U01–U11 ni introducir una alternativa que las contradiga.

La integración de una aplicación suministra sus Def, mappings, scripts de transformación, checks de negocio, configuración de entorno y punto real de activación. Esos datos concretos no son decisiones pendientes sobre la arquitectura del framework. No inventar direcciones email, reglas de reparación o límites de operación para una instalación real a partir de los fixtures.
