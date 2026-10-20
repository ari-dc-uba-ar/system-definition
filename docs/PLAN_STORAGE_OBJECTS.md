# CHECKs e índices desde el descriptor de almacenamiento

El vocabulario PgObjectInfo, la inspección, la normalización y los generadores ya
representan CHECKs e índices. Falta el enlace desde el módulo SSOT tipado hasta la
proyección/estado archivado. Este paso reutiliza esas herramientas: no agrega otro
parser, generador, motor de migraciones ni perfiles PostgreSQL adicionales.

Contrato propuesto: mapas opcionales `checks` e `indexes` dentro de cada entidad
de `postgresStorage`. Las claves son los nombres físicos. Los CHECKs conservan
`definition` y `columns` (referencias a campos declarados); los índices independientes
conservan `definition`. Los atributos existentes validación/enforcement y valid/ready
se completan como true; ownerConstraint es null. Schema/tabla/identidad se derivan
de la entidad contenedora y de la proyección. Las definiciones SQL explícitas
permanecen vinculadas a esos nombres y schema: un cambio de namespace requiere SQL
correspondiente, sin reescrituras silenciosas. Omitir los mapas conserva bytes/hashes
archivados. Se reutiliza la validación SQL y de nombres existente.

Cuatro pruebas en `ssot-check-index-storage-test.ts`: proyección, generación
existente, archivo/hash y rechazos de referencias/nombres/SQL. Compilan y fallan
porque el decoder aún rechaza `checks`/`indexes`. No usan datos ni un servidor.
El contrato público deberá restringir las columnas en tipos, con asignabilidad en
ambos sentidos y casos negativos, además de los checks de runtime.

El programador aprobó el contrato y las cuatro pruebas. Implementación completada
en el descriptor/proyector existentes, con tipos públicos derivados del vocabulario
PgObjectInfo. Se reutilizan constraintSql/indexSql; sus imports de identificadores
ahora vienen de pg-sql para evitar un ciclo de dependencias con el proyector.
El namespace se transmite por decodeSqlSsot/loadSsot, estados y CLI con database.
Se conservan las propiedades omitidas; no se agregan defaults nuevos a archivos viejos.

Validación: seis pruebas de contrato (incluidos tipos bidireccionales y negativos,
namespace distinto de public y compatibilidad sin mapas) y dos round trips reales
de creación limpia/incremental con CHECK, índice parcial, archivo, enforcement y
drift. Los **293 tests del consumidor pasan** contra PostgreSQL 18.6 aislado.
El documento PLAN_HANDOFF_POSTGRES.md editado por el propietario no se modificó.

Repetición de los tests de contrato:

```sh
node node_modules/typescript/bin/tsc -p consumers/postgres-migrations
node node_modules/mocha/bin/mocha.js --exit consumers/postgres-migrations/dist/test/ssot-check-index-storage-test.js
```
