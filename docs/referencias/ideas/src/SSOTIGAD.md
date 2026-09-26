# SSOTIGAD — Single Source Of Truth Implies Good Application Design

> Documento de diseño en construcción. Refleja el estado de la conversación hasta el momento; hay secciones cerradas y otras marcadas explícitamente como abiertas/pendientes.

## 1. Motivación

Los frameworks que generan backends y frontends completos a partir de la descripción de tablas y relaciones (CRUDs genéricos basados en grillas, manejo general de endpoints, procedimientos con lógica custom) suelen acumular, con los años, un tipo particular de deuda: no técnica en el sentido de "código viejo", sino **conceptual** — decisiones de diseño que tenían sentido en el momento en que se tomaron, pero que hoy se harían distinto porque el ecosistema del lenguaje maduró.

Los síntomas típicos de esa deuda conceptual son:

- Código duplicado en varios lugares para representar el mismo concepto.
- Un single source of truth (SSOT) que existe a nivel de metadata, pero no está fuertemente tipado.
- Ausencia, desde el diseño original, de objetivos explícitos de DRY, KISS, y de grado de SSOT.

El objetivo de este framework es lograr ese mismo tipo de resultado funcional, pero diseñado desde el principio con objetivos explícitos: minimizar código duplicado, maximizar SSOT, tipado fuerte de punta a punta, seguridad y simplicidad.

## 2. Principio central: Single Source of Truth (SSOT)

### 2.1 Definición operativa

Un concepto del sistema debe mencionarse por nombre en el **mínimo número de lugares necesarios para tener sentido semántico**, y en ningún lugar más.

Ejemplo canónico: un campo booleano `esImportador` en la entidad Cliente, que solo se usa para mostrarse en el "Libro de Ventas" por una razón regulatoria. Ese nombre debe aparecer en exactamente dos lugares:
1. La definición de la entidad Cliente.
2. La definición del listado "Libro de Ventas".

En ningún otro lugar del código debería aparecer una mención a `esImportador`. Todo lo demás (columna SQL, validación, endpoint CRUD, formulario de edición, columna en la grilla) se **deriva** automáticamente de esas dos menciones.

### 2.2 Repetición semántica vs. repetición técnica

No toda repetición es mala. Hay conceptos de negocio importantes (por ejemplo, el código de cliente) que aparecen legítimamente en múltiples definiciones: en la FK de otra entidad, en parámetros de un procedimiento, en relaciones. Esa repetición **informa** algo y es deseable.

Lo que el framework debe eliminar es la repetición **técnica**: el mismo campo mencionado una y otra vez en clases, interfaces, DTOs, validadores y mappers solo por limitaciones de la arquitectura, sin aportar información nueva.

### 2.3 Forma de la definición

- La fuente de verdad son **variables del lenguaje de programación**, tipadas — no JSON externo, no introspección del esquema de base de datos.
- Esas definiciones deben ser **serializables** (representables como JSON plano). Esto implica que no pueden contener funciones ni lógica embebida directamente.
- Cuando una entidad o campo necesita comportamiento especial (validación custom, cálculo, hook), ese comportamiento se referencia por **nombre** (string identificador) dentro de la definición, y se resuelve contra una implementación registrada aparte, fuera de la definición serializable.
  - Pendiente de decidir: si ese registro de comportamientos nombrados es centralizado o distribuido por módulo/feature.
  - Pendiente de decidir: catálogo completo de "tipos de comportamiento especial" más allá de validación y formato (cálculo de valores derivados, hooks pre/post, permisos dinámicos, etc.).

### 2.4 Isomorfismo navegador/servidor

El SSOT (al menos su parte pública) se escribe una sola vez y se consume tanto en el servidor como en el navegador. Esto es un fuerte argumento a favor de que backend y frontend compartan el mismo lenguaje de programación.

### 2.5 Tipos de dominio (conceptuales, no de lenguaje ni de base de datos)

Un tipo, en este framework, no es un tipo del lenguaje de programación (`number`, `string`) ni un tipo de la base de datos (`integer`, `varchar`). Es un **tipo del dominio del sistema** — por ejemplo, "Edad" es un tipo con semántica propia, que internamente sabrá cómo representarse, qué rango es válido, cómo se formatea, etc.

- Pendiente de decidir: si un tipo de dominio se compone de tipos más primitivos (Edad = entero con rango 0–150) o se define desde cero cada vez.
- Pendiente de decidir: si los tipos de dominio son reutilizables entre proyectos (librería común: edad, email, CUIT, moneda, porcentaje) o específicos de cada sistema construido con el framework.

## 3. Categorías del Single Source of Truth

### 3.1 Entidades

Una entidad es cualquier cosa que puede representarse como grilla en la interfaz. Puede ser:
- Una tabla física en la base de datos.
- Una vista o query sobre varias tablas (grilla virtual).
- Un dato sin persistencia SQL (por ejemplo, proveniente de una API externa o calculado en memoria).

**Atributos a nivel de entidad:**
- Clave primaria, que puede ser simple o **compuesta** (varios campos). Preferencia explícita por claves naturales sobre `id` sintético autoincremental, cuando existe una clave natural razonable.
- Columnas calculadas: campos derivados de otros campos de la misma entidad (por ejemplo, `nombre_completo` a partir de nombre y apellido).
- Subgrillas: relaciones hijas que se embeben como grillas anidadas en la UI (por ejemplo, Provincias dentro de País, o Facturas dentro de Cliente), unidas por FK pero declaradas explícitamente como tales.

**Atributos a nivel de campo:**
- Tipo de dominio (con sus opciones específicas: decimales, cantidad de caracteres, etc., según corresponda al tipo).
- Label / título de columna (separado del nombre técnico del campo).
- Descripción (para tooltip o documentación).
- Grupo de columna: agrupador visual con "sobretítulo" (por ejemplo, "País" arriba, con "código" y "nombre" como subcolumnas debajo).
- Valor por defecto (que podría ser constante o un nombre que remita a un método, por ejemplo la fecha del día, el usuario logueado, etc...).
- `isName`: marca el campo que da el nombre legible de un código (por ejemplo, en la entidad País, el campo `nombre` es el `isName` del código ISO). Cualquier grilla que muestre ese código automáticamente agrega al lado la columna del `isName`, salvo override explícito.
- `inComboBox`: campos adicionales (más allá del código y el `isName`) que se muestran en el desplegable cuando ese código se referencia como FK.

**Comportamiento derivado para FKs (aplica tanto en grillas como en parámetros de procedimientos):**
- Cualquier campo que sea FK se renderiza automáticamente como combo box editable-y-desplegable (tipeable, tipo autocomplete), mostrando código + `isName` + campos `inComboBox`.
- Si la entidad referenciada tiene PK compuesta (ejemplo: Localidad = [Provincia, Localidad]):
  - Si ya se seleccionó la Provincia en el mismo formulario/fila, el combo de Localidad se filtra a esa provincia.
  - Si no hay Provincia seleccionada, el combo muestra todas las localidades.
  - Si el usuario elige una Localidad sin haber elegido Provincia antes, el framework autocompleta la Provincia a partir de la PK compuesta de la localidad elegida.

### 3.2 Procedimientos

Un procedimiento se puede pensar como un endpoint destinado a recibir parámetros (típicamente desde un formulario) y ejecutar una acción con procesamiento interno más complejo que un simple guardado (ejemplo: cierre del mes).

**Definición agnóstica de protocolo**: puede exponerse por REST, por RPC, o invocarse directamente como función (por ejemplo, en tests), sin cambiar la definición.

**Atributos:**
- Nombre.
- Parámetros de entrada, con sus tipos de dominio (y por lo tanto combo box automático si algún parámetro es FK, con la misma lógica de PK compuesta que en grillas).
- Parámetros/estructura de salida.
- Roles autorizados.
- Códigos de error posibles.
- Pantalla custom (opcional): si no se define, hay una pantalla genérica por defecto.
- Método custom de interpretación de la respuesta (opcional): si no se define, hay un visor por defecto (tabla si la respuesta es un array de objetos compatible con grilla; visor JSON en otro caso).
- Label del botón de ejecución (configurable; por defecto genérico, pero se puede personalizar, por ejemplo "Cerrar el mes").
- Flag para desactivar el bookmarking de la fase de resultado (ver más abajo), pensado para procedimientos costosos o con efectos secundarios donde no conviene re-ejecutar por recarga o link compartido.

**Comportamiento por defecto (todo procedimiento lo tiene, salvo override):**
- URL GET con formulario auto-generado a partir de los parámetros de entrada.
- Botón de ejecución, instancia del widget único de navegación (ver sección 4).
- Modelo de **dos fases**:
  1. **Formulario activo** — parámetros editables, botón "ejecutar" activo, sin resultados (porque en esta fase no los hay).
  2. **Resultado** — parámetros en modo readonly (muestran qué se usó), resultado de la ejecución visible, botón "editar".
  - Transición 1→2: acción "ejecutar".
  - Transición 2→1: acción "editar" (descarta el resultado, vuelve el formulario editable con los mismos valores).
- La fase 2 es, por defecto, bookmarkeable/compartible por URL (mismo criterio que las grillas), salvo que se anule explícitamente por configuración (ver flag arriba).

**Invocación desde grillas**: una grilla puede tener columnas de acción (botones/links, no datos de la entidad) que invocan un procedimiento saltando directo a la fase 2, porque los parámetros ya se conocen desde el contexto de la fila (por ejemplo, botón "Ver Legajo" en la grilla de empleados, usando el código de empleado de esa fila). Es el mismo procedimiento que el accesible por su URL genérica (fase 1) — no hay duplicación de lógica, solo dos caminos de entrada distintos.

### 3.3 Roles y menúes — **pendiente de desarrollar**

Preguntas abiertas, todavía sin resolver:
- ¿Los roles son estáticos y predefinidos, o se contempla algo más dinámico (permisos compuestos, jerarquías, permisos a nivel de fila/dato)?
- ¿La asociación rol↔menú vive en la definición del ítem de menú (qué roles lo pueden ver) o en la definición del rol (qué menú tiene ese rol)?
- ¿Un ítem de menú apunta siempre a una entidad o a un procedimiento, o también puede apuntar a pantallas custom que no son ni CRUD ni procedimiento?

Lo único ya resuelto: los ítems de menú usan el mismo **widget único de navegación** (sección 4) que cualquier otro elemento navegable del sistema, por lo tanto soportan igual la apertura en pestaña nueva con Ctrl+click.

### 3.4 Vistas / grillas virtuales

Cubierto conceptualmente dentro de "Entidades" (sección 3.1): una entidad puede ser una vista/query multi-tabla sin mapear 1 a 1 con una tabla física. No se identificó, hasta el momento, una necesidad de tratamiento aparte.

Debería ser fácil generar automáticamente grillas que representen asignaciones entre entidades. Por ejemplo habiendo e entidades materias, docentes y asignación docente (con un renglón por cada asignación entre docentes y materias) tendría que generarse automáticamente una matriz (similar a la tabla dinámica de Excel). Habría que decidir qué hacer si hay más de una campo de dato en la asingación, si no hay ninguno simplemente es true/false.

Otra grilla que puede ser necesario es la que desnormalice listas simples (por ejemplo teléfonos en la tabla personas), que muestre todo en un solo campo pero que al verlo no se confunda el separador de listas con un caracter dentro del dato y al editar también tiene que ser explícita la diferencia.

## 4. Frontend

### 4.1 Código isomórfico

Si backend y frontend comparten lenguaje de programación, el SSOT público vive en un módulo común, importado por ambos lados, fuertemente tipado en los dos. Es un requisito que condiciona fuertemente la elección de lenguaje (sección 5).

Podrían ser dos lenguajes pero hay que ver cómo evitar la duplicación del algoritmos y el fuertetipadismo en ambos frontend y backend.

### 4.2 URLs legibles y con estado

La URL de una grilla refleja su estado completo: filtro, criterio de orden, y foco de fila (y columna, si tiene sentido). Esto permite:
- Compartir un link a un estado exacto de la grilla.
- Que el botón "atrás" del navegador funcione de forma predecible.

**Modelo de navegación con contexto preservado**: si desde una grilla (con su filtro/orden) el usuario navega a una pantalla de detalle (por ejemplo, "Ver Legajo"), al volver atrás no se reconstruye un estado genérico de la grilla — se restaura exactamente el mismo filtro, mismo orden, y además queda con foco (o resaltada) la fila y el botón que se había presionado, para poder recorrer secuencialmente la lista.

- **Pendiente de decidir**: si el detalle debería tener botones propios de "anterior/siguiente", y si en ese caso el orden que siguen es el canónico de esa entidad o el de la grilla de origen.

### 4.3 Navegación tipo Excel en grillas

Edición inline; flechas para moverse entre celdas; Home/End/PgUp/PgDn con comportamiento de spreadsheet.

### 4.4 Widget único de navegación

Cualquier elemento de la interfaz que navegue a otra pantalla (botón en una grilla, ítem de menú, botón "ejecutar" de un procedimiento, etc.) es una instancia de un mismo componente reutilizable, que:

- Maneja el estado visual/funcional de "seleccionado".
- Con click normal, navega desplazando la pantalla actual.
- Con Ctrl+click, click del medio, o rueda del mouse, abre la URL correspondiente en una pestaña nueva — comportamiento estándar de un link, agnóstico al mecanismo de sesión que se termine eligiendo (si es cookie, viaja solo; si es algo que vive en URL, `sessionStorage`, o header custom, el widget se encarga de propagarlo también a la pestaña nueva).

## 5. Decisión de lenguaje de implementación — **abierta**

### 5.1 Tres condiciones necesarias

1. **Derivar tipos a partir de otros tipos**, quitando o agregando campos, de forma genérica (por ejemplo, `Omit`/`Pick` de TypeScript) — para poder mencionar un campo una sola vez y derivar todas las variantes de tipo que se necesiten (lectura, edición, validación) sin repetirlo.
2. **Reflection tipada**: poder iterar los campos de un objeto por nombre, obtener/asignar valores dinámicamente (para generar SQL — INSERT, SELECT, UPDATE —, o para copiar entre objetos), sin perder la información de tipo de cada campo.
3. **Preservación de tipo fuerte de compile-time a runtime**: si una función recibe una entidad de tipo conocido en compilación (por ejemplo, Cliente), el campo `esImportador` tiene que seguir estando tipado como `boolean` en runtime — no perder el tipado por el hecho de iterar dinámicamente.

### 5.2 Evaluación de candidatos

| Lenguaje | Derivar tipos restando campos | Reflection tipada | Preservación compile→runtime | Observación |
|---|---|---|---|---|
| **TypeScript** | Sí, nativo (`Omit`/`Pick`/mapped types) | Sí (`Object.keys` + acceso dinámico) | Sí | Las tres condiciones son parte del lenguaje, sin macros. Corre nativamente en navegador → isomorfismo directo. Mayor experiencia previa del equipo. |
| **Zig** | Sí (`comptime` puede generar tipos) | Sí (`@typeInfo`, `@field`) | Sí | Cumple las tres de forma nativa. Más verboso, ecosistema web mucho menos maduro que TypeScript. |
| **Nim** | Parcial — no hay equivalente nativo a `Omit`; requiere macro que lea la definición del objeto y genere el tipo derivado | Sí (`fieldPairs`, con `when value is X` para distinguir tipo por campo en compile-time) | Sí, dentro del alcance de las macros usadas | Reflection tipada confirmada; la derivación de tipos exige más trabajo de metaprogramación que en TypeScript. |
| **D** | Parcial — vía mixins + `__traits`/`std.traits`, más manual | Sí (`__traits(allMembers)`) | Sí | Capacidad técnica similar a Nim, ecosistema web más chico. |
| **Crystal** | Débil para este patrón específico | Parcial (macros sobre `@type.instance_vars`) | Parcial | Menos maduro en derivación de tipos que los anteriores. |
| **F# (Type Providers)** | No aplica — resuelve un problema distinto (generar tipos desde una fuente de datos externa, no restar campos de un tipo propio) | — | — | Paradigma no ajustado a este caso de uso. |
| **Scala / Kotlin (JVM)** | Sí (sistemas de tipos sofisticados, especialmente Scala) | Sí (reflection de la JVM) | Sí | Pierden el isomorfismo directo con navegador (no corren nativamente en el cliente sin transpilar). |
| **Go** | No — generics limitados (1.18+) | Limitada | Limitada | Probablemente no alcanza para este patrón. |
| **C# / .NET** | Parcial vía reflection + generics | Sí, pero verbosa (`PropertyInfo`, `FieldInfo`) | Sí | Ecosistema sólido, menor familiaridad previa. |
| **Python** | No hay tipado fuerte real en runtime sin herramientas adicionales | Sí, trivial (`vars`, `getattr`) | No — es más runtime que compile-time | Reflection excelente pero no ofrece garantías de tipo fuerte. |

**Conclusión provisoria**: TypeScript y Zig son los dos candidatos que cumplen las tres condiciones de forma nativa. TypeScript tiene la ventaja adicional de la experiencia previa y el isomorfismo directo con el navegador. Zig queda como alternativa a seguir explorando. Nim y D son técnicamente viables pero exigen más trabajo de metaprogramación para la condición de "derivar tipos restando campos".

## 6. Glosario rápido

- **SSOT**: Single Source of Truth — ver sección 2.
- **Entidad**: unidad de datos representable como grilla (tabla física, vista, o dato sin persistencia SQL) — sección 3.1.
- **Procedimiento**: endpoint con parámetros y procesamiento custom, más allá de un CRUD simple — sección 3.2.
- **`isName`**: campo que provee el nombre legible de un código — sección 3.1.
- **`inComboBox`**: campos adicionales mostrados en el desplegable de un combo de FK — sección 3.1.
- **Widget único de navegación**: componente universal para cualquier elemento que navegue a otra pantalla — sección 4.4.

## 7. Temas pendientes de definir

- Registro de comportamientos nombrados: centralizado vs. distribuido.
- Catálogo completo de "comportamientos especiales" (más allá de validación/formato).
- Composición de tipos de dominio (¿se arman a partir de primitivos, o desde cero?) y su reusabilidad entre proyectos.
- Roles y permisos: estáticos vs. dinámicos, jerarquías, permisos a nivel de fila.
- Menúes: dónde vive la asociación rol↔menú; si un ítem puede apuntar a pantallas custom.
- Botón "anterior/siguiente" en pantallas de detalle: ¿existe?, ¿orden canónico de la entidad o de la grilla de origen?
- Decisión final de lenguaje de implementación (TypeScript vs. Zig vs. otros).
