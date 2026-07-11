# system-design
<!--lang:es-->
Capa descriptiva para sistemas diseñados alrededor de una única fuente de verdad (SSOT).
<!--lang:en--]
Descriptive layer for systems designed around a Single Source of Truth (SSOT).
[!--lang:*-->

<!--multilang v0 es:LEEME.md en:README.md -->

<!-- cucardas -->
[![npm-version](https://img.shields.io/npm/v/system-definition.svg)](https://npmjs.org/package/system-definition)
[![downloads](https://img.shields.io/npm/dm/system-definition.svg)](https://npmjs.org/package/system-definition)
[![build](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml)
[![security](https://socket.dev/api/badge/npm/package/system-definition)](https://socket.dev/npm/package/system-definition)
[![qa-control](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/qa-control.yml/badge.svg)](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/qa-control.yml)

<!--multilang buttons-->

idioma: ![castellano](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-es.png)
también disponible en:
[![inglés](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-en.png)](README.md)

<!--lang:es-->

## Objetivo

Este módulo provee el vocabulario para describir un sistema — tipos de dominio, entidades,
campos, procedimientos — como valores fuertemente tipados y serializables. A partir de esas
descripciones, generadores de código o implementaciones on-the-fly pueden derivar los scripts
de creación de tablas, los endpoints CRUD con su capa de base de datos, las pantallas del
frontend, los serializadores en ambos sentidos, los validadores de tipo, etc.

Este módulo cubre solo la parte descriptiva de los sistemas: no genera nada por sí mismo.

<!--lang:en--]

## Goal

This module provides the vocabulary to describe a system — domain types, entities, fields,
procedures — as strongly typed, serializable values. From those descriptions, code generators
or on-the-fly implementations can derive the table creation scripts, the CRUD endpoints with
their database layer, the frontend screens, the serializers in both directions, the type
validators, and so on.

This module covers only the descriptive part of systems: it does not generate anything itself.

[!--lang:es-->

## Convención de nombres: Def e Info

Cada concepto descriptivo tiene (al menos) dos versiones, distinguidas por sufijo:

* `XxxDef` (definition): lo que escribe el humano. Contiene solo lo mínimo con sentido
  semántico; lo que tiene un default razonable se puede omitir.
* `XxxInfo`: lo que produce el framework al completar la `Def` con los defaults. Ahí está
  todo explícito; es lo que consumen los generadores.

La `Info` se deriva determinísticamente de la `Def`, y ambas son serializables (representables
como JSON plano, sin funciones embebidas).

<!--lang:en--]

## Naming convention: Def and Info

Every descriptive concept has (at least) two versions, distinguished by a suffix:

* `XxxDef` (definition): what the human writes. It contains only the minimum with semantic
  meaning; anything with a sensible default can be omitted.
* `XxxInfo`: what the framework produces by completing the `Def` with the defaults. Everything
  is explicit there; it's what the generators consume.

The `Info` is derived deterministically from the `Def`, and both are serializable (representable
as plain JSON, with no embedded functions).

[!--lang:es-->

## Vocabulario

### Tipos de dominio

Cada sistema define su propia colección de tipos (`TypeCollection`), asociando un nombre de
tipo (por ejemplo `"texto"`, `"legajo"`) con el tipo TypeScript que le corresponde en
tiempo de ejecución. El framework aporta unos pocos tipos comunes (`text`, `integer`,
`boolean`) como punto de partida; cada sistema puede agregar los suyos (en el ejemplo,
`fecha`, `email`).

### Campos: `FieldDef` / `FieldInfo`

Un campo se describe con `FieldDef`: el `type` (una key de la `TypeCollection`) y,
opcionalmente, `label`, `nullable` y `description`. `completeRecord` produce el `FieldInfo`
correspondiente, con esos tres campos siempre presentes (defaults: `label` derivado del
nombre, `nullable: true`, `description: ''`), preservando el literal de `type`.

### Records: `RecordDef` / `RecordInfo`

Un `RecordDef` es simplemente un mapa de campos (`Record<string, FieldDef>`): la descripción
de una fila. `RecordInfoOf<TRecordDef>` es el tipo exacto de `Info` que corresponde a un
`RecordDef` concreto — conserva las claves y los literales de `type` de cada campo — y es lo
que devuelve `completeRecord`.

`RecordInstanceType<TTypeCollection, TRecordDef>` deduce, a partir de un `RecordDef` y la
`TypeCollection` del sistema, el tipo TypeScript de una instancia real de ese record (los
valores que tomaría cada campo en tiempo de ejecución).

### Entidades: `EntityDef`

`EntityDef` es el nivel contenedor — la unidad representable como grilla — con la forma
`{pk, fields}`, donde `fields` es un `RecordDef` y `pk` es la tupla de nombres de campo que
forman la clave primaria (admite pk compuesta). Se construye con `defineEntity`, que
chequea en tiempo de compilación que cada elemento de `pk` sea una key de `fields`, y
preserva los literales (`pk` queda tipado como tupla exacta, no como `string[]`).

### Reutilización de claves: `extractPk` / `mergePk`

* `extractPk(entityDef)` devuelve los campos de la pk de una entidad como un `RecordDef` con
  el tipo exacto (`PkFieldsOf<TEntityDef>`), para heredarlos por spread en otra entidad
  (por ejemplo, `curso` hereda las pk de `periodos`, `materias` y `docentes`). Para el resto
  de los campos no hace falta una función especial: el spread de objetos ya deduplica keys.
* `mergePk(...pks)` une varias pk que pueden superponerse, sin repetir elementos y
  deduplicando también a nivel de tipos (preserva el orden de primera aparición). Se usa
  para pks combinadas, como la de `presencias`, que junta las de `inscripciones` y `clases`.

<!--lang:en--]

## Vocabulary

### Domain types

Each system defines its own type collection (`TypeCollection`), associating a type name
(e.g. `"text"`, `"student id"`) with the TypeScript type it maps to at runtime. The
framework provides a few common types (`text`, `integer`, `boolean`) as a starting point;
each system can add its own (in the example, `fecha` — date — and `email`).

### Fields: `FieldDef` / `FieldInfo`

A field is described with `FieldDef`: its `type` (a key of the `TypeCollection`) and,
optionally, `label`, `nullable` and `description`. `completeRecord` produces the
corresponding `FieldInfo`, with those three fields always present (defaults: `label`
derived from the field name, `nullable: true`, `description: ''`), preserving the `type`
literal.

### Records: `RecordDef` / `RecordInfo`

A `RecordDef` is simply a map of fields (`Record<string, FieldDef>`): the description of a
row. `RecordInfoOf<TRecordDef>` is the exact `Info` type that corresponds to a concrete
`RecordDef` — it keeps the keys and the `type` literal of each field — and it's what
`completeRecord` returns.

`RecordInstanceType<TTypeCollection, TRecordDef>` deduces, from a `RecordDef` and the
system's `TypeCollection`, the TypeScript type of an actual instance of that record (the
values each field would hold at runtime).

### Entities: `EntityDef`

`EntityDef` is the container level — the grid-representable unit — shaped as
`{pk, fields}`, where `fields` is a `RecordDef` and `pk` is the tuple of field names that
make up the primary key (composite keys are supported). It's built with `defineEntity`,
which checks at compile time that every element of `pk` is a key of `fields`, and preserves
the literals (`pk` ends up typed as an exact tuple, not as `string[]`).

### Reusing keys: `extractPk` / `mergePk`

* `extractPk(entityDef)` returns an entity's pk fields as a `RecordDef` with the exact type
  (`PkFieldsOf<TEntityDef>`), so they can be inherited by spreading them into another entity
  (for example, `curso` — course — inherits the pks of `periodos`, `materias` and
  `docentes`). The rest of the fields need no special function: spreading objects already
  dedups keys.
* `mergePk(...pks)` merges several pks that may overlap, without repeating elements and
  deduplicating at the type level too (preserving the order of first appearance). It's used
  for combined pks, like the one for `presencias` (attendance), which joins the pks of
  `inscripciones` (enrollments) and `clases` (classes).

[!--lang:es-->

## Ejemplo: sistema de alumnos

`examples/common/aida.ts` describe un sistema de alumnos con este vocabulario. Incluye
entidades independientes (`docentes`, `materias`, `periodos`, `alumnos`) y entidades que
heredan claves de otras:

* `cursos` hereda las pk de `periodos`, `materias` y `docentes` (el docente responsable).
* `clases` extiende la pk de `cursos` agregando `orden`.
* `preguntas` extiende la pk de `clases` agregando `pregunta`, y `opciones` extiende la de
  `preguntas` agregando `opcion` (encadenamiento de herencia de pk en varios niveles).
* `inscripciones` hereda las pk de `cursos` y `alumnos`.
* `presencias` combina, con `mergePk`, las pk de `inscripciones` y `clases`, que comparten
  `periodo` y `materia`: esos campos no se repiten.

Los tests en `test/aida-test.ts` importan estas definiciones y verifican, para cada tramo
del vocabulario, tanto la asignabilidad en ambos sentidos (una `Info` esperada escrita a
mano y la deducida deben poder asignarse mutuamente) como los rechazos esperados en
compilación (con `// @ts-expect-error`): pk con campos inexistentes, acceso a campos que
la entidad no tiene, reasignación de un `type` literal, etc.

<!--lang:en--]

## Example: student system

`examples/common/aida.ts` describes a student system using this vocabulary. It includes
independent entities (`docentes` — instructors, `materias` — subjects, `periodos` — terms,
`alumnos` — students) and entities that inherit keys from others:

* `cursos` (courses) inherits the pks of `periodos`, `materias` and `docentes` (the
  instructor in charge of the course).
* `clases` (classes) extends the `cursos` pk by adding `orden` (sequence number).
* `preguntas` (questions) extends the `clases` pk by adding `pregunta`, and `opciones`
  (options) extends the `preguntas` pk by adding `opcion` (pk inheritance chained across
  several levels).
* `inscripciones` (enrollments) inherits the pks of `cursos` and `alumnos`.
* `presencias` (attendance) combines, with `mergePk`, the pks of `inscripciones` and
  `clases`, which share `periodo` and `materia`: those fields aren't repeated.

The tests in `test/aida-test.ts` import these definitions and check, for each part of the
vocabulary, both two-way assignability (a hand-written expected `Info` and the deduced one
must be mutually assignable) and the expected compile-time rejections (with
`// @ts-expect-error`): a pk with nonexistent fields, accessing a field the entity doesn't
have, reassigning a literal `type`, and so on.

[!--lang:es-->

## Estructura

* `src/common`: el framework descriptor; no conoce ningún sistema concreto.
* `examples/common`: un sistema de ejemplo (sistema de alumnos) descripto con el framework.
* `test/`: tests con mocha que importan las definiciones de los ejemplos (los ejemplos
  implican tests).

<!--lang:en--]

## Structure

* `src/common`: the descriptive framework; it knows nothing about any concrete system.
* `examples/common`: an example system (a students system) described with the framework.
* `test/`: mocha tests that import the example definitions (the examples double as tests).

[!--lang:es-->

## Forma de trabajo

Enfoque TDD, avanzando de a pasos chicos: primero el test que muestra el problema, después
la implementación mínima que lo hace pasar. Los tests de tipos no son flojos: prueban
asignabilidad en ambos sentidos y también los rechazos esperados con `// @ts-expect-error`.

`npm test` compila con TypeScript y corre mocha sobre el resultado compilado (no se usa
ts-node ni loaders).

<!--lang:en--]

## Way of working

TDD approach, moving forward in small steps: first the test that shows the problem, then
the minimal implementation that makes it pass. Type tests aren't loose: they check
assignability in both directions and also the expected rejections with
`// @ts-expect-error`.

`npm test` compiles with TypeScript and runs mocha over the compiled output (no ts-node,
no loaders).

[!--lang:es-->

## Estado

En etapa de diseño.

<!--lang:en--]

## Status

Design stage.

[!--lang:*-->

<!--lang:es-->
## Licencia

<!--lang:en--]
## License

[!--lang:*-->
[MIT](LICENSE)
