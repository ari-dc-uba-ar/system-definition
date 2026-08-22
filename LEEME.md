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

### Comportamiento de los tipos: `TypeProvider`

Una descripción dice que un campo es una `fecha`; cómo se lee y cómo se escribe una `fecha`
es parte de lo que una `fecha` **es**. Por eso el comportamiento vive acá, junto a la
definición de los tipos, y no en cada implementación: si cada una lo escribiera de nuevo,
cada una lo escribiría distinto y la fuente de verdad dejaría de ser única.

* `TypeBehaviour<TsType>` es el par `parse` / `format` de un tipo: de texto a valor y de
  valor a texto. Texto, y no otro formato de intercambio, porque es lo que ya llevan todos
  los bordes de afuera del dominio (un body http, un parámetro de url, un input de un
  formulario, una celda de un csv).
* `parse` devuelve un `ParseResult<TsType>`: o el valor, o una **clave de mensaje**
  (`type.integer`, `type.date`) y nunca un texto, así la redacción se resuelve donde se
  conoce el idioma. Se construyen con `parsed(valor)` y `notParsed(clave)`.
* `TypeProvider<TTypeDefs>` es el mapa completo de una colección de tipos a su
  comportamiento, exhaustivo por construcción: agregar un tipo a la colección sin declarar
  cómo se lee no compila.
* `commonTypeBehaviours` trae el de `text`, `integer` y `boolean`. Un sistema agrega el de
  sus tipos propios y puede especializar uno común: en el ejemplo, el `boolean` de aida lee
  además `sí` y `no`.

Esto no rompe la regla de que las descripciones son serializables: un `TypeDef` sigue sin
llevar funciones. El `TypeProvider` es exactamente el registro aparte que esa regla supone,
y el nombre del tipo que lleva la descripción es la clave para buscar en él.

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

### Type behaviour: `TypeProvider`

A description says that a field is a `fecha` (a date); what a `fecha` reads like and writes
like is part of what a `fecha` **is**. That's why behaviour lives here, next to the
definition of the types, and not in each implementation: if every implementation wrote it
again, every one would write it differently and the source of truth would stop being
single.

* `TypeBehaviour<TsType>` is a type's `parse` / `format` pair: text to value and value to
  text. Text, and no other interchange format, because it's what every boundary outside the
  domain already carries (an http body, a url parameter, a form input, a csv cell).
* `parse` returns a `ParseResult<TsType>`: either the value, or a **message key**
  (`type.integer`, `type.date`) and never a text, so the wording is resolved where the
  language is known. They're built with `parsed(value)` and `notParsed(key)`.
* `TypeProvider<TTypeDefs>` is the complete map from a type collection to its behaviour,
  exhaustive by construction: adding a type to the collection without saying how it reads
  does not compile.
* `commonTypeBehaviours` provides it for `text`, `integer` and `boolean`. A system adds the
  behaviour of its own types and may specialize a common one: in the example, aida's
  `boolean` also reads `sí` and `no`.

This doesn't break the rule that descriptions are serializable: a `TypeDef` still carries no
functions. The `TypeProvider` is exactly the separate registry that rule assumes, and the
type name a description carries is the key into it.

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
* `examples/common`: un sistema de ejemplo (sistema de alumnos) descripto con el framework,
  con el comportamiento de sus tipos.
* `test/`: tests con mocha que importan las definiciones de los ejemplos (los ejemplos
  implican tests).

<!--lang:en--]

## Structure

* `src/common`: the descriptive framework; it knows nothing about any concrete system.
* `examples/common`: an example system (a students system) described with the framework,
  with the behaviour of its types.
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
