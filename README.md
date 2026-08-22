# system-design
Descriptive layer for systems designed around a Single Source of Truth (SSOT).


[![npm-version](https://img.shields.io/npm/v/system-definition.svg)](https://npmjs.org/package/system-definition)
[![downloads](https://img.shields.io/npm/dm/system-definition.svg)](https://npmjs.org/package/system-definition)
[![build](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml)
[![security](https://socket.dev/api/badge/npm/package/system-definition)](https://socket.dev/npm/package/system-definition)
[![qa-control](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/qa-control.yml/badge.svg)](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/qa-control.yml)


language: ![English](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-en.png)
also available in:
[![Spanish](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-es.png)](LEEME.md)


## Goal

This module provides the vocabulary to describe a system — domain types, entities, fields,
procedures — as strongly typed, serializable values. From those descriptions, code generators
or on-the-fly implementations can derive the table creation scripts, the CRUD endpoints with
their database layer, the frontend screens, the serializers in both directions, the type
validators, and so on.

This module covers only the descriptive part of systems: it does not generate anything itself.


## Naming convention: Def and Info

Every descriptive concept has (at least) two versions, distinguished by a suffix:

* `XxxDef` (definition): what the human writes. It contains only the minimum with semantic
  meaning; anything with a sensible default can be omitted.
* `XxxInfo`: what the framework produces by completing the `Def` with the defaults. Everything
  is explicit there; it's what the generators consume.

The `Info` is derived deterministically from the `Def`, and both are serializable (representable
as plain JSON, with no embedded functions).


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


## Structure

* `src/common`: the descriptive framework; it knows nothing about any concrete system.
* `examples/common`: an example system (a students system) described with the framework,
  with the behaviour of its types.
* `test/`: mocha tests that import the example definitions (the examples double as tests).


## Way of working

TDD approach, moving forward in small steps: first the test that shows the problem, then
the minimal implementation that makes it pass. Type tests aren't loose: they check
assignability in both directions and also the expected rejections with
`// @ts-expect-error`.

`npm test` compiles with TypeScript and runs mocha over the compiled output (no ts-node,
no loaders).


## Status

Design stage.


## License

[MIT](LICENSE)
