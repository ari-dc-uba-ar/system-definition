# Integración con una única entrada SSOT

La aplicación exporta `ssot` desde su módulo de definiciones:

```typescript
import {definePostgresSystem} from '@system-definition/postgres-migrations/ssot';
export const ssot = definePostgresSystem(context, {
    systemId: 'mi-sistema', entities, schema: 'ssot',
});
```

El contexto conserva comportamientos y validadores; la definición contiene datos
serializables. El constructor preserva los tipos y literales concretos. La aplicación
no arma manifiestos, hashes, conexiones de migración ni transacciones propias.

```sh
postgres-migrations bootstrap --ssot dist/system.js
postgres-migrations publish --ssot dist/system.js
postgres-migrations install --ssot dist/system.js
postgres-migrations verify --ssot dist/system.js
postgres-migrations status --ssot dist/system.js
```

El CLI lee `.env` cuando existe y respeta variables ya definidas. `PG*` identifica la
conexión de aplicación; `MIGRATION_PGUSER`/`MIGRATION_PGPASSWORD` (o
`MIGRATION_DATABASE_URL`) identifica al dueño. `POSTGRES_USER`/`POSTGRES_PASSWORD`
se usa únicamente en bootstrap. Nunca se guardan contraseñas en releases.

Para `text`, `integer` y `boolean` se incluyen mappings PostgreSQL. Otros dominios
almacenados declaran `typeMappings` junto a sus definiciones. El schema predeterminado
es `ssot`. Bootstrap prepara dos roles distintos y el schema; el release declara
USAGE y CRUD para la aplicación sin propiedad ni permiso CREATE.

`publish` verifica clean-create en una base temporal propia y publica el release
`initial` inmutable en `migrations/releases/initial`. No reemplaza un ID publicado
con otro contenido. `install` carga bytes verificados, rechaza tablas no registradas,
toma el lock del consumidor, verifica, registra el intento y confirma DDL y baseline
en una sola transacción. Los intentos existen antes del primer baseline: una
instalación fallida conserva su evidencia sin afirmar un head inexistente.

`verify`/`status` verifican la instalación existente sin crear bases temporales.
Normalizan definiciones PostgreSQL y descartan sólo índices propiedad de constraints;
los índices independientes y otros objetos extra siguen siendo drift. Corren los
checks publicados de acceso y datos administrados.

La entrada simple cubre publicación e instalación inicial, más verificación y
status. La autoría de upgrades, decisiones destructivas y transformaciones de datos
continúa en las APIs existentes de `MigrationProject`; no se inventan esas decisiones
ni se sustituyen sus gates por defaults permisivos. El CLI `--project` sigue disponible.

## Evidencia de esta integración

- Regresión de compilación: una configuración capture con contexto concreto ya no
  exige fields `never` (`test/cli-capture-test.ts`).
- Preservación de tipos y definición serializable (`test/ssot-definition-test.ts`).
- Regresión PostgreSQL del primer install y su intento durable:
  `node scripts/test-first-install-integration.js` (PostgreSQL 18.6).
- La suite existente sigue cubriendo authoring, checkpoints, drift, recovery y gates.

La revisión del desarrollador queda pendiente; estos resultados describen pruebas
del agente, no una revisión atribuida al programador.
