# system-design
<!--lang:es-->
Capa descriptiva para sistemas diseñados alrededor de una única fuente de verdad (SSOT).
<!--lang:en--]
Descriptive layer for systems designed around a Single Source of Truth (SSOT).
[!--lang:*-->

<!--multilang v0 es:LEEME.md en:README.md -->
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
## Estructura

* `src/common`: el framework descriptor; no conoce ningún sistema concreto.
* `examples/common`: un sistema de ejemplo (sistema de alumnos) descripto con el framework.

## Estado

En etapa de diseño.

<!--lang:en--]
## Structure

* `src/common`: the descriptive framework; it knows nothing about any concrete system.
* `examples/common`: an example system (a students system) described with the framework.

## Status

Design stage.

[!--lang:es-->
## Licencia

<!--lang:en--]
## License

[!--lang:*-->
[MIT](LICENSE)
