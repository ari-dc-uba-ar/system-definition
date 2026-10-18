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
Este paso carga el modelo y permite conocer sus entidades. Todos los comandos
de autoría, estado y aplicación usan estos inputs; no requieren un adaptador
`MigrationProject`. `resolve` sólo necesita el draft y sus respuestas.

## Base y usuarios provistos por la aplicación

La aplicación exporta `databaseSettings` desde su módulo de configuración:

```typescript
import type {DatabaseSettings} from '@system-definition/postgres-migrations/database';
export const databaseSettings = {
    database: {host: 'localhost', port: 5432, database: 'mi-base', schema: 'app'},
    initialUser: {user: 'provisioning_admin', password: process.env['PROVISIONING_PASSWORD']},
    owner: {user: 'schema_owner', password: process.env['OWNER_PASSWORD']},
    appUser: {user: 'app_user', password: process.env['APP_PASSWORD']},
} satisfies DatabaseSettings;
```

`database` usa el `ClientConfig` del driver PostgreSQL, con base y schema
requeridos. `owner` y `appUser` también usan `ClientConfig`, con `user` requerido; sus identidades son distintas. La aplicación determina
sus nombres. `initialUser` usa el mismo `ClientConfig`, con `user` requerido:
la aplicación suministra la conexión y credenciales para crear inicialmente los
roles y sus permisos. Se combinará con `database` para ese paso; el consumidor
no lee variables de entorno específicas de la aplicación.
`loadDatabaseSettings` carga este valor sin conectarse ni modificar
roles. El usuario owner ejecuta migraciones y el appUser opera los datos.

Cada migración otorga `SELECT, INSERT, UPDATE, DELETE` únicamente sobre las tablas
que crea. Alterar, renombrar o eliminar tablas existentes no repite esos grants;
si no se crean tablas, no se agrega un paso de permisos. El aprovisionamiento no
otorga privilegios por defecto sobre tablas futuras y revoca la antigua regla
automática si estaba configurada, conservando los grants de tablas existentes. La aplicación sigue
verificando los permisos de todas las tablas administradas antes de confirmar.
El SQL generado conserva los comentarios escritos por el autor y omite los
encabezados, rótulos por paso y explicaciones automáticas redundantes; las
conexiones, verificaciones y recursos auxiliares permanecen en los metadatos.

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

Los renderers de `PgSchemaInfo` permiten identidades `GENERATED BY DEFAULT` y
`GENERATED ALWAYS` sobre enteros, CHECKs validados con su nombre, e índices
independientes válidos, incluidos los únicos parciales. Conservan las definiciones
registradas y contrastan sus nombres y tablas antes de generar una sentencia.
Los índices de claves se crean mediante sus constraints, sin duplicarlos.
Agregar CHECKs o índices a tablas existentes requiere decisiones de datos; la
generación no omite esa revisión ni ejecuta índices concurrentes.

Esto no amplía por sí solo `sqlMapping` ni la proyección del SSOT: todavía no
expresan todas las características de un esquema heredado. Las identidades no
registran opciones ni estado de sus secuencias. Las expresiones generadas, vistas
y rutinas siguen necesitando SQL explícito y estados esperados verificables.

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

## Recoger decisiones de una migración

`collectMigrationDecisions(draft, answers)` usa los tipos existentes del draft y de
sus decisiones. Las respuestas contienen solamente `id`, `revisionHash` y
`decisions`: identifican la migración y la revisión exacta que el usuario leyó.
Se reutilizan el decoder de decisiones, el validador de readiness y el hash del
draft. Inference, resolución y compilación comparten esta validación.

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

Cada migración publicada contiene dos archivos: un SQL numerado y metadata.json.
Los IDs nuevos también llevan el prefijo de secuencia, por ejemplo:

```text
migrations/
  baseline.json
  catalog.json
  entries/
    0001_initial/
      0001_initial.sql
      metadata.json
    0002_add-planes/
      0002_add-planes.sql
      metadata.json
```

El SQL muestra los pasos ordenados y las fases de conexión. La inicial guarda
creación de owner/app, schemas y permisos para initialUser; el owner aplica
schema/datos y grants. Los passwords se suministran al ejecutar, nunca se guardan.
Los queries de apoyo se muestran como comentarios; checks y validadores los
controla el runner. No se debe ejecutar el archivo saltándose esas comprobaciones.

metadata.json empaqueta los contratos existentes: manifiesto, authoring, registro
de recursos, estados origen/destino y módulos históricos. El reader reconstruye
sus bytes usando los hashes originales. No agrega otro modelo de schema ni otro
historial. El SQL combinado también está ligado al hash de la migración nueva.
Los drafts generados por defecto se eliminan al publicar; los drafts explícitos
fuera del directorio de trabajo se conservan. El catálogo legible ordena las entradas.

Los readers también aceptan directorios anteriores. Compactar su representación
conserva identidad e historial. Cuando el setup de roles no estaba archivado en una
migración aplicada, su SQL lo indica como declaración histórica de la configuración;
las migraciones iniciales nuevas sí guardan y ejecutan ese recurso.

La creación del manifiesto se comparte con replay. `generate --ssot` reutiliza
el ensamblador y saver, y liga los estados origen/destino al manifiesto. La API de
biblioteca permite ensamblar/guardar con verificación separada. Guardar no equivale
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


## Autoría directa desde el SSOT

`infer` y `generate` aceptan los módulos de SSOT/base sin `MigrationProject`.
`infer --id <id> --directory <dir> --draft <file>` guarda el draft y sus estados.
`generate --draft <file>` valida decisiones/bindings, ensambla y publica la migración.
El catálogo es una secuencia explícita; cada migración nueva contiene sus estados
origen/destino como `FileInfo` ligados al authoring. Los readers verifican sus bytes.
`--baseline <release-dir>` importa una release inicial publicada sin reescribirla.
Los estados guardan el schema SQL proyectado; la comparación normaliza ambos lados.

`data --id <id> --sql <file> --contract <file>` genera una migración independiente
con schema sin cambios y efectos SQL declarados mediante `AddSqlContractInfo`.
Los checks y transformaciones adicionales pueden usar el export opcional
`migrationAuthoring: SsotAuthoringRuntime`, que reutiliza solamente `readSql`,
`readQuery` y `loadDataContext` del runtime existente. No exige callbacks de releases,
historia, deployment o replay. Guardar SQL no lo ejecuta.

`provisionDatabase(session, settings)` usa la conexión administrativa inicial para
crear roles faltantes y el schema del owner, con privilegios de datos para app.
`appPermissionSql` genera los grants guardados en la migración; se ejecutan como
pasos de esa migración. `verifyDatabasePermissions`
lee ownership y privilegios de todas las tablas esperadas y rechaza app administrativo,
miembro de owner o con CREATE en el schema. Owner/app incluyen sus credenciales
en los settings; el CLI sólo expone nombres.

## Aplicar y consultar estado

```sh
postgres-migrations apply --ssot dist/system.js --database dist/database.js
postgres-migrations status --ssot dist/system.js --database dist/database.js
```

`apply` reutiliza inferencia y generación cuando el SSOT cambia. Si falta una
resolución, guarda el draft y devuelve los cambios pendientes sin aplicar SQL.
Después de completar las decisiones con `resolve`, se puede repetir `apply`.
Para una base que ya tenga una release inicial publicada, suministrar
`--baseline <release-dir>` al importar el catálogo; sus archivos se conservan.

La conexión `initialUser` crea inicialmente roles y schemas del owner, incluido
el journal. El owner no necesita CREATE sobre toda la base. Las operaciones y
el historial usan conexiones del owner; la aplicación sólo recibe permisos CRUD
sobre las tablas esperadas. El journal contiene installation, migration_history
y execution_attempt. Se conservaron sus formatos, sin borrar historial existente.

La aplicación valida los archivos, el prefijo aplicado y el drift del head guardado
antes de ejecutar. Un lock de sesión evita ejecuciones concurrentes. Cada migración
verifica schema/constraints, checks de datos declarados y permisos dentro de su
transacción, antes de registrar éxito y avanzar el puntero atómicamente.
Los fallos revierten SQL y dejan una tentativa registrada. Los resultados inciertos
de commit/rollback se reconcilian con el puntero; una conexión anterior todavía
activa bloquea esa reconciliación. `status` lee el historial y comprueba drift.

Se eliminaron activación de deployments, readiness, política de rehearsal y
preparaciones correctivas con historial separado. El drift sigue requiriendo
reconciliación explícita del usuario; no se corrige automáticamente. Los documentos
T01–T23 describen el diseño histórico y no son el contrato del CLI actual.

## Contratos internos y flujos

Los ocho comandos se agrupan en inspección (capture/assess/status), autoría
(infer/resolve/generate/data) y aplicación (apply). Provisioning y recuperación
son fases de aplicación; no agregan un workflow de deployment.

El CLI valida los argumentos requeridos y pasa opciones tipadas por comando:
data requiere SQL/contrato e id; infer requiere id. Los artifacts inmutables se
decodifican completos al cargarlos, reutilizando los decoders del core y el mismo
contrato de filas/checkpoints que usa el compilador. El ejecutor conserva checks
de referencias, datos, hashes, permisos y resultado de transacciones; no repite
las comprobaciones de forma del loader. Los objetos SQL soportados correlacionan
su kind con la identidad y el parent. Las tentativas usan resultados tipados de
conexión y una sola escritura inicial. ArtifactResult/ArtifactProblem son aliases
de ValidationResult/Problem, sin una propiedad message paralela a messageKey.

Los drafts también se decodifican completos en la lectura, antes de verificar su
revisión. Las referencias de campos, dominios y ports usan un solo decoder
compartido con las transformaciones y checkpoints inmutables. La compatibilidad
con snapshots y transformaciones se comprueba después, sobre valores tipados.

El ordenamiento de dependencias y la consulta de ancestros se comparten entre
SQL manual y datos. Se conserva la política de orden existente: cola lexicográfica
para SQL manual/DDL y capas completas para capturas de datos. Se eliminaron el
loop inalcanzable de filas manuales, los wrappers sin consumidores y los helpers
reemplazados por pasos persistidos. El compilador rechaza locales y parámetros
sin uso; los checks de tipos siguen siendo aserciones exportadas.
