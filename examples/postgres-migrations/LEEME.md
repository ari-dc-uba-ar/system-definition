# Ejemplos del consumidor PostgreSQL

Estos ejemplos siguen la separación de `examples/common`: primero las descripciones
serializables del sistema y las migraciones, después el comportamiento y la conexión con
el entorno. No son scripts de tests disfrazados de ejemplos.

- `student-context.ts`: tipos de dominio, comportamiento de máquina y completador.
- `students.ts`: tres estados del SSOT, declarados con `defineRecord`, `defineEntity`,
  `defineEntities` y `captureSystemSnapshot`.
- `student-storage.ts`: representación PostgreSQL y codecs para leer valores de máquina.
- `student-migrations.ts`: ejemplos de las tres categorías y de SQL escrito a mano.
- `student-runtime.ts`: composición de los recursos, validadores históricos y reconstrucción
  del historial sobre bases temporales cuya propiedad conoce el proveedor.
- `validation-*.ts`: entradas de los validadores históricos. El bundle incluye el snapshot
  y sus comportamientos; su hash impide reemplazarlos por el código de una versión posterior.

En `student-migrations.ts`, `inferredDraft` agrega una columna nulleable sin escribir SQL.
`dataOnlyDraft` copia datos entre columnas con un esquema que no cambia. `destructiveDraft`
conserva el correo anterior mediante una transformación y descarta la nota con una razón
explícita. `manualDraft` declara los efectos de un recurso SQL escrito por el desarrollador.
Todos terminan en el mismo compilador y en el mismo motor transaccional.

La consulta de origen se construye con `buildSourceSelection`. La transformación declara
entradas, salidas y tipos mediante `completeTransformation`. `completeDataMigration`
comprueba la correspondencia entre esas salidas y las columnas destino. El compilador
genera preparación, captura privada, escritura, conservación, checkpoints de validación
y eliminación de las columnas autorizadas. La comparación final incluye las tablas,
columnas, restricciones e índices reales de la aplicación.

Los ejemplos se compilan por separado después del consumidor para preservar la separación
entre el núcleo y PostgreSQL. Desde la raíz del repositorio:

```powershell
docker compose up -d
docker compose exec -T node npm test
docker compose exec -T node node consumers/postgres-migrations/dist/src/cli-main.js --help
docker compose exec -T node node consumers/postgres-migrations/dist/src/cli-main.js generate --project examples/postgres-migrations/dist/student-runtime.js --out local-generated-student-migration
```

El último comando genera un directorio nuevo con SQL, manifiesto, recursos y validadores,
después de ejecutar el resultado sobre PostgreSQL 18.6. No reemplaza un directorio existente.
Usa las variables `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` y `PGDATABASE` del entorno;
el usuario PostgreSQL debe poder crear las bases temporales de verificación.

Para probar otro caso, un módulo de proyecto puede exportar:

```javascript
const {studentProject} = require('./examples/postgres-migrations/dist/student-runtime.js');
exports.createMigrationProject = () => studentProject('data');
```

Las opciones son `inferred`, `data`, `destructive` y `manual`. El historial del ejemplo
parte de un baseline explícito. Una aplicación existente debe aportar su baseline real,
el camino publicado completo hasta el origen y el resolvedor de artefactos; el adaptador
reproduce ese historial antes de inferir diferencias con el nuevo SSOT.

`add-data` y `resolve` permiten interacción solamente fuera de CI y con terminal.
`add-data` ofrece columnas compatibles, transformaciones registradas, destino e identidad;
también acepta contratos JSON para selecciones con joins y transformaciones de conjuntos.
`infer`, `generate`, `verify`, `apply` y `deployment-gate` nunca esperan respuestas.
Una verificación fallida bloquea tanto la aplicación como el deployment. Las decisiones
se guardan en drafts; nunca modifican migraciones publicadas.

La suite completa compila y ejecuta estos ejemplos, además de probar rollback tardío,
verificación fallida, resolución de conflictos y ausencia de activación tras un fallo:

```powershell
docker compose exec -T node npm run test:all
```
