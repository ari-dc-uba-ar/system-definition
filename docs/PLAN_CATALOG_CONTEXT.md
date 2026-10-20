# Inspección estable respecto del search_path del llamador

La integración completa de Meta desde descripciones TypeScript ya reproduce sus
68 tablas, 570 columnas, 273 constraints y 252 índices con generación limpia e
incremental. Requiere search_path=pg_catalog, igual que su adaptador de inspección.

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

Según CLAUDE.md, implementación pendiente de revisión de estas dos pruebas.
