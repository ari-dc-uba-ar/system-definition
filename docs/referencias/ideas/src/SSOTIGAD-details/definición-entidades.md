# Definición de entidades — ejemplo: profesores y materias

⚠️ Estado del documento: BORRADOR. TODO PODRÍA CAMBIAR. La idea subyacente es lo único válido. ⚠️

> Bajada a tierra de [SSOTIGAD](../SSOTIGAD.md), sección 3.1 (Entidades), cumpliendo la forma de definición de la sección 2.3 (variables tipadas del lenguaje, serializables, comportamientos referenciados por nombre). Los ejemplos están en TypeScript siguiendo la conclusión provisoria de la sección 5; la decisión de lenguaje sigue abierta.

## 1. Convenciones

- Lo que es parte del **framework** va en inglés (`FieldDef`, `ModelsDef`, `pk`, `fks`); lo que es parte de la **aplicación** va en castellano (`profesores`, `horas_semanales`).
- Los nombres de la aplicación (tipos, modelos, campos, entidades, comportamientos) van en **snake_case en minúsculas**, y el mismo nombre se usa idéntico en SQL — no hay derivación camelCase↔snake_case.
- Los **labels** van en minúsculas y solo se declaran cuando difieren del nombre del campo con los guiones bajos reemplazados por espacios. Ejemplo: `horas_semanales` no necesita label ("horas semanales" ya es correcto); `telefono` sí, por el acento ("teléfono").

## 2. La definición del sistema, por capas

La **definición del sistema** es un objeto plano puro (JSON), construido por capas:

1. **Tipos de dominio** (sin tipo no hay nada), con sus representaciones físicas.
2. **Modelos**: la definición de los campos de cada record.
3. **Entidades**: a partir de un modelo agregan pk, fks, y más adelante subgrillas.

Los **comportamientos** (funciones nombradas) no son una capa de la definición: quedan afuera, y la definición los referencia por nombre. El framework SSOTIGAD es el que conecta las dos partes y hace que el sistema funcione.

No hay builder ni cadena de llamadas — llamar funciones no se parece en nada a un SSOT serializable. Cada capa es una constante independiente, tipada con `satisfies`; cada `XxxDef` recibe como parámetro de tipo **solo las capas que necesita**:

```ts
// cada capa es una constante aparte, tipada contra las capas que necesita
const types        = {/* sección 3 */} as const satisfies TypesDef;
const typeMappings = {/* sección 3 */} as const satisfies TypeMappingsDef<typeof types>;
const models       = {/* sección 4 */} as const satisfies ModelsDef<typeof types>;
const entities     = {/* sección 6 */} as const satisfies EntitiesDef<typeof models>;

// la definición del sistema: un objeto plano puro, 100% serializable
const systemDef = {
    types,
    typeMappings,
    models,
    entities,
} satisfies SystemDef<typeof types, typeof models>;

// los comportamientos, aparte: la única parte con funciones (sección 5)
const behaviors = {/* sección 5 */} satisfies BehaviorsDef;
```

Dos propiedades de esta forma:

- `systemDef` es JSON plano puro: es la parte serializable que pide 2.3. Los comportamientos son exactamente su "registro aparte" — no funciones `registrarX(...)` sueltas sino un mapa, que la definición referencia por nombre y el framework conecta.
- Las referencias por nombre hacia capas que participan como parámetro de tipo se verifican en compilación vía `keyof` (un error de tipeo no compila y el editor autocompleta). Las referencias hacia los comportamientos (por ejemplo `validation: 'email'` en un tipo) las valida el framework al conectar definición y comportamientos. Ver cuestión abierta 8.4.

## 3. Capa 1: tipos de dominio y sus representaciones

El dato más importante de un campo es su tipo de dominio, y es un **string**. Los parámetros del tipo (min, max, validación) se definen una sola vez por tipo — es la idea de la sección 2.5: "Edad" es un tipo que internamente sabe su rango; acá `horas_semanales` sabe el suyo.

Un tipo de dominio no significa nada por sí solo ("texto" no dice nada): lo que lo define son sus **representaciones** — a qué tipo JS, Postgres, SqlServer, etc. se mapea. Esos mapeos van en una capa propia, con forma `Record<Representation, Record<TypeName, string>>`:

```ts
// framework
type TypeDef = {min?: number, max?: number, validation?: string};
type TypesDef = Record<string, TypeDef>;
type TypeMappingsDef<Types extends TypesDef> = Record<string, Record<keyof Types & string, string>>;

// aplicación
const types = {
    codigo:          {},
    texto:           {},
    email:           {validation: 'email'},
    fecha:           {},
    booleano:        {},
    entero:          {},
    horas_semanales: {min: 1, max: 60},
} as const satisfies TypesDef;

const typeMappings = {
    jsType:       {codigo: 'string', texto: 'string', email: 'string', fecha: 'Date', booleano: 'boolean', entero: 'number', horas_semanales: 'number'},
    postgresType: {codigo: 'text',   texto: 'text',   email: 'text',   fecha: 'date', booleano: 'boolean', entero: 'integer', horas_semanales: 'integer'},
} as const satisfies TypeMappingsDef<typeof types>;
```

Por qué el mapeo agrupado por representación, y no cada representación adentro de cada tipo (`codigo: {jsType: 'string', postgresType: 'text', ...}`):

- El chequeo de completitud funciona en las dos direcciones: agregar un tipo obliga a completar todas las representaciones declaradas, y agregar una representación (por ejemplo, migrar a Oracle) obliga a cubrir todos los tipos. Con la representación adentro de cada tipo, olvidar una es fácil, y exigirlas todas obliga a declarar backends que no se usan.
- La aplicación declara solo las representaciones que usa.

`jsType` es una representación especial: su vocabulario es fijo del framework (`'string' | 'number' | 'boolean' | 'Date'`, etc.) porque es lo que usa `RowOf` para derivar los tipos de compilación (sección 7).

Nota: los textos no llevan largo — en 2026 eso ya no tiene sentido; `codigo`, `texto` y `email` mapean todos a `text` en Postgres.

## 4. Capa 2: modelos

Un modelo es el mapa nombre de campo → definición de campo. Las entidades se definen después, sobre un modelo (así la pk de una entidad puede tiparse como `keyof` de su modelo).

La definición de campo (framework):

```ts
type FieldDef<Types extends TypesDef> = {
    type: keyof Types & string;
    label?: string;          // si falta: el nombre del campo, con "_" → " "
    description?: string;
    columnGroup?: string;
    defaultValue?: string | number | boolean | {method: string};
    nullable?: true;         // si falta: NOT NULL
    isName?: true;
    inComboBox?: true;
    computed?: {method: string};
};

type ModelsDef<Types extends TypesDef> = Record<string, Record<string, FieldDef<Types>>>;
```

Los modelos del ejemplo:

```ts
const models = {
    materias: {
        materia:         {type: 'codigo', description: 'código de la materia en el plan de estudios'},
        nombre:          {type: 'texto', isName: true},
        horas_semanales: {type: 'horas_semanales', inComboBox: true},
    },
    profesores: {
        profesor:        {type: 'codigo', description: 'legajo docente'},
        apellido:        {type: 'texto'},
        nombres:         {type: 'texto'},
        nombre_completo: {type: 'texto', isName: true, computed: {method: 'nombre_completo'}},
        email:           {type: 'email', columnGroup: 'contacto'},
        telefono:        {type: 'texto', label: 'teléfono', columnGroup: 'contacto'},
        fecha_ingreso:   {type: 'fecha', label: 'ingreso', description: 'fecha de ingreso a la institución', defaultValue: {method: 'fecha_de_hoy'}},
        activo:          {type: 'booleano', defaultValue: true},
    },
    asignacion_profesores: {
        profesor:       {type: 'codigo'},
        materia:        {type: 'codigo'},
        puede_dictarla: {type: 'booleano'},
        prioridad:      {type: 'entero', nullable: true},
    },
} as const satisfies ModelsDef<typeof types>;
```

- `nombre_completo` es una columna calculada (3.1); el cálculo no está acá, solo su nombre.
- `fecha_ingreso` tiene valor por defecto que remite a un método (`fecha_de_hoy`); `activo`, uno constante — los dos casos previstos en 3.1.
- `email` y `telefono` comparten el grupo de columna "contacto": en la grilla aparecen bajo un sobretítulo común.
- Solo `telefono` y `fecha_ingreso` declaran label; el resto se deriva del nombre del campo.

**Nullability** (decisión provisoria): los campos son **NOT NULL por defecto** y `nullable: true` es la excepción (`prioridad`). Razones: en un modelo de datos típico la mayoría de los campos son obligatorios, y equivocarse por omisión hacia el lado estricto falla temprano y se relaja fácil — lo inverso admite datos malos en silencio. No se diferencia nullable / undefinable / optativo a nivel modelo: en los datos existe un solo concepto (NULL); `undefined` y la opcionalidad aparecen únicamente en tipos derivados de operaciones (por ejemplo, un `Partial` para updates parciales), nunca en el modelo.

## 5. Los comportamientos, fuera de la definición

Un mapa por clase de comportamiento — no funciones `registrar...` sueltas. No forma parte de `systemDef`: es exactamente el "registro aparte" que pide 2.3. El framework es el que conecta la definición (que referencia por nombre) con este mapa para hacer funcionar el sistema.

```ts
const behaviors = {
    calculations: {
        nombre_completo: (row: {apellido: string, nombres: string}) => `${row.apellido}, ${row.nombres}`,
    },
    defaultValues: {
        fecha_de_hoy: () => today(),
    },
    validations: {
        email: (value: string) => /* ... */,
    },
} satisfies BehaviorsDef;
```

Las clases de comportamiento (`calculations`, `defaultValues`, `validations`) son vocabulario del framework; el catálogo completo es un pendiente de 2.3. El tipado a mano del parámetro `row` debería poder derivarse del modelo — ver cuestión abierta 8.5.

## 6. Capa 3: entidades

Una entidad toma un modelo por nombre y agrega lo relacional: pk, fks (y más adelante, subgrillas).

```ts
const entities = {
    materias:   {model: 'materias', pk: ['materia']},
    profesores: {model: 'profesores', pk: ['profesor']},
    asignacion_profesores: {
        model: 'asignacion_profesores',
        pk: ['profesor', 'materia'],
        fks: [
            {fields: ['profesor'], references: 'profesores'},
            {fields: ['materia'],  references: 'materias'},
        ],
    },
} as const satisfies EntitiesDef<typeof models>;
```

- `pk` y `fields` se tipan como `keyof` del modelo elegido: una pk con un campo inexistente no compila. Es la razón de definir los modelos antes que las entidades.
- La PK de `asignacion_profesores` es natural y **compuesta**: el par [profesor, materia] identifica la asignación; no hace falta ningún id sintético.
- Las FKs se renderizan automáticamente como combos editables-y-desplegables (3.1). El de materia muestra `materia` + `nombre` (el `isName`) + `horas_semanales` (el `inComboBox`); el de profesor muestra `profesor` + `nombre_completo` — que es una columna calculada.
- Las FKs van a nivel de entidad (no de campo) para que las compuestas se declaren igual que las simples.

## 7. Qué se deriva automáticamente

De `systemDef` más los comportamientos, sin ninguna mención adicional a ningún campo (criterio 2.1), el framework deriva:

- **Tipos del lenguaje**: `type Materia = RowOf<typeof systemDef, 'materias'>` produce `{materia: string, nombre: string, horas_semanales: number}` (vía el `jsType` de cada tipo de dominio) — es la razón de las tres condiciones de la sección 5.1. `prioridad` se deriva como `number | null` por el `nullable`.
- **SQL**: `CREATE TABLE` con los tipos físicos del `typeMappings` de la base elegida, la PK compuesta y las FKs; y los `INSERT`/`SELECT`/`UPDATE` del CRUD.
- **Endpoints CRUD** para las tres entidades.
- **Grilla**: columnas con sus labels (declarados o derivados del nombre), tooltips desde las descripciones, sobretítulo "contacto" agrupando email y teléfono, edición inline.
- **Formulario de alta/edición**: con `fecha_ingreso` precargada con la fecha del día y `activo` en verdadero.
- **Combos** en las FKs de asignacion_profesores, tipeables, con código + `isName` + campos `inComboBox`.
- **Validación** en ambos extremos (navegador y servidor, por el isomorfismo de 2.4): rangos y validaciones nombradas salen de la capa de tipos; la obligatoriedad, de `nullable`.

Verificación del criterio SSOT (2.1): `horas_semanales` aparece **una sola vez** como campo — en el modelo materias. La columna SQL, la validación de rango (vía la capa de tipos), la columna de grilla y su aparición en los combos que referencian materias se derivan de esa única mención.

## 8. Cuestiones que este ejercicio dejó a la vista

Decisiones provisorias a confirmar, y problemas nuevos que aparecieron:

1. **Parámetros del tipo solo en el catálogo**: `horas_semanales` (1–60) vive en la capa de tipos, estilo "Edad" (2.5). ¿Qué pasa cuando un campo necesita un rango puntual no reutilizable: se crea igual un tipo, o se admite override por campo? Es la pregunta de composición de 2.5.
2. **Repetición en los mapeos físicos**: `codigo`, `texto` y `email` mapean idéntico en todas las representaciones. Es repetición técnica (2.2) que la composición de tipos (2.5) debería eliminar — por ejemplo, "email se representa como texto".
3. **NOT NULL por defecto**: decidido provisoriamente (sección 4). Confirmar.
4. **Referencias a comportamientos, ¿chequeadas en compilación?**: los tipos referencian validaciones (`validation: 'email'`) y los modelos referencian cálculos; hoy esas referencias las valida el framework al conectar las partes. La alternativa es declarar `behaviors` antes que `models` y pasarlo como parámetro de tipo a `ModelsDef` (cada Def recibe solo las capas que necesita, así que es posible) para chequear los nombres de método en compilación, pero eso impide lo inverso: tipar el `row` de cada cálculo a partir del modelo. Hay una circularidad genuina; hay que elegir qué lado se chequea en compilación.
5. **Tipado de los comportamientos contra los modelos**: el `row` de `nombre_completo` debería tiparse solo (derivado del modelo profesores) y no a mano. Es el otro lado de la circularidad del punto 4.
6. **`references` tipado contra la propia capa**: idealmente `references: 'profesores'` sería `keyof` del objeto de entidades que se está definiendo — autorreferencia que hay que ver si TypeScript permite expresar razonablemente.
7. **¿`computed`, `isName` e `inComboBox` son del modelo o de la entidad?**: los puse en el modelo (FieldDef), pero puede argumentarse que son cuestión de la entidad (cómo se muestra cuando se la referencia). Relacionado con el pendiente de 2.3 sobre dónde viven los comportamientos.
8. **Modelo↔entidad casi 1:1**: en este ejemplo cada entidad usa un modelo homónimo. ¿Conviene un atajo para ese caso, reservando la separación para vistas/variantes?
9. **Singular/plural**: la entidad se llama `profesores` y el tipo derivado sería `Profesor`. ¿Se deriva automáticamente (problemático en español) o se declara?
10. **`isName` sobre columna calculada**: `nombre_completo` es calculada y es el `isName` de profesores. Asumí que es válido; implica que el combo de las FKs a profesores muestra un valor calculado.
