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

## Historial mínimo

El catálogo ordenado usa `MigrationCatalogInfo` del core: releases y migraciones
publicadas con sus hashes. Se conserva junto a los archivos inmutables generados;
incluye las migraciones que todavía no se aplicaron. La base sólo guarda el
baseline, el puntero actual y la secuencia confirmada de migraciones aplicadas.

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
historial juntos y comprueba drift contra el schema guardado para el hash del head
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
