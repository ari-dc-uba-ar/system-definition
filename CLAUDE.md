# system-design

Parte descriptiva del framework SSOTIGAD (Single Source Of Truth Implies Good Application Design).
El documento de diseño conceptual está en [SSOTIGAD.md](https://github.com/codenautas/ideas/blob/SSOTIGAD/src/SSOTIGAD.md).

Este módulo provee el vocabulario para describir sistemas (tipos de dominio, entidades, campos,
procedimientos, etc.) de modo que generadores automáticos o implementaciones on-the-fly puedan
derivar los scripts de creación de tablas, los endpoints CRUD con su capa de base de datos,
las pantallas del frontend, los serializadores en ambos sentidos y los validadores de tipo.
Este módulo cubre **solo la parte descriptiva**: no genera nada.

## Forma de trabajo

* Avanzamos de a pasos chicos, guiados por el programador. Acordar antes de programar.
* Enfoque TDD: primero el test que muestra el problema. Mostrar los rojos (errores de
  compilación o tests fallando) y **esperar la revisión del programador antes de corregir**.
* Los tests de tipos no deben ser flojos: probar asignabilidad **en ambos sentidos**, y
  también los rechazos con `// @ts-expect-error` (que no se pueda asignar un valor de un
  tipo que no corresponde, ni acceder a campos que no existen en la definición).
* Código e identificadores dentro de `src` y `examples` en inglés.
* Los planes y este archivo, en castellano.
* Documentación multilingüe con la herramienta `multilang` (disponible en el PATH):
  la fuente es `LEEME.md` en castellano; `README.md` en inglés se genera con `multilang LEEME.md`.
  No editar `README.md` a mano.

## Estructura

* `src/common`: el framework descriptor. No conoce ningún sistema concreto.
  (Más adelante podrían aparecer `src/backend` y `src/frontend`, o aplanarse todo a `src` si no hacen falta.)
* `examples/common`: un sistema de ejemplo (sistema de alumnos) descripto con el framework.
* `test/`: tests con mocha que importan las definiciones de los ejemplos (los ejemplos implican tests).
  `npm test` compila con tsc y corre mocha sobre `dist/test/`; no se usa ts-node ni loaders.

## Herramientas

* TypeScript 7 (el compilador nativo). Que quitó
  `baseUrl` y `moduleResolution: node`, y ya no incluye los `@types` automáticamente
  (van listados en `types` del tsconfig).
* Cobertura: c8 (`npm run test-cov`, configuración en `.c8rc.json`). Ojo: los tests que solo
  verifican tipos no cargan nada en runtime (tsc elide los imports usados solo en posiciones
  de tipo), así que la cobertura es 0% hasta que haya comportamiento runtime que ejercitar;
  por eso `all: true`, para que los archivos aparezcan igual en el reporte.
  (Esa elisión fue también la causa de que nyc reportara vacío: no era un bug de nyc.)

## Decisiones de diseño acordadas

* TypeScript estricto, sin `any`.
* Las descripciones son valores TypeScript fuertemente tipados y **serializables** (representables
  como JSON plano, sin funciones embebidas). Los comportamientos especiales se referencian por
  nombre y se resuelven contra implementaciones registradas aparte.
* Los tipos de dominio (por ejemplo "Edad", "Legajo") los define cada sistema (en `examples`),
  no el framework. El framework provee el mecanismo para definirlos.
* Del valor de una definición se deriva el tipo estático correspondiente (por ejemplo, el tipo
  de una fila de la entidad), sin escribir los campos dos veces: preservación del tipado
  de compile-time a runtime.
* La validación estructural de las descripciones (FK que apuntan a entidades existentes,
  PK sobre campos declarados, etc.) se expresa preferentemente en el sistema de tipos.

## Convención de nombres: Def e Info

Para cada concepto descriptivo hay al menos dos versiones, distinguidas por sufijo:

* `XxxDef` (definition): lo que escribe el humano. Contiene solo lo mínimo necesario para
  tener sentido semántico; todo lo que tiene un default razonable se puede omitir
  (por ejemplo, si un campo es nulleable o no).
* `XxxInfo`: lo que produce el framework completando la Def con los defaults. Ahí está todo
  explícito; es lo que consumen los generadores.

Ambas versiones son serializables. La Info se deriva determinísticamente de la Def.

Nombres ya elegidos:

* La descripción del registro de una entidad (el elemento fundamental) es `RecordDef` / `RecordInfo`.
  El identificador pelado `Record` no se usa nunca, para no competir con el tipo utilitario
  `Record<K, V>` de TypeScript.
* La descripción de un campo es `FieldDef` / `FieldInfo`. `RecordDef` es el mapa de campos:
  `Record<string, FieldDef>`.
* `EntityDef` es el nivel contenedor (la unidad representable como grilla, como la llama el
  documento SSOTIGAD): `{pk, fields}` donde `fields` es un `RecordDef`; ahí se irán agregando
  foreign keys, subgrillas, título, etc. Se construye con `defineEntity`, que chequea en
  compilación que los elementos de `pk` sean keys de `fields` (funciona con PK compuesta)
  y preserva los literales (parámetros de tipo `const`).
* Convención de nombres en los sistemas de ejemplo: el record en singular, la entidad en
  plural (`docente` es el `RecordDef`, `docentes` es la entity que lo envuelve).
* `PkFieldsOf<TEntityDef>` / `extractPk(entityDef)`: los campos de la pk como `RecordDef`
  tipado exacto, para heredarlos con spread en otra entidad
  (`fields: {...extractPk(cursos), orden: ...}` — la repetición semántica buena del documento).
* `MergedPk<TPks>` / `mergePk(...pks)`: une pks que se superponen sin repetir elementos,
  deduplicando también a nivel de tipos (tupla recursiva), preservando el orden de primera
  aparición. Es para pks combinadas (`presencias.pk = mergePk(inscripciones.pk, clases.pk)`);
  para los `fields` no hace falta: el spread ya deduplica keys solo.
* `isName?: true` en `FieldDef` (solo `true`, así el literal sobrevive al `satisfies`);
  `completeRecord` lo completa a `false` en la Info.
* `EntityDef` tiene además `uks` (uniques con nombre: `{denominacion: ['denominacion']}`) y
  `fks`. Una `FkDef` es `{entity, fields}` donde `entity` es el **nombre** de la entidad
  destino (string, no el objeto: mantiene la serializabilidad y permite fks circulares y
  reflexivas), y `fields` tiene dos formas: array de nombres cuando origen y destino se
  llaman igual (`fields: cursos.pk`), o mapa `{origen: 'destino'}` cuando no
  (`{jefe: 'docente'}`). La key del mapa de `fks` es el nombre de la fk (permite dos fks a
  la misma entidad: `presidente` y `vocal` → docentes).
* Los chequeos de fks tienen dos niveles: `defineEntity` chequea lo local (campos origen y
  de uks existen en `fields`); `defineEntities(entityDefs)` chequea lo global del sistema
  (la entidad destino existe, y los campos destino son su pk completa o una de sus uks).
  El error de `defineEntities` es críptico (mapped type a `never`), pero señala la fk mala.
* `RecordInfoOf<TRecordDef>`: la Info precisa que corresponde a una Def concreta (conserva
  las claves y los literales de `type`); es lo que devuelve `completeRecord`. El sufijo `Of`
  marca "tipo derivado de una definición concreta".
