# Cargar el SSOT

La aplicación define su modelo con `system-definition` y exporta `ssot`, el
`SystemSnapshotInfo` que produce `captureSystemSnapshot`. No necesita tipos ni
constructores propios del consumidor de migraciones.

```typescript
const result = captureSystemSnapshot(context, {systemId, entities, records});
if (!result.ok) throw new Error(JSON.stringify(result.problems));
export const ssot = result.value;
```

El consumidor carga ese módulo y usa el decoder existente del core:

```typescript
import {loadSsot} from '@system-definition/postgres-migrations/ssot';
const result = await loadSsot('dist/system.js');
```

```sh
postgres-migrations capture --ssot dist/system.js
```

La función devuelve `ValidationResult<SystemSnapshotInfo>`, ambos tipos del core.
Este paso carga el modelo y permite conocer sus entidades. La integración
de creación, permisos, generación y ejecución de migraciones se refactorizará
por separado. Los comandos existentes con `--project` conservan su implementación.

## Base y usuarios provistos por la aplicación

La aplicación exporta `databaseSettings` desde su módulo de configuración:

```typescript
import type {DatabaseSettings} from '@system-definition/postgres-migrations/database';
export const databaseSettings = {
    database: {host: 'localhost', port: 5432, database: 'mi-base'},
    owner: 'schema_owner',
    appUser: 'app_user',
} satisfies DatabaseSettings;
```

`database` usa el `ClientConfig` del driver PostgreSQL, con el nombre de base
requerido. `owner` y `appUser` son identidades distintas; la aplicación determina
sus nombres. `loadDatabaseSettings` carga este valor sin conectarse ni modificar
roles. El usuario owner se usará para migraciones y el appUser para datos.

```sh
postgres-migrations capture --ssot dist/system.js --database dist/database.js
```

Así el consumidor recibe ambos inputs. La salida del CLI muestra el modelo,
host/puerto/base y nombres de usuarios; omite parámetros de autenticación del
driver. La creación de roles y la verificación de privilegios son pasos separados.
