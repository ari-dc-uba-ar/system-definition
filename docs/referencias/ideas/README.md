# Referencias de ideas incluidas en el handoff

Copias exactas de las tres fuentes de diseño consultadas en el checkout hermano `../ideas` al preparar las migraciones. Se incluyen para que el agente pueda recibir solamente este repositorio sin perder contexto ni encontrar enlaces obligatorios rotos.

- [SSOTIGAD](src/SSOTIGAD.md): marco conceptual.
- [Definición de entidades](src/SSOTIGAD-details/definición-entidades.md): borrador de representaciones físicas y entidades.
- [Mantener actualizada la estructura DB](src/mantener-actualizada-estructura-db.md): versiones, scripts y verificación.
- [LICENSE](LICENSE): licencia original del repositorio fuente, conservada sin cambios.
- [snapshot.json](snapshot.json): rutas de origen, longitudes y SHA-256 de los bytes copiados.

No es un checkout completo de ideas ni una especificación nueva. Los borradores conservan preguntas abiertas/propuestas históricas. Para implementar rigen las [decisiones U01–U11](../../migraciones-trazabilidad.md), los contratos del handoff y el código vigente de system-definition. No reabrir decisiones ya tomadas por leer alternativas en estas fuentes.

No editar estas copias para acomodarlas a la implementación. Una actualización deliberada de fuentes debe recopiarlas, actualizar hashes y explicar el impacto en trazabilidad. La `.gitattributes` local conserva los bytes copiados de fuentes/licencia al transportar el repositorio entre sistemas operativos.
