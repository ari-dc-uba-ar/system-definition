/* EJEMPLO del sistema de alumnos */

import {
    boxType, commonTypeDefs,
    RecordDef
} from "../../src/common/system-design";

type Fecha = {año: number, mes: number, día:number}

export var typeDefs = {
    ...commonTypeDefs,
    fecha: {tsType: boxType<Fecha>()},
    email: commonTypeDefs.text
}

type RecordsDef = RecordDef<typeof typeDefs>

export const cargo = {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denomiación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},

} satisfies RecordsDef

export const materia = {
    materia          : {type: 'text' },
    denominacion     : {type: 'text' , label:'denomiación'},
} satisfies RecordsDef

export const docente = {
    docente          : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    cargo            : {type: 'text' },
    email            : {type: 'email'},
    email_alternativo: {type: 'email'},
} satisfies RecordsDef

export const asignacion = {
    docente: docente.docente,
    materia: materia.materia,
    cargo  : cargo.cargo,
} satisfies RecordsDef

export const recordDefs = {
    cargo,
    docente,
    materia,
    asignacion
}
