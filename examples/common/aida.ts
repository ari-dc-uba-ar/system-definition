/* EJEMPLO del sistema de alumnos */

import { boxType, commonTypeDefs } from "../../src/common/ssot-types";
import { recordDef } from "../../src/common/ssot-record";
import { EntityDef, EntityInstanceType, defineEntity, defineEntities, extractPk, mergePk } from "../../src/common/ssot-entity";

export type Fecha = {año: number, mes: number, día:number}

/* the context this system is described against: one value that every layer of the SSOT
   receives, so a def never has to say twice which types it is talking about */
export const aidaContext = {
    types: {
        ...commonTypeDefs,
        fecha: {tsType: boxType<Fecha>()},
        email: commonTypeDefs.text,
    }
}

export const cargo = recordDef(aidaContext, {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denominación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},
})

export const cargos = defineEntity({
    fields: cargo,
    pk: ['cargo'],
})

export const materia = recordDef(aidaContext, {
    materia          : {type: 'text'   },
    denominacion     : {type: 'text'   , label:'denominación', nullable: false, isName: true, description: 'si corresponde a más de una carrera, aclarar en el nombre'},
})

export const docente = recordDef(aidaContext, {
    docente          : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    cargo            : {type: 'text' },
    email            : {type: 'email'},
    email_alternativo: {type: 'email'},
    jefe             : {type: 'text' , description: 'jefe de cátedra (otro docente)'},
})

export const asignacion = recordDef(aidaContext, {
    docente: docente.docente,
    materia: materia.materia,
    cargo  : cargo.cargo,
})

export const periodo = recordDef(aidaContext, {
    periodo          : {type: 'text' , description: 'bimestre, cuatrimestre, etc...'},
})

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

export const curso = recordDef(aidaContext, {
    ...extractPk(periodos),
    ...extractPk(materias),
    ...extractPk(docentes), // docente responsable del curso
})

export const cursos = defineEntity({
    pk: ['periodo', 'materia'],
    fks: {
        periodos   : {entity: 'periodos', fields: periodos.pk},
        materias   : {entity: 'materias', fields: materias.pk},
        responsable: {entity: 'docentes', fields: docentes.pk},
    },
    fields: curso,
})

export const clase = recordDef(aidaContext, {
    ...extractPk(cursos),
    orden            : {type: 'integer'},
    fecha            : {type: 'fecha'  },
    tema             : {type: 'text'   },
})

export const clases = defineEntity({
    pk: [...cursos.pk, 'orden'],
    fks: {cursos: {entity: 'cursos', fields: cursos.pk}},
    fields: clase,
})

export const alumno = recordDef(aidaContext, {
    alumno           : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    email            : {type: 'email'},
})

export const alumnos = defineEntity({pk: ['alumno'], fields: alumno})

export const pregunta = recordDef(aidaContext, {
    ...extractPk(clases),
    pregunta         : {type: 'integer'},
    formulacion      : {type: 'text'   , nullable:false, label: 'formulación', description: 'texto principal de la pregunta'},
    aclaraciones     : {type: 'text'   , description: 'texto que no necesita repetirse cuando se quiera referir a una pregunta por su formulación, pero que es necesario para aclarar el contexto o posibles ambigüedades de la pregunta'},
    tipo_respuesta   : {type: 'text'   , nullable:false, label: 'tipo'}
})

export const preguntas = defineEntity({
    pk: [...clases.pk, 'pregunta'],
    fks: {clases: {entity: 'clases', fields: clases.pk}},
    fields: pregunta,
})

export const opcion = recordDef(aidaContext, {
    ...extractPk(preguntas),
    opcion           : {type: 'text'   },
    detalle          : {type: 'text'   },
})

export const opciones = defineEntity({
    pk: [...preguntas.pk, 'opcion'],
    fks: {preguntas: {entity: 'preguntas', fields: preguntas.pk}},
    fields: opcion,
})

export const inscripcion = recordDef(aidaContext, {
    ...extractPk(cursos),
    ...extractPk(alumnos),
})

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

export const presencia = recordDef(aidaContext, {
    ...extractPk(inscripciones),
    ...extractPk(clases),
})

export const presencias = defineEntity({
    pk: mergePk(inscripciones.pk, clases.pk),
    fks: {
        inscripciones: {entity: 'inscripciones', fields: inscripciones.pk},
        clases       : {entity: 'clases'       , fields: clases.pk},
    },
    fields: presencia,
})

/* two fks to the same entity, renaming the fields */

export const mesa = recordDef(aidaContext, {
    ...extractPk(cursos),
    fecha            : {type: 'fecha'},
    presidente       : {type: 'text' },
    vocal            : {type: 'text' },
})

export const mesas = defineEntity({
    pk: [...cursos.pk, 'fecha'],
    fks: {
        cursos    : {entity: 'cursos'  , fields: cursos.pk},
        presidente: {entity: 'docentes', fields: {presidente: 'docente'}},
        vocal     : {entity: 'docentes', fields: {vocal: 'docente'}},
    },
    fields: mesa,
})

/* a record def is not only the fields of an entity: this one describes the parameters of a
   search endpoint and belongs to no table at all */
export const alumnoSearchParams = recordDef(aidaContext, {
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
export type DefinedType<TEntityDef extends EntityDef<typeof aidaContext>> = EntityInstanceType<typeof aidaContext, TEntityDef>

export function validarCargo(cargoSinValidar: DefinedType<typeof cargos>){
    // denominacion is nullable in the def, so the deduced type forces the null check here
    if (cargoSinValidar.puede_dirigir && cargoSinValidar.denominacion?.match(/ayudante/i)) {
        throw new Error('Los ayudantes no pueden dirigir. Recibido:"' + cargoSinValidar.denominacion + '"');
    }
}

