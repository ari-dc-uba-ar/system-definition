# Punto de entrada para implementar migraciones

Este repositorio contiene el handoff completo y su [checklist compartida](docs/migraciones-checklist.md). La checklist registra progreso; los documentos enlazados definen el comportamiento. La preparación del handoff no acredita implementación ni pruebas del sistema.

## Orden de lectura

1. [CLAUDE.md](CLAUDE.md): convenciones, capas y flujo TDD/revisión del repositorio.
2. [Decisiones U01–U11 y procedencia](docs/migraciones-trazabilidad.md): decisiones ya tomadas, límites y fuentes.
3. [Checklist T01–T23](docs/migraciones-checklist.md): dependencias, entregables, criterios y evidencias.
4. [Especificación general](docs/implementacion-migraciones.md) y [contratos generales](docs/migraciones-contratos.md).
5. [Autoría de las tres categorías](docs/migraciones-autoria.md) y [contratos detallados de autoría y resolución](docs/migraciones-autoria-contratos.md).
6. Código actual y secciones específicas enlazados desde la tarea elegida. La [matriz de reutilización](docs/implementacion-migraciones.md#31-matriz-obligatoria-de-reutilización-por-componente) distingue funciones que importar, patrones que adaptar y código nuevo.

Las tres fuentes de diseño utilizadas de `../ideas` están incluidas sin modificar en [referencias/ideas](docs/referencias/ideas/README.md), con licencia y hashes. No se necesita ese checkout hermano para leer este handoff. Los documentos de referencia conservan propuestas históricas: las decisiones U01–U11 y el código actual fijan el alcance de implementación.

## Instrucción para entregar al agente

```text
Implementa el sistema completo de migraciones descrito en este repositorio.
Empieza por MIGRACIONES.md y sigue su orden de lectura.

Usa docs/migraciones-checklist.md como registro único de progreso T01–T23.
Lee contratos y código de reutilización antes de implementar cada tarea.
Respeta las dependencias; conserva los IDs aunque cambie el orden de trabajo.
No declares una tarea terminada sin evidencia de sus criterios de aceptación.
Registra por separado implementación, verificación y revisión del desarrollador.
Nunca marques la revisión del desarrollador en su nombre.

Las decisiones U01–U11 están tomadas. No vuelvas a pedirlas ni sustituyas el
alcance completo por un MVP. SQL transforma los datos; los comportamientos
TypeScript existentes los validan. El SSOT es obligatorio. La historia define
el origen; drift bloquea. Generación y deployment no preguntan: los conflictos
se resuelven mediante migration resolve, fuera del despliegue.

Reutiliza símbolos y patrones indicados. Mantén Def/Info serializables,
contextos, literales, ValidationResult/Problem y la separación del consumidor.
Implementa y verifica los tres tipos de migración y todos los gates/recovery.

Sigue el flujo de CLAUDE.md y las instrucciones expresas del desarrollador.
El permiso para implementar no implica que puedas atribuirle una revisión.
Si una firma del handoff no compila, demuestra el caso y ajusta el mecanismo
sin cambiar su comportamiento. Si hay una contradicción real de producto,
regístrala con referencias concretas y pide sólo esa decisión.

Antes de terminar una sesión, actualiza checklist, evidencias y siguiente paso.
No confundas tests propuestos, omitidos o bloqueados con tests ejecutados.
La implementación sólo está completa cuando pasa la aceptación final.
```

## Qué debe recibir el desarrollador

Por cada tarea: código afectado, símbolos reutilizados, pruebas ejecutadas con resultado, límites o bloqueos y enlace a evidencia. El agente puede implementar y verificar; el desarrollador registra su revisión. La sección de reanudación de la checklist permite cambiar de agente sin reconstruir la conversación.
