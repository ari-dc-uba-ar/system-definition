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
docker compose exec -T node npm run test:all
```

La suite compila y ejecuta los casos `inferred`, `data`, `destructive` y
`manual` mediante la API de biblioteca, en bases temporales cuya propiedad
verifica el proveedor. También comprueba rollback y validadores históricos.
`studentProject` es la composición de esos ejemplos de biblioteca.

El CLI actual carga directamente módulos `--ssot` y `--database`, sin
`--project`. El módulo de SSOT exporta `ssot` y `sqlMapping`; la conexión
exporta `databaseSettings`. Ver los contratos y comandos en
[LEEME-SSOT.md](../../consumers/postgres-migrations/LEEME-SSOT.md).

`infer` guarda un draft; `resolve` recibe respuestas ligadas a su revisión;
`generate` publica archivos inmutables. `data` permite SQL de datos con
contrato explícito de efectos. `apply` genera lo necesario y ejecuta sólo
migraciones sin decisiones pendientes; `status` consulta historial y drift.
Todos los comandos son no interactivos. Las decisiones nunca modifican una
migración publicada. No hay activación de aplicación ni deployment gate.
