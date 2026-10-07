# Contratos ejecutables de autoría y generación

Complementa [autoría](migraciones-autoria.md) y [contratos generales](migraciones-contratos.md). Implementar ambos, no elegir uno. U09 fija transformaciones SQL y validadores TypeScript existentes. U10 fija SSOT obligatorio, generación desde historia comprobada y rechazo de drift. U11 separa resolución interactiva de generación y deployment. Las formas siguientes concretan esas decisiones; son contratos nuevos y no APIs ya implementadas.

## 1. Estado de partida, objetivo y conflictos

Hay tres estados distintos:

- `historyHead`: estado esperado de la última migración de la historia elegida. En autoría es el último artifact publicado; en una instalación es su último commit registrado, que puede ser anterior.
- `desired`: nueva release construida desde el SSOT obligatorio, sus mappings y recursos de creación. Se genera e inspecciona en scratch como establece verifyRelease.
- `observed`: inspección de una DB concreta. Nunca sustituye a historyHead ni modifica el SSOT.

Para generar, reconstruir historyHead en scratch desde baseline y artifacts históricos, con verificación de hashes y estado después de cada transición. Contrastar su estructura con el esquema esperado de historyHead. Cualquier divergencia de historia es un error bloqueante. Crear desired desde cero en otro scratch; no deducirlo ejecutando el mismo upgrade que se está verificando.

Para aplicar, adquirir el lock, establecer mantenimiento y comprobar observed contra el head de ESA instalación antes de ejecutar cualquier recurso de upgrade. Comprobar también journal, invariantes y metadatos administrados. Un dato ordinario de usuario diferente de un fixture no constituye drift. Una precondición de datos incumplida, historia incompleta/alterada, estructura desconocida o diferencia del esquema esperado sí bloquea la operación. No preguntar «adoptar lo encontrado» ni generar reparación desde observed.

El diálogo de autoría resuelve ambigüedades de intención, tipos, cardinalidad y pérdidas de datos. No adopta drift de producción como historia válida: el resolver separado puede proponer una preparación verificada para restaurar el head, según sección 13. El mismo programa ofrece comandos de autoría e install/apply; la separación no exige dos productos ni impide que el desarrollador resuelva una migración interactivamente.

Una instalación atrasada recorre artifacts consecutivos desde su head. No generar un atajo distinto para cada DB. Una instalación nueva usa creación desde SSOT; sin SSOT no se permite generar, publicar ni instalar.

## 2. Referencias y contratos de valores

Importar `JsonValue`, `FileInfo`, `ReleaseRefInfo`, `ResourceInfo`, `ResourceRefInfo`, `SystemSnapshotInfo`, `PgObjectIdentity`, `PgSchemaInfo`, `Problem`, `ValidationResult`, `MigrationInfo` y `ReleaseBundle` de los módulos ya especificados. Los tipos de consumidor permanecen fuera del núcleo: StructureChangeInfo, MigrationDraftInfo, CompiledAuthoringInfo y toda interfaz que nombre PgSchema/PgObject/ReleaseBundle se declaran en authoring-contract.ts. Referencias lógicas, ports, TransformationDef/Info y DataMigrationDef/Info sin SQL embebido pertenecen a migration-authoring.ts; no importar tipos PostgreSQL desde src/common.

```ts
export type SnapshotSide = 'from' | 'to';
export type FieldRefInfo = {
    side: SnapshotSide
    entity: string
    field: string
};
export type DomainRefInfo = {
    side: SnapshotSide
    type: string
    nullable: boolean
};
export type PortInfo = {
    domain: DomainRefInfo
    field: FieldRefInfo | null
};
export type MachineValueInfo = {
    domain: DomainRefInfo
    value: string | null
};
export type AuthoringBaseInfo = {
    from: ReleaseRefInfo
    to: ReleaseRefInfo
    fromSnapshotHash: string
    toSnapshotHash: string
    fromPersistenceHash: string
    toPersistenceHash: string
};
export type QueryResourceInfo = {
    kind: 'query'
    file: FileInfo
};
export type QueryRefInfo = {
    name: string
    kind: 'query'
    contentHash: string
};
```

`field` presente deriva domain de los fields completados; el decoder verifica igualdad, no permite dos declaraciones discrepantes. Un port sin field tiene un contrato de dominio explícito, útil para salidas calculadas/constantes. side selecciona el contexto histórico del dominio, no el momento de ejecución de SQL. Campos source se vinculan a from; outputs de negocio se vinculan a to. Una salida intermedia de un paso anterior sólo se usa mediante dependencia y query explícitas, nunca cambiando silenciosamente el significado de from.

Constantes viajan como texto de máquina con dominio, incluyendo null separado. Decodificar con behaviourOf y exigir check; no aceptar JSON number para bigint/decimal ni usar conversión humana. El compilador convierte parámetros a SQL mediante binding o emisor de literales tipados y probado; no interpolar strings del usuario como fragmentos SQL.

No ampliar ResourceRefInfo para fingir que una consulta es un check booleano. QueryRefInfo es una referencia adicional del manifest de autoría. SQL final de escritura sigue usando recursos kind sql y checks existentes siguen exigiendo una fila/booleano ok. El loader tiene decoders por variante y rechaza referencias cruzadas.

## 3. Modelo concreto de datos y transformaciones

```ts
export type SourceSelectionInfo = {
    query: QueryRefInfo
    ports: Readonly<Record<string, PortInfo>>
    identity: readonly string[]
    coverageChecks: readonly ResourceRefInfo[]
};
export type TransformationInfo = {
    name: string
    version: string
    inputs: Readonly<Record<string, PortInfo>>
    parameters: Readonly<Record<string, DomainRefInfo>>
    outputs: Readonly<Record<string, PortInfo>>
    mode: 'row' | 'set'
    query: QueryRefInfo
    lineage: QueryRefInfo | null
    before: readonly ResourceRefInfo[]
    after: readonly ResourceRefInfo[]
};
export type OutputBindingInfo = {
    output: string
    target: FieldRefInfo
};
export type MatchPairInfo = {output: string, targetField: string};
export type WriteInfo =
    | {kind: 'insert', entity: string,
       values: readonly OutputBindingInfo[], key: readonly string[]}
    | {kind: 'update', entity: string,
       values: readonly OutputBindingInfo[], match: readonly MatchPairInfo[],
       whenMissing: 'error' | 'insert'};
export type DataMigrationInfo = {
    id: string
    description: string
    dependsOn: readonly string[]
    source: SourceSelectionInfo
    transformation: string
    arguments: Readonly<Record<string, MachineValueInfo>>
    writes: readonly WriteInfo[]
    conservationChecks: readonly ResourceRefInfo[]
};
```

Todas las estructuras son readonly por API pública, copiadas/normalizadas al completar. Las variantes usan exactitud recursiva. Def permite omitir description (`''`), dependsOn y listas de checks (`[]`); ports, identities, mode, query, writes, keys y políticas de datos son obligatorios. TransformationDef permite omitir lineage sólo cuando mode=row; completa a null. Ningún default decide qué fila se pierde o sobrescribe. whenMissing se exige en update. Un conflicto de insert, o varias filas fuente dirigidas a la misma fila destino, falla; no agregar ignore/lastWins implícitos. Cuando se necesita reconciliación, el autor la expresa en SQL de transformación y sus checks.

`identity` nombra ports que identifican unívocamente cada fila seleccionada. No tiene que ser una sola PK: un join puede necesitar la tupla de claves de ambas entidades. Verificar no-null y unicidad antes de transformar. Sin fuentes, generar una selección de una fila con un port técnico constante para identidad; no inventar filas de negocio ni valores destino. La selección siempre es una query versionada, incluso cuando el wizard la genera desde columnas/joins.

El resultado de la query source tiene exactamente sus ports; las keys de identity son parte del resultado. Un LEFT JOIN vuelve nullable el port correspondiente en la selección aunque el campo histórico sea NOT NULL: registrar esa extensión en el contrato de selección y comprobar que la transformación la admite. PortInfo.field mantiene la referencia original; su domain puede ampliar nullable únicamente para esta operación explícita de selección. En cualquier otro caso debe coincidir con el field completado.

El wizard construye SELECT para tabla única y joins por igualdad declarados. Pide tablas/aliases, pares de columnas, INNER o LEFT, filtro opcional y política para filas sin correspondencia. Si el autor decide excluir filas, registra la selección y sus checks; en cambios destructivos, la partición excluida también necesita resolución de descarte/transferencia. No autocompletar un join basándose sólo en nombres. Consultas complejas, filtros, agregaciones y joins no cubiertos por el asistente admiten SQL explícito con el mismo contrato de salida.

`writes` puede repartir las salidas a varias tablas. Cada binding tiene target.side=to y target.entity=write.entity; rechazar destinos repetidos en una escritura. Campos omitidos de un update conservan sus valores actuales. Campos omitidos de un insert requieren default SQL declarado o null permitido; PK/NOT NULL sin fuente/default produce pregunta pendiente. Generated columns no se escriben. Los defaults con efectos incompatibles con atomicidad se rechazan por las reglas del runner.

`match` debe cubrir una PK/UK completa del destino. Validar todos los pares y su orden; jamás emitir UPDATE FROM con varias coincidencias por destino. whenMissing=insert implica comprobar también que outputs provean todos los campos obligatorios de inserción. Rechazar update que cambie sus propias columnas de match: para cambiar claves, usar SQL explícito con staging, correspondencia before/after y checks de dependencias, conforme sección 8. No inventar una clave sustituta.

## 4. Protocolo SQL de transformación y conservación

El compilador materializa source una vez dentro de la transacción como relación temporal privada. Añade `__source_id` bigint mediante row_number sobre identity; su valor identifica filas dentro de esa ejecución, no es ID de negocio ni dato del artifact. No usar secuencias. Los ports del usuario no pueden usar prefijo `__`.

Las queries de transformación referencian una relación lógica `migration_input` con ports + __source_id y una relación `migration_parameters` de una fila con argumentos tipados. La query se parsea; el compilador sustituye solamente esas referencias de relación mediante AST por nombres temporales propios. No hacer reemplazo textual. Parámetros y nombres citados no se confunden con referencias. Prohibir shadowing de esos nombres mediante CTE/alias que cambie su resolución. Toda otra relación/rutina referenciada debe estar declarada en el contrato de recursos/efectos.

Contrato de salida:

- mode=row: exactamente __source_id y los outputs declarados; una fila por source. Faltantes, duplicados, IDs ajenos o outputs extra fallan. Esto cubre identidad, casts explícitos, combinar/separar columnas y actualizar in-place.
- mode=set: exactamente __output_id text no-null único y los outputs declarados; lineage es obligatorio y produce pares (__source_id bigint, __output_id text). Rechazar pares duplicados/IDs inexistentes. Permite múltiples fuentes por salida y múltiples salidas por fuente. conservationChecks es obligatorio para cambios de cardinalidad y prueba la regla de negocio elegida; la existencia de lineage por sí sola no prueba una agregación correcta.

Una fuente excluida deliberadamente o una salida sin fuentes necesita check explícito que defina ese conjunto; en caso contrario la cobertura exige que toda fuente y salida participe en lineage. Sin fuentes de negocio se usa la fila técnica mencionada en sección 3. Materializar outputs y lineage una vez antes de escribir; conservarlos hasta comprobar escritura y antes de destruir fuentes.

Primero validar los outputs según sus dominios declarados. Después construir/escribir las filas destino completas y validar sus reglas de entidad. Las restricciones que deben retirarse temporalmente se restauran y verifican antes de COMMIT. Comparar, con igualdad sensible a null, cada campo escrito con su output materializado y verificar que las filas fuera de alcance y columnas no escritas se conservan. El compilador toma capturas before de los conjuntos necesarios; no usar sólo rowCount para demostrar conservación.

Los checks automáticos comprueban mecánica de copia/cobertura. El autor provee checks de semántica no inferible (p.ej. cómo redondear un total). La UI distingue esas obligaciones y no presenta una declaración de contrato como prueba de que SQL implementa la intención.

La sintaxis de queries se interpreta con parser PostgreSQL compatible, no regex. Consultas pueden contener CTE/SELECT, pero no DML escondido en CTE ni rutinas de efectos no declarados. Se rechazan efectos no transaccionales conforme contratos generales. Las operaciones de SELECT/CTE se basan en [SELECT de PostgreSQL](https://www.postgresql.org/docs/18/sql-select.html); el protocolo de ports/lineage es diseño de este consumidor.

## 5. Tipos estáticos y firmas del núcleo

No hacer que un JSON runtime prometa nombres literales recuperados. Ofrecer constructor tipado sobre snapshots literales y decoder sobre snapshots amplios. Reutilizar TypeCollection, ExactFieldsOf y el patrón ValidatorNamesFor. Este helper fija la relación entidad/campo que los tests deben preservar:

```ts
export type FieldRefsOf<S extends SystemSnapshotInfo, Side extends SnapshotSide> = {
    [E in keyof S['entities'] & string]: {
        [F in keyof S['entities'][E]['fields'] & string]: {
            side: Side, entity: E, field: F
        }
    }[keyof S['entities'][E]['fields'] & string]
}[keyof S['entities'] & string];

export type AuthoringContext = {
    from: SystemSnapshotInfo
    to: SystemSnapshotInfo
    transformations: Readonly<Record<string, TransformationInfo>>
};

export declare function defineTransformation<const D extends TransformationDef>(
    context: AuthoringContext, def: D & ExactTransformationDef<D>
): D;
export declare function completeTransformation<const D extends TransformationDef>(
    context: AuthoringContext, def: D
): ValidationResult<TransformationInfoOf<D>>;
export declare function defineDataMigration<
    const C extends AuthoringContext, const D extends DataMigrationDef<C>
>(context: C, def: D & ExactDataMigrationDef<C,D> & CompatibleDataMigration<C,D>): D;
export declare function completeDataMigration<
    const C extends AuthoringContext, const D extends DataMigrationDef<C>
>(context: C, def: D): ValidationResult<DataMigrationInfoOf<C,D>>;
export declare function decodeDataMigration(
    context: AuthoringContext, value: unknown
): ValidationResult<DataMigrationInfo>;
```

Def y helpers se implementan con estas reglas exactas, no como aliases permisivos a Info:

1. TransformationDef = TransformationInfo con description inexistente, before/after opcionales y lineage discriminada como sección 3. Sus ports ya están completos: no agregar defaults a nullable. TransformationInfoOf preserva cada literal de D y completa sólo listas/lineage omitidos.
2. DataMigrationDef<C> = DataMigrationInfo con description/dependsOn/conservationChecks opcionales; transformation es keyof C.transformations; referencias de source son FieldRefsOf<C.from,'from'>, de destinos FieldRefsOf<C.to,'to'>. Port técnico sin field se permite con dominio válido. Def de source omite coverageChecks si vacío; Info completa [].
3. ExactTransformationDef/ExactDataMigrationDef aplican el patrón de claves excedentes a cada variante, port, ref, write, match y binding. No usar un index signature para aceptar typos en propiedades; sólo mapas nombrados de ports/argumentos son abiertos.
4. CompatibleDataMigration se calcula para D.transformation concreto: mismas keys de inputs y source.ports, mismas keys de parámetros/arguments, outputs referenciados existentes, destinos válidos, nullability compatible, tipos de dominio compatibles. Un error marca la propiedad correspondiente never, no ensancha el contrato completo. InfoOf preserva ref/ID/tuplas y sólo materializa defaults/copia.
5. Compatibilidad de dominio requiere la misma side/type o contrato idéntico de tipo histórico comprobado por hash. Para tipos diferentes el autor debe declarar una transformación con output del tipo destino; nunca hacer cast implícito de dominios porque ambos sean string. El constructor puede permitir port.domain del destino aunque SQL lea valores del origen: esa conversión es precisamente la transformación explícita.
6. El chequeo de tipos TS de valores de dominio usa los TypeCollection de ambos contextos originales, a través de un adaptador tipado del constructor; después de decodificar artifacts sólo están disponibles contratos runtime. Si un nombre de dominio se conserva pero su comportamiento cambia, los hashes históricos obligan a revalidar. No inferir igualdad de implementaciones desde el nombre.

Tests estáticos: preservar alumno/nombres sin ensanchar a string; typo en field/transform/argument/write; campo de B usado como source A; output nullable hacia target NOT NULL; salida email tratada como texto sin conversión declarada; arrays de PK compuesta; asignabilidad bidireccional de Info completada. Separar tests de aridad de tests de compatibilidad.

## 6. Diferencia, decisiones y borrador

```ts
export type ChangeImpact = 'preserving' | 'requiresDataCheck' | 'destructive' | 'unsupported';
export type StructureChangeInfo = {
    id: string
    action: 'add' | 'remove' | 'alter' | 'rename'
    origin: 'inferred' | 'authored'
    impact: ChangeImpact
    before: PgObjectIdentity | null
    after: PgObjectIdentity | null
    differences: readonly {path: readonly string[], before: JsonValue, after: JsonValue}[]
    affectedFields: readonly FieldRefInfo[]
    dependsOn: readonly string[]
};
export type DestructiveDecisionInfo = {
    changeId: string
    source: FieldRefInfo | null
    partitionCheck: ResourceRefInfo | null
    resolution:
        | {kind: 'discard', reason: string}
        | {kind: 'migrate', dataMigrationId: string, outputs: readonly string[]}
};
export type RenameInfo = {before: FieldRefInfo | {entity: string},
                          after: FieldRefInfo | {entity: string}};
export type PendingQuestionInfo = {
    id: string
    kind: 'rename' | 'dataRequired' | 'destructive' | 'rowMapping' | 'unsupported'
    subjects: readonly string[]
    messageKey: string
};
export type MigrationDraftInfo = {
    formatVersion: 1
    id: string
    base: AuthoringBaseInfo
    revisionHash: string
    renames: readonly RenameInfo[]
    changes: readonly StructureChangeInfo[]
    data: readonly DataMigrationInfo[]
    decisions: readonly DestructiveDecisionInfo[]
    manual: readonly ManualStepInfo[]
    pending: readonly PendingQuestionInfo[]
};
export type AuthoringValidationInfo = {
    contracts: 'valid' | 'invalid' | 'unresolved'
    data: 'notRun' | 'passed' | 'failed'
    revisionHash: string
    questions: readonly PendingQuestionInfo[]
    problems: readonly Problem[]
    reportRefs: readonly string[]
};
```

DestructiveResolutionInfo del documento de autoría se concreta como `{base: AuthoringBaseInfo, decisions: readonly DestructiveDecisionInfo[]}`. Su Def admite omitir reason sólo para migrate, que no tiene ese campo; discard siempre requiere razón no vacía. DataMigrationDef autoriza explícitamente los campos de update; una decisión destructiva adicional corresponde a retirada/reducción de fuentes, no a aprobar dos veces cada UPDATE normal.

source=null se admite para eliminación de objeto sin campos (p.ej. tabla sin columnas); no representa aprobación global. partitionCheck=null significa todas las filas; las particiones explícitas se verifican exhaustivas y disjuntas contra la fuente capturada, no sólo por sus nombres. outputs en migrate no puede estar vacío y debe demostrar correspondencia mediante bindings/lineage/checks. Un descarte selectivo no autoriza pérdidas fuera de la partición.

revisionHash = hash canónico de base, renames, data, decisions, manual y hashes de sus recursos; excluye revisionHash, pending y reportRefs. IDs de cambios se calculan sobre base + operación/identidad/diferencias; los derivados changes/pending se recalculan, no se aceptan del cliente como autoridad. Respuestas llevan revisionHash y questionId, así una pregunta antigua no autoriza un borrador distinto.

Comparar objetos por identidad física después de aplicar renames explícitos. Un rename debe ser biyectivo en su ámbito, el origen existe, destino existe en SSOT nuevo y no produce colisiones; se comparan igualmente los demás atributos. Sin correspondencia explícita, add+remove y resolución destructiva. Distinto label con igual estructura: sin DDL, pero se conserva cambio de snapshot/release.

Matriz de clasificación mínima:

| Cambio | Clasificación y emisión |
| --- | --- |
| Tabla/columna nueva nullable | preserving; CREATE/ADD mediante generador existente |
| Columna NOT NULL nueva con filas potenciales | requiresDataCheck; nullable temporal + relleno explícito o prueba de tabla vacía; después SET NOT NULL |
| DROP tabla/columna | destructive; cobertura por campo antes de DROP RESTRICT |
| Tipo físico idéntico pero nuevo validador | requiresDataCheck sobre todas las filas afectadas; no inventar ALTER |
| Tipo físico diferente | requiresDataCheck; conversión SQL explícita y prueba de conservación, o resolución destructiva si reduce/pierde información |
| Quitar NOT NULL | preserving; DROP NOT NULL, salvo obligación PK/constraint pendiente |
| Agregar NOT NULL/UK/FK/check | requiresDataCheck; comprobar datos y aplicar definición final |
| Cambiar default | ALTER default; no rellenar datos existentes implícitamente |
| Quitar/cambiar clave/índice | Resolver dependencias; reconstruir explícitamente lo requerido por SSOT; no duplicar backing index |
| Vista/rutina modificada | Recurso de creación/reemplazo declarado y dependencias; inspeccionar todos sus atributos |
| Propiedad/objeto fuera de cobertura | unsupported; pregunta/diagnóstico bloqueante, nunca omitido |

No mantener una lista supuestamente universal de casts seguros. Se puede registrar un adaptador probado de conversión preservadora; su nombre/hash/precondiciones se incluyen en el plan. En ausencia de tal adaptador pedir transformación, no elegir truncamiento/redondeo. Las operaciones ALTER corresponden a [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html); la clasificación de riesgo es contrato del producto.

Para un cambio de tipo que requiere transformar valores y conservar fuentes, usar columna temporal del tipo destino: capturar claves/valores originales, añadir temporal nullable, escribir outputs y validarlos, retirar dependencias declaradas, retirar/renombrar columnas para obtener la identidad final y recrear restricciones/índices/vistas afectados. Aplicar defaults/NOT NULL finales después del relleno. No escribir valores del tipo nuevo en una columna que todavía tiene el tipo viejo. Un adaptador puede emitir ALTER TYPE USING directamente sólo si sus checks de conservación usan una captura anterior y la dependencia del objeto está cubierta. Mismos pasos para cambios cíclicos: materializar todos los originales antes de sobrescribir. FKs no generan cascadas de datos implícitas; mantener/probar correspondencia de claves de todas las tablas afectadas.

## 7. Algoritmo de compilación a una migración

Entry points del consumidor, exportados por index.ts e invocados también por CLI:

```ts
export interface AuthoringRuntime {
    loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<ReleaseBundle>>;
    reconstructHistory(head: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>>;
    readQuery(ref: QueryRefInfo): Promise<ValidationResult<string>>;
    inspectDraft(draft: MigrationDraftInfo): Promise<ValidationResult<PgSchemaInfo>>;
}
export declare function inferStructureChanges(
    base: AuthoringBaseInfo, from: PgSchemaInfo, to: PgSchemaInfo,
    renames: readonly RenameInfo[]
): ValidationResult<readonly StructureChangeInfo[]>;
export declare function validateAuthoring(
    draft: MigrationDraftInfo, context: AuthoringContext
): AuthoringValidationInfo;
export declare function compileDraft(
    draft: MigrationDraftInfo, runtime: AuthoringRuntime
): Promise<ValidationResult<CompiledAuthoringInfo>>;
```

`reconstructHistory` y `inspectDraft` usan scratch propiedad del harness. Su contrato incluye liberar scratch en finally y entregar problemas de creación/replay/inspección, nunca devolver un esquema parcial como éxito. La función pura inferStructureChanges recibe estructuras ya validadas y no abre conexiones.

Secuencia obligatoria de compileDraft:

1. Decodificar todo, resolver/verificar hashes de releases, consultas, SQL y módulos de validación. Recalcular revisionHash y validar relaciones. Rechazar pendientes antes de generar artifact publicable.
2. Reconstruir la historia y comprobar from. Cargar desired desde creación SSOT independiente. Aplicar correspondencias explícitas y obtener diff completo.
3. Verificar cobertura destructiva, transformaciones, referencias, joins, políticas de escritura y recursos manuales. Si falta decisión, devolver problemas/preguntas estables; no ejecutar en target.
4. Crear nodos de operación: comprobación/captura de origen, retirada temporal de dependencias, preparación de destinos, selección/materialización, transformaciones, checks, escrituras, validación/conservación, eliminación autorizada de fuentes, restauración de restricciones/objetos y comprobación final.
5. Añadir edges por lectura/escritura/creación/eliminación y por dependsOn explícito. Fuente debe seguir existiendo hasta último lector/check; dependencia debe retirarse antes de modificar su objeto y recrearse después. Toda escritura precede a sus checks, y todo check de preservación precede al DROP correspondiente.
6. Detectar dos escritores sobre mismo campo/conjunto sin orden explícito; producir conflicto. Si se ordenan, el segundo usa valores de origen capturados o resultados anteriores según su query explícita. No cambiar esa elección por optimización.
7. Orden topológico con desempate lexicográfico por ID de operación. Resolver FK circulares creando tablas primero y FK al final. Para ciclos de transferencia materializar todas las fuentes implicadas antes de sobrescribir; si el ciclo restante requiere una decisión semántica, pedirla y bloquear. No confundir ciclo local de operaciones con ramas de releases.
8. Emitir SQL citando identificadores por componente y binding/emisión tipada de valores. Nombres temporales privados derivan de migrationId+operationId; comprobar colisiones y longitud permitida sin truncar IDs silenciosamente. SQL final no usa IF EXISTS para ocultar un estado inesperado.
9. Probar SQL combinado en scratch reconstruido desde historia. Inspeccionar resultado. Recalcular diff residual contra desired tras los efectos manuales para evitar cambios duplicados. Generar las operaciones residuales inferibles y volver a probar. Si residual requiere datos/decisión, volver a pending. No iterar sin límite: cada operación generada debe resolver una diferencia identificada; si reaparece tras replay, error con contraejemplo.
10. Comparación final exactamente contra desired, checks de datos/manifest y cleanup temporal. Publicar sólo mediante verify/publish; compileDraft no constituye por sí solo evidencia de ensayo productivo ni permiso de apply.

Los pasos manuales reemplazan cambios reclamados explícitamente; los demás siguen generándose. La planificación usa sus contratos para ordenar y el replay/inspector para comprobar efectos reales. Un recurso manual que recrea una columna que el SSOT elimina no convierte esa columna en parte válida del destino: genera conflicto final.

## 8. SQL escrito a mano, checkpoints y runner

```ts
export type ManualStepInfo = {
    id: string
    run: ResourceRefInfo
    dependsOn: readonly string[]
    implementsChanges: readonly string[]
    reads: readonly PgObjectIdentity[]
    writes: readonly PgObjectIdentity[]
    destroys: readonly PgObjectIdentity[]
    before: readonly ResourceRefInfo[]
    after: readonly ResourceRefInfo[]
    rowChecks: readonly RowValidationInfo[]
};
export type RowValidationInfo = {
    id: string
    afterStep: string
    side: SnapshotSide
    entity: string
    select: QueryRefInfo
    validatorArtifactHash: string
};
export type CompiledAuthoringInfo = {
    formatVersion: 1
    draftHash: string
    base: AuthoringBaseInfo
    migration: MigrationInfo
    operations: readonly {
        id: string, stepIds: readonly string[], changeIds: readonly string[],
        dataMigrationIds: readonly string[]
    }[]
    decisions: readonly DestructiveDecisionInfo[]
    checkpoints: readonly {
        afterStep: string
        checks: readonly ResourceRefInfo[]
        rows: readonly RowValidationInfo[]
    }[]
    queryResources: Readonly<Record<string, QueryResourceInfo>>
    validationArtifacts: readonly ValidationArtifactInfo[]
};
```

SQL handwritten se registra con `migration add-sql --draft PATH --file PATH --contract PATH`. El contrato identifica cambios implementados, dependencias y efectos, y necesita checks/decisiones igual que SQL generado. Scripts de datos sin cambio de estructura tienen implementsChanges vacío pero writes/checks explícitos. La historia publicada es inmutable; cambiar un manual script publicado requiere nueva transición.

Mantener MigrationInfo.steps `{id,run}`; checkpoints vive en el manifest obligatorio y el runner lo consume después de cada step. Orden en cada checkpoint: checks SQL, consultas de filas + validadores, siguiente step. Los before manuales se ubican en el checkpoint del predecesor o en migration.before si son previos al primer step; para dependencias múltiples insertar un nodo SQL de comprobación de precondiciones con identidad propia antes de run. No ejecutar validadores sólo después del COMMIT ni sólo en CLI.

Los selects de filas deben devolver fila completa en representación de máquina con aliases iguales a campos SSOT. Filas adicionales/columnas faltantes provocan error; filas de alcance vacío se admiten sólo si cobertura de la operación lo demuestra. No admitir un query `WHERE false` como evidencia de que se validó toda la entidad: el compilador genera alcance desde fuentes/escrituras, y el manifest compara el conjunto de claves de row check con el conjunto debido. Cambio de reglas sin cambios de filas exige validar toda la entidad.

La lectura puede usar cursor NO SCROLL sin WITH HOLD dentro de la misma transacción y cerrar en finally; page size es configuración operativa positiva. No confirma lotes. El contrato de cursores se apoya en [DECLARE](https://www.postgresql.org/docs/18/sql-declare.html).

El manifest persistido de migración incluye `authoring: FileInfo`; sus bytes incluyen CompiledAuthoringInfo y hashes transitivos de queries/validadores. El hash de manifest omite sólo su propio migrationHash. El loader verifica stepIds/checkpoints sin duplicados, cobertura exacta de cambios/decisiones, recursos existentes/kind, refs base==migration.from/to y ausencia de checkpoints no usados. MigrationInfo sola no es entrada suficiente de apply: buildMigrationPlan debe resolver este manifest. No introducir un modo legacy sin manifest que eluda U08/U10.

Reglas de AST y manifest reducen efectos no declarados, pero no prueban toda la semántica de funciones SQL arbitrarias. Los recursos de aplicación son código revisado; require contratos/checks de efectos y rechazar capacidades no verificables. No afirmar que un parser demuestra ausencia universal de pérdida de datos.

## 9. Validadores históricos: formato, carga y validación

```ts
export type ValidationArtifactInfo = {
    formatVersion: 1
    side: SnapshotSide
    snapshotHash: string
    entry: FileInfo
    runtime: {nodeVersion: string, abi: 'migration-validation-1'}
    domainContractHashes: Readonly<Record<string, string>>
    entityValidatorNames: Readonly<Record<string, readonly string[]>>
};
export interface ValidationModule {
    abi: 'migration-validation-1';
    snapshotHash: string;
    validatePorts(
        ports: Readonly<Record<string, PortInfo>>,
        values: Readonly<Record<string, string | null>>
    ): readonly Problem[];
    validateEntityRow(
        entity: string, values: Readonly<Record<string, string | null>>
    ): readonly Problem[];
}
```

Build de aplicación exporta un entry `validation.cjs` autónomo que empaqueta sus contextos de tipos/validadores y dependencias transitivas; no resuelve imports del checkout actual. Identificar por SHA-256 bytes exactos. Configuración/runtime Node exacta viene del build reproducible usado por CI, no de un número inventado por el handoff. Error si runtime no satisface el contrato. No prometer aislamiento de código no confiable: son artifacts de aplicación revisados como los scripts SQL.

El módulo se construye usando los contextos históricos reales. Wrapper llama behaviourOf/check/deserialización de máquina, instanceProblems y validateInstance; no reimplementa las reglas. Adaptar fields de completeEntity para PK efectivamente no nullable. validateEntityRow rechaza columnas omitidas antes de instanceProblems porque éste admite ausencias nullable. Todo Problem producido invalida la migración, incluyendo severity regular; regular significa continuar recogiendo errores, no permitir deployment.

SQL de proyección a representación de máquina pertenece al adaptador de tipo físico versionado. Añadir a StorageContext un registro por representación de codecs con expresión SQL de lectura y tipo de transporte. El compilador inserta la columna mediante AST en la expresión, no mediante sustitución de strings. Built-ins obligatorios: text conserva '', integer produce texto decimal inequívoco, boolean true/false, date formato de máquina acordado con fechaBehaviour. No usar el formato de sesión del driver como contrato. Tipos adicionales aportan codec explícito probado ida/vuelta. null viaja como null.

Guardar domainContractHashes calculados sobre comportamiento/codec y dependencias declaradas por tipo; es admisible que una implementación use hash del módulo entero para todos sus tipos (invalida más, nunca menos). Antes de cargar, verificar entry/hash/snapshot/ABI; cargar por ruta física derivada del hash para evitar caché de un módulo distinto con igual nombre. Validar exports en runtime antes de llamar. Ningún nombre de módulo deriva directamente de un campo escrito en CLI sin resolver contra el manifest verificado.

La aplicación suministra el entry build de validación y su build cerrado. El consumidor no intenta serializar closures ni convertir TypeScript en SQL. TypeScript sólo valida; las transformaciones y escrituras se realizan por SQL. Faltan módulo, codec o validador nombrado: error bloqueante con referencia concreta.

## 10. CLI y sesión reproducible

`migration infer --from last --to ./releases/B --draft ./drafts/A-B` resuelve last contra catálogo publicado local, verifica historia, compara con SSOT B y produce reporte de preguntas pendientes, sin abrir stdin. Si se proporciona conexión de desarrollo, antes comprueba drift; sin conexión real usa scratch de historia. Nunca utiliza una DB desconocida para adivinar baseline.

`migration resolve REPORT` abre el diálogo explícito de desarrollo. Orden del diálogo:

1. Mostrar releases y diff por entidad/campo, identificando qué se puede generar.
2. Resolver renames explícitos antes de clasificar add/drop finales.
3. Para cada dato necesario o destructivo, listar campos/tipos y opciones conservar mediante transformación o descartar cuando corresponda. No ofrecer descartar para satisfacer un nuevo NOT NULL: allí se pide valor/transformación o prueba de tabla vacía.
4. Si conserva, invocar el mismo asistente de add-data: fuente/selección, transformación SQL existente o nueva, parámetros, outputs/destinos y correspondencia de filas.
5. Mostrar problemas de tipos, reglas pendientes, conflictos de escritura/dependencias y SQL resultante. Escribir draft y recursos; no ejecutar cambios sobre DB destino.
6. `migration validate` comprueba contratos. `verify` ejecuta checks con datos y genera evidencia. `publish` exige las comprobaciones correspondientes de los contratos generales. `apply` vuelve a comprobar drift y gates sin diálogo de decisiones.

Una query SQL nueva se crea como archivo con contrato de ports y se edita por el desarrollador; el comando acepta `--query PATH --contract PATH`. Si no existe transformación adecuada, la pregunta no inventa SQL de negocio: deja draft pendiente hasta recibir ese recurso. Transformaciones identity y constantes son generables; las demás pueden registrarse y reutilizarse por nombre/version.

Archivo de respuestas:

```json
{
  "formatVersion": 1,
  "draftHash": "<hash calculado del borrador mostrado>",
  "answers": [
    {
      "questionId": "<id de la pregunta>",
      "kind": "destructive",
      "changeId": "<id del cambio>",
      "source": {"side": "from", "entity": "alumnos", "field": "email_anterior"},
      "resolution": {"kind": "migrate", "dataMigrationId": "move-email", "outputs": ["email"]}
    }
  ]
}
```

Los placeholders del ejemplo se sustituyen por IDs reales emitidos; no son valores aceptados por decoder. `--non-interactive --answers PATH` aplica respuestas en una transacción de edición local contra draftHash; duplicados/conflictos/obsoletos fallan sin modificar draft. Recalcular preguntas/hash después del lote. Guardar archivos temporales y reemplazar el draft atómicamente, sin sobrescribir artifacts publicados. Cancelación/EOF conserva borrador pendiente, retorna no cero y no deja un artifact publicable parcial.

Forma de salida JSON estable: `{ok, command, draftPath, revisionHash, validation, questions, problems, files}`. validation es AuthoringValidationInfo; files enumera rutas/hash de recursos generados. Nunca incluir datos de filas ni credenciales por defecto. Contratos válidos con data=notRun pueden devolver éxito para `migration validate`, pero ese resultado no es VerificationRunInfo ni habilita gates. Preguntas pendientes, drift o errores retornan no cero conforme tabla general de códigos.

## 11. Ejemplo completo: conservar email y retirar origen

La versión ejecutable y comentada de este ejemplo vive en `consumers/postgres-migrations/fixtures/authoring-email/index.ts`. No replica JSON a mano: define ambos SSOT, captura snapshots, proyecta PostgreSQL, infiere cambios, construye la selección de origen, completa transformación/data migration, valida las decisiones destructivas y ejecuta `compileDraft` con un runtime en memoria. El test de integración de autoría importa ese fixture y exige que compile correctamente.

Fixture histórico nuevo, separado de aida-email existente: A.alumnos tiene alumno PK, nombres obligatorio, email_anterior nullable y nota_legacy nullable. B mantiene alumno/nombres y tiene email nullable; elimina email_anterior y nota_legacy. El autor identifica email_anterior→email como transferencia (si lo declara rename, probar ese camino por separado) y acepta descarte de nota_legacy.

Source query devuelve ports alumno y email_anterior, identity=[alumno]. SQL de transformación mode=row:

```sql
SELECT i.__source_id, i.alumno, i.email_anterior AS email
FROM migration_input AS i;
```

Contrato inputs: alumno y email_anterior con tipos/nullability de A. Outputs: alumno y email con tipos/nullability de B. Escritura update a alumnos, match alumno→alumno, values email→B.alumnos.email, whenMissing=error. Sin argumentos. Decisiones: migrate email_anterior vía move-email/output email; discard nota_legacy con razón explícita del fixture. El compilador verifica que alumno no se modifica, crea email temporalmente compatible y conserva las fuentes hasta comprobar copia.

SQL lógico resultante (los nombres reales temporales los emite el compilador y los checks/validadores se intercalan por checkpoints):

```sql
ALTER TABLE app.alumnos ADD COLUMN email text;
CREATE TEMP TABLE migration_input_example ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY alumno) AS __source_id,
         alumno, email_anterior FROM app.alumnos;
CREATE TEMP TABLE migration_output_example ON COMMIT DROP AS
  SELECT __source_id, alumno, email_anterior AS email FROM migration_input_example;
UPDATE app.alumnos AS a SET email = o.email
  FROM migration_output_example AS o WHERE a.alumno = o.alumno;
```

Antes de escribir: source identities únicas/no-null, una salida por source, ports válidos y match sin ambigüedad. Después: filas completas validadas y conservación:

```sql
SELECT NOT EXISTS (
  SELECT 1 FROM migration_output_example AS o
  LEFT JOIN app.alumnos AS a ON a.alumno = o.alumno
  WHERE a.alumno IS NULL OR a.email IS DISTINCT FROM o.email
) AS ok;
```

Sólo después de esos checkpoints:

```sql
ALTER TABLE app.alumnos DROP COLUMN email_anterior RESTRICT;
ALTER TABLE app.alumnos DROP COLUMN nota_legacy RESTRICT;
```

El runner finalmente comprueba esquema SSOT B, datos/invariantes y confirma historial/head. Todo ocurre en su transacción. Fixtures con email null, vacío y valor no vacío comprueban que la transferencia no los confunde; agregar un caso inválido según el dominio real que rechace su validador. No cambiar el dominio de Aida para hacer pasar una fixture: si vacío no es válido para email, debe fallar y preservarse A por rollback.

Variante manual: registrar SQL de copia con implementsChanges y checks; el inferidor genera ADD/DROP que faltan y no duplica los que el manual ya implementó. Variante negativa: manual agrega columna no presente en B o omite conservación; no se publica, aunque el script termine sin error.

## 12. Matriz de aceptación y mapa de trabajo

| Test nuevo | Entrada/acción | Resultado exigido |
| --- | --- | --- |
| history-replay | Última migración no produce su esquema registrado | inference bloqueada antes de preguntas de pérdida |
| ssot-required | Script manual sin SSOT destino | publicación rechazada |
| drift-before-apply | DB tiene columna extra/faltante respecto de su propio head | cero recursos de upgrade y cero activaciones |
| older-installation | Catálogo termina C, DB está A y no tiene drift | plan A→B→C; no comparar A contra C antes de aplicar |
| generated-only | ADD nullable inferido | SQL generado llega exactamente a SSOT B |
| mixed-authoring | Manual implementa parte del diff | generar sólo residual; la comparación final sigue obligatoria |
| manual-conflict | Manual contradice B o escribe fuera del scope | error; no cambiar SSOT ni aceptar observed como referencia |
| data-only | Mismo esquema, outputs transformados | transición nueva, conservación comprobada, validators ejecutados |
| missing-policy | Join ambiguo, NULL→NOT NULL o decisión DROP ausente | preguntas concretas; sin artifact publicable |
| row-protocol | __source_id duplicado/ajeno/faltante | error antes de escritura |
| set-protocol | Lineage huérfano/duplicado o agregado incorrecto | error de cobertura/check de negocio |
| duplicate-target | Dos sources escriben misma PK destino | error antes de UPDATE; sin last-wins |
| missing-target | whenMissing error con fila ausente | rollback; whenMissing insert explícito crea fila completa validada |
| immutable-validator | Mismos nombres con bytes distintos | hash/evidencia inválidos; módulo histórico anterior sigue reproducible |
| regular-problem | TypeScript devuelve Problem regular | rollback y deployment bloqueado |
| source-destruction | Check de copia falla antes del DROP | fuente conservada; cero activaciones |
| late-failure | Error tras DROP y antes del COMMIT | restaurados datos/estructura/head |
| source-cycle | A→B y B→A in-place | staging conserva ambos originales; sin cascada de sobrescrituras |
| stale-answer | answers de otro draftHash | ningún cambio al borrador |
| noninteractive | Pregunta pendiente sin stdin | salida no cero inmediata con preguntas serializadas |

T18 implementa secciones 1,6,7 y los tests de historia/diff/drift. T19 implementa 2–5,10 y tests de tipos/protocolo/CLI. T20 implementa 4,8,9 y tests de validadores/conservación. T21 integra decisiones, manual scripts y dependencias. T22 integra hashes/checkpoints/gates, ejemplo de sección 11 y toda la matriz con PostgreSQL real. Ninguna tarea queda satisfecha por un mock que devuelva el esquema esperado sin ejecutar SQL.

Archivos adicionales exactos del consumidor: `authoring-contract.ts` (tipos SQL/manifest), `source-selection.ts` (wizard/query), `compile-data.ts` (materialización/escrituras/checkpoints), `validation-artifact.ts` (build manifest/loader), `authoring-cli.ts` (diálogo/answers). Reutilizar infer.ts, authoring.ts, data-validation.ts y runner ya enumerados; no crear otro pipeline de ejecución. Tests correspondientes `authoring-contract-test.ts`, `infer-test.ts`, `compile-data-test.ts`, `validation-artifact-test.ts`, `authoring-cli-test.ts` e integración en `authoring-integration-test.ts`.

Este documento fija las decisiones de producto y los comportamientos observables. El implementador conserva responsabilidad de compilar helpers, implementar adaptadores y demostrar oráculos. Si una firma necesita ajuste mecánico, documentarlo sin cambiar semántica; no afirmar que estas declaraciones ya fueron compiladas o probadas con otro modelo.

## 13. Reportes y resolución separada de conflictos

El comando infer siempre intenta producir el upgrade hacia SSOT. Si encuentra una decisión pendiente, conserva draft, genera reporte y sale no cero. install/apply/verify/deployment-gate también producen reportes de fallo, nunca preguntas, incluso con TTY disponible. El ejecutable no cambia esa regla por detectar que un usuario lo llamó a mano. Sólo los subcomandos de autoría explícitos como resolve/add-data solicitan respuestas.

```ts
export type ConflictKind =
    | 'authoringDecision' | 'targetData' | 'schemaDrift'
    | 'historyIntegrity' | 'artifactIntegrity' | 'operational' | 'commitUnknown';
export type ConflictReportInfo = {
    formatVersion: 1
    reportId: string
    reportHash: string
    command: string
    kind: ConflictKind
    phase: string
    systemId: string
    draftHash: string | null
    installationId: string | null
    attemptId: string | null
    confirmedHead: ReleaseRefInfo | null
    requestedTarget: ReleaseRefInfo | null
    planHash: string | null
    observedSchemaHash: string | null
    historyHash: string | null
    questions: readonly PendingQuestionInfo[]
    problems: readonly Problem[]
    evidenceRefs: readonly FileInfo[]
};
export type ResolutionResultInfo =
    | {kind: 'draftUpdated', reportHash: string, draft: MigrationDraftInfo}
    | {kind: 'preparation', reportHash: string, artifact: PreparationArtifactInfo}
    | {kind: 'retryEligibleForVerification', reportHash: string, head: ReleaseRefInfo}
    | {kind: 'blocked', reportHash: string, problems: readonly Problem[]};
```

reportHash cubre JSON canónico salvo su propio campo. Incluye artefactos/referencias exactas; no contiene credenciales ni filas completas. Es diagnóstico, no evidencia autorizante. Una ejecución puede producir varios reportes cuando hay varias clases de fallo; no perder causas al elegir un único kind. El JSON principal enumera sus refs y el código de salida sigue siendo no cero.

requestedTarget=null se admite para una entrada inválida o SSOT ausente; no autoriza resolver hacia un destino inventado. Solicitar/cargar SSOT válido y producir un nuevo reporte ligado a esa referencia antes de generar artifacts.

Un reporte de error capturado durante SQL describe el punto de fallo, pero confirmedHead/observedSchemaHash se obtienen después de ROLLBACK y reconciliación. Si no se puede conectar/reconciliar, confirmedHead es null y kind=commitUnknown. No inventar que todos los cambios de una cadena se revirtieron.

El resolver valida origen/integridad de artifacts referenciados y relee estado actual, sin tomar decisiones basándose sólo en un reporte viejo. Diferencia de draft, head, historia, esquema o datos relevantes genera un reporte nuevo; las respuestas previas no se aplican por aproximación.

| Clase de conflicto | Acción del resolver |
| --- | --- |
| authoringDecision sobre draft | Preguntar las decisiones pendientes, actualizar draft mediante respuestas versionadas, volver a inferir/generar/validar |
| targetData con estado origen confirmado | Preguntar transformación/selección necesaria; si draft sigue sin publicar puede corregirlo; si SQL publicado está fijo, producir preparación de datos previa al retry |
| schemaDrift | Mostrar comparación contra SSOT del head confirmado; producir propuesta explícita para restaurar ese estado, con decisiones sobre datos afectados; no cambiar el head para adoptar drift |
| historyIntegrity/artifactIntegrity | Bloquear hasta recuperar artifacts/historia auténticos; no fabricar hashes/journal ni producir SQL que marque éxito |
| operational | Diagnóstico y corrección de configuración por el operador; no inventar migración de datos; después revalidar antes de retry |
| commitUnknown | Sólo reconciliación read-only de journal/head; hasta resolverla no generar ni ejecutar corrección |

`retryEligibleForVerification` no autoriza apply: indica que el diagnóstico ya permite repetir verificación con el estado/plan actual. Un report resuelto no se convierte en un recibo passed.

### 13.1 Preparación sin modificar historia publicada

Una migración publicada no se edita, y una preparación no se introduce como rama ni como arista retroactiva del catálogo. Es un artifact correctivo ligado a una instalación y su head actual, que restaura el estado requerido por esa release o prepara sus datos para cumplir las precondiciones del upgrade. Su ejecución no avanza head; queda auditada aparte. Esta es la concreción técnica de resolver fallos de aplicación conservando U05/U06, no una autorización para omitir SSOT.

```ts
export type PreparationArtifactInfo = {
    formatVersion: 1
    id: string
    artifactHash: string
    reportHash: string
    installationId: string
    head: ReleaseRefInfo
    historyHash: string
    observedSchemaHash: string
    inputFingerprint: string
    requestedPlanHash: string
    steps: readonly {id: string, run: ResourceRefInfo}[]
    before: readonly ResourceRefInfo[]
    after: readonly ResourceRefInfo[]
    checkpoints: CompiledAuthoringInfo['checkpoints']
    decisions: readonly DestructiveDecisionInfo[]
    resources: Readonly<Record<string, ResourceInfo>>
    queryResources: CompiledAuthoringInfo['queryResources']
    validationArtifacts: CompiledAuthoringInfo['validationArtifacts']
    inputCapture: readonly SourceSelectionInfo[]
    expectedSchemaHash: string
};
export type PreparationReceiptInfo = {
    preparationId: string
    artifactHash: string
    installationId: string
    head: ReleaseRefInfo
    inputFingerprint: string
    status: 'passed' | 'failed' | 'incomplete'
    checks: readonly {id: string, report: FileInfo, passed: boolean}[]
};
```

artifactHash incluye todos los campos salvo sí mismo y cierra sobre recursos/queries/módulos usados por checkpoints. expectedSchemaHash debe ser el schemaHash de head. El decoder verifica esa igualdad. inputFingerprint es hash canónico de los datos que leen/escriben/checkean los recursos, capturados por inputCapture con claves/orden/codecs y cobertura comprobable. Sus queries están en queryResources; checks en resources. La verificación comprueba que cubren el alcance completo de efectos. Si no puede acotarse ese alcance, capturar todo el scope afectado o bloquear; no usar un conteo de filas como fingerprint.

La preparación usa selección, transformaciones SQL, validadores, decisiones de conservación y runner transaccional ya descritos. Correcciones de drift conservan/eliminan datos sólo mediante decisiones expresas. Campos ajenos al SSOT histórico no tienen tipos de dominio inferibles: pedir contrato de entrada y SQL explícito, o dejar bloqueado. No asumir que toda columna extra es descartable. La propuesta siempre apunta al head confirmado, nunca convierte observed en baseline.

Comandos:

```text
migration resolve reports/failure.json --out resolutions/fix-source
migration verify-resolution resolutions/fix-source --copy COPY_REFERENCE
migration apply-resolution resolutions/fix-source --installation INSTALLATION_ID
verify --plan ORIGINAL_PLAN --installation INSTALLATION_ID
apply --plan ORIGINAL_PLAN --installation INSTALLATION_ID
```

Las rutas/IDs del ejemplo se concretan por la aplicación; opciones de conexiones y mantenimiento siguen los contratos generales. resolve no ejecuta la preparación. verify-resolution usa copia aislada identificada del estado fallido; en producción es obligatoria. También ensaya preparación + segmento de upgrade requerido, sin activar aplicación. Su recibo es distinto de VerificationRunInfo y jamás habilita deployment. apply-resolution es explícito y no interactivo, exige recibo completo/passed exacto y precondiciones actuales idénticas.

Ejecución de apply-resolution:

1. Verificar artifacts/recibo, lock de instalación y mantenimiento. Reconciliar cualquier commit ambiguo pendiente; comprobar head/historyHash y fingerprints actuales. Observed debe coincidir exactamente con el estado inicial autorizado, aunque éste tenga el drift documentado: esta excepción sólo existe para la preparación verificada, nunca para apply normal.
2. Abrir una transacción en el mismo motor interno; ejecutar before, SQL y checkpoints. Si cualquier dato cambió respecto del fingerprint, fallar antes de escribir y regenerar/reverificar la resolución.
3. Comprobar esquema final igual a head, invariantes/reglas requeridas y after; escribir registro de preparación exitosa en el journal dentro de la misma transacción. Head e historia de migraciones permanecen idénticos.
4. COMMIT. Fallo revierte todo y registra intento fuera de la transacción; commit ambiguo usa el mismo protocolo de reconciliación por preparationId/artifactHash, sin repetir escrituras a ciegas.
5. Invalidar readiness/evidencia de deployment previa y mantener mantenimiento. Repetir verify y gates del upgrade con estado corregido y nuevo binding; no activar aplicación por el éxito de la preparación.

Journal agrega `preparation_attempts` y `preparations` (éxitos confirmados), con installationId, ordinal monotónico, preparationId único, artifactHash, head, fingerprints antes/después, timestamps y refs de reportes. Un segundo intento del mismo artifact confirmado es no-op verificado, no reejecución. No reconocer éxito sólo porque el estado actual parece correcto: exige registro confirmado y hashes.

El configurationHash del DeploymentBindingInfo incorpora `preparationHistoryHash`, hash canónico de la lista ordenada de preparaciones confirmadas de esa instalación (lista vacía tiene hash canónico definido). Así cualquier corrección invalida evidencia anterior sin cambiar las firmas del binding. El pipeline vuelve a reservar/actualizar su binding por los mecanismos existentes; un reporte o recibo viejo nunca autoriza después de la preparación.

Si ningún cambio puede mantener el SSOT del head y hacer viable el upgrade publicado, devolver blocked con el contraejemplo. No toda contradicción tiene arreglo automático: resolver puede requerir datos correctos suministrados por el desarrollador. No editar una migración ya publicada ni declarar compatibilidad inventada para salir del bloqueo. Corregir la lógica de una transición aún no publicada sí produce un draft nuevo verificable.

### 13.2 Contratos del comando y tests T23

```ts
export type ResolutionStateInfo = {
    installationId: string
    confirmedHead: ReleaseRefInfo | null
    historyHash: string
    observedSchema: PgSchemaInfo
    unknownCommit: boolean
};
export interface ResolutionRuntime extends AuthoringRuntime {
    inspectInstallation(id: string): Promise<ValidationResult<ResolutionStateInfo>>;
    fingerprintInputs(
        installationId: string,
        selections: readonly SourceSelectionInfo[]
    ): Promise<ValidationResult<string>>;
}
export declare function resolveConflict(
    report: ConflictReportInfo,
    answers: unknown,
    runtime: ResolutionRuntime
): Promise<ValidationResult<ResolutionResultInfo>>;
```

El adaptador CLI recoge respuestas o carga archivo; la biblioteca no abre stdin. ResolutionRuntime sólo expone lecturas de instalación/journal/fingerprints; el loader de consultas verifica manifiestos y ejecuta las lecturas del resolver en transacción read-only. La CLI materializa los artifacts locales retornados mediante artifact.ts. Esos métodos no exponen ejecutar SQL de escritura en target al resolver. Verificación/aplicación de preparación usa el ConsumerRuntime y motor compartido en comandos separados. blocked se informa con salida no cero aunque sea un ResolutionResultInfo válido como diagnóstico.

Archivos nuevos: `conflict-report.ts` (tipos/decoder/producer), `resolve-conflict.ts` (clasificación/edición de draft/propuesta), `preparation.ts` (artifact/verify/apply sobre motor compartido). Integrar CLI y journal existentes; no crear otro runner ni otra implementación de locks/transacciones.

Tests T23 obligatorios:

- infer con destrucción pendiente produce reporte y cero lecturas de stdin; resolve consume ese reporte y sí pregunta.
- apply/install/verify/gate con TTY fallan sin prompt; el proceso termina con reporte y cero activaciones.
- fallo de C después de éxito B reporta head B; resolución ligada a A se rechaza.
- reporte obsoleto/alterado o respuestas para otro draft no modifica archivos/DB.
- resolver nunca llama a query de escritura contra target.
- SQL publicado/hash/historia idénticos antes y después de resolver/preparar.
- preparación de datos pasa ensayo y cumple precondiciones; retry usa el mismo artifact original y nueva evidencia.
- preparación de drift restaura SSOT de head y conserva datos indicados; columna extra con datos sin decisión bloquea.
- preparación termina con esquema diferente del head, check fallido, fingerprint cambiado o recibo incompleto: rollback/cero deploy.
- commit ambiguo de preparación reconciliado por journal; no duplicar transformaciones.
- preparación exitosa invalida evidencia anterior mediante preparationHistoryHash y no completa mantenimiento ni activa aplicación.
- fallo irreparable de SQL publicado informa blocked; no añade rama de release ni modifica historia para fingir solución.
