# Cargar el SSOT

La aplicación define su modelo con `system-definition` y exporta `ssot`, el
`SystemSnapshotInfo` que produce `captureSystemSnapshot`. En el mismo módulo
exporta `sqlMapping`, con una elección SQL explícita por cada tipo del backend.
No necesita un constructor propio del consumidor de migraciones.

```typescript
const result = captureSystemSnapshot(context, {systemId, entities, records});
if (!result.ok) throw new Error(JSON.stringify(result.problems));
export const ssot = result.value;
export const sqlMapping = {
    text: sqlTypes.text,
    integer: sqlTypes.integer,
    boolean: sqlTypes.boolean,
} satisfies SqlTypeMapping<typeof ssot>;
```

`sqlTypes` y `SqlTypeMapping` se importan de `system-definition`. El vocabulario
incluye 17 tipos escalares SQL; el mapeo tipado exige todas las claves registradas
en el SSOT y sólo permite esas elecciones. Los tipos lógicos propios pueden usar
cualquier elección explícita: por ejemplo, `edad: sqlTypes.smallint`.

El consumidor carga ese módulo y usa el decoder existente del core:

```typescript
import {loadSsot} from '@system-definition/postgres-migrations/ssot';
const result = await loadSsot('dist/system.js');
```

```sh
postgres-migrations capture --ssot dist/system.js
```

La función devuelve `ValidationResult<SqlSsotInfo>`: `{ssot, persistence}` compone
los contratos existentes `SystemSnapshotInfo` y `PersistenceInfo` del core.
El loader usa `decodeSystemSnapshot` y `decodePersistence` y rechaza mappings
ausentes, incompletos, extra o desconocidos antes de conectarse a PostgreSQL.
No hay defaults por nombre lógico ni inferencia desde los tipos de TypeScript.
Este paso carga el modelo y permite conocer sus entidades. La integración
de creación, permisos, generación y ejecución de migraciones se refactorizará
por separado. `capture` y `assess` requieren `--ssot`; el adaptador anterior de
captura con `--project` fue eliminado. Los demás comandos conservan su implementación.

## Base y usuarios provistos por la aplicación

La aplicación exporta `databaseSettings` desde su módulo de configuración:

```typescript
import type {DatabaseSettings} from '@system-definition/postgres-migrations/database';
export const databaseSettings = {
    database: {host: 'localhost', port: 5432, database: 'mi-base', schema: 'app'},
    initialUser: {user: 'provisioning_admin', password: process.env['PROVISIONING_PASSWORD']},
    owner: 'schema_owner',
    appUser: 'app_user',
} satisfies DatabaseSettings;
```

`database` usa el `ClientConfig` del driver PostgreSQL, con base y schema
requeridos. `owner` y `appUser` son identidades distintas; la aplicación determina
sus nombres. `initialUser` usa el mismo `ClientConfig`, con `user` requerido:
la aplicación suministra la conexión y credenciales para crear inicialmente los
roles y sus permisos. Se combinará con `database` para ese paso; el consumidor
no lee variables de entorno específicas de la aplicación.
`loadDatabaseSettings` carga este valor sin conectarse ni modificar
roles. El usuario owner se usará para migraciones y el appUser para datos.

```sh
postgres-migrations capture --ssot dist/system.js --database dist/database.js
```

Así el consumidor recibe ambos inputs. La salida del CLI muestra el modelo,
el mapping de persistencia, host/puerto/base y nombres de usuarios; omite parámetros de autenticación del
driver. La creación de roles y la verificación de privilegios son pasos separados.

## Comparar el SSOT con la base actual

```sh
postgres-migrations assess --ssot dist/system.js --database dist/database.js
```

El consumidor proyecta el SSOT, inspecciona el schema configurado y compara
representaciones normalizadas. La inspección obtiene schemas existentes y objetos
en una única consulta, distinguiendo schemas vacíos de inexistentes.
Reutiliza `projectSchema`, `inspectSchema`,
`normalizePgSchema` y `compareSchemas`; no crea releases ni historial para comparar.
Devuelve `{equal, differences}` con `path`, `change`, `before` (base actual) y
`after` (SSOT). Cada diferencia tiene `impact`: `preserving` (sin decisión de datos),
`requiresDataCheck` (validar datos o definir conversión/backfill), `destructive`
(el usuario decide el destino de los datos), o `unsupported`.
Usa el usuario de aplicación para leer los catálogos.

`classifySchemaDifferences` clasifica el resultado del comparador sin conectarse,
leer historial ni generar SQL. Reutiliza `ChangeImpact` y `SchemaDifferenceInfo`.
Una tabla eliminada agrupa sus columnas/constraints/índices en una única decisión.
En una tabla nueva no hay filas existentes que completar. Un posible rename sigue
siendo eliminación + agregado hasta que el usuario declare la correspondencia.
El adaptador de authoring reutiliza estas reglas y el comparador; conserva los IDs
de releases y las correspondencias explícitas que necesita la compilación posterior.

Los índices de constraints se representan mediante sus constraints; índices
independientes y objetos extra siguen apareciendo. El mapping lógico usa
únicamente las elecciones declaradas en `sqlMapping`. Un mapping inválido
se rechaza al cargar. Este paso no ejecuta DDL ni modifica datos.

## Generar SQL desde mappings explícitos

`generateMigrationSql(changes, current, target, schema, dataDestinations)` es una
función pura: proyecta el SSOT destino con su mapping y reutiliza los renderers de
tablas, columnas y constraints. Devuelve statements ordenados con `text` y `order`.
`current` es el schema observado y `changes` son los cambios ya evaluados; las
decisiones y el código de transformaciones pertenecen a sus pasos propios.

`dataDestinations` es un array opcional de `FieldRefInfo` existentes, con `side:
"to"`: las columnas que recibirán un backfill. No se codifican nombres de campos
como strings JSON. Sólo el `SET NOT NULL` se difiere hasta después del backfill;
tipo y default se preparan antes. El ensamblador existente consume ese orden.
Los renames de columnas también emiten los cambios simultáneos de atributos.

La creación inicial y el DDL incremental comparten la misma definición SQL de
columna y los renderers de tipos/constraints e identificadores. Los atributos
físicos soportados se representan completos; columnas identity/generated y
otras variantes no soportadas requieren SQL explícito. No se descartan atributos
silenciosamente. Los defaults físicos se renderizan cuando están declarados en
`PgSchemaInfo`; no se deducen de metadata arbitraria del backend.

```typescript
const target = await loadSsot('dist/system.js');
if (!target.ok) throw new Error(JSON.stringify(target.problems));
const sql = generateMigrationSql(changes, current, target.value, 'app');
```

El generador no abre conexiones, reconstruye historial, aplica migrations ni
traduce validators arbitrarios a SQL. Los PK, UK, FK y nullability se obtienen de
sus definiciones explícitas. El vocabulario actual es escalar y sin parámetros de
longitud/precisión; un `maxLength` propio de la aplicación no se convierte por
suposición en `varchar(n)`. Los renderers existentes siguen rechazando efectos
que requieran SQL manual.

## Decisiones de datos por migración

Las decisiones se guardan en `MigrationDraftInfo.decisions`, junto a `data` y las
correspondencias explícitas de `renames`. `DataDecisionInfo` es el contrato común;
`DestructiveDecisionInfo` restringe sus resoluciones para la preparación de cambios
destructivos. Las resoluciones son:

- `discard`: eliminación deliberada, con motivo; sólo para cambios destructivos.
- `migrate`: ID de una transformación/backfill en `draft.data` y outputs escritos.
- `check`: recurso SQL de tipo check, para validar datos antes de aplicar el cambio.

`assessMigrationDecisions(changes, draft)` es una función pura que devuelve las
preguntas pendientes o errores de decisiones inválidas. Cada elección identifica
un cambio de esa migración. Los IDs de cambios incluyen los estados origen/destino;
una elección anterior no cubre un cambio distinto. La validación comprueba fuentes,
outputs y, para columnas requeridas, la columna destino concreta.

No se guarda un booleano de aprobación. Tener otra migración de datos, o borrar la
lista `pending`, no resuelve un cambio. Inference, resolución de respuestas y
compilación usan el mismo validador. La compilación reconstruye los cambios y
bloquea antes de replay si faltan decisiones. Los checks elegidos se incluyen en
`migration.before`; el ejecutor existente los verifica antes del DDL. La resolución
de una decisión no sustituye las validaciones de SQL, datos y replay del compilador.

```typescript
const readiness = assessMigrationDecisions(changes, draft);
if (!readiness.ok) throw new Error(JSON.stringify(readiness.problems));
const pending = readiness.value; // []: decisiones completas para estos cambios
```

`validateMigrationDecisions(changes, draft)` es el gate estricto para generar o
aplicar: reutiliza el mismo assessment y devuelve `true` sólo cuando no quedan
preguntas; de lo contrario devuelve problemas bloqueantes. Recibe los cambios
recalculados, no confía en `draft.changes` ni en `draft.pending`. El compilador usa
este gate antes de replay. Recoger respuestas sigue admitiendo decisiones parciales.

Las declaraciones de SQL manual también se validan aquí: el recurso debe ser SQL,
cada cambio sólo puede ser reclamado por un paso, y sus `writes`/`destroys` deben
incluir el objeto afectado. Declarar un DROP no sustituye la decisión sobre los
datos eliminados. El compilador conserva las verificaciones de SQL real y replay;
esta validación comprueba las decisiones y sus referencias, no ejecuta recursos.

El flujo existente `infer --project ... --out draft.json` guarda preguntas para
`destructive` y `dataRequired`. Se responden mediante `resolve --draft draft.json
--report draft.json.conflict.json --answers answers.json`. Las respuestas están
ligadas al hash del draft y del reporte. Para un check, una respuesta puede ser:

```json
{
  "questionId": "<ID del cambio>",
  "kind": "dataRequired",
  "decision": {
    "changeId": "<ID del cambio>",
    "source": null,
    "partitionCheck": null,
    "resolution": {
      "kind": "check",
      "run": {"kind": "check", "name": "datos-validos", "contentHash": "<SHA-256 del recurso>"}
    }
  }
}
```

Ese objeto va en `answers` del archivo existente, con `formatVersion`, `reportHash`,
`draftHash` y `draft`. El recurso SQL debe estar registrado en los recursos de la
migración; una descripción sin recurso no autoriza aplicar el cambio. El prompt
interactivo actual conserva las decisiones destructivas; los demás casos usan el
archivo de respuestas. La carga por `--ssot` sigue limitada al modelo y assessment;
la composición completa del draft con esa entrada se integrará por separado.

## Recoger decisiones de una migración

`collectMigrationDecisions(draft, answers)` usa los tipos existentes del draft y de
sus decisiones. Las respuestas contienen solamente `id`, `revisionHash` y
`decisions`: identifican la migración y la revisión exacta que el usuario leyó.
Se reutilizan el decoder de decisiones, el validador de readiness y el hash del
draft. El mismo collector también se usa desde el resolver anterior con reports.

```sh
postgres-migrations resolve --draft migration-draft.json --answers answers.json
```

Esta entrada no requiere `--project` ni `--report`. Ejemplo de `answers.json` para
una columna eliminada; los IDs/hash y campos se toman del draft existente:

```json
{
  "id": "migration-id",
  "revisionHash": "<draft.revisionHash>",
  "decisions": [{
    "changeId": "<change.id>",
    "source": {"side": "from", "entity": "people", "field": "legacy"},
    "partitionCheck": null,
    "resolution": {"kind": "discard", "reason": "Datos que ya no se necesitan"}
  }]
}
```

También admite las resoluciones `migrate` (referencia a una transformación en
`draft.data` y sus outputs) y `check` (recurso de comprobación para datos requeridos).
Un check no autoriza pérdida de datos. Los renames siguen siendo declaraciones
`RenameInfo` del draft, que la inferencia evalúa antes de recoger estas decisiones.
`createMigrationDraft` puede crear ese draft desde el SSOT suministrado y el schema
origen; la composición completa de esos inputs en la CLI se integra por separado.

Las respuestas válidas se agregan y el draft se guarda atómicamente con una nueva
revisión. Las parciales dejan las demás diferencias en `pending`; exit 0 significa
que se guardaron las decisiones, no que la migración esté lista para aplicar.
Respuestas de otra migración/revisión, duplicadas o con referencias inválidas se
rechazan sin cambiar el archivo. La función pura retorna el nuevo draft y no
consulta la base ni ejecuta SQL. La generación vuelve a evaluar readiness.

## Ensamblar y guardar una migración

Los tres pasos usan los contratos existentes:

- `createMigrationDraft(id, base, current, target, schema)` proyecta el SSOT,
  calcula cambios/preguntas y crea su revisión. `base` identifica los estados
  origen/destino con `AuthoringBaseInfo`; lo aporta el caller desde sus releases.
- `assembleMigration(draft, current, desired, runtime)` recalcula las diferencias,
  valida las decisiones y compone SQL, transformaciones y checks ordenados. Usa
  sólo los callbacks existentes para leer recursos y emitir archivos; no necesita
  callbacks de inspección/reconstrucción, conexión ni scratch. Para estructura sola
  basta con `emitResource`. Checks usan `readSql`; transformaciones usan los readers
  y `loadDataContext` existentes.
- `saveMigrationArtifact(directory, assembled, files)` comprueba los recursos y
  guarda el directorio completo mediante el publisher atómico existente. No
  reemplaza una salida previa ni registra aplicación/success en la base.

```typescript
const files = new AuthoringFiles();
const draft = createMigrationDraft('migration-id', base, current, target, schema);
if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
const desired = projectSsotSchema(target, schema);
if (!desired.ok) throw new Error(JSON.stringify(desired.problems));
const assembled = await assembleMigration(draft.value, current, desired.value, {
    emitResource: files.emitResource.bind(files),
});
if (!assembled.ok) throw new Error(JSON.stringify(assembled.problems));
const saved = await saveMigrationArtifact('migrations/migration-id', assembled.value, files);
```

Se conserva el formato de artifacts: `migration.json`, `authoring.json`,
`resources.json` y los archivos referenciados. `authoring.json` es la compilación
canónica cubierta por el hash del manifiesto; se eliminó la copia redundante
`compiled.json`. Los SQL/checks se incluyen por referencia y por bytes, manteniendo
sus hashes y el orden capture → prepare → write → finish del ensamblador existente.
Los checkpoints tipan sus checks con `ResourceRefInfo` en el contrato ya existente.

La creación del manifiesto se comparte con replay. El comando `generate --project`
conserva el compiler/verificador y usa el mismo saver; la nueva API permite sólo
ensamblar/guardar cuando la verificación se hace por separado. Guardar no equivale
a verificar ni aplicar. Los readers existentes siguen validando los artifacts.

## Verificar los archivos de una migración

`verifyMigrationFiles(directory, expected)` reutiliza los readers de artifacts y
`loadVerifiedMigrationAuthoring`. `expected` es el `PublishedMigrationInfo` del
catálogo registrado/revisado: comparar sólo el hash recalculado del archivo contra
sí mismo no detectaría una migración reescrita con un nuevo hash.

Verifica el manifiesto y los bytes del authoring canónico, los SQL/checks de before,
steps, after y checkpoints, todos los recursos del registro, las queries y los
bundles de validación. Para `FileInfo` comprueba hash y tamaño mediante
`readVerified`; los demás recursos se leen por su content hash. Usa los decoders
del core para las referencias y `decodeValidationArtifact` para bundles.

Los manifiestos nuevos también incluyen `resources: FileInfo`, que liga
`resources.json` al hash de la migración. Es opcional para leer artifacts previos;
no se reescribe historial ni archivos publicados. En los artifacts anteriores,
el registro conserva la comprobación de sus textos/recursos contra los hashes
declarados, aunque no tiene su propio hash ligado al manifiesto.

```typescript
const verified = await verifyMigrationFiles(directory, catalog.migrations[index]);
if (!verified.ok) throw new Error(JSON.stringify(verified.problems));
```

El resultado usa `VerifiedMigrationAuthoring` existente. La función sólo lee:
no interpreta datos, importa módulos, ejecuta SQL ni inspecciona schemas. El reader
de catálogo sigue leyendo los manifiestos; la comprobación completa de bytes es
este paso separado. La composición completa en la CLI permanece por integrar.

## Historial mínimo

El catálogo ordenado usa `MigrationCatalogInfo` del core: releases y migraciones
publicadas con sus hashes. Se conserva junto a los archivos inmutables generados;
incluye las migraciones que todavía no se aplicaron. La base sólo guarda el
baseline, el puntero actual y la secuencia confirmada de migraciones aplicadas.

`readMigrationCatalog(baseline, directories)` lee los manifiestos guardados en el
orden suministrado y completa `MigrationCatalogInfo` mediante el core. No ordena
por nombre ni fecha ni descubre un baseline implícito. `baseline` viene de la
release inicial guardada; la app proporciona las ubicaciones ordenadas de las
migraciones. Se rechazan secuencias desconectadas, duplicadas o archivos ausentes.
El reader de manifiestos reutiliza el parser JSON y decoder existentes y admite
los manifiestos anteriores con formato pretty JSON: su identidad usa JSON
canónico, mientras los recursos referenciados conservan hashes de bytes exactos.

`readMigrationStatus(session, journal, scope, catalog)` combina ese catálogo con
el puntero y el log aplicado mediante la única consulta de `readHistoryState`.
Devuelve los estados `applied`/pendiente con `MigrationHistoryStateInfo`, sin
inspección de schemas, inicialización, control de transacciones ni aplicación.
Reutiliza la comprobación de secuencia existente. Los datos completos del log,
incluidas fechas de commit, siguen disponibles con `readHistoryState`.

```typescript
const catalog = await readMigrationCatalog(baseline, orderedDirectories);
if (!catalog.ok) throw new Error(JSON.stringify(catalog.problems));
const status = await readMigrationStatus(session, journal, scope, catalog.value);
```

`bootstrapHistory(session, {schema})` crea únicamente `installation` y
`migration_history`. Los estados operativos de deployment/verificación no forman
parte de esta inicialización. El formato existente se conserva: no se borra ni
reescribe historial ya guardado. `appendCommittedMigration` agrega la entrada y
actualiza el puntero en una misma sentencia, dentro de la transacción del caller
que también aplica SQL. Un rollback revierte ambas cosas.

`describeMigrationHistory(installation, history, catalog)` comprueba que las
migraciones aplicadas son un prefijo sin cambios del catálogo. Devuelve la lista
ordenada con `position` y `applied`; los elementos posteriores están pendientes.
El baseline representa el estado inicial instalado, no una migración ficticia.
Se rechazan gaps, reordenamientos, migraciones aplicadas desaparecidas o hashes
distintos. SQL y recursos se cargan mediante los readers de artifacts existentes,
que verifican sus bytes antes de ejecución.

`readMigrationHistory(session, journal, scope, catalog, schemas)` lee puntero e
historial mediante `readMigrationStatus` y comprueba drift contra el schema guardado para el hash del head
actual. `schemas` contiene los schemas publicados, indexados por release hash.
No se usa el próximo SSOT deseado como estado esperado de la base. Un drift bloquea
el resultado y requiere reconciliación del usuario antes de planificar o aplicar.
Para mantener también la inspección en el mismo snapshot, el caller usa una
transacción de lectura `REPEATABLE READ` o el lock de migraciones existente.

```typescript
const state = await readMigrationHistory(session, journal, scope, catalog, schemas);
if (!state.ok) throw new Error(JSON.stringify(state.problems));
const pending = state.value.migrations.filter(migration => !migration.applied);
```

Se eliminaron los wrappers sin callers que reconstruían historia mediante un
replay completo de verificación y que sólo comprobaban presencia de una release.
El replay y sus garantías siguen en el ejecutor/verificador cuando corresponden.
