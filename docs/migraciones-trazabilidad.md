# Procedencia y decisiones acordadas del handoff

Este registro separa decisiones explícitas del usuario, requisitos de los dos repositorios e inferencias técnicas de implementación. Describe el alcance actual después de las decisiones U01–U11, incluyendo SQL para transformar, SSOT obligatorio y resolución separada de conflictos.

Leer con [la especificación completa](implementacion-migraciones.md) y [los contratos](migraciones-contratos.md). Los documentos deben ser coherentes; si aparece una contradicción, prevalece la decisión explícita del usuario y se corrige el documento, en lugar de elegir otra alternativa silenciosamente.

Entrada de implementación: [MIGRACIONES.md](../MIGRACIONES.md). Progreso/revisión: [checklist](migraciones-checklist.md). Las fuentes de ideas referenciadas abajo están [incluidas sin cambios con licencia y hashes](referencias/ideas/README.md) para transportar el handoff dentro de este repositorio.

## 1. Decisiones explícitas del usuario

El usuario respondió:

> 1. Postgres 18.6
> 2. separate consumer
> 3. your recommendation
> 4. your recommendation
> 5. your recommendation
> 6. your recommendation, but failed verification should also block deployment

Las recomendaciones aceptadas estaban definidas en la pregunta anterior. Se registran aquí completas para que el implementador no necesite reconstruir la conversación:

| ID | Decisión | Fuente de autorización | Consecuencia verificable |
| --- | --- | --- | --- |
| U01 | PostgreSQL **18.6** | Respuesta 1 | El runner y CI comprueban exactamente esa versión; no asumir compatibilidad de toda 18.x |
| U02 | Consumidor separado | Respuesta 2 | SQL/DB/I/O fuera de `src/common`; el consumidor usa la API pública del núcleo |
| U03 | Un runner de ejecución/verificación invocado por deployment | Respuesta 3, recomendación aceptada | Scratch e instalación real llaman la misma unidad de ejecución |
| U04 | Mantenimiento con aplicación sin escrituras | Respuesta 4, recomendación aceptada | Escritores detenidos/drenados antes de cambios; mantener condición hasta finalizar despliegue |
| U05 | Una secuencia lineal de versiones | Respuesta 5, recomendación aceptada | Upgrade antiguo = segmento de scripts consecutivos; sin branches/merges |
| U06 | Verificación bloqueante y una transacción por migración | Respuesta 6, recomendación aceptada | Before/steps/after/postcondiciones/head confirman juntos; rechazar operaciones incompatibles |
| U07 | La verificación fallida bloquea también deployment | Precisión explícita de respuesta 6 | No iniciar/promover/conmutar tráfico al candidato sin evidencia vigente y target DB confirmado |
| U08 | Soporte de estructura inferida, datos explícitos y estructura destructiva con resolución por columna | Mensaje posterior del usuario: «There should be support for all 3» y explicación de cada categoría | Inferencia SQL, comando para seleccionar fuentes/transformaciones/destinos, comprobación de tipos/validaciones y prompt para decidir descarte o transferencia |
| U09 | SQL para transformar; TypeScript existente para validar | Respuesta explícita «Option 1» | No implementar motores de transformación TypeScript; sí empaquetar/reutilizar codecs/validadores |
| U10 | SSOT obligatorio, inferencia desde historia, SQL manual permitido, fallo ante estado DB conflictivo | Precisión del usuario tras elegir Option 1 | Historia y SSOT son autoridades distintas de observed; verificar drift y completar SQL residual tras pasos manuales |
| U11 | Comando separado para resolver conflictos de generación o aplicación | Última precisión del usuario: deployment no debe preguntar | Reportes estables; migration resolve pregunta fuera del deploy y genera artifacts; nunca reescribe historia publicada |

U07 no es una nueva recomendación del asistente: es una exigencia explícita del usuario. Se traduce en dos gates (antes de apply y antes de activación), evidencia ligada al candidato y tests que exigen cero activaciones tras fallos.

## 2. Alternativas retiradas de las instrucciones

Las propuestas anteriores de DAG de releases, online/expand-contract, backfills con commits parciales, efectos externos, compensaciones y downgrades no se seleccionaron. Se retiraron del desglose de implementación para que otro agente no las implemente por seguir una checklist antigua.

La exclusión anterior de generación automática de SQL de upgrade queda corregida por U08: el sistema debe inferir cambios estructurales y generar SQL durante autoría. El usuario también exige autoría guiada de datos y resolución destructiva. [Autoría](migraciones-autoria.md) establece los contratos. No atribuir estos requisitos nuevos a la aceptación previa de seis recomendaciones ni afirmar que ya estaban cubiertos por el handoff anterior.

El consumidor sí ejecuta transformaciones de datos escritas por la aplicación dentro de la transacción completa. Mantenimiento y atomicidad no equivalen a prohibir transformaciones complejas; fijan su contrato de ejecución. No introducir retries, checkpoints confirmados o excepciones no transaccionales para superar una restricción del motor.

Los números de batch/retry/timeouts sugeridos anteriormente no fueron aprobados. Batch/parallel/retry no forman parte del modelo actual; los límites operativos necesarios se reciben como configuración explícita de instalación y se registran en el intento.

## 3. Requisitos con fuente identificada

| ID | Requisito | Fuente exacta |
| --- | --- | --- |
| F01 | Las descripciones son valores tipados y serializables, sin funciones embebidas | [SSOTIGAD, sección 2.3](referencias/ideas/src/SSOTIGAD.md), [CLAUDE.md, decisiones de diseño](../CLAUDE.md) |
| F02 | Def mínima, Info completada determinísticamente | [CLAUDE.md, convención Def e Info](../CLAUDE.md), `completeCoreField`, `completeRecord`, `completeEntity` |
| F03 | Comportamiento en contexto/registro; referencias por nombre | [ssot-types.ts](../src/common/ssot-types.ts): `SystemTypeContext`, `defineTypes`; [ssot-entity.ts](../src/common/ssot-entity.ts): `withValidators`; SSOTIGAD 2.3 |
| F04 | Reutilizar verdad de campos, claves y referencias | [ssot-record.ts](../src/common/ssot-record.ts), [ssot-entity.ts](../src/common/ssot-entity.ts): `EntityInfoOf`, `completeEntity`, `extractPk`, `mergePk`, `defineEntities` |
| F05 | Mantener precisión de tipos y checks bidireccionales | [CLAUDE.md](../CLAUDE.md), [aida-test.ts](../test/aida-test.ts) |
| F06 | Separar conversiones de máquina y humanas | [serialize.ts](../src/common/serialize.ts), [type-behaviour.ts](../src/common/type-behaviour.ts), [human.ts](../src/common/human.ts) |
| F07 | La biblioteca describe; un consumidor genera DDL/implementa almacenamiento | [README.md, Goal](../README.md), [CLAUDE.md](../CLAUDE.md) |
| F08 | Mapping de tipos por representación; cobertura de tipos | [Definición de entidades, sección 3](referencias/ideas/src/SSOTIGAD-details/definición-entidades.md). Es un borrador conceptual, no una API ya implementada |
| F09 | Una entidad puede ser tabla, vista o dato sin persistencia SQL | [SSOTIGAD, sección 3.1](referencias/ideas/src/SSOTIGAD.md) |
| F10 | Mantener scripts explícitos de actualización entre versiones nombradas | [Mantener actualizada estructura DB, «la idea», puntos 1 y 2](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F11 | Poder encadenar varios scripts desde una versión anterior | [Mismo documento, punto 2.2](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F12 | Guardar estructura generada en forma canónica por instalación/actualización | [Mismo documento, ayuda del framework, punto 1](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F13 | Verificar que los scripts llevan del estado anterior al nuevo | [Mismo documento, ayuda del framework, punto 2 y verificación automática](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F14 | Comparar mediante el motor porque SQL generado y dump pueden diferir sintácticamente | [Mismo documento, verificación automática](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F15 | Una base vacía no basta para probar transformaciones de datos; ensayar con backup | [Mismo documento, puntos 5 y 6 y nota sobre datos](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F16 | Verificar también en desarrollo y marcar versiones instalables con tags | [Mismo documento, «marcar las versiones durante el desarrollo»](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F17 | La estructura generada puede incluir tablas/claves/restricciones/vistas, metadatos y procedimientos almacenados | [Mismo documento, «la idea», punto 1](referencias/ideas/src/mantener-actualizada-estructura-db.md) |
| F18 | Reutilizar errores localizables y forma de resultado | [problem.ts](../src/common/problem.ts): `Problem`, `ValidationResult`, `problem`; trasladarlos a migraciones es I |

El vocabulario de entidades de `ideas` contiene decisiones marcadas como borrador y pendientes. No convertir todo su contenido en acuerdo definitivo ni reemplazar las APIs actuales con ejemplos históricos del documento.

## 4. Inferencias técnicas de implementación

| ID | Inferencia | Fundamento y límite |
| --- | --- | --- |
| I01 | MigrationDef/MigrationInfo con recursos por nombre | F01–F03 aplicados a scripts/versiones F10; formas nuevas, no APIs existentes |
| I02 | Snapshot mediante completeEntity/completeRecord | F02/F04/F12; evita redefinir defaults |
| I03 | Artifacts históricos, hashes y manifests | F11–F13 requieren reproducir origen/destino; formato JSON/SHA-256 son concreciones técnicas |
| I04 | Comparar A→B con creación limpia B | Concreta el objetivo F13/F14 y utiliza el mismo motor para ambos lados |
| I05 | Selección explícita de entidades persistidas | F09; no convertir todo record/export en tabla |
| I06 | Decoders runtime estrictos | Un JSON importado no pasó por el compilador; conservar garantías de F01/F04 |
| I07 | Layout `consumers/postgres-migrations` | U02 y F07; ubicación técnica reversible dentro del checkout compartido |
| I08 | Journal con head/historia e intentos | F11/F12 + U06; éxito del upgrade se confirma junto a datos/DDL |
| I09 | Gate ligado a candidato, plan y target | Concreción de U07: impide aceptar un resultado pasado de otra versión/instalación |
| I10 | Tests de pipeline con cero activaciones en fallos | Evidencia ejecutable de U07; no sustituye integración con el pipeline real de la aplicación |
| I11 | Advisory lock de sesión y mantenimiento de aplicación | Coordina migradores entre transacciones; mantenimiento viene de U04 y no lo reemplaza el lock |
| I12 | Firmas/helpers exactos siguiendo patrones actuales | Concreción técnica de F02–F06; corregir mecanismos de inferencia con tests si el compilador lo requiere |
| I13 | Drafts, nombres de comandos, manifest de decisiones y compilación a MigrationInfo | Concreción técnica de U08 usando F01–F06 e I03; preguntas durante autoría y respuestas verificables en deployment |
| I14 | Validación de contratos separada de pruebas con datos, contextos históricos por hash | U08 exige tipos/reglas; reutilizar validate.ts/type-behaviour.ts y no prometer prueba estática de SQL arbitrario |
| I15 | Protocolos SQL de ports/lineage, staging, checkpoints y formato de módulos históricos | Concreción técnica de U08/U09 para conservar datos y ejecutar validadores existentes; [contratos de autoría](migraciones-autoria-contratos.md) |
| I16 | Reportes, resolución y artifacts de preparación que conservan head | Concreción de U10/U11 y de inmutabilidad/atomicidad ya acordadas; no autoriza a marcar aplicada una migración que falló |

La elección de un nombre nuevo o un archivo no implica que exista literalmente en las fuentes. Se permite concretar detalles técnicos preservando F/U, con razones y tests. No está permitido ampliar scope/comportamiento y etiquetarlo como una inferencia de implementación.

## 5. Datos que suministra cada aplicación/instalación

La aplicación entrega sus Def/mappings, scripts concretos de conversión, checks de negocio, metadatos administrados y fuentes válidas de datos. El entorno entrega DSN/credenciales, scope, límites operativos, copia para ensayo y punto real de activación/mantenimiento del pipeline.

Estos son parámetros de uso, no decisiones de arquitectura pendientes. Para implementar y probar se usan fixtures sintéticos de Aida. No volver a pedir U01–U11 ni inventar valores productivos usando ejemplos de test.

## 6. Estado de verificación y fuentes técnicas externas

La documentación oficial PostgreSQL se consulta para los mecanismos de versión, locks, transacciones, inspección y limitaciones de SQL. La elección de PostgreSQL 18.6 procede de U01, no de esa documentación. Las fuentes externas no establecen decisiones de producto.

El handoff está actualizado en alcance y contratos, pero las APIs/SQL/CI del consumidor siguen por implementar. Las comprobaciones documentales no equivalen a compilación, tests con PostgreSQL 18.6 ni una prueba del handoff con otro modelo. T01–T23 definen la evidencia que deberá producir la implementación.
