/* EJEMPLO del sistema de alumnos */

import { boxType, commonTypeDefs, CoreFieldDef, defineTypes } from "../../src/common/ssot-types";
import { recordDef } from "../../src/common/ssot-record";
import { EntityDef, EntityInstanceType, defineEntities, entityDef, extractPk, mergePk, withRecords } from "../../src/common/ssot-entity";

export type Fecha = {año: number, mes: number, día:number}

const types = {
    ...commonTypeDefs,
    fecha: {tsType: boxType<Fecha>()},
    email: commonTypeDefs.text,
}

/* what a field of THIS system looks like: the core the ssot needs plus what aida wants. isName
   is not a concept of the framework, it is a decision of this system, and so are the defaults */
export type AidaFieldDef = CoreFieldDef<typeof types> & {
    isName?: boolean
    label?: string
    description?: string
}

/* the context this system is described against: one value that every layer of the SSOT
   receives, so a def never has to say twice which types it is talking about. The completer
   builds the info key by key, which also fixes the order the generators will see. */
export const aidaTypes = defineTypes({
    types,
    completeField: (fieldDef: AidaFieldDef, name: string) => ({
        type       : fieldDef.type,
        isName     : fieldDef.isName ?? false,
        nullable   : fieldDef.nullable ?? true,
        label      : fieldDef.label ?? name.replace(/_/g,' '),
        description: fieldDef.description ?? '',
    }),
})

/* THE RECORDS THAT DEPEND ON NOTHING: they only need the types */

export const cargo = recordDef(aidaTypes, {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denominación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},
})

export const materia = recordDef(aidaTypes, {
    materia          : {type: 'text'   },
    denominacion     : {type: 'text'   , label:'denominación', nullable: false, isName: true, description: 'si corresponde a más de una carrera, aclarar en el nombre'},
})

export const docente = recordDef(aidaTypes, {
    docente          : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    cargo            : {type: 'text' },
    email            : {type: 'email'},
    email_alternativo: {type: 'email'},
    jefe             : {type: 'text' , description: 'jefe de cátedra (otro docente)'},
})

export const asignacion = recordDef(aidaTypes, {
    docente: docente.docente,
    materia: materia.materia,
    cargo  : cargo.cargo,
})

export const periodo = recordDef(aidaTypes, {
    periodo          : {type: 'text' , description: 'bimestre, cuatrimestre, etc...'},
})

export const alumno = recordDef(aidaTypes, {
    alumno           : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    email            : {type: 'email'},
})

/* LEVEL 1 of the data model: the entities whose records stand on their own.
   Plural names wrap the singular record defs, and the entity names its record. */

export const aida1 = withRecords(aidaTypes, {cargo, materia, docente, asignacion, periodo, alumno})

export const cargos = entityDef(aida1, {record: 'cargo', pk: ['cargo']})

export const docentes = entityDef(aida1, {
    record: 'docente',
    pk: ['docente'],
    // reflexive fk: inside its own definition the entity is referenced by name,
    // and the source field (jefe) is mapped to the target field (docente)
    fks: {jefe: {entity: 'docentes', fields: {jefe: 'docente'}}},
})

export const materias = entityDef(aida1, {
    record: 'materia',
    pk: ['materia'],
    uks: {denominacion: ['denominacion']},
})

export const periodos = entityDef(aida1, {record: 'periodo', pk: ['periodo']})
export const alumnos  = entityDef(aida1, {record: 'alumno' , pk: ['alumno' ]})

/* LEVEL 2: curso inherits the pks of level 1, so it cannot exist before them */

export const curso = recordDef(aidaTypes, {
    ...extractPk(periodos),
    ...extractPk(materias),
    ...extractPk(docentes), // docente responsable del curso
})

export const aida2 = withRecords(aida1, {curso})

export const cursos = entityDef(aida2, {
    record: 'curso',
    pk: ['periodo', 'materia'],
    fks: {
        periodos   : {entity: 'periodos', fields: periodos.pk},
        materias   : {entity: 'materias', fields: materias.pk},
        responsable: {entity: 'docentes', fields: docentes.pk},
    },
})

/* LEVEL 3 */

export const clase = recordDef(aidaTypes, {
    ...extractPk(cursos),
    orden            : {type: 'integer'},
    fecha            : {type: 'fecha'  },
    tema             : {type: 'text'   },
})

export const aida3 = withRecords(aida2, {clase})

export const clases = entityDef(aida3, {
    record: 'clase',
    pk: [...cursos.pk, 'orden'],
    fks: {cursos: {entity: 'cursos', fields: cursos.pk}},
})

/* LEVEL 4: three records at the same depth, one single stage */

export const pregunta = recordDef(aidaTypes, {
    ...extractPk(clases),
    pregunta         : {type: 'integer'},
    formulacion      : {type: 'text'   , nullable:false, label: 'formulación', description: 'texto principal de la pregunta'},
    aclaraciones     : {type: 'text'   , description: 'texto que no necesita repetirse cuando se quiera referir a una pregunta por su formulación, pero que es necesario para aclarar el contexto o posibles ambigüedades de la pregunta'},
    tipo_respuesta   : {type: 'text'   , nullable:false, label: 'tipo'}
})

export const inscripcion = recordDef(aidaTypes, {
    ...extractPk(cursos),
    ...extractPk(alumnos),
})

/* two fks to the same entity, renaming the fields */

export const mesa = recordDef(aidaTypes, {
    ...extractPk(cursos),
    fecha            : {type: 'fecha'},
    presidente       : {type: 'text' },
    vocal            : {type: 'text' },
})

export const aida4 = withRecords(aida3, {pregunta, inscripcion, mesa})

export const preguntas = entityDef(aida4, {
    record: 'pregunta',
    pk: [...clases.pk, 'pregunta'],
    fks: {clases: {entity: 'clases', fields: clases.pk}},
})

export const inscripciones = entityDef(aida4, {
    record: 'inscripcion',
    pk: [...cursos.pk, 'alumno'],
    fks: {
        cursos : {entity: 'cursos' , fields: cursos.pk},
        alumnos: {entity: 'alumnos', fields: alumnos.pk},
    },
})

export const mesas = entityDef(aida4, {
    record: 'mesa',
    pk: [...cursos.pk, 'fecha'],
    fks: {
        cursos    : {entity: 'cursos'  , fields: cursos.pk},
        presidente: {entity: 'docentes', fields: {presidente: 'docente'}},
        vocal     : {entity: 'docentes', fields: {vocal: 'docente'}},
    },
})

/* LEVEL 5 */

export const opcion = recordDef(aidaTypes, {
    ...extractPk(preguntas),
    opcion           : {type: 'text'   },
    detalle          : {type: 'text'   },
})

export const aida5 = withRecords(aida4, {opcion})

export const opciones = entityDef(aida5, {
    record: 'opcion',
    pk: [...preguntas.pk, 'opcion'],
    fks: {preguntas: {entity: 'preguntas', fields: preguntas.pk}},
})

/* LEVEL 6: combined pk — inscripciones and clases share periodo and materia, no repetition;
   periodo and materia belong to both fks */

export const presencia = recordDef(aidaTypes, {
    ...extractPk(inscripciones),
    ...extractPk(clases),
})

export const aida6 = withRecords(aida5, {presencia})

export const presencias = entityDef(aida6, {
    record: 'presencia',
    pk: mergePk(inscripciones.pk, clases.pk),
    fks: {
        inscripciones: {entity: 'inscripciones', fields: inscripciones.pk},
        clases       : {entity: 'clases'       , fields: clases.pk},
    },
})

/* the context with everything: the last stage is the whole system */
export const aida = aida6

/* THE SYSTEM DESCRIBING ITSELF: what an aida field def looks like, said with the very same
   vocabulary. This is what a generator would read to build the screen that edits the
   definitions of aida. It cannot replace the static declaration above — a flat record cannot
   express that the type of defaultValue depends on the type of the field — so they are two
   halves, and the test checks that they did not drift apart. */

export type AidaTypeName = keyof typeof types

const metaTypes = {
    ...commonTypeDefs,
    typeName: {tsType: boxType<AidaTypeName>()},
}

export const aidaMetaContext = defineTypes({
    types: metaTypes,
    completeField: (fieldDef: CoreFieldDef<typeof metaTypes> & {label?: string}, name: string) => ({
        type    : fieldDef.type,
        nullable: fieldDef.nullable ?? true,
        label   : fieldDef.label ?? name.replace(/_/g,' '),
    }),
})

export const aidaFieldInfo = recordDef(aidaMetaContext, {
    type       : {type: 'typeName', nullable: false},
    isName     : {type: 'boolean' , nullable: false},
    nullable   : {type: 'boolean' , nullable: false},
    label      : {type: 'text'    , nullable: false},
    description: {type: 'text'    , nullable: false},
})

/* a record def is not only the fields of an entity: this one describes the parameters of a
   search endpoint and belongs to no table at all */
export const alumnoSearchParams = recordDef(aidaTypes, {
    apellido: {type: 'text' },
    desde   : {type: 'fecha'},
})

export const recordDefs = {
    cargo,
    docente,
    materia,
    asignacion,
    periodo,
    curso,
    clase,
    alumno,
    pregunta,
    opcion,
    inscripcion,
    presencia,
    mesa,
}

export const entityDefs = defineEntities({
    docentes,
    materias,
    periodos,
    cursos,
    clases,
    alumnos,
    preguntas,
    opciones,
    inscripciones,
    presencias,
    mesas,
})

/* the instance type of a row of an entity, bound to this system's context (the fields that are
   not marked nullable:false admit null):
   DefinedType<typeof cargos> = {cargo: string, orden?: number|null, ...} */
export type DefinedType<TEntityDef extends EntityDef<typeof aida>> = EntityInstanceType<typeof aida, TEntityDef>

export function validarCargo(cargoSinValidar: DefinedType<typeof cargos>){
    // denominacion is nullable in the def, so the deduced type forces the null check here
    if (cargoSinValidar.puede_dirigir && cargoSinValidar.denominacion?.match(/ayudante/i)) {
        throw new Error('Los ayudantes no pueden dirigir. Recibido:"' + cargoSinValidar.denominacion + '"');
    }
}

