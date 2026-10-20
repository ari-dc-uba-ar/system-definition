# Inspección estable respecto del search_path del llamador

La integración completa de Meta desde descripciones TypeScript ya reproduce sus
68 tablas, 570 columnas, 273 constraints y 252 índices con generación limpia e
incremental. Antes del arreglo requería search_path=pg_catalog, igual que su
adaptador de inspección. Ahora también pasa con la configuración normal del llamador.

Gap genérico observado: pg_get_indexdef y pg_get_constraintdef imprimen referencias
calificadas o no según la visibilidad del objeto para la sesión. El normalizador
actual conserva esa diferencia y assessSchema puede anunciar drift sin cambio DDL.
El consumidor no fija ese contexto en su conexión/inspección.

Dos pruebas reproducen el problema contra PostgreSQL 18.6 real: un índice y una FK
se inspeccionan con y sin su schema en search_path. La comparación normalizada debe
ser igual y la inspección debe conservar el search_path del llamador. Hoy las dos
fallan: sólo difiere la calificación del schema. No se usan datos de producción.

La expectativa a revisar es estabilidad del catálogo sin efectos persistentes en
la configuración del llamador. El arreglo pertenece al consumidor PostgreSQL;
no a Meta ni a un perfil PostgreSQL 16. No se propone quitar schemas con regex,
ignorar las diferencias ni agregar un segundo normalizador.

El programador aprobó las dos expectativas. Implementación completada en
inspectSchema: un savepoint de nombre único delimita SET LOCAL search_path=pg_catalog,
la única consulta de inventario y ROLLBACK TO/RELEASE. Se usa la misma conexión para
ver DDL no confirmado. No se releen ni reescriben las descripciones SQL con regex.
Si SAVEPOINT informa 25P01 (no hay transacción explícita), el inspector abre su propia
transacción READ ONLY y siempre la termina con ROLLBACK. Cualquier otro fallo al
abrir el scope se conserva como error; nunca se revierte la transacción del llamador.

El rollback del scope cancela SET LOCAL incluso después de un error SQL; conserva
tanto los valores locales como los de sesión del llamador. Referencias PostgreSQL:
[SAVEPOINT](https://www.postgresql.org/docs/18/sql-savepoint.html) y
[SET](https://www.postgresql.org/docs/18/sql-set.html).

Validación contra PostgreSQL 18.6 aislado: **297 tests del consumidor pasan**.
Los casos revisados comprueban igualdad cruda y normalizada de índices/FKs. Casos
adicionales prueban fallo de catálogo real (división por cero), DDL/DML previo no
confirmado, recuperación de la transacción del llamador, inspección sin BEGIN,
ausencia de transacciones abiertas y no convertir un SET LOCAL previo en SET SESSION.
Los dobles de sesión aceptan sólo los comandos de control esperados; mantienen sus
aserciones anteriores sobre ejecución, rollback, journal y consultas de inventario.

Meta permite esa secuencia exacta dentro de su transacción read-only propia. Sigue
exigiendo un solo inventario parametrizado con su fingerprint original, que no
cambió. Sus 10 checks de adaptador y ambos replays completos de esquema pasan.
El perfil 16.15 continúa en Meta; el consumidor no agregó compatibilidad PostgreSQL 16.
PLAN_HANDOFF_POSTGRES.md, editado por el propietario, no se modificó.
