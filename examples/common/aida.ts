/* EJEMPLO del sistema de alumnos */

import {
    boxType, commonTypeDefs,
    FieldDef, EntityInstanceType, defineEntity, defineEntities, extractPk, mergePk,
    EntityDef
} from "../../src/common/system-design";

export type PlainDate = {year: number, month: number, day: number}
export type PlainTime = {hour: number, minute: number}
export type TstzRange = {from: Date, to: Date | null}
export type TstzMultirange = readonly TstzRange[]

export var typeDefs = {
    ...commonTypeDefs,
    email           : commonTypeDefs.text,
    /* enteros con un dominio más chico que integer */
    positive_integer: commonTypeDefs.integer,
    /* lo numera la base */
    serial          : commonTypeDefs.integer,
    plaindate       : {tsType: boxType<PlainDate>()},
    time            : {tsType: boxType<PlainTime>()},
    timestamp       : {tsType: boxType<Date>()},
    timestamptz     : {tsType: boxType<Date>()},
    tstzmultirange  : {tsType: boxType<TstzMultirange>()},
}

/* lo que este sistema le agrega a la definición de un campo, aprovechando que los tipos
   de TypeScript admiten propiedades de más:
     - `defaultValue`: el valor que toma el campo cuando no se lo especifica;
     - `options`: los valores admitidos, cuando son unos pocos fijos. No son un tipo
       aparte (el tipo sigue siendo text o boolean), son opciones de ese tipo;
     - `secreto`: el campo no se muestra ni se manda al frontend. */
export type FieldsDef = FieldDef<typeof typeDefs> & {
    defaultValue?: string | number | boolean | readonly unknown[]
    options?: readonly (string | number | boolean)[]
    secreto?: true
}

export type RecordsDef = Record<string, FieldsDef>

/* lo mismo a nivel entidad: `title`, `description` y `skipCrud` son de este sistema, no del
   framework. `defineEntity` y `completeEntity` las dejan pasar (no se pierde nada de la
   definición), pero los tipos todavía no las llevan, así que cada definición que las usa
   necesita un `// @ts-expect-error`. Lo dejo así porque no sé cómo declarar un genérico que
   extienda la definición de tabla y del que se pueda sacar el completo, sin agregar un
   parámetro de tipo extra ni tocar otra cosa en los tipos. */

export const cargo = {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denominación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},

} satisfies RecordsDef

export const cargos = defineEntity({
    fields: cargo,
    pk: ['cargo'],
})

/* --- tablas estables --- */

export const periodo = {
    periodo : {type: 'text', label: 'período'},
    cerrado : {type: 'boolean', nullable: false, defaultValue: false},
} satisfies RecordsDef

export const periodos = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    title: 'períodos',
    description: 'períodos: cuatrimestres, bimestres, etc...',
    pk: ['periodo'],
    fields: periodo,
})

export const curso = {
    ...extractPk(periodos),
    cod_mat        : {type: 'text'},
    nombre_materia : {type: 'text'   , nullable: false},
    abierto        : {type: 'boolean', nullable: false, defaultValue: false},
} satisfies RecordsDef

export const cursos = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'materias por período lectivo',
    pk: [...periodos.pk, 'cod_mat'],
    fks: {periodos: {entity: 'periodos', fields: periodos.pk}},
    fields: curso,
})

export const comision = {
    ...extractPk(cursos),
    comision     : {type: 'text', label: 'comisión'},
    denominacion : {type: 'text', nullable: false, isName: true, label: 'denominación'},
    hora_desde   : {type: 'time'},
    hora_hasta   : {type: 'time'},
} satisfies RecordsDef

export const comisiones = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    title: 'comisiones',
    description: 'comisiones de cada curso (teórica, práctica, laboratorio, ...)',
    pk: [...cursos.pk, 'comision'],
    fks: {cursos: {entity: 'cursos', fields: cursos.pk}},
    fields: comision,
})

export const sede = {
    sede   : {type: 'text'},
    nombre : {type: 'text', nullable: false, isName: true},
} satisfies RecordsDef

export const sedes = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'sedes',
    pk: ['sede'],
    fields: sede,
})

export const aula = {
    ...extractPk(sedes),
    aula              : {type: 'text'},
    descripcion       : {type: 'text', label: 'descripción'},
    filas             : {type: 'positive_integer'},
    asientos_por_fila : {type: 'positive_integer'},
    escritorios       : {type: 'text'},
    puertas           : {type: 'text'},
} satisfies RecordsDef

export const aulas = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'aulas disponibles',
    pk: [...sedes.pk, 'aula'],
    fks: {sedes: {entity: 'sedes', fields: sedes.pk}},
    fields: aula,
})

/* La lista de inscriptos de cada materia llega de otro sistema, por curso, y la misma
   persona puede venir en dos listas con el nombre escrito distinto, otra libreta u otro
   mail. Consolidar eso a mano no es trabajo que se le pueda pedir a nadie, así que no se
   consolida: la fila importada queda tal como vino (`inscripciones`) y lo único común a
   la persona es lo verificable: el mail, que se prueba con el link de recuperación. */

/* la pk de inscripciones, aparte porque alumnos la repite entre sus campos comunes */
const inscripcion_pk = {
    ...extractPk(cursos),
    libreta : {type: 'text'},
} satisfies RecordsDef

/* los campos con los que se entra al sistema, iguales en alumnos y en docentes */
const credenciales = {
    email_alternativo : {type: 'email'},
    hash_pass         : {type: 'text', secreto: true},
    hash_type         : {type: 'text', nullable: false, label: 'tipo de hash',
                         options: ['scram-sha-256', 'bcrypt'], defaultValue: 'scram-sha-256'},
    last_pass_change  : {type: 'plaindate', label: 'último cambio de contraseña'},
} satisfies RecordsDef

export const alumno = {
    email : {type: 'email'},
    /* La inscripción con la que el alumno se muestra. Arranca en la primera que lo creó
       y él puede elegir otra: el nombre no lo edita, elige con cuál de los que ya
       mandaron las listas se lo nombra.
       Acá no son pk, así que hay que decir que no son nulleables (el default es true). */
    periodo : {...inscripcion_pk.periodo, nullable: false},
    cod_mat : {...inscripcion_pk.cod_mat, nullable: false},
    libreta : {...inscripcion_pk.libreta, nullable: false},
    /* Con qué más puede escribir su usuario, además del mail. Por ahora está siempre en
       null: es lo que hace que las tres fuentes de login (alumnos, docentes, users) se
       busquen igual. */
    username : {type: 'text'},
    /* hash_pass en null = todavía no eligió contraseña (así lo crea el trigger cuando
       aparece una inscripción con un mail nuevo). Entra por "olvidé mi contraseña". */
    ...credenciales,
} satisfies RecordsDef

export const alumnos = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'las personas que entran al sistema: el mail es la identidad',
    pk: ['email'],
    /* circular con la fk alumnos de inscripciones: en la base tiene que ser DEFERRABLE.
       Acá la fk nombra a la entidad destino en vez de referenciar el objeto, así que las
       dos se pueden escribir en su lugar. */
    fks: {inscripciones: {entity: 'inscripciones', fields: ['periodo', 'cod_mat', 'libreta']}},
    fields: alumno,
})

export const inscripcion = {
    ...inscripcion_pk,
    /* Tal como vino en la lista del otro sistema. No se corrige para que dos
       inscripciones coincidan: son dos listas distintas y las dos dicen la verdad. */
    apellido          : {type: 'text' , nullable: false},
    nombres           : {type: 'text' , nullable: false},
    email             : {type: 'email', nullable: false},
    plan              : {type: 'text'},
    /* A qué alumno corresponde esta inscripción. Lo llena un trigger normalizando el
       email, y crea el alumno si no estaba. Es un campo aparte del `email` importado
       justamente para poder corregirlo: cuando la misma persona aparece con dos mails, se
       apunta esta inscripción al otro alumno sin tocar el dato que mandó el otro sistema.
       Nullable acá (mandarlo en null es pedirle al trigger que lo calcule); en la base es
       NOT NULL. */
    email_normalizado : {type: 'email', label: 'mail del alumno'},
} satisfies RecordsDef

export const inscripciones = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'inscripciones a cada curso, tal como las manda el sistema de inscripciones',
    pk: [...cursos.pk, 'libreta'],
    fks: {
        cursos : {entity: 'cursos' , fields: cursos.pk},
        alumnos: {entity: 'alumnos', fields: {email_normalizado: 'email'}},
    },
    fields: inscripcion,
})

export const docente = {
    legajo   : {type: 'text'},
    username : {type: 'text' , nullable: false},
    apellido : {type: 'text' , nullable: false},
    nombres  : {type: 'text' , nullable: false},
    cargo    : {type: 'text'},
    email    : {type: 'email', nullable: false},
    ...credenciales,
} satisfies RecordsDef

export const docentes = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'docentes',
    pk: ['legajo'],
    fields: docente,
})

export const asignacion = {
    ...extractPk(cursos),
    ...extractPk(docentes),
} satisfies RecordsDef

export const asignacion_docente = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'docentes asignados a cada curso',
    pk: [...cursos.pk, ...docentes.pk],
    fks: {cursos: {entity: 'cursos', fields: cursos.pk}},
    fields: asignacion,
})

/* --- tablas dinámicas --- */

/* la parte no pk de clases, aparte porque snapshots_clases la repite entera */
const datos_clase = {
    tema              : {type: 'text', nullable: false},
    filas             : {type: 'positive_integer'},
    asientos_por_fila : {type: 'positive_integer'},
    empezada          : {type: 'boolean', nullable: false, defaultValue: false},
    escritorios       : {type: 'text'},
    /* Dónde se da la clase. Es una sola: una clase no se da en dos aulas a la vez.
       Van al final porque en las bases que ya existen se agregan al final, y así una
       base actualizada queda igual que una creada de cero. */
    ...extractPk(aulas),
} satisfies RecordsDef

export const clase = {
    ...extractPk(comisiones),
    fecha : {type: 'plaindate'},
    ...datos_clase,
} satisfies RecordsDef

export const clases = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'clases dictadas',
    pk: [...comisiones.pk, 'fecha'],
    fks: {
        comisiones: {entity: 'comisiones', fields: comisiones.pk},
        aulas     : {entity: 'aulas'     , fields: aulas.pk},
    },
    fields: clase,
})

export const pregunta = {
    ...extractPk(clases),
    id_pregunta        : {type: 'integer'},
    pregunta           : {type: 'text', nullable: false},
    aclaracion         : {type: 'text', label: 'aclaración'},
    tipo               : {type: 'text'   , nullable: false, defaultValue: 'texto',
                          options: ['int', 'texto', 'opciones', 'multiple_opcion']},
    abierta            : {type: 'boolean', nullable: false, defaultValue: false},
    respuesta_correcta : {type: 'text'},
} satisfies RecordsDef

export const preguntas = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'preguntas realizadas en clase',
    pk: [...clases.pk, 'id_pregunta'],
    fks: {clases: {entity: 'clases', fields: clases.pk}},
    fields: pregunta,
})

export const opcion = {
    ...extractPk(preguntas),
    id_opcion : {type: 'text', label: 'opción'},
    detalle   : {type: 'text', nullable: false},
} satisfies RecordsDef

export const opciones = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'opciones de las preguntas (simples o múltiples)',
    pk: [...preguntas.pk, 'id_opcion'],
    fks: {preguntas: {entity: 'preguntas', fields: preguntas.pk}},
    fields: opcion,
})

export const respuesta = {
    ...extractPk(preguntas),
    ...extractPk(inscripciones),
    respuesta : {type: 'text'     , nullable: false},
    momento   : {type: 'timestamp', nullable: false},
} satisfies RecordsDef

export const respuestas = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'respuestas de alumnos a preguntas',
    pk: mergePk(preguntas.pk, inscripciones.pk),
    fks: {
        preguntas    : {entity: 'preguntas'    , fields: preguntas.pk},
        inscripciones: {entity: 'inscripciones', fields: inscripciones.pk},
    },
    fields: respuesta,
})

export const respuesta_seleccion = {
    ...extractPk(respuestas),
    seleccion : opcion.id_opcion,
    id_opcion : opcion.id_opcion,
    es_unica  : {type: 'boolean'},
    texto     : {type: 'text'},
} satisfies RecordsDef

export const respuestas_selecciones = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'opciones elegidas en las respuestas múltiples o simples',
    skipCrud: true,
    pk: [...respuestas.pk, 'seleccion'],
    fks: {
        respuestas: {entity: 'respuestas', fields: respuestas.pk},
        opciones  : {entity: 'opciones'  , fields: opciones.pk},
    },
    fields: respuesta_seleccion,
})

/* Las filas y los asientos son de la clase, no del aula: el aula es un dato de la clase
   (`clases.sede`, `clases.aula`) y no entra en estas pk. Si entrara habría que mostrar
   varias aulas a la vez, que es justamente lo que no queremos. */

export const clase_fila = {
    ...extractPk(clases),
    fila : {type: 'positive_integer'},
} satisfies RecordsDef

export const clase_filas = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'filas de asientos disponibles en cada clase',
    pk: [...clases.pk, 'fila'],
    fks: {clases: {entity: 'clases', fields: clases.pk}},
    fields: clase_fila,
})

export const clase_asiento = {
    ...extractPk(clase_filas),
    asiento : {type: 'positive_integer'},
    uso     : {type: 'text'},
} satisfies RecordsDef

export const clase_asientos = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'asientos disponibles por fila y clase',
    pk: [...clase_filas.pk, 'asiento'],
    fks: {clase_filas: {entity: 'clase_filas', fields: clase_filas.pk}},
    fields: clase_asiento,
})

/* la parte no pk de presentes sin `horarios`, aparte porque snapshots_presentes repite
   exactamente esos campos */
const ubicacion = {
    presente : {type: 'boolean', nullable: false},
    retiro   : {type: 'boolean', nullable: false, defaultValue: false},
    fila     : {type: 'positive_integer'},
    asiento  : {type: 'positive_integer'},
} satisfies RecordsDef

export const presente = {
    ...extractPk(clases),
    ...extractPk(inscripciones),
    ...ubicacion,
    /* Tramos en los que el alumno estuvo presente; lo mantiene un trigger.
       El default (multirango vacío) es "sin registro de horarios". */
    horarios : {type: 'tstzmultirange', nullable: false, defaultValue: []},
} satisfies RecordsDef

export const presentes = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'asistencia de alumnos a clase',
    pk: mergePk(clases.pk, inscripciones.pk),
    fks: {
        clases       : {entity: 'clases'       , fields: clases.pk},
        inscripciones: {entity: 'inscripciones', fields: inscripciones.pk},
    },
    fields: presente,
})

/* --- snapshots ---
   Un snapshot es una foto de un momento. La tabla `snapshots` es genérica: solo el número
   y la hora, no sabe de qué es la foto. Lo fotografiado cuelga de ella en una tabla
   `snapshots_<tabla>` por cada tabla que haga falta, con la pk de esa tabla + `snapshot`
   y sus mismos campos.

   Una de esas tablas es el alcance del snapshot: la que dice de qué es la foto y se graba
   siempre, aunque no haya nada más que fotografiar. Hoy el único alcance es la clase
   (`snapshots_clases`) y lo único que se fotografía adentro son los presentes
   (`snapshots_presentes`, hija de `snapshots_clases` igual que `presentes` lo es de
   `clases`): eso es el control del aula del docente. */

export const snapshot = {
    snapshot : {type: 'serial'},
    momento  : {type: 'timestamptz', nullable: false},
} satisfies RecordsDef

export const snapshots = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    title: 'snapshots',
    description: 'cada foto de un momento; lo fotografiado va en las tablas snapshots_*',
    pk: ['snapshot'],
    fields: snapshot,
})

export const snapshot_clase = {
    ...extractPk(snapshots),
    ...extractPk(clases),
    ...datos_clase,
} satisfies RecordsDef

export const snapshots_clases = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'de qué clase es cada snapshot (y cómo estaba la clase en ese momento)',
    pk: mergePk(snapshots.pk, clases.pk),
    fks: {
        snapshots: {entity: 'snapshots', fields: snapshots.pk},
        clases   : {entity: 'clases'   , fields: clases.pk},
    },
    fields: snapshot_clase,
})

/* Las mismas columnas que `presentes` menos `horarios`: el snapshot es la foto de las
   ubicaciones en un momento, y la historia de tramos ya la lleva presentes.horarios. */
export const snapshot_presente = {
    ...extractPk(snapshots_clases),
    ...extractPk(inscripciones),
    ...ubicacion,
} satisfies RecordsDef

export const snapshots_presentes = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'ubicaciones de los alumnos en un snapshot (el control del aula del docente)',
    pk: mergePk(snapshots_clases.pk, inscripciones.pk),
    fks: {
        snapshots_clases: {entity: 'snapshots_clases', fields: snapshots_clases.pk},
        inscripciones   : {entity: 'inscripciones'   , fields: inscripciones.pk},
    },
    fields: snapshot_presente,
})

export const docente_presente = {
    ...extractPk(clases),
    ...extractPk(asignacion_docente),
    tema : {type: 'text'},
} satisfies RecordsDef

export const docentes_presentes = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'docentes presentes en clase',
    pk: mergePk(clases.pk, asignacion_docente.pk),
    fks: {
        clases            : {entity: 'clases'            , fields: clases.pk},
        asignacion_docente: {entity: 'asignacion_docente', fields: asignacion_docente.pk},
    },
    fields: docente_presente,
})

/* --- parámetros y usuarios --- */

export const parameter = {
    unique_row : {type: 'boolean', options: [true], defaultValue: true},
    app_name   : {type: 'text'     , nullable: false, label: 'nombre de la app'},
    fecha_test : {type: 'plaindate', label: 'fecha de prueba'},
} satisfies RecordsDef

export const parameters = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'parámetros globales de la aplicación (una sola fila: unique_row = true siempre)',
    pk: ['unique_row'],
    fields: parameter,
})

export const user = {
    username   : {type: 'text'},
    first_name : {type: 'text'},
    last_name  : {type: 'text'},
    email      : {type: 'email'},
    ...credenciales,
    /* acá el hash_type sí es nulleable */
    hash_type  : {...credenciales.hash_type, nullable: true},
    rol        : {type: 'text', nullable: false, options: ['admin']},
} satisfies RecordsDef

export const users = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'usuarios del sistema',
    pk: ['username'],
    fields: user,
})

export const password_reset_token = {
    token      : {type: 'text'},
    rol        : {type: 'text'       , nullable: false, options: ['alumno', 'docente', 'admin']},
    identity   : {type: 'text'       , nullable: false},
    created_at : {type: 'timestamptz', nullable: false},
    used_at    : {type: 'timestamptz'},
} satisfies RecordsDef

export const password_reset_tokens = defineEntity({
    // @ts-expect-error las propiedades de este sistema no están en los tipos (ver la nota de arriba)
    description: 'tokens de recuperación de contraseña',
    skipCrud: true,
    pk: ['token'],
    fields: password_reset_token,
})

export const recordDefs = {
    cargo,
    periodo,
    sede,
    curso,
    comision,
    alumno,
    inscripcion,
    docente,
    asignacion,
    parameter,
    user,
    aula,
    clase,
    pregunta,
    opcion,
    respuesta,
    respuesta_seleccion,
    clase_fila,
    clase_asiento,
    presente,
    snapshot,
    snapshot_clase,
    snapshot_presente,
    docente_presente,
    password_reset_token,
}

export const entityDefs = defineEntities({
    periodos,
    sedes,
    cursos,
    comisiones,
    alumnos,
    inscripciones,
    docentes,
    asignacion_docente,
    parameters,
    users,
    aulas,
    clases,
    preguntas,
    opciones,
    respuestas,
    respuestas_selecciones,
    clase_filas,
    clase_asientos,
    presentes,
    snapshots,
    snapshots_clases,
    snapshots_presentes,
    docentes_presentes,
    password_reset_tokens,
})

/* the instance type of a record def, bound to this entity instance system's typeDefs (the fields that are
   not marked nullable:false admit null):
   DefinedType<typeof cargos> = {cargo: string, orden?: number|null, ...} */
export type DefinedType<TRecordDef extends EntityDef<typeof typeDefs>> = EntityInstanceType<typeof typeDefs, TRecordDef>

export function validarCargo(cargoSinValidar: DefinedType<typeof cargos>){
    // denominacion is nullable in the def, so the deduced type forces the null check here
    if (cargoSinValidar.puede_dirigir && cargoSinValidar.denominacion?.match(/ayudante/i)) {
        throw new Error('Los ayudantes no pueden dirigir. Recibido:"' + cargoSinValidar.denominacion + '"');
    }
}

/* una pregunta abierta no lleva respuesta correcta */
export function validarPregunta(preguntaSinValidar: DefinedType<typeof preguntas>){
    if (preguntaSinValidar.abierta && preguntaSinValidar.respuesta_correcta) {
        throw new Error('Una pregunta abierta no puede tener respuesta correcta. Recibido:"' + preguntaSinValidar.respuesta_correcta + '"');
    }
}
