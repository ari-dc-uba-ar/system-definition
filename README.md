# system-design
Descriptive layer for systems designed around a Single Source of Truth (SSOT).


[![npm-version](https://img.shields.io/npm/v/system-definition.svg)](https://npmjs.org/package/system-definition)
[![downloads](https://img.shields.io/npm/dm/system-definition.svg)](https://npmjs.org/package/system-definition)
[![build](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/ari-dc-uba-ar/system-definition/actions/workflows/build-and-test.yml)
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

This module covers the descriptive part of systems and the tools that operate on that
description. It generates no code: it does not write the DDL, the endpoints or the screens —
the modules above do that by reading these descriptions.

What it does provide, beyond the vocabulary, is what no consumer can write without writing a
piece of the truth again: turning a text into the value the definition declares, looking at a
value that is already built and saying whether it belongs, and running the rules of a record.
A date's `parse` written outside gets written differently by each implementation, and there
the single source of truth stops being single.

The rule that this does not break is the one that matters: **descriptions still carry no
functions**. A `TypeDef` is the same as before and a def still serializes as plain JSON. The
behaviour lives in the context, which is not a description and never was — it already carried
the field completer.


## What it runs on

The library itself needs nothing beyond a current Node. The **aida example** uses
`Temporal.PlainDate` for its `fecha` type, which is native from Node 26 on; on 22 and 24 it
needs `--node-option harmony-temporal`, which is what the test scripts here pass. Nothing in
`src/` uses Temporal, so a consumer that does not import the example is unaffected.


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
* `examples/common`: an example system (a students system) described with the framework.
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
