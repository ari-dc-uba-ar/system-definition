# Contratos y pruebas del handoff de migraciones

Este anexo precisa las APIs nuevas de [la especificación](implementacion-migraciones.md), conforme a las decisiones U01–U11 registradas en [trazabilidad](migraciones-trazabilidad.md). [Autoría](migraciones-autoria.md) y [sus contratos detallados](migraciones-autoria-contratos.md) añaden inferencia, transformaciones SQL y resolución separada de conflictos, y los compilan a las MigrationInfo de este anexo. El código actual conserva autoridad para los símbolos existentes. Las interfaces nuevas son contratos de implementación; deben pasar pruebas de tipos/runtime antes de considerarse implementadas.

## 1. Invariantes que no son parámetros configurables

- Backend elegido: PostgreSQL **18.6**, `server_version_num = 180006`.
- Consumidor separado del núcleo, en `consumers/postgres-migrations` como elección de layout.
- Releases en secuencia lineal; exactamente una migración entre cada par consecutivo.
- Todas las escrituras de aplicación detenidas/drenadas durante la operación.
- Una transacción controlada por el runner por migración, incluyendo before/steps/after/postcondiciones/head.
- Verificación fallida, incompleta, ausente o no correspondiente al candidato bloquea apply y deployment.
- Scripts explícitos, históricos y verificados, generados desde SSOT o escritos por el autor durante desarrollo. No se generan upgrades al vuelo durante deployment.
- Las tres categorías U08 son obligatorias; resoluciones destructivas incompletas y validaciones de datos fallidas bloquean publicación/aplicación según la etapa, y nunca habilitan deployment.
- U09–U11: transformar mediante SQL, validar con comportamientos existentes, exigir SSOT/historia y fallar ante drift. Deployment no pregunta; migration resolve consume reportes fuera del deploy.

No exponer opciones `transaction:false`, `online`, `via`, `reverse`, `force` o `skipVerification`. Incluirlas como APIs opcionales volvería a introducir las alternativas no elegidas por el usuario.

La instalación entrega `lockWaitTimeoutMs`, `statementTimeoutMs` y `lockTimeoutMs` como enteros positivos. No hay valores numéricos implícitos elegidos por el asistente ni retry automático. Cambiar esos límites de operación produce un nuevo binding de intento y queda auditado; no modifica scripts publicados.

## 2. Tipos comunes y snapshot

Importar los símbolos reales desde sus módulos propietarios dentro del núcleo; el consumidor importa de `system-definition`. Reutilizar `ValidationResult`, `Problem`, `EntityInfoOf`, `RecordInfoOf`, `RecordDef`, `EntityDef`, `SystemEntityContext`, `TypeCollection` y `AnyEntityDef`.

```ts
export type JsonValue =
    | null | boolean | number | string
    | readonly JsonValue[]
    | {readonly [key: string]: JsonValue};

export type FileInfo = {
    path: string
    contentHash: string
    byteLength: number
};

export type ReleaseRefInfo = {
    systemId: string
    releaseId: string
    releaseHash: string
};

export type ResourceRefInfo = {
    name: string
    kind: 'sql' | 'check'
    contentHash: string
};

export type SnapshotFieldInfo = {
    readonly [key: string]: JsonValue
    name: string
    type: string
    nullable: boolean
};

export type SnapshotEntityInfo = {
    name: string
    record: string
    fields: Readonly<Record<string, SnapshotFieldInfo>>
    pk: readonly string[]
    uks: Readonly<Record<string, readonly string[]>>
    fks: Readonly<Record<string, {
        entity: string
        fields: Readonly<Record<string, string>>
    }>>
    validators: readonly string[]
};

export type SystemSnapshotInfo = {
    formatVersion: 1
    systemId: string
    typeNames: readonly string[]
    entities: Readonly<Record<string, SnapshotEntityInfo>>
    records: Readonly<Record<string, Readonly<Record<string, SnapshotFieldInfo>>>>
};
```

Estos tipos amplios son la salida de decoders. La captura tipada conserva relaciones concretas:

```text
TContext extends SystemEntityContext
TInput.systemId extends string
TInput.entities extends Record<string, EntityDef<TContext>>
TInput.records, cuando existe, extends Record<string, RecordDef<TContext>>

SystemSnapshotInfoOf<TContext,TInput>.entities[E]
  = EntityInfoOf<TContext,TInput.entities[E]>
SystemSnapshotInfoOf<TContext,TInput>.records[R]
  = RecordInfoOf<TContext,TInput.records[R]>
```

Si `records` no está en input, su tipo y valor completados son `{}`. Resolver con conditional types, sin defaults genéricos silenciosos. `formatVersion` queda literal 1 y `systemId` conserva su literal cuando existe. No ensanchar TEntities antes de mapear.

Firmas:

```text
toJsonValue(value: unknown): ValidationResult<JsonValue>
canonicalJson(value: JsonValue): string
captureSystemSnapshot(context, input): ValidationResult<SystemSnapshotInfoOf<...>>
decodeSystemSnapshot(value: unknown): ValidationResult<SystemSnapshotInfo>
```

Los límites de tipos no garantizan JSON válido en runtime: validar/copyar antes de devolver éxito. En `canonicalJson`, entrada externa inválida por cast/JS arroja TypeError; no ejecutar getters. Repetir la validación en boundaries, no parsear JSON con un cast.

## 3. Persistencia

```ts
export type PersistenceContext = {
    types: TypeCollection
    entities: Readonly<Record<string, AnyEntityDef>>
};

export type PersistenceDef<TContext extends PersistenceContext> = {
    entities: readonly (keyof TContext['entities'] & string)[]
    representations: Readonly<Record<string,
        Readonly<Record<keyof TContext['types'] & string, string>>>>
};

export type PersistenceInfo = {
    entities: readonly string[]
    representations: Readonly<Record<string, Readonly<Record<string, string>>>>
};
```

`definePersistence(context, def)` devuelve el tipo exacto de Def. Usar mapped types de exactitud para no aceptar keys de tipos sobrantes y para exigir todas las keys por representación. El tipo genérico de Info conserva keys/mappings concretos; no retornar siempre la forma amplia de arriba.

`completePersistence(context,def)` devuelve `ValidationResult<PersistenceInfoOf<...>>`, ordena selección, rechaza duplicados y valida closure de FK. `decodePersistence(value,snapshot)` produce la forma amplia después de validar nombres/tipos existentes.

Las adiciones SQL de creación pertenecen al consumidor, con el contrato siguiente; no se agregan propiedades arbitrarias a FieldDef.

```ts
export type CreateResourceInfo = {
    id: string
    run: ResourceRefInfo
    dependsOn: readonly string[]
    expectedObjects: readonly PgObjectIdentity[]
};
```

Los recursos se ejecutan en orden topológico con desempate por ID estable. `expectedObjects` enumera los objetos que el autor pretende crear; comprobar su existencia/kind y cubrir sus atributos vía inspector. No publicar un artifact con objetos extras inadvertidos o dependencias cíclicas.

## 4. Recursos y migraciones

```ts
export type ResourceInfo = {
    kind: 'sql' | 'check'
    file: FileInfo
};

export type MigrationContext = {
    releases: Readonly<Record<string, ReleaseRefInfo>>
    resources: Readonly<Record<string, ResourceInfo>>
};

export type ResourceNamesFor<
    TContext extends MigrationContext,
    TKind extends ResourceInfo['kind']
> = {
    [N in keyof TContext['resources']]:
        TContext['resources'][N]['kind'] extends TKind ? N : never
}[keyof TContext['resources']] & string;

export type MigrationDef<TContext extends MigrationContext> = {
    id: string
    from: keyof TContext['releases'] & string
    to: keyof TContext['releases'] & string
    description?: string
    before?: readonly ResourceNamesFor<TContext, 'check'>[]
    steps: readonly {
        id: string
        run: ResourceNamesFor<TContext, 'sql'>
    }[]
    after?: readonly ResourceNamesFor<TContext, 'check'>[]
};

export type MigrationInfo = {
    id: string
    from: ReleaseRefInfo
    to: ReleaseRefInfo
    description: string
    before: readonly ResourceRefInfo[]
    steps: readonly {id: string, run: ResourceRefInfo}[]
    after: readonly ResourceRefInfo[]
};
```

En Info tipada preservar kind exacto: before/after son check, steps.run es sql. `ResourceRefInfo` amplio sirve al formato persistido, pero su decoder verifica kind según posición. `MigrationInfoOf<C,D>` preserva `D.id`, IDs de pasos y nombres de recursos, y resuelve extremos a `C.releases[D.from/to]`. Si before/after están ausentes, su tipo es `readonly []`; description omitida completa a literal `''`.

`defineMigration` usa parámetros const como `defineEntity`; def exacta con chequeo recursivo de propiedades extras por variante/step. `completeMigration` produce copia validada. `defineMigrations` chequea key→id como `ValidatedEntities`; la secuencia de catálogo impone después la relación entre extremos consecutivos.

Un SQL resource puede contener varios statements; el loader los reconoce mediante parser de PostgreSQL sin reescribir su semántica. Mantener el orden del archivo y rechazar control de transacción propio, comandos no transaccionales conocidos o efectos incompatibles. El validador del recurso sigue siendo comportamiento del consumidor, no función incrustada en la Def.

Firmas del núcleo:

```text
defineMigration(context, def): tipo literal de def
completeMigration(context, def): ValidationResult<MigrationInfoOf<context,def>>
defineMigrations(context, defs): tipo literal del mapa
decodeMigration(value, context): ValidationResult<MigrationInfo>
```

## 5. Catálogo y plan lineal

```ts
export type PublishedMigrationInfo = {
    migration: MigrationInfo
    migrationHash: string
};

export type MigrationCatalogInfo = {
    systemId: string
    releases: readonly ReleaseRefInfo[]
    migrations: readonly PublishedMigrationInfo[]
};

export type MigrationPlanInfo = {
    formatVersion: 1
    from: ReleaseRefInfo
    to: ReleaseRefInfo
    migrations: readonly PublishedMigrationInfo[]
    planHash: string
};
```

Invariante: `migrations.length === max(0,releases.length-1)`; catálogo vacío es inválido; migración i une release i→i+1. Rechazar IDs repetidos de release/migración, sistema discordante, hashes mal formados, gaps, forks, reorder histórico o self edge.

`completeMigrationCatalog(releases,migrations)` valida el formato y las relaciones. El consumidor verifica además inmutabilidad frente a artifacts/historia publicados; un catálogo JSON aislado no puede probar que nunca se editó el pasado.

`resolveMigrationPath(catalog,fromId,toId)` es función pura y retorna el segmento ordenado sin hash. `buildMigrationPlan(path,artifactContext)` en consumidor verifica bytes/recursos y calcula `planHash`. Esta separación evita importar SHA-256 o filesystem en `src/common`.

El plan vacío de una instalación ya actualizada conserva from/to exactos. No exime al runner/gate de validar archivos, estado real y candidato de aplicación.

## 6. Release manifest y entorno

```ts
export type EnvironmentInfo = {
    engine: 'postgresql'
    version: '18.6'
    serverVersionNum: 180006
    encoding: string
    collations: Readonly<Record<string, string>>
    externalDependencies: Readonly<Record<string, string>>
};

export type ManagedDataInfo = {
    table: {schema: string, name: string}
    key: readonly string[]
    columns: readonly string[]
    rows: readonly Readonly<Record<string, string | null>>[]
};

export type ReleaseManifestInfo = {
    formatVersion: 1
    release: ReleaseRefInfo
    snapshot: FileInfo
    snapshotHash: string
    persistence: FileInfo
    schema: FileInfo
    schemaHash: string
    createPlan: FileInfo
    resources: Readonly<Record<string, ResourceInfo>>
    invariantChecks: readonly ResourceRefInfo[]
    managedData: readonly ManagedDataInfo[]
    environment: EnvironmentInfo
    generator: {name: string, version: string, contentHash: string}
    inspector: {name: string, version: string, contentHash: string}
};
```

Para calcular `releaseHash`, quitar únicamente `release.releaseHash` del contenido hashable; no quitar IDs, paths, recursos o configuración semántica. El decoder verifica algoritmo/formato y vuelve a calcularlo. `FileInfo.contentHash` se refiere a bytes exactos; snapshotHash/schemaHash a JSON canónico. No confundir ambos.

`ManagedDataInfo.rows` usa codecs de máquina declarados para los tipos de columna; null y string vacío siguen distintos. `columns` incluye claves; su conjunto debe existir en la tabla. El checker compara esas filas/columnas, exige unicidad de keys y no toca filas ajenas. El plan de creación carga los valores mediante recursos o inserts generados validados; el upgrade los modifica con scripts explícitos.

Una representación PostgreSQL del tipo define cómo sus valores de DB se decodifican al dominio. Reutilizar TypeBehaviour cuando su contrato coincide. Nunca convertir bigint/decimal a number para comparar ni usar parseRecord si colapsa string vacío a null. Las dependencias de codecs históricos se preservan como parte del bundle de consumidor/aplicación identificado por hash.

## 7. Inspección PostgreSQL y diferencias

```ts
export type PgObjectIdentity = {
    schema: string
    kind: string
    name: string
    parentName: string | null
    signature: readonly string[]
};

export type PgTypeInfo = {
    schema: string
    name: string
    modifiers: readonly string[]
    arrayDimensions: number
    collation: string | null
};

export type PgObjectInfo =
    | {kind: 'table', identity: PgObjectIdentity, persistence: string,
       relationKind: string}
    | {kind: 'column', identity: PgObjectIdentity, type: PgTypeInfo,
       nullable: boolean, defaultExpression: string | null,
       identityDefinition: string | null, generatedDefinition: string | null}
    | {kind: 'constraint', identity: PgObjectIdentity,
       constraintKind: 'primaryKey' | 'unique' | 'foreignKey' | 'check',
       definition: string, columns: readonly string[],
       target: PgObjectIdentity | null,
       pairs: readonly {source: string, target: string}[],
       deferrable: boolean, initiallyDeferred: boolean,
       validated: boolean, enforced: boolean}
    | {kind: 'index', identity: PgObjectIdentity, definition: string,
       valid: boolean, ready: boolean, ownerConstraint: PgObjectIdentity | null}
    | {kind: 'view', identity: PgObjectIdentity, definition: string,
       columns: readonly string[], options: Readonly<Record<string, string>>}
    | {kind: 'routine', identity: PgObjectIdentity,
       routineKind: 'function' | 'procedure', definition: string};

export type PgSchemaInfo = {
    formatVersion: 1
    engineVersion: '18.6'
    schemas: readonly string[]
    objects: readonly PgObjectInfo[]
};

export type InspectionInfo = {
    schema: PgSchemaInfo
    unknown: readonly {object: PgObjectIdentity, feature: string}[]
    excluded: readonly {object: PgObjectIdentity, reason: string}[]
};

export type SchemaDifferenceInfo = {
    path: readonly string[]
    change: 'add' | 'remove' | 'change'
    before: JsonValue | null
    after: JsonValue | null
};
```

`definition` no es SQL original concatenado: es la representación normalizada obtenida del servidor bajo opciones fijadas. Los atributos separados permiten checks directos y mensajes precisos. Cuando el deparser no refleja una propiedad semántica (validez, enforcement, opciones), capturarla explícitamente. Un atributo soportado por el motor pero no por el descriptor produce unknown; extender tipo/decoder/inspector/tests si se necesita administrar ese objeto.

Identidades de columna/constraint contienen tabla en parentName; rutina contiene tipos identidad de argumentos en signature. El decoder exige `identity.kind === object.kind`, unicidad de identidades y formas válidas por variante. Las pairs de FK conservan correspondencia; target null y pairs vacío para constraints que no sean FK. Para checks sin columnas explícitas no inventarlas desde un parse textual. El ownership del backing index evita duplicar semántica; no excluir un índice ajeno por parecer similar.

`inspectSchema` siempre retorna `InspectionInfo` completo. `compareSchemas` no se ejecuta como garantía de igualdad si unknown no está vacío: primero fallar por unsupportedSchemaFeature. Incluir objetos inesperados dentro del scope como add, no ignorarlos porque no aparecen en snapshot. Las exclusiones son journal y dependencias externas identificadas, no una lista genérica que ignore todas las clases no conocidas.

El generador desde EntityInfo y el inspector se prueban independientemente. Se debe comprobar antes de publicación que las definiciones observadas contienen todos los objetos/propiedades declarados por SSOT y recursos `expectedObjects`.

## 8. Journal y unidad de ejecución

```ts
export type InstallationInfo = {
    installationId: string
    systemId: string
    schemas: readonly string[]
    baseline: ReleaseRefInfo
    current: ReleaseRefInfo
    journalFormatVersion: 1
};

export type MigrationHistoryInfo = {
    installationId: string
    ordinal: number
    migrationId: string
    migrationHash: string
    from: ReleaseRefInfo
    to: ReleaseRefInfo
    committedAt: string
};

export type AttemptInfo = {
    attemptId: string
    deploymentId: string
    installationId: string
    planHash: string
    state: 'running' | 'failed' | 'unknown' | 'succeeded'
    confirmedTarget: ReleaseRefInfo | null
    problems: readonly Problem[]
};

export type ExecutionOptions = {
    lockWaitTimeoutMs: number
    statementTimeoutMs: number
    lockTimeoutMs: number
};
```

Los timestamps provienen de un proveedor de reloj del consumidor, son UTC strings y no entran en el hash de release. Ordinal expresa posición efectiva de transición respecto del baseline/catálogo, no orden cronológico inferido. No usar auto-ID de aplicación para ordenar releases.

Contratos de journal (todos asíncronos; sesión explícita, no conexiones ocultas):

```text
readInstallation(session, scope): ValidationResult<InstallationInfo|null>
verifyHistory(session, installation, catalog): ValidationResult<readonly MigrationHistoryInfo[]>
startAttempt(session, binding): ValidationResult<AttemptInfo>
appendCommittedMigration(session, expectedHead, history): ValidationResult<InstallationInfo>
finishAttempt(session, attemptId, result): ValidationResult<AttemptInfo>
recordVerification(session, run): ValidationResult<VerificationRunInfo>
readLatestVerification(session, deploymentId): ValidationResult<VerificationRunInfo|null>
recordReadiness(session, readiness): ValidationResult<DeploymentReadinessInfo>
```

`appendCommittedMigration` verifica head/hashes y agrega historia/cambia head **en la sesión de la transacción de la migración**. La query actualiza con condición expectedHead y exige exactamente una fila afectada. No registrar esa confirmación en otra conexión.

`executeMigration(session,migration,target,context)`:

1. Recibe sesión dedicada con lock de despliegue/migrador vigente; context contiene artifact loader, inspector y checker, no Def actuales.
2. Abre transacción y configura timeouts locales validados.
3. Revalida origen/head/historia y checks before.
4. Ejecuta bytes resueltos de steps en orden; no cambia resourceHash.
5. Checks after + invariantes target + metadatos + inspección target.
6. Agrega confirmación/head y COMMIT.
7. Ante fallo previo a commit: rollback y diagnóstico fuera de la transacción.
8. Ante resultado ambiguo: estado unknown, nunca retry automático; reconciliar con journal al reconectar.

No hay estado durable succeeded por step: todos los steps confirman o revierten juntos. Los eventos de progreso pueden indicar que se ejecutó un statement, pero sólo historia confirmada acredita aplicación. Ese detalle evita reconstruir una máquina de checkpoints innecesaria.

## 9. Evidencia y gate de deployment

```ts
export type DeploymentBindingBase = {
    deploymentId: string
    installationId: string
    candidateApplicationHash: string
    planHash: string
    to: ReleaseRefInfo
    engineVersion: '18.6'
    schemas: readonly string[]
    configurationHash: string
    maintenanceId: string
    production: boolean
};

export type DeploymentBindingInfo = DeploymentBindingBase & (
    | {operation: 'install', from: null}
    | {operation: 'upgrade', from: ReleaseRefInfo}
);

export type VerificationCheckInfo = {
    id: string
    kind: 'artifacts' | 'environment' | 'structure' | 'data' | 'rehearsal'
    status: 'passed' | 'failed' | 'incomplete'
    reportId: string
    problems: readonly Problem[]
};

export type VerificationRunInfo = {
    verificationId: string
    ordinal: number
    binding: DeploymentBindingInfo
    status: 'passed' | 'failed' | 'incomplete'
    checks: readonly VerificationCheckInfo[]
    createdAt: string
};

export type DeploymentReadinessInfo = {
    binding: DeploymentBindingInfo
    state: 'pending' | 'blocked' | 'ready' | 'consumed'
    verificationId: string | null
    applyAttemptId: string | null
    confirmedTarget: ReleaseRefInfo | null
    problems: readonly Problem[]
};

export type DeploymentReadyInfo = {
    binding: DeploymentBindingInfo
    verificationId: string
    applyAttemptId: string
    confirmedTarget: ReleaseRefInfo
};
```

`checkApplyEligibility(binding, evidenceContext)` retorna `ValidationResult<VerificationRunInfo>` sólo con una verificación pasada, completa y exacta del binding. Se usa como gate de entrada tanto en install como en apply. La cobertura requerida se deriva de operation/plan/entorno, no de qué checks decidió incluir un JSON externo. Producción requiere ensayo con copia identificada cuando operation es upgrade; install exige scope vacío y verificación de creación sin fingir una copia de datos previos. Missing/incomplete equivale a bloqueo.

Cobertura obligatoria del recibo de entrada:

| Kind | Evidencia necesaria |
| --- | --- |
| artifacts | Hashes/formatos de todos los releases, scripts, codecs/inspector y plan usados |
| environment | PostgreSQL 18.6 y contrato ambiental del entorno de ensayo coincidentes |
| structure | Install: creación destino validada contra intención; upgrade: además todas las transiciones del segmento y resultado A→B vs B limpio |
| data | Invariantes, metadatos y escenarios/checks de transformación declarados ejecutados; el reporte enumera IDs, no sólo un total |
| rehearsal | Obligatorio si production y operation upgrade: copia identificada y segmento exacto ejecutado con resultado correcto |

Un recibo sin alguno de los grupos requeridos es incomplete aunque su campo status diga passed. Un grupo con fallo vuelve failed al run; un grupo faltante/no terminado deja incomplete. Status passed se deriva sólo cuando todo lo requerido terminó satisfactoriamente. El checker de coverage vive en una función pura compartida por publicación del resultado y lectura del gate; no confiar en el status leído del JSON.

`ordinal` es un entero creciente por deploymentId asignado por el store en transacción, con unicidad `(deploymentId,ordinal)`. `readLatestVerification` ordena por él, no por createdAt ni UUID. Crear un run incomplete invalida la autorización anterior hasta terminar; sólo el proceso dueño puede finalizar ese run una vez con passed/failed. Las transiciones de readiness consultan ese ordinal bajo exclusión del deployment. Un proceso interrumpido no deja vigente un passed previo por no haber escrito aún su resultado final.

`checkDeploymentReady(binding, runtime)` retorna `ValidationResult<DeploymentReadyInfo>`. Un resultado `{ok:true,value:{allowed:false}}` no existe: ok significa que realmente puede activarse el candidato. Para lograrlo:

1. Validar hashes/IDs, engine y scope.
2. Leer la última verificación autorizada de ese deploymentId; exigir exactitud del binding y cobertura completa.
3. Leer el intento de apply exitoso y el head real igual a binding.to.
4. Ejecutar/consultar postcondiciones finales dentro del mantenimiento y exclusión de despliegue vigentes.
5. Comprobar que no haya fallo posterior invalidante, cambio de artifacts/configuración ni otro intento en ejecución.
6. Registrar ready y devolver sólo evidencia confiable; el pipeline activa el mismo candidateApplicationHash y registra consumed.

La comparación before apply usa from; la comprobación final usa to. No invalidar el binding original porque el propio apply ya avanzó from→to. El intento/historia demuestra esa transición. Para plan vacío, from y to son iguales y `applyAttemptId` corresponde a una ejecución de revalidación sin SQL de upgrade.

Para install, from es null y applyAttemptId identifica el intento de instalación; el chequeo inicial es scope vacío, no una comparación con una release inexistente. Calcular su planHash como SHA-256 del JSON canónico `{operation:'install', release:bundle.manifest.release, createPlanContentHash:bundle.manifest.createPlan.contentHash}`. La identidad release ya cubre resources/checks/entorno. El wrapper install vuelve a calcularlo antes de escribir; no usa MigrationPlanInfo, cuyo from siempre es una release real de un upgrade.

La librería no implementa una plataforma de despliegue. La integración proporciona `maintenance.isActive(id,installationId)`, una exclusión por deployment, `activate(candidateApplicationHash)` y `completeMaintenance(id)`. Los tests espían esas llamadas y mantienen estado para comprobar el orden. `activate` sólo es accesible desde el camino que obtuvo `DeploymentReadyInfo`; el pipeline real debe hacer lo mismo.

No aceptar receipts de otro pipeline/archivo sin verificación de su procedencia. La implementación puede usar el journal y artifacts del job confiable; los hashes proporcionan integridad, no autenticación. No se requiere añadir una plataforma de firmas o proveedor de secretos para cumplir este contrato.

## 10. Configuración y adaptación de entornos

Los artifacts usan nombres físicos concretos de schema del sistema (fixtures: `app`). La instalación proporciona ese scope y el consumidor comprueba coincidencia. No implementar remapeo textual de SQL arbitrario ni reescribir archivos históricos.

Si una aplicación necesita templates de identifiers para varios namespaces, debe declararlos como recursos parametrizados y fijar los parámetros al construir el bundle/plan concreto; el resultante recibe hashes propios. El binding y la verificación se refieren a los mismos bytes concretos. Esto es una integración de la aplicación, no permiso para ejecutar SQL diferente del artifact verificado.

Las credenciales se leen del entorno de ejecución y no se incluyen en DeploymentBindingInfo. ConfigurationHash abarca los valores no secretos que afectan el plan/inspección/alcance y opciones operativas del intento. Incluye preparationHistoryHash según la sección 13 del anexo de autoría: una corrección verificada de estado invalida evidencia anterior aunque conserve el head. Rotación de una credencial equivalente no cambia semántica de DB.

## 11. Errores y códigos

| Message key | Resultado |
| --- | --- |
| migration.invalidJson | Decoder falla con path sin ejecutar getters |
| migration.unsupportedFormat | No interpretar formato parcialmente |
| migration.invalidReference | Entidad/tipo/recurso/release inexistente |
| migration.invalidResourceKind | Check usado como SQL o viceversa |
| migration.invalidCatalog | Gap, rama, duplicado, self edge, hashes/sistema discordantes |
| migration.downgradeUnsupported | Destino anterior al origen |
| migration.checksumMismatch | No ejecutar ni activar |
| migration.environmentMismatch | PostgreSQL distinto de 18.6 o entorno incompatible |
| migration.nonTransactionalResource | SQL/efecto incompatible con atomicidad |
| migration.schemaDrift | Diferencias estructurales concretas |
| migration.unsupportedSchemaFeature | Objeto/atributo no representado en el alcance |
| migration.checkFailed | Check false/salida inválida; rollback si está en migración |
| migration.lockUnavailable | No iniciar cambios |
| migration.unknownCommitOutcome | Bloquear hasta reconciliar head/historia |
| deployment.verificationMissing | No aplicar ni activar |
| deployment.verificationFailed | No aplicar ni activar |
| deployment.verificationIncomplete | No aplicar ni activar |
| deployment.evidenceMismatch | Evidencia no corresponde a candidato/plan/instalación/configuración |
| deployment.maintenanceRequired | Escritores no detenidos o mantenimiento no vigente |
| deployment.targetNotReady | Falta confirmación de target o check final |
| deployment.blocked | Intento invalidado; no activar con resultado previo |

`details` conserva strings; reportes estructurados separados contienen diferencias/checks. Códigos técnicos de CLI: 0 éxito, 2 entrada/configuración inválida, 3 verificación/gate bloqueado, 4 fallo operativo/commit desconocido. Todos los no cero bloquean el job dependiente de deployment; no basar promoción en una whitelist que sólo considere fatal un código.

## 12. Soporte del consumidor sin tipos implícitos

Los tipos siguientes completan las referencias de las firmas. Son comportamiento/datos internos del consumidor, no nuevas propiedades de Def del núcleo.

```ts
export type MigrationPathInfo = {
    from: ReleaseRefInfo
    to: ReleaseRefInfo
    migrations: readonly PublishedMigrationInfo[]
};

export type PgTypeRepresentation = {
    schema: string
    name: string
    modifiers: readonly string[]
};

export type StorageContext = {
    representation: string
    physicalTypes: Readonly<Record<string, PgTypeRepresentation>>
    schema: string
    environment: EnvironmentInfo
    resources: Readonly<Record<string, ResolvedSqlResource>>
    createResources: readonly CreateResourceInfo[]
    managedData: readonly ManagedDataInfo[]
    invariantChecks: readonly ResourceRefInfo[]
};

export type CreatePlanInfo = {
    formatVersion: 1
    schema: string
    generatedSql: readonly ResourceRefInfo[]
    extraResources: readonly CreateResourceInfo[]
    dataResources: readonly ResourceRefInfo[]
    after: readonly ResourceRefInfo[]
};

export type ResolvedSqlResource = {
    ref: ResourceRefInfo
    text: string
};

export type ReleaseBundle = {
    manifest: ReleaseManifestInfo
    snapshot: SystemSnapshotInfo
    persistence: PersistenceInfo
    expectedSchema: PgSchemaInfo
    createPlan: CreatePlanInfo
    resources: Readonly<Record<string, ResolvedSqlResource>>
};

export type SqlParameter = null | boolean | number | string | Uint8Array;

export interface PgSession {
    query(text: string, values: readonly SqlParameter[]): Promise<{
        rows: readonly Readonly<Record<string, unknown>>[]
        rowCount: number | null
    }>;
    close(): Promise<void>;
}

export interface ConsumerRuntime {
    openTarget(): Promise<PgSession>;
    loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<ReleaseBundle>>;
    now(): string;
    maintenanceActive(id: string, installationId: string): Promise<boolean>;
}
```

`PgSession` es el wrapper del driver; decodificar filas desconocidas antes de tratarlas como catálogo, journal o valores de aplicación. Los SQL parameters son valores de transporte, no descripciones serializables. Recursos de migración tienen texto inmutable ya resuelto; parámetros de negocio, si hay, se concretan en el artifact/plan y sus hashes antes de verificación, no se improvisan en apply.

`CreatePlanInfo.generatedSql` contiene recursos generados desde las entidades; `extraResources` aplica dependencias declaradas para vistas/rutinas/restricciones; `dataResources` carga metadatos y `after` verifica. Todos los recursos se resuelven/verifican antes de abrir la transacción de instalación.

Contratos de entrypoints:

```text
buildRelease(snapshot,persistence,storageContext): ValidationResult<ReleaseBundleDraft>
verifyRelease(draft,scratchProvider): Promise<ValidationResult<ReleaseBundle>>
loadRelease(path): Promise<ValidationResult<ReleaseBundle>>
buildMigrationPlan(path,artifactContext): Promise<ValidationResult<MigrationPlanInfo>>
verifyPlan(plan,binding,verificationContext): Promise<ValidationResult<VerificationRunInfo>>
install(bundle,binding,runtime,options): Promise<ValidationResult<AttemptInfo>>
apply(plan,binding,runtime,options): Promise<ValidationResult<AttemptInfo>>
checkApplyEligibility(binding,evidenceContext): Promise<ValidationResult<VerificationRunInfo>>
checkDeploymentReady(binding,runtime): Promise<ValidationResult<DeploymentReadyInfo>>
```

`ReleaseBundleDraft` tiene `snapshot`, `persistence`, `createPlan`, `resources` y `environment`, junto a `systemId`, `releaseId`, `generator` e `inspector`. Es un tipo distinto sin `manifest` final ni `expectedSchema`; no simular ReleaseBundle con hashes vacíos. Los tipos de esas propiedades se reutilizan de ReleaseBundle/ReleaseManifestInfo mediante indexed access. `verifyRelease` ejecuta el create plan común en scratch, obtiene expectedSchema, materializa archivos/hashes y construye ReleaseBundle. No permitir que un draft pase a install/apply, que exigen artifacts completos y validados.

`artifactContext` es el loader verificable de releases/migraciones/recursos. `evidenceContext` es un lector confiable del journal/results store para el deploymentId. `verificationContext` contiene dicho lector/escritor, runtime de scratch y escenarios de datos. No pasar referencias de módulos actuales de aplicación para resolver releases históricas.

`scratchProvider` crea bases descartables del engine/version exigidos y devuelve identidad y PgSession; conserva registro de ownership y sólo destruye sus propias bases. Para ensayo con backup recibe la referencia/copia preparada por la infraestructura; nunca restaura sobre el target real. La implementación de su conexión utiliza configuración de entorno del harness.

El verificador llama al motor interno compartido sin exigir un recibo de verificación previo de sí mismo. Ese acceso está restringido a handles de scratch creados/identificados por el harness; no es un flag de CLI para omitir gates sobre target. Los wrappers públicos install/apply siempre ejecutan checkApplyEligibility. Probar que un DSN/handle de instalación no puede presentarse como scratch sólo mediante un campo booleano.

## 13. Pruebas con resultados esperados

Estas pruebas refinan T01–T17 del documento principal; no son tareas de una versión posterior.

| Caso | Resultado exacto |
| --- | --- |
| Keys `{b:2,a:1}` | JSON canónico `{"a":1,"b":2}` |
| Keys numéricas `2` y `10` | Orden textual canónico `10`, `2`; no orden numérico incidental de JS |
| Getter que lanza | No se llama; toJsonValue devuelve invalidJson con path |
| Null, `''`, `'null'` | Tres valores distintos en copia y codecs de almacenamiento |
| Captura clases | PK literal readonly `['periodo','materia','orden']`; campos PK nullable false |
| Mapping sin fecha | Error de compilación específico y error runtime equivalente en JSON |
| Check usado como step SQL | Error de kind, sin ejecutar recurso |
| Catálogo A,B,C con A→B,B→C | A→C retorna exactamente esos dos IDs en orden |
| Catálogo A,B,C con A→C | invalidCatalog; no saltar B |
| B→A | downgradeUnsupported |
| B→B | Segmento vacío; no omitir gate/checks |
| Version server distinta de 180006 | environmentMismatch; apply y activate no llamados |
| Bytes de recurso cambiados | checksumMismatch antes de SQL de aplicación |
| Quitar ALTER de fixture email | Datos pueden pasar; schemaDrift en nullable; deployment blocked |
| Falla check después de UPDATE | Valores originales, schema origen e historia/head sin cambio |
| A→B confirma, B→C falla | Head B, historial sólo A→B, cero activaciones, mantenimiento activo |
| Respuesta COMMIT perdida | Reconexión consulta journal; si confirmado no repite UPDATE |
| Evidencia passed antigua + latest failed | Gate devuelve error; no activación |
| Mismo plan/DB, otro candidateApplicationHash | evidenceMismatch |
| Mismo candidato, otra instalación | evidenceMismatch |
| Falta ensayo exigido de upgrade de producción | verificationIncomplete; apply y activate no llamados |
| Install nuevo de producción con checks completos | from null, scope vacío; no exige backup de origen inexistente; sólo activa tras target confirmado |
| Apply correcto, check final fallido | targetNotReady/verificationFailed; readiness blocked |
| Éxito completo | activate llamado una vez con hash exacto, después de ready; mantenimiento se completa después |
| Error de pipeline ignorado por simulación | Test falla: contador de activate debe permanecer 0 |

Para cada objeto SQL que el consumidor genera/admite: fixture creado con SQL independiente, inspección correcta, cambio semántico detectado y variación irrelevante normalizada. Devolver unknown para objetos fuera de cobertura y probar bloqueo. No actualizar golden snapshots para ocultar una omisión del generador.

Las pruebas de tipos requieren asignabilidad en ambos sentidos y errores precisos. Las de recuperación crean una instancia nueva del runner. Las del pipeline utilizan mocks/spies sólo para activación/mantenimiento; estructura, checks, transacciones e historial se ejercitan con PostgreSQL real en integración.

## 14. Texto de handoff para implementar

La instrucción de entrega al agente se mantiene en un solo lugar: [MIGRACIONES.md](../MIGRACIONES.md#instrucción-para-entregar-al-agente). Ese archivo fija orden de lectura y enlaza la [checklist compartida](migraciones-checklist.md), con T01–T23, dependencias, reutilización, entregables, aceptación y evidencia.

Actualizar el progreso únicamente en la checklist; no copiar estados a este anexo. Los contratos de las secciones anteriores y los anexos de autoría siguen siendo obligatorios. Las firmas nuevas requieren compilación y pruebas, y el flujo de revisión sigue CLAUDE.md e instrucciones expresas del desarrollador.

Las comprobaciones hechas al editar este handoff son documentales. No se ha declarado una ejecución de PostgreSQL 18.6, compilación de firmas nuevas ni prueba empírica con otro modelo. La implementación debe aportar esa evidencia; el texto de un handoff no la sustituye.
