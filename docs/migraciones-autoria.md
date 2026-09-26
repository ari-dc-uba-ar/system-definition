# Autoría: estructura inferida, datos y cambios destructivos

Este documento forma parte del handoff completo junto con [implementación](implementacion-migraciones.md), [contratos](migraciones-contratos.md), [contratos detallados de autoría/resolución](migraciones-autoria-contratos.md) y [trazabilidad](migraciones-trazabilidad.md). Concreta U08–U11: tres categorías, SQL para transformar, SSOT obligatorio y resolución separada. Las APIs indicadas son nuevas, por implementar. Los comandos y nombres de archivos son concreciones técnicas; las decisiones de transformación y pérdida de datos corresponden al desarrollador.

## 1. Tres categorías, una transición ejecutable

| Categoría | Qué determina el sistema | Qué determina el desarrollador |
| --- | --- | --- |
| Estructura inferida | Diferencia entre snapshots SSOT históricos y sus mappings físicos; operaciones y SQL necesarios para alcanzar el destino | Resuelve ambigüedades y revisa el artifact generado |
| Datos explícitos | Validez de referencias, contratos de entrada/salida y resultados comprobables | Fuentes opcionales, transformaciones, destinos y relación entre filas |
| Estructura destructiva inferida | Qué datos/objetos desaparecerían y qué dependencias resultarían afectadas | Para cada columna afectada: eliminar sin transferencia o conservar mediante una migración de datos |

No son tres runners ni tres historiales. Una transición A→B puede contener las tres categorías y se publica como una sola MigrationInfo con recursos ordenados, ejecutada en una transacción por el runner existente del diseño. Una migración exclusivamente de datos también es válida si el esquema no cambia.

Inferir estructura no permite inferir intención de negocio. Por ejemplo, añadir una columna NOT NULL permite inferir la restricción final, pero no el valor con que rellenar filas existentes. Un rename tampoco se deduce de semejanzas de nombres: solicitar correspondencia explícita o presentar add+drop con resolución destructiva.

La generación ocurre durante autoría. El despliegue ejecuta artifacts históricos publicados; no recalcula SQL contra las Def actuales ni pregunta cómo tratar los datos.

## 2. Diferencia estructural e inferencia SQL

`inferStructureChanges(from, to)` compara snapshots completados y mappings versionados de ambas releases. Usa completeEntity para defaults y claves efectivas y la proyección física del consumidor para los nombres/tipos SQL. No usa el estado productivo como sustituto del SSOT histórico: el inspector comprueba drift por separado.

Cada cambio entrega un ID determinístico, identidad antes/después, operación, dependencias, datos afectados y estado de resolución. El ID incluye la pareja de snapshots/mappings: una decisión de un diff anterior no autoriza uno nuevo.

El consumidor genera SQL para las operaciones de su cobertura declarada: creación/eliminación de tablas y columnas, cambios de tipos/nullability/defaults, claves, restricciones e índices representados por su modelo. Para vistas/rutinas y objetos adicionales usa los recursos versionados y adaptadores de generación/inspección ya exigidos; si falta una operación de actualización, informa bloqueo con objeto y capacidad faltante. Nunca omitir un cambio desconocido ni tratarlo como seguro.

Separar `origin: inferred | authored` de `impact: preserving | requiresDataCheck | destructive | unsupported`. Lo inferible puede ser destructivo o depender de datos. Un cast disponible no demuestra conservación; reducir capacidad de un tipo o sobrescribir valores exige resolver su impacto. Añadir UK/FK/NOT NULL requiere comprobar datos aunque no elimine columnas.

Construir un grafo local de dependencias de operaciones dentro de la transición. No es un DAG de releases: se conserva U05. Emitir orden determinístico; ciclos no resueltos producen un diagnóstico, no un orden arbitrario. Una secuencia habitual es crear destinos temporariamente compatibles, transformar/copiar, validar, retirar fuentes y establecer restricciones finales; el estado intermedio nunca se publica como release instalable.

## 3. Comandos de autoría

| Comando nuevo | Contrato |
| --- | --- |
| `migration infer --from A --to B` | Crear/actualizar borrador del diff, generar estructura resoluble y reportar pendientes sin preguntar |
| `migration resolve REPORT` | Leer conflictos de infer/apply, preguntar al desarrollador y generar resolución local verificable |
| `migration add-data --draft PATH` | Añadir una transformación explícita, incluso cuando el diff estructural está vacío |
| `migration resolve-destructive --draft PATH` | Mostrar datos afectados y recoger decisiones completas por columna |
| `migration validate --draft PATH` | Validar contratos y reportar qué pruebas con datos faltan; no autoriza apply/deployment |

Los comandos de autoría operan sobre artifacts locales de desarrollo. infer/apply/deployment nunca solicitan respuestas. resolve y add-data son sesiones explícitas de autoría; resolve-destructive es entrada especializada al mismo resolver. `--non-interactive --answers PATH` carga las mismas respuestas serializables; faltantes o ambiguas producen salida no cero y reporte de pendientes. No hay respuesta implícita «eliminar todas». Cancelar conserva el borrador sin publicarlo ni ejecutar DDL.

`add-data` permite seleccionar cero, una o varias columnas de origen, transformación registrada o nuevo recurso SQL con contrato, y una o varias columnas de destino. Incluye transformaciones dentro de una misma columna, entre tablas, combinación/separación de campos y generación desde constantes/parámetros declarados. Los parámetros son valores versionados y tipados, no SQL concatenado ni fuentes externas implícitas.

La unidad no puede limitarse a «una función por columna»: una transformación puede consumir varios valores y producir varios resultados. Para operaciones entre filas/tablas el autor declara claves de correspondencia, joins/filtros, cardinalidad esperada, inserción o actualización, y política de conflictos/filas sin correspondencia. No inventar un join por nombre coincidente, una deduplicación, agregación, sobrescritura o descarte. Los casos complejos usan un recurso SQL explícito con el mismo contrato y checks.

## 4. Contratos de autoría

Implementar Def mínimas y sus Info completas con los patrones del núcleo. Ninguna Def/Info contiene funciones. Las siguientes son obligaciones de campos y relaciones; derivar los tipos genéricos desde los contextos reales, sin copiar interfaces de filas.

| Contrato nuevo | Contenido obligatorio |
| --- | --- |
| `StructureChangeInfo` | ID, refs origen/destino, operación, origin, impact, dependencias, columnas afectadas y problemas pendientes |
| `DataMigrationDef` / `DataMigrationInfo` | ID, selecciones de fuentes, nombre de transformación, parámetros, bindings de salidas a destinos, alcance de filas, correspondencia/cardinalidad y checks |
| `TransformationDef` / `TransformationInfo` | Nombre/version, contrato de entradas/salidas con tipos de dominio y nullability, recursos SQL/check por nombre y precondiciones |
| `DestructiveResolutionDef` / `DestructiveResolutionInfo` | changeId, refs de snapshots/mappings, decisiones exhaustivas por columna y referencia a DataMigrationInfo cuando se conserva |
| `MigrationDraftInfo` | Refs históricas, diff, transformaciones, resoluciones, operaciones ordenadas, problemas y estado de validación |
| `AuthoringValidationInfo` | Estado de contratos, estado de pruebas con datos, lista de Problem y referencias a reportes; nunca un único booleano ambiguo |

Una referencia de campo indica explícitamente release/entidad/campo y rol source o target. Las fuentes se resuelven contra A y los destinos contra B. La capa de compilación mantiene aparte referencias a columnas/tablas temporales, que no se confunden con campos del SSOT final.

El constructor tipado filtra los nombres de transformaciones cuya entrada admite los tipos de las fuentes y cuya salida satisface los tipos de los destinos. Reutilizar el patrón de `ValidatorNamesFor` para compatibilidad por asignabilidad. Los tipos de dominio conservan identidad/contratos runtime: dos dominios representados como string no se declaran semánticamente equivalentes por compartir tipo TypeScript. Validar también nullability y contratos versionados.

Al importar JSON repetir validación de nombres, contratos y cobertura. `as` no convierte JSON en una migración válida. El SQL arbitrario tiene un contrato declarado, no una prueba estática de su resultado: queda pendiente de validación con datos. No intentar convertir automáticamente funciones JavaScript existentes a SQL.

El draft se compila a las MigrationDef/Info y recursos sql/check de los contratos existentes. Guardar además un manifest de autoría con diff, decisiones, transformaciones y correspondencia de cada operación a sus recursos/checks. El manifest y todos sus recursos entran en el hash del artifact de migración y, por transitividad, del plan. El loader/publicador comprueba completitud y correspondencia; no basta una pantalla de CLI que se pueda omitir invocando la biblioteca.

## 5. Validación en dos niveles

**Contratos:** referencias existentes, tipos de entrada/salida, nullability, parámetros, cobertura de destinos obligatorios, correspondencia de filas y dependencias. Mostrar errores sobre la selección concreta. Un input incompatible se rechaza antes de ejecutar SQL. Una conversión explícita registrada puede transformar entre tipos distintos; exige comprobar sus resultados, no sólo declarar que son compatibles.

**Datos:** ejecutar sobre fixtures y la copia requerida para producción, y repetir checks sobre el destino real durante la transacción. Comprobar valores contra el comportamiento del tipo destino, reglas de registro, NOT NULL, PK/UK/FK, checks de DB y propiedades de conservación declaradas. Para transformaciones entre filas, comprobar fuentes sin correspondencia, colisiones, multiplicidad y que no se pierden filas por un filtro o join accidental. Comparar por claves/valores; igualdad de conteos por sí sola es insuficiente.

Reutilizar `instanceProblems` para tipos y nullability y `validateInstance` para los validadores declarados. Como instanceProblems completa un RecordDef, construir el record de validación a partir de los fields efectivos de completeEntity para preservar NOT NULL implícito de PK; no utilizar el record original nullable de una PK. Ejecutar validadores sobre la fila destino completa, después de ensamblar todas las salidas y los valores conservados, no sobre cada celda aislada.

Un validador TypeScript no necesita equivalente SQL para ser obligatorio: el consumidor lee las filas afectadas dentro de la misma sesión/transacción, decodifica por codecs de máquina y ejecuta el comportamiento registrado. Puede procesar páginas sin commits parciales, usando recorrido estable sin omisiones. Las propiedades globales se verifican con restricciones/checks SQL o validadores globales explícitos. Falta de una implementación de validación requerida significa bloqueo, nunca «validación omitida».

Los contextos históricos de codecs/validadores se distribuyen como módulos ejecutables inmutables identificados por hash, separados del JSON descriptivo y ligados al artifact/plan verificado. El loader resuelve exclusivamente implementaciones declaradas y comprobadas; cambiar una implementación invalida la evidencia. No cargar el contexto actual para validar valores de una release antigua. Es una extensión técnica necesaria para ejecutar las validaciones existentes sin incrustar funciones en las Def.

Mantener `null`, `''` y el texto `'null'` distintos; usar `behaviourOf`/codecs de máquina, no el camino walkTextRecord que trata string vacío como ausencia. No reparar, truncar ni coaccionar silenciosamente valores inválidos.

Reportar contratos como `valid | invalid | unresolved` y datos como `notRun | passed | failed`, junto al alcance de los datos comprobados. Contratos válidos con datos notRun no significa «migración verificada». Las pruebas sobre una copia tampoco prueban todos los datos futuros: el check real sigue siendo bloqueante. Cualquier fallo revierte la migración y bloquea deployment conforme U06/U07.

## 6. Resolución destructiva obligatoria

Al detectar eliminación de tabla, enumerar todas sus columnas persistidas del origen y dependencias afectadas. Al detectar eliminación de columna, enumerarla con su tipo, tabla y usos. Mostrar referencias completas, no sólo nombres ambiguos. La misma revisión de impacto se aplica a conversiones potencialmente reductoras y sobrescrituras; no clasificar todo ALTER como conservador.

Para cada columna a retirar, exigir exactamente una resolución:

- `discard`: el autor acepta explícitamente retirar sus valores sin transferencia.
- `migrate`: referencia una migración de datos y los bindings que conservan/transforman sus valores antes de retirar la fuente.

Permitir selección múltiple, pero expandirla a decisiones por columna en el manifest; no guardar «toda columna que exista al ejecutar». Una tabla vacía en un ensayo también necesita resolución: ese hecho no autoriza perder datos de otra instalación. Si la tabla tiene cero columnas, exigir además decisión de eliminación del objeto y sus filas.

Si el autor desea transferir sólo un subconjunto de filas/valores y descartar otros, debe definir particiones explícitas con sus decisiones y checks de cobertura/exclusión; nada fuera del subconjunto queda tácitamente autorizado. Una selección migrate no se satisface con una migración no relacionada: comprobar que consume las fuentes indicadas y verifica los destinos/conservación declarados.

Ordenar preservación y verificación antes de DROP. Para cambios en la misma columna, materializar la entrada original cuando sea necesaria para comprobar conservación. Mantener fuentes o staging dentro de la transacción hasta pasar los checks que los necesitan. Cualquier fallo anterior/posterior al DROP revierte el conjunto. La pérdida aceptada por discard se limita a los campos/particiones registrados.

No emitir CASCADE para esconder dependencias sin resolver. Toda dependencia administrada se representa y se resuelve explícitamente; una dependencia externa no autorizada bloquea. Las decisiones se revalidan si cambia diff, mapping, transformación o destino, y la evidencia previa se invalida.

Publish y apply rechazan un artifact sin cobertura destructiva completa. Analizar también recursos SQL escritos a mano: un DROP o una escritura que elimina/sobrescribe datos debe corresponder al manifest de efectos y decisiones. La inspección final del esquema no detecta pérdidas de datos. Para efectos no analizables de rutinas/SQL complejo exigir contratos/checks explícitos y revisión de recursos; informar incertidumbre y bloquear cuando no se puede verificar, sin afirmar que un parser demuestra toda la semántica SQL.

## 7. Reutilización y archivos concretos

| Pieza | Reutilización obligatoria | Código nuevo |
| --- | --- | --- |
| Snapshots y diff | completeEntity/completeRecord, snapshots/persistencia y proyección física del handoff | `src/common/migration-authoring.ts`: Def/Info, referencias y validación pura; `consumers/postgres-migrations/src/infer.ts`: diff físico y emisión SQL |
| Selecciones tipadas | EntityInfoOf, EntityInstanceType, ExactFieldsOf, patrón ValidatorNamesFor | Constructores `defineDataMigration`, `defineTransformation`, completadores correspondientes y registro de transformaciones por nombre |
| Validación de resultados | TypeBehaviour.check, behaviourOf, instanceProblems, validateInstance, withValidators, Problem/ValidationResult | `consumers/postgres-migrations/src/data-validation.ts`: puente DB→dominio con contextos históricos |
| Borradores y decisiones | JSON canónico, decoders, hashes y recursos del handoff | `consumers/postgres-migrations/src/authoring.ts`: drafts, cobertura destructiva, compilación y manifest |
| Comandos/preguntas | Unidades de biblioteca anteriores, manejo de errores/CLI previsto | Subcomandos infer/add-data/resolve-destructive/validate en el CLI del consumidor |
| Ejecución | El mismo runner, journal, mantenimiento, transacción y gates de T10–T16 | Integración de checks de datos/manifest, sin duplicar el algoritmo de ejecución |
| Fixtures | aida/alumnos, cursos/clases/inscripciones/presencias, aidaConReglas y comportamientos existentes | Variantes históricas locales de prueba; no modificar ejemplos vivos para simular versiones |

Los nombres de módulos nuevos anteriores fijan dónde implementar cada responsabilidad; no afirman existencia actual. La API pública del núcleo exporta sólo descripción/operaciones puras. SQL, interacción, lectura de filas y carga de módulos viven en el consumidor.

## 8. Tareas y aceptación adicionales obligatorias

Estas tareas extienden T01–T17; pertenecen al sistema completo, sin aplazarlas a otra versión. Los IDs no imponen orden cronológico: desarrollar siguiendo dependencias y actualizar integración existente cuando corresponda.

| ID | Dependencias | Entregable y oráculo |
| --- | --- | --- |
| T18 | T02–T09,T11,T13 | Diff/generación desde historia reconstruida con runner/harness; añadir columna nullable se infiere, rename ambiguo no se inventa; incapacidad declarada bloquea |
| T19 | T04,T06,T18 | Def/Info de datos y CLI add-data; fuentes/salidas múltiples, sin fuente, datos sin cambio de esquema; tipos incompatibles rechazados |
| T20 | T11,T13,T19 | Validación real con codecs/reglas históricos; tipo correcto pero regla de dominio fallida revierte y bloquea deployment |
| T21 | T18–T20 | Prompt destructivo y manifest; toda columna resuelta, transferencias antes de DROP, no bypass por API directa o SQL manual |
| T22 | T15–T17,T21 | Integración completa; hashes/evidencia incluyen autoría y validadores, CI no interactiva rechaza pendientes, gates bloqueantes |
| T23 | T12,T20–T22 | Reportes de infer/apply y resolver separado; scripts publicados intactos, preparación del origen verificada y auditada, cero prompts en deployment |

Pruebas adicionales mínimas:

1. Estructura inferida sin datos explícitos produce el destino; NOT NULL sobre filas existentes exige resolución/check y no inventa relleno.
2. Data-only conserva schemaHash, crea transición histórica y verifica resultados concretos.
3. Combinar dos columnas en una, separar una en varias, generar desde constante y actualizar in-place; verificar claves, valores conservados y resultados.
4. Conversión declarada de texto a entero con fila inválida: fallo diagnosticado, ningún cambio confirmado. Tipo correcto con regla de negocio inválida también falla.
5. PK efectiva no nullable, UK duplicada, FK huérfana, join sin correspondencia o multiplicidad imprevista: no presentar éxito.
6. Eliminar tabla muestra todas las columnas. Una decisión pendiente impide publicar; una decisión antigua no vale después de cambiar el diff.
7. En una misma tabla, descartar columna autorizada y migrar otra a destino: comprobar copia exacta/transformación, luego eliminación y esquema final.
8. Migración relacionada incorrectamente, DROP manual no declarado y CASCADE con dependencias no resueltas: rechazo.
9. Fallo de validación antes de DROP y fallo posterior: rollback de datos/estructura/head y cero activaciones.
10. Flujo interactivo y archivo answers equivalentes producen el mismo artifact; CI sin respuestas falla sin esperar stdin. Cambiar implementación de validador invalida evidencia.

La UI nunca presenta «válida» sin distinguir validez de contratos y verificación con datos. Los tests ejecutan el runner compartido; no simulan resultados SQL para declarar cubierta una transformación.
