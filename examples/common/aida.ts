/* EJEMPLO del sistema de alumnos */

import {
    boxType, commonTypeDefs,
    RecordDef, RecordInstanceType, defineEntity, defineEntities, extractPk, mergePk
} from "../../src/common/system-design";

type Fecha = {año: number, mes: number, día:number}

export var typeDefs = {
    ...commonTypeDefs,
    fecha: {tsType: boxType<Fecha>()},
    email: commonTypeDefs.text
}

type RecordsDef = RecordDef<typeof typeDefs>

/* the instance type of a record def, bound to this system's typeDefs:
   DefinedType<typeof cargo> = {cargo: string, orden: number, ...} */
export type DefinedType<TRecordDef extends RecordsDef> = RecordInstanceType<typeof typeDefs, TRecordDef>

export const cargo = {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denominación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},

} satisfies RecordsDef

export const materia = {
    materia          : {type: 'text'   },
    denominacion     : {type: 'text'   , label:'denominación', nullable: false, isName: true, description: 'si corresponde a más de una carrera, aclarar en el nombre'},
} satisfies RecordsDef

export const docente = {
    docente          : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    cargo            : {type: 'text' },
    email            : {type: 'email'},
    email_alternativo: {type: 'email'},
    jefe             : {type: 'text' , description: 'jefe de cátedra (otro docente)'},
} satisfies RecordsDef

export const asignacion = {
    docente: docente.docente,
    materia: materia.materia,
    cargo  : cargo.cargo,
} satisfies RecordsDef

export const periodo = {
    periodo          : {type: 'text' , description: 'bimestre, cuatrimestre, etc...'},
} satisfies RecordsDef

/* entities: plural names wrap the singular record defs */

export const docentes = defineEntity({
    pk: ['docente'],
    // reflexive fk: inside its own definition the entity is referenced by name,
    // and the source field (jefe) is mapped to the target field (docente)
    fks: {jefe: {entity: 'docentes', fields: {jefe: 'docente'}}},
    fields: docente,
})
export const materias = defineEntity({
    pk: ['materia'],
    uks: {denominacion: ['denominacion']},
    fields: materia,
})
export const periodos = defineEntity({pk: ['periodo'], fields: periodo})

export const curso = {
    ...extractPk(periodos),
    ...extractPk(materias),
    ...extractPk(docentes), // docente responsable del curso
} satisfies RecordsDef

export const cursos = defineEntity({
    pk: ['periodo', 'materia'],
    fks: {
        periodos   : {entity: 'periodos', fields: periodos.pk},
        materias   : {entity: 'materias', fields: materias.pk},
        responsable: {entity: 'docentes', fields: docentes.pk},
    },
    fields: curso,
})

export const clase = {
    ...extractPk(cursos),
    orden            : {type: 'integer'},
    fecha            : {type: 'fecha'  },
    tema             : {type: 'text'   },
} satisfies RecordsDef

export const clases = defineEntity({
    pk: [...cursos.pk, 'orden'],
    fks: {cursos: {entity: 'cursos', fields: cursos.pk}},
    fields: clase,
})

export const alumno = {
    alumno           : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    email            : {type: 'email'},
} satisfies RecordsDef

export const alumnos = defineEntity({pk: ['alumno'], fields: alumno})

export const pregunta = {
    ...extractPk(clases),
    pregunta         : {type: 'integer'},
    formulacion      : {type: 'text'   , nullable:false, label: 'formulación', description: 'texto principal de la pregunta'},
    aclaraciones     : {type: 'text'   , description: 'texto que no necesita repetirse cuando se quiera referir a una pregunta por su formulación, pero que es necesario para aclarar el contexto o posibles ambigüedades de la pregunta'},
    tipo_respuesta   : {type: 'text'   , nullable:false, label: 'tipo'}
} satisfies RecordsDef

export const preguntas = defineEntity({
    pk: [...clases.pk, 'pregunta'],
    fks: {clases: {entity: 'clases', fields: clases.pk}},
    fields: pregunta,
})

export const opcion = {
    ...extractPk(preguntas),
    opcion           : {type: 'text'   },
    detalle          : {type: 'text'   },
} satisfies RecordsDef

export const opciones = defineEntity({
    pk: [...preguntas.pk, 'opcion'],
    fks: {preguntas: {entity: 'preguntas', fields: preguntas.pk}},
    fields: opcion,
})

export const inscripcion = {
    ...extractPk(cursos),
    ...extractPk(alumnos),
} satisfies RecordsDef

export const inscripciones = defineEntity({
    pk: [...cursos.pk, 'alumno'],
    fks: {
        cursos : {entity: 'cursos' , fields: cursos.pk},
        alumnos: {entity: 'alumnos', fields: alumnos.pk},
    },
    fields: inscripcion,
})

/* combined pk: inscripciones and clases share periodo and materia, no repetition;
   periodo and materia belong to both fks */

export const presencia = {
    ...extractPk(inscripciones),
    ...extractPk(clases),
} satisfies RecordsDef

export const presencias = defineEntity({
    pk: mergePk(inscripciones.pk, clases.pk),
    fks: {
        inscripciones: {entity: 'inscripciones', fields: inscripciones.pk},
        clases       : {entity: 'clases'       , fields: clases.pk},
    },
    fields: presencia,
})

/* two fks to the same entity, renaming the fields */

export const mesa = {
    ...extractPk(cursos),
    fecha            : {type: 'fecha'},
    presidente       : {type: 'text' },
    vocal            : {type: 'text' },
} satisfies RecordsDef

export const mesas = defineEntity({
    pk: [...cursos.pk, 'fecha'],
    fks: {
        cursos    : {entity: 'cursos'  , fields: cursos.pk},
        presidente: {entity: 'docentes', fields: {presidente: 'docente'}},
        vocal     : {entity: 'docentes', fields: {vocal: 'docente'}},
    },
    fields: mesa,
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

export function validarCargo(cargoSinValidar: DefinedType<typeof cargo>){
    if (cargoSinValidar.puede_dirigir && cargoSinValidar.denominacion.match(/ayudante/i)) {
        throw new Error('Los ayudantes no pueden dirigir. Recibido:"' + cargoSinValidar.denominacion + '"');
    }
}
