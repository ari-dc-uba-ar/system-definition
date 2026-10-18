# Adopción de un esquema existente: primer paso

Rama: `feat/existing-schema-handoff`, creada desde `refactor/migrations-full`.

El propietario eligió ampliar el consumidor PostgreSQL de system-definition para conservar el contrato persistente de Meta. Producción usa PostgreSQL 16.15; la disponibilidad de un respaldo restaurado todavía no está confirmada. No se modificó ningún servidor de producción.

## Primer contrato sometido a revisión

La inspección debe conservar los parámetros físicos de los tipos que informa PostgreSQL: por ejemplo varchar(64), numeric(12,2) y timestamp(3). Esos parámetros pertenecen al estado observado y deben participar en la comparación de deriva.

Dos pruebas nuevas en `consumers/postgres-migrations/test/schema-typmod-postgres-test.ts`:

1. Crear columnas con parámetros y verificar los modificadores observados: ['64'], ['12','2'] y ['3']; varchar sin límite conserva [].
2. Inspeccionar varchar(64), cambiarlo a varchar(128), volver a inspeccionar y exigir una diferencia en `type.modifiers`.

Compilación correcta. Ejecución contra PostgreSQL 18.6 real: **0 correctas, 2 fallidas**, por los motivos esperados. La primera recibe [] donde esperaba ['64']; la segunda recibe igualdad donde esperaba deriva. Los datos de prueba viven en una base y un rol propios, con esquemas transaccionales; ambos recursos temporales fueron eliminados. No se usó la base de la aplicación.

Para repetir las pruebas, configurar `POSTGRES_HANDOFF_TEST_URL` con una base desechable explícita y ejecutar desde la raíz:

```sh
node node_modules/typescript/bin/tsc -p consumers/postgres-migrations
node --enable-source-maps node_modules/mocha/bin/mocha.js --exit consumers/postgres-migrations/dist/test/schema-typmod-postgres-test.js
```

Sin esa variable las pruebas quedan pendientes para que la suite ordinaria no conecte por su cuenta a una base. El fixture no carga archivos .env y revierte su transacción incluso ante una aserción fallida.

Se respeta la regla de CLAUDE.md: mostrar los rojos y esperar la revisión del programador antes de corregir. No se modificó código de implementación.

## Trabajo posterior a la revisión

1. Corregir la inspección de modificadores y demostrar los verdes sobre PostgreSQL real.
2. Revisar la representación de tipos parametrizados y los contratos existentes de mapping/proyección, manteniendo compatibilidad para los consumidores actuales.
3. Incorporar de forma incremental identidades, nombres físicos y atributos de constraints/índices, con pruebas de adopción y deriva. No confundir ejecutar SQL explícito con poder representar y verificar el estado resultante.
4. Preparar la adopción de una línea de base observada, sin recrear tablas pobladas ni simular el historial de Django.

La ampliación del consumidor no autoriza a ejecutar la adopción o una actualización de PostgreSQL en producción. Esas operaciones requieren evidencia de la base real y el ensayo correspondiente.
