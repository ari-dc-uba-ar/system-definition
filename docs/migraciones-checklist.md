# Checklist compartida de implementación de migraciones

Entrada y prompt del agente: [MIGRACIONES.md](../MIGRACIONES.md). Alcance completo: [U01–U11](migraciones-trazabilidad.md#1-decisiones-explícitas-del-usuario). Este archivo es el registro de progreso único; los contratos siguen en la especificación. Estado inicial: todas las tareas pendientes, sin evidencia de implementación aportada por este handoff.

## Uso y significado de las casillas

Cada tarea tiene tres casillas independientes:

- **Implementación:** están implementados todos sus entregables, sin stubs ni caminos que omitan requisitos.
- **Verificación:** se ejecutaron sus tests/chequeos pertinentes sobre ese código, pasaron y existe evidencia. Una tarea escrita pero sin entorno de prueba no está verificada.
- **Revisión del desarrollador:** el desarrollador revisó esa entrega y lo confirmó expresamente. Sólo registrar una confirmación real; el agente no la concede.

Una casilla vacía no distingue por sí sola pendiente/en curso/bloqueado: el registro de sesión lo explica. No convertir revisar archivos, proponer tests o pasar tests de documentación en verificación del runtime. Si una modificación invalida pruebas previas, desmarcar las verificaciones afectadas y conservar la evidencia anterior como histórica.

El flujo de [CLAUDE.md](../CLAUDE.md#forma-de-trabajo) exige mostrar el test rojo y «esperar la revisión del programador antes de corregir». Registrar esa revisión del rojo en la evidencia de cada tarea, distinta de la revisión final de entrega. Aplicar las instrucciones expresas vigentes del desarrollador si cambian ese flujo; no interpretar el handoff como una excepción automática.

## Preparación y reanudación

- [x] Leer decisiones, especificaciones, contratos y código actual indicado por la tarea.
- [x] Comprobar entorno real: compilador/scripts del repo, dependencias y PostgreSQL 18.6 para integración; registrar versiones y pruebas base ejecutadas. No sustituir 18.6 silenciosamente. **Resultado:** dependencias no instalables en esta sesión y `psql` ausente; ver [evidencia T01](migraciones-evidencia/T01.md).
- [ ] Identificar cambios preexistentes del desarrollador y preservarlos; contrastar casillas con código/evidencia antes de retomar. **Límite:** el ZIP no contiene `.git`; no hay base de commit para distinguir cambios previos. Se preservó el contenido recibido.
- [x] Elegir una tarea cuyas dependencias estén implementadas/verificadas, registrar el test rojo y seguir el flujo de revisión vigente. **T01–T16 cerradas. T17 activa y verificada globalmente: typecheck limpio, 61 tests del consumidor, documentación reproducible, integración real PostgreSQL 18.6 y recorrido raíz con 207 tests verdes. Falta únicamente la revisión final explícita del desarrollador.**

Actualizar este bloque al cerrar una sesión o cambiar de agente; no dejar sólo información en el chat:

| Campo | Registro actual |
| --- | --- |
| Tarea activa | T17 — CLI, CI y documentación del motor |
| Estado / bloqueo concreto | T01–T16 cerradas. T17 implementada y verificada globalmente el 2026-09-29: typecheck consumidor limpio; 61 passing en consumidor; `docs:check` limpio; integración real PostgreSQL 18.6 confirmada con `server_version_num=180006`; `npm test` raíz con 146 core + 61 consumidor = 207 passing. Falta sólo revisión final explícita del desarrollador. |
| Revisión del rojo y autorización vigente | Primer rojo T17 aprobado con `T17 red approved`; segundo rojo aprobado con `T17 second red approved`, ambos el 2026-09-29. Ambos alcances fueron implementados y verificados. No queda autorización técnica pendiente; T17 no se cierra hasta la revisión final explícita del desarrollador. |
| Archivos modificados durante implementación | T17: `src/cli.ts`; tests/fixture CLI; `package.json` del consumidor con `test-integration`/`docs:*`; `scripts/test-integration.js`; `scripts/generate-readme.js`; README generado del consumidor; `.github/workflows/postgres-migrations.yml`; `Dockerfile` con cliente PostgreSQL; enlace público en `LEEME.md`; handoff T17. |
| Última evidencia válida / revisión de código | Verde autoritativo T17 final aportado el 2026-09-29: typecheck consumidor sin diagnósticos; suite consumidor 61 passing; `docs:check` exit 0; integración real PostgreSQL 18.6 verificada (`server_version_num=180006`); suite raíz 146 core + 61 consumidor = 207 passing. La corrección de EOL/Compose queda incluida en este verde. |
| Próxima acción | Revisión final del desarrollador. Si la entrega es aceptada, registrar literalmente `T17 approved`, cerrar T17 y activar T18 sin adelantar implementación. |
| Decisión pendiente del desarrollador | Ninguna de producto identificada; U01–U11 están acordadas |

Para cada tarea, sustituir «Pendiente» en Evidencia por un enlace a un registro o bloque completo con: revisión del código (commit o resumen de cambios si aún no hay commit), archivos, reutilización R/P/N, caso rojo y revisión recibida, comandos exactos, entorno, fecha, exit code/resultados, criterios cubiertos y bloqueos. No exigir crear un commit para registrar progreso. Si se guardan registros, usar `docs/migraciones-evidencia/Txx.md`; no guardar credenciales ni datos productivos. No crear archivos de evidencia vacíos para aparentar trabajo.

## Dependencias y navegación

El orden T01→T23 es válido; los IDs identifican trabajo, no versiones del producto. Las tareas que ya cumplen sus dependencias pueden avanzarse según el flujo del desarrollador. No interpretar esta tabla como autorización para delegar a otros agentes.

| Tarea | Dependencias | Resultado |
| --- | --- | --- |
| [T01](#t01) | — | JSON estricto y canónico |
| [T02](#t02) | T01 | Snapshot del SSOT |
| [T03](#t03) | T02 | Persistencia y mappings |
| [T04](#t04) | T01 | Recursos y MigrationDef/Info |
| [T05](#t05) | T04 | Catálogo y segmento lineal |
| [T06](#t06) | T02–T05 | Artifacts inmutables y hashes |
| [T07](#t07) | T03,T06 | Creación PostgreSQL |
| [T08](#t08) | T07 | Inspector y comparación |
| [T09](#t09) | T08 | Objetos adicionales y metadatos |
| [T10](#t10) | T06 | Journal, baseline y locks |
| [T11](#t11) | T05,T08–T10 | Unidad transaccional |
| [T12](#t12) | T11 | Recuperación y commit ambiguo |
| [T13](#t13) | T07–T12 | Verificación de ambas rutas |
| [T14](#t14) | T13 | Ensayo con copia |
| [T15](#t15) | T06,T10,T13,T14 | Evidencia ligada al deployment |
| [T16](#t16) | T11,T12,T15 | Gate de activación y pipeline |
| [T17](#t17) | T01–T16 | CLI/CI/documentación del motor |
| [T18](#t18) | T02–T09,T11,T13 | Inferencia y generación desde historia |
| [T19](#t19) | T04,T06,T18 | Autoría tipada de datos |
| [T20](#t20) | T11,T13,T19 | Transformación SQL y validación real |
| [T21](#t21) | T18–T20 | Resolución destructiva y SQL manual |
| [T22](#t22) | T15–T17,T21 | Integración de autoría, artifacts y gates |
| [T23](#t23) | T12,T20–T22 | Reportes, resolver y preparación del origen |

T17 integra lo construido hasta T16; T22/T23 amplían y vuelven a verificar CLI/CI/pipeline con la autoría y resolución completas. T17 no cierra el producto ni permite omitir tareas posteriores. Toda ampliación vuelve a comprobar los contratos afectados de tareas anteriores, sin crear una dependencia circular.

## T01

**JSON estricto y canónico.** Dependencias: ninguna.

- **Leer:** [implementación §7](implementacion-migraciones.md#7-json-canónico-e-integridad), [contratos §2](migraciones-contratos.md#2-tipos-comunes-y-snapshot).
- **Reutilizar:** `ValidationResult`, `problem` de [problem.ts](../src/common/problem.ts). JSON/canonicalización son código nuevo, no TOON ni un segundo tipo Result.
- **Entregar:** `src/common/json-value.ts`, exportación pública y tests de copia/decoder/canonicalización.
- **Aceptar:** getters nunca ejecutados; rechazo de undefined, ciclos, huecos y números no finitos; referencias compartidas acíclicas válidas; keys numéricas en orden canónico; null y string vacío distintos; fuente no mutada.
- **Evidencia:** [Evidencia T01](migraciones-evidencia/T01.md). Rojo aprobado; implementación y verde completos en Docker Node 24; revisión final confirmada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T02

**Captura del SSOT.** Dependencias: T01.

- **Leer:** [implementación §5](implementacion-migraciones.md#5-snapshot-del-sistema), [contratos §2](migraciones-contratos.md#2-tipos-comunes-y-snapshot), [variables de Aida](implementacion-migraciones.md#32-variables-concretas-de-aida-y-dónde-usarlas).
- **Reutilizar:** `completeEntity`, `EntityInfoOf` de [ssot-entity.ts](../src/common/ssot-entity.ts); `completeRecord`, `RecordInfoOf` de [ssot-record.ts](../src/common/ssot-record.ts); patrón `designSnapshot` de [aida-test.ts](../test/aida-test.ts), sin importar tests desde producción.
- **Entregar:** `system-snapshot.ts`, captura tipada y decoder runtime estricto, con fixtures derivados de [aida.ts](../examples/common/aida.ts).
- **Aceptar:** PK compuesta de clases conserva tupla y NOT NULL efectivo; fields custom conservados; records independientes no se pierden; literales/asignabilidad bidireccional; JSON externo inválido rechazado; copia sin aliases mutables.
- **Evidencia:** [Evidencia T02](migraciones-evidencia/T02.md). Rojo limpio aprobado; implementación completa; verificación Docker Node 24 verde con 121 tests; revisión final aprobada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T03

**Persistencia y representaciones.** Dependencias: T02.

- **Leer:** [implementación §6](implementacion-migraciones.md#6-descripción-de-persistencia), [contratos §3](migraciones-contratos.md#3-persistencia).
- **Reutilizar:** `TypeCollection`, `AnyEntityDef`; patrón exhaustivo `TypeProvider` de [type-behaviour.ts](../src/common/type-behaviour.ts). No usar ese registro de funciones como mapping SQL.
- **Entregar:** `system-persistence.ts`, Def/Info y `examples/common/aida-persistence.ts`; selección explícita y mappings completos por representación.
- **Aceptar:** mapping fecha faltante/sobrante rechazado en tipos y runtime; selección única/cerrada por FK; `alumnoSearchParams` no crea tabla; `cargos` no se descubre automáticamente; literales preservados.
- **Evidencia:** [Evidencia T03](migraciones-evidencia/T03.md). Rojo limpio aprobado; implementación y verificación Docker Node 24 completas; revisión final aprobada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T04

**Recursos y descripciones de migración.** Dependencias: T01.

- **Leer:** [implementación §9](implementacion-migraciones.md#9-migraciones-y-checks-por-nombre), [contratos §4](migraciones-contratos.md#4-recursos-y-migraciones).
- **Reutilizar:** patrones `defineEntity`, `ValidatedEntities` de [ssot-entity.ts](../src/common/ssot-entity.ts), `ExactFieldsOf` de [ssot-record.ts](../src/common/ssot-record.ts), `ValidatorNamesFor` de [validate.ts](../src/common/validate.ts); resultado Problem/ValidationResult.
- **Entregar:** `migration.ts`, constructores/completadores/decoders, recursos nombrados sql/check y tipos Info precisos.
- **Aceptar:** typo `befor`/`stepps`, kind incorrecto, nombre faltante y IDs duplicados rechazados; before/after omitidos completan listas vacías; constructor sin I/O; Def/Info serializables y tipos exactos.
- **Evidencia:** [Evidencia T04](migraciones-evidencia/T04.md). Rojo limpio aprobado; implementación y verde completos en Docker Node 24; revisión final aprobada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T05

**Catálogo e historia lineal.** Dependencias: T04.

- **Leer:** [implementación §10](implementacion-migraciones.md#10-historial-lineal-y-planificación), [contratos §5](migraciones-contratos.md#5-catálogo-y-plan-lineal).
- **Reutilizar:** T04 y ValidationResult; separar algoritmo puro `resolveMigrationPath` del hashing/I/O de consumidor.
- **Entregar:** `migration-plan.ts`, validación de catálogo y resolución del segmento.
- **Aceptar:** A→C devuelve A→B,B→C; gap/rama/duplicado/downgrade/origen desconocido fallan; plan vacío conserva referencias; data-only y metadata-only válidos aunque schemaHash no cambie.
- **Evidencia:** [Evidencia T05](migraciones-evidencia/T05.md). Rojo limpio ejecutado y aprobado; implementación/verificación autoritativa completas; revisión final aprobada con `T05 approved` el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T06

**Artifacts, manifests e integridad.** Dependencias: T02–T05.

- **Leer:** [implementación §§7–8](implementacion-migraciones.md#7-json-canónico-e-integridad), [manifest §6](migraciones-contratos.md#6-release-manifest-y-entorno), [layout](implementacion-migraciones.md#4-archivos-y-dependencias).
- **Reutilizar:** canonicalización T01, snapshots/persistencia T02/T03 y recursos T04. SHA-256 y filesystem son nuevos sólo en consumidor.
- **Entregar:** paquete separado `consumers/postgres-migrations`, `artifact.ts`, loader/publicador con referencias históricas verificadas y formatos versionados.
- **Aceptar:** byte SQL alterado falla antes de escritura; IDs publicados inmutables; rutas/escapes/case collisions rechazados; manifiestos sin ciclo de su propio hash; release antigua no carga Def viva. Extensiones de autoría se integran/reverifican en T22.
- **Evidencia:** [Evidencia T06](migraciones-evidencia/T06.md). Rojo limpio ejecutado/aprobado; implementación y verificación autoritativa completas; revisión final aprobada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T07

**Creación desde SSOT en PostgreSQL 18.6.** Dependencias: T03,T06.

- **Leer:** [creación §11.1](implementacion-migraciones.md#111-creación-desde-el-ssot), [soporte §12](migraciones-contratos.md#12-soporte-del-consumidor-sin-tipos-implícitos).
- **Reutilizar:** EntityInfo/FkInfo completados, T03/T06; `extractPk`, `mergePk` en fixtures Aida. Generador/adapter PostgreSQL son nuevos, no código SQL ya existente en core.
- **Entregar:** `pg-schema.ts`, `generate-create.ts`, planes de creación, SQL/identificadores/valores emitidos de forma comprobable.
- **Aceptar:** PK/UK/FK compuestas, reflexivas y circulares; tablas primero y FK después; tipos/mappings exhaustivos; versión exacta comprobada; representación desconocida bloquea.
- **Evidencia:** [Evidencia T07](migraciones-evidencia/T07.md). Rojo limpio ejecutado/aprobado; implementación y verificación autoritativa completas; revisión final aprobada el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T08

**Inspección y comparación semántica.** Dependencias: T07.

- **Leer:** [inspección §11.2](implementacion-migraciones.md#112-inspección-que-ve-cambios-sin-confirmar), [normalización §11.3](implementacion-migraciones.md#113-normalización-y-diferencias), [contratos §7](migraciones-contratos.md#7-inspección-postgresql-y-diferencias).
- **Reutilizar:** identidades/proyección T07 y JSON T01; wrapper PgSession especificado. Inspector y comparer nuevos, con fixtures SQL independientes del generador.
- **Entregar:** `inspect-schema.ts`, `compare-schema.ts`, inventario completo del scope y reporte unknown/excluded/diff.
- **Aceptar:** ve DDL sin commit en misma sesión; modificación semántica detectada; orden irrelevante normalizado; no comparar OIDs; nullability/defaults/acciones FK no desaparecen; unknown bloquea.
- **Evidencia:** [Evidencia T08](migraciones-evidencia/T08.md). Rojo limpio ejecutado/aprobado; implementación y verificación autoritativa completas; revisión final aprobada con `T08 approved` el 2026-09-26.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T09

**Objetos adicionales y datos administrados.** Dependencias: T08.

- **Leer:** [alcance/recursos §6](implementacion-migraciones.md#6-descripción-de-persistencia), [manifest §6](migraciones-contratos.md#6-release-manifest-y-entorno), [inspector §7](migraciones-contratos.md#7-inspección-postgresql-y-diferencias).
- **Reutilizar:** T07/T08, TypeBehaviour/behaviourOf y tipos de filas/claves del SSOT; CreateResourceInfo y ManagedDataInfo del contrato.
- **Entregar:** cobertura de vistas/rutinas/restricciones/índices y metadatos declarados, dependencias y checks en generador/inspector.
- **Aceptar:** cambiar cuerpo/atributo de objeto produce diferencia; objeto extra no se ignora; metadato incorrecto falla sin exigir igualdad de todas las filas de usuario; backing index no duplica constraint; recursos desconocidos bloquean.
- **Evidencia:** [Evidencia T09](migraciones-evidencia/T09.md). Rojo limpio aprobado; implementación/verificación autoritativa completas; revisión final aprobada con `T09 approved` el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T10

**Journal y coordinación.** Dependencias: T06.

- **Leer:** [mantenimiento/journal §§12.1–12.2](implementacion-migraciones.md#121-mantenimiento-y-coordinación), [contratos §8](migraciones-contratos.md#8-journal-y-unidad-de-ejecución).
- **Reutilizar:** referencias/hashes T06 y Problem/ValidationResult. Journal/advisory locks nuevos en `journal.ts`, no un scheduler basado en validateInstance.
- **Entregar:** baseline, head, historia, intentos y exclusión de migradores; schema de journal separado del scope de aplicación.
- **Aceptar:** instalación nueva B tiene baseline B sin historia ficticia; dos runners no escriben en paralelo; no devolver conexión con lock al pool; éxito durable sólo dentro de transacción de cambios; fallos registrados tras rollback.
- **Evidencia:** [Evidencia T10](migraciones-evidencia/T10.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 29 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada con `T10 approved` el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T11

**Ejecución atómica.** Dependencias: T05,T08–T10.

- **Leer:** [unidad §12.3](implementacion-migraciones.md#123-unidad-transaccional-exacta), [restricciones §12.4](implementacion-migraciones.md#124-scripts-admitidos-y-límites-de-atomicidad), [contratos §8](migraciones-contratos.md#8-journal-y-unidad-de-ejecución).
- **Reutilizar:** T05/T08/T09/T10 y mismo PgSession; motor único para verificación y aplicación.
- **Entregar:** `sql-resource.ts`, `execute-migration.ts`, `runner.ts`; prechecks/steps/postchecks/esquema/head dentro de una transacción.
- **Aceptar:** check tardío revierte datos+DDL+historia/head; checks no booleanos o con cardinalidad incorrecta fallan; drift bloquea antes de recursos; parser rechaza control transaccional/efectos incompatibles; cero commits parciales por step.
- **Evidencia:** [Evidencia T11](migraciones-evidencia/T11.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 34 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada con `T11 approved` el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T12

**Recuperación y commit ambiguo.** Dependencias: T11.

- **Leer:** [fallos §12.5](implementacion-migraciones.md#125-fallos-y-commit-ambiguo), [oráculos §13](migraciones-contratos.md#13-pruebas-con-resultados-esperados).
- **Reutilizar:** journal y unidad T10/T11; planes T05. Reconciliación por registro durable, nunca sólo flags en memoria.
- **Entregar:** recuperación en nueva instancia de runner y diagnósticos que distingan failed/unknown/succeeded.
- **Aceptar:** respuesta de COMMIT perdida no duplica cambios; origen/destino no demostrables bloquean retry/deploy; éxito A→B y fallo B→C deja head B, no A ni C; mantenimiento continúa activo.
- **Evidencia:** [Evidencia T12](migraciones-evidencia/T12.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 38 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T13

**Verificación de las dos rutas.** Dependencias: T07–T12.

- **Leer:** [verificación §13](implementacion-migraciones.md#13-verificación-de-estructuras-y-datos), [fixture Aida §16](implementacion-migraciones.md#16-fixture-obligatorio-de-aida), [harness §12](migraciones-contratos.md#12-soporte-del-consumidor-sin-tipos-implícitos).
- **Reutilizar:** create plan, runner, inspector y comparer T07–T12; Def de fixtures con defineRecord/withRecords/defineEntity/defineEntities existentes.
- **Entregar:** `verify.ts`, harness dueño de scratch y fixture histórico aida-email con dos rutas A→B/B limpio.
- **Aceptar:** quitar ALTER NOT NULL falla estructura aunque filas pasen checks; creación verifica intención SSOT independientemente; datos/valores preservados; scratch no exige recibo circular ni expone skipVerification a targets; cleanup limitado a scratch propio.
- **Evidencia:** [Evidencia T13](migraciones-evidencia/T13.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 42 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada por el desarrollador el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T14

**Ensayo sobre copia identificada.** Dependencias: T13.

- **Leer:** [ensayo §13.3](implementacion-migraciones.md#133-ensayo-con-copiabackup), [cobertura de evidencia §9](migraciones-contratos.md#9-evidencia-y-gate-de-deployment).
- **Reutilizar:** verificador/motor T13 y formatos de reportes/errores; copia provista por infraestructura, no restore sobre target.
- **Entregar:** rehearsal de segmento completo en copia y reporte de origen, alcance, artifacts y checks ejecutados.
- **Aceptar:** upgrade productivo sin copia o con ensayo fallido bloquea; copia de otro estado/artifact no habilita; install nuevo no requiere backup inexistente; ensayo no sustituye checks reales bajo mantenimiento.
- **Evidencia:** [Evidencia T14](migraciones-evidencia/T14.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 46 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada por el desarrollador el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T15

**Binding y vigencia de evidencia.** Dependencias: T06,T10,T13,T14.

- **Leer:** [identidad §14.2](implementacion-migraciones.md#142-identidad-de-la-evidencia), [contratos §9](migraciones-contratos.md#9-evidencia-y-gate-de-deployment).
- **Reutilizar:** manifest/hashes T06, journal T10 y resultados T13/T14; un validador puro de cobertura compartido al escribir/leer evidencia.
- **Entregar:** binding exacto por candidato/instalación/plan/configuración, ordinal de runs y `checkApplyEligibility`.
- **Aceptar:** evidencia ausente, incompleta, obsoleta, alterada o de otro candidato/instalación bloquea; nuevo run incomplete/fallido invalida passed anterior; status declarado no suplanta cobertura; install from=null distinto de upgrade.
- **Evidencia:** [Evidencia T15](migraciones-evidencia/T15.md). Rojo aprobado; implementación y verificación autoritativa completas: core 146 passing, consumidor 51 passing y `tsc -p consumers/postgres-migrations/tsconfig.json --noEmit` sin diagnósticos. Revisión final aprobada el 2026-09-28.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T16

**Bloqueo de activación de aplicación.** Dependencias: T11,T12,T15.

- **Leer:** [pipeline §14.3](implementacion-migraciones.md#143-contrato-de-integración-de-pipeline), [negativos §14.4](implementacion-migraciones.md#144-tests-del-gate-que-son-obligatorios), [gate §9](migraciones-contratos.md#9-evidencia-y-gate-de-deployment).
- **Reutilizar:** binding T15, head/intentos T10–T12 y checks existentes; mocks sólo en frontera de activación/mantenimiento, DB real para integración.
- **Entregar:** `deployment-gate.ts`, `checkDeploymentReady` y pipeline de referencia con integración simulada ejecutable.
- **Aceptar:** cada negativo tiene cero activaciones; éxito activa hash exacto una vez tras ready; fallo de activación deja mantenimiento y readiness sin consumir; ningún continue-on-error/force/skip evita gate. No afirmar integración productiva que el repo no posee.
- **Evidencia:** [Evidencia T16](migraciones-evidencia/T16.md). Rojo aprobado; implementación completa; defecto de aridad de bind detectado y corregido antes del cierre; verificación autoritativa Docker verde con core 146 passing + consumidor 56 passing y typecheck consumidor sin diagnósticos en la salida aportada. Revisión final aprobada explícitamente con `T16 approved` el 2026-09-29.
- [x] Implementación
- [x] Verificación
- [x] Revisión del desarrollador

## T17

**CLI, CI y documentación del motor.** Dependencias: T01–T16.

- **Leer:** [CLI §15](implementacion-migraciones.md#15-cli-y-errores), [build §19](implementacion-migraciones.md#19-build-ci-y-verificación-del-handoff), [códigos §11](migraciones-contratos.md#11-errores-y-códigos).
- **Reutilizar:** funciones de biblioteca T01–T16, scripts de [package.json](../package.json), exports de [index.ts](../src/common/index.ts), Mocha/tsc existentes; LEEME/multilang para documentación raíz.
- **Entregar:** `cli.ts`, scripts/build del consumidor, CI puro Windows/Linux + integración PostgreSQL 18.6 y documentación obtenida de ejemplos probados.
- **Aceptar:** CLI no duplica runner; cada fallo devuelve no cero; versión de servidor incorrecta/no disponible falla, no skip exitoso; package consumidor fuera de globs raíz; README generado no editado manualmente. T22/T23 actualizan esta integración con funcionalidades posteriores.
- **Evidencia:** [Evidencia T17](migraciones-evidencia/T17.md). Primera frontera CLI verificada; segundo rojo aprobado e implementado; una primera verificación expuso y corrigió portabilidad EOL y orquestación Compose. Rerun autoritativo final del 2026-09-29: typecheck consumidor limpio, 61 tests consumidor, `docs:check` limpio, integración real PostgreSQL 18.6 con `server_version_num=180006` y suite raíz 146 + 61 = 207 passing. Falta únicamente revisión final explícita del desarrollador.
- [x] Implementación
- [x] Verificación
- [ ] Revisión del desarrollador

## T18

**Inferencia estructural desde historia hacia SSOT.** Dependencias: T02–T09,T11,T13.

- **Leer:** [autoría §2](migraciones-autoria.md#2-diferencia-estructural-e-inferencia-sql), [estados §1](migraciones-autoria-contratos.md#1-estado-de-partida-objetivo-y-conflictos), [diff §6](migraciones-autoria-contratos.md#6-diferencia-decisiones-y-borrador), [compilación §7](migraciones-autoria-contratos.md#7-algoritmo-de-compilación-a-una-migración).
- **Reutilizar:** snapshots/persistencia T02/T03, artifacts T06, generador/inspector/comparer T07–T09; completeEntity/completeRecord, sin copiar defaults.
- **Entregar:** `infer.ts`, diff y clasificación de impacto, IDs estables, reconstrucción de historia y plan de operaciones residual contra SSOT.
- **Aceptar:** ADD nullable inferido; rename no adivinado; NOT NULL pide datos/prueba; cambios desconocidos bloquean; replay real con runner/harness T11/T13 que no produce head esperado falla; instalación atrasada se compara con su propio head; sin SSOT no genera.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## T19

**Autoría tipada de migraciones de datos.** Dependencias: T04,T06,T18.

- **Leer:** [autoría §§3–4](migraciones-autoria.md#3-comandos-de-autoría), [ports/datos §§2–3](migraciones-autoria-contratos.md#2-referencias-y-contratos-de-valores), [tipos §5](migraciones-autoria-contratos.md#5-tipos-estáticos-y-firmas-del-núcleo), [CLI §10](migraciones-autoria-contratos.md#10-cli-y-sesión-reproducible).
- **Reutilizar:** patrones ExactFieldsOf/ValidatorNamesFor/Def-Info; EntityInstanceType/EntityInfoOf desde contexto real. Nombres/recursos T04 y artifacts T06.
- **Entregar:** `migration-authoring.ts`, `authoring-contract.ts`, `source-selection.ts`, `authoring-cli.ts`; add-data, fuentes/outputs múltiples, parámetros, mappings y decisiones explícitas de filas.
- **Aceptar:** data-only, sin fuente de negocio, combinación/separación de columnas; typo/source de lado incorrecto/nullability/tipo incompatible rechazados; joins y políticas no se inventan; row/set y lineage tipados; SQL custom con contrato permitido; ninguna transformación TypeScript.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## T20

**SQL de datos, conservación y validación histórica.** Dependencias: T11,T13,T19.

- **Leer:** [validación §5](migraciones-autoria.md#5-validación-en-dos-niveles), [protocolo §4](migraciones-autoria-contratos.md#4-protocolo-sql-de-transformación-y-conservación), [checkpoints §8](migraciones-autoria-contratos.md#8-sql-escrito-a-mano-checkpoints-y-runner), [módulos §9](migraciones-autoria-contratos.md#9-validadores-históricos-formato-carga-y-validación).
- **Reutilizar:** behaviourOf/TypeBehaviour, instanceProblems/validateInstance y withValidators existentes; [aida-behaviour.ts](../examples/common/aida-behaviour.ts), [aida-validators.ts](../examples/common/aida-validators.ts) y sus tests; motor T11/T13.
- **Entregar:** `compile-data.ts`, `data-validation.ts`, `validation-artifact.ts`; staging, escritura SQL, checkpoints y módulos históricos por hash.
- **Aceptar:** __source_id/lineage/cobertura válidos; duplicados o match ambiguo fallan antes de UPDATE; null/''/'null' distintos; validar fila completa y PK efectiva; tipo correcto/regla inválida revierte; Problem regular también bloquea; cambio de módulo invalida evidencia; originales preservados en transferencias cíclicas.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## T21

**Decisiones destructivas y SQL manual.** Dependencias: T18–T20.

- **Leer:** [resolución destructiva §6](migraciones-autoria.md#6-resolución-destructiva-obligatoria), [borrador §6](migraciones-autoria-contratos.md#6-diferencia-decisiones-y-borrador), [compilación §7](migraciones-autoria-contratos.md#7-algoritmo-de-compilación-a-una-migración), [SQL manual §8](migraciones-autoria-contratos.md#8-sql-escrito-a-mano-checkpoints-y-runner).
- **Reutilizar:** authoring-contract/datos/staging T18–T20, JSON/hashes, parser de T11, runner y checks. La interacción es explícita en resolver/autoría, nunca en apply.
- **Entregar:** `authoring.ts`, decisiones exhaustivas discard/migrate, particiones, grafo local, manifest y add-sql con efectos/checks.
- **Aceptar:** DROP tabla enumera todas las columnas; decisión faltante/obsoleta bloquea; transferencia verificada antes de DROP; CASCADE no es bypass; manual implementa parte del diff y generador completa residual; manual que contradice SSOT falla; API directa exige el mismo manifest que CLI.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## T22

**Integración completa de autoría y deployment.** Dependencias: T15–T17,T21.

- **Leer:** [ejemplo completo §11](migraciones-autoria-contratos.md#11-ejemplo-completo-conservar-email-y-retirar-origen), [matriz §12](migraciones-autoria-contratos.md#12-matriz-de-aceptación-y-mapa-de-trabajo), [matriz de autoría §8](migraciones-autoria.md#8-tareas-y-aceptación-adicionales-obligatorias).
- **Reutilizar:** artifact loader T06, runner T11, verificador T13, evidencia/gates T15/T16 y CLI/CI T17; ningún runner especial para SQL generado.
- **Entregar:** unión de authoring manifest, queries, validadores y checkpoints a hashes/plan/gates; fixture email transferido + nota descartada; CLI/CI/docs ampliados.
- **Aceptar:** flujo generado, manual y mixto produce SSOT destino; manifest/checkpoint/recurso faltante bloquea; evidencia cambia con validator/SQL/decisión; respuestas interactivas y archivo equivalentes; tests negativos conservan cero activaciones; matrices T18–T21 pasan con PostgreSQL real.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## T23

**Reportes y resolver separado de deployment.** Dependencias: T12,T20–T22.

- **Leer:** [contratos §13 completo](migraciones-autoria-contratos.md#13-reportes-y-resolución-separada-de-conflictos), [preparación §13.1](migraciones-autoria-contratos.md#131-preparación-sin-modificar-historia-publicada), [tests §13.2](migraciones-autoria-contratos.md#132-contratos-del-comando-y-tests-t23).
- **Reutilizar:** reconciliación T12, transformaciones/decisiones T20/T21, artifacts/gates T22, mismo motor transaccional y lock. Resolver no recibe capacidad de escritura en target.
- **Entregar:** `conflict-report.ts`, `resolve-conflict.ts`, `preparation.ts`, comandos resolve/verify-resolution/apply-resolution y auditoría de preparaciones sin avanzar head.
- **Aceptar:** infer/install/apply/verify/gate con TTY nunca leen stdin; resolver sí pregunta explícitamente; reporte obsoleto/commit ambiguo bloquea; fallo en C informa head B; SQL publicado intacto; preparación verificada restaura/prepara origen y conserva head; fingerprint cambiado revierte; corrección invalida evidencia vía preparationHistoryHash; fallo irreparable sigue bloqueado.
- **Evidencia:** Pendiente.
- [ ] Implementación
- [ ] Verificación
- [ ] Revisión del desarrollador

## Aceptación final del sistema completo

No completar esta sección al terminar T17. La [regla de terminación](implementacion-migraciones.md#20-criterio-de-terminación-y-entrega), [matriz general](implementacion-migraciones.md#18-matriz-de-aceptación), [oráculos generales](migraciones-contratos.md#13-pruebas-con-resultados-esperados) y matrices de autoría/resolución siguen siendo obligatorias; los resúmenes anteriores no las recortan.

- [ ] T01–T23 implementadas y verificadas, con evidencia vigente; revisiones del desarrollador identificadas por separado.
- [ ] Las tres categorías demostradas end-to-end: estructura inferida, datos explícitos y destrucción resuelta conservando/descartando datos según decisiones.
- [ ] Creación limpia y replay desde historia coinciden con SSOT obligatorio; SQL manual no evita comparación; drift real bloquea antes del upgrade.
- [ ] Autoría/resolver pregunta sólo cuando se invoca explícitamente; todos los comandos de deployment fallan sin prompts y producen reportes útiles.
- [ ] Fallos de verificación, datos, recuperación o integridad mantienen bloqueo y cero activaciones; preparación no concede permiso de deployment ni altera historia publicada.
- [ ] Suite raíz y suite del consumidor pertinentes pasan; integración real PostgreSQL 18.6 y cobertura de CI exigida registradas. Ningún skip/bloqueo se presenta como passed.
- [ ] API pública/build/docs operativas actualizados; README raíz generado desde LEEME cuando corresponda; referencias y ejemplos finales siguen correctos.
- [ ] Revisión final del desarrollador registrada, sin casillas completadas en su nombre.

**Evidencia de aceptación final:** Pendiente.

## Registro de cambios de alcance o contradicciones

Ninguna decisión nueva pendiente registrada. Si aparece un conflicto real, añadir fecha, tarea, dos referencias concretas, evidencia, impacto y decisión del desarrollador. Un ajuste mecánico de tipos/implementación conserva el contrato; un cambio de comportamiento actualiza especificación, trazabilidad y esta checklist antes de darlo por acordado. No relegar requisitos a «futuro» para poder marcar tareas terminadas.
