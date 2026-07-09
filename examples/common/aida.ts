/* EJEMPLO del sistema de alumnos */

import {
    boxType, commonTypeDefs,
    RecordDef, RecordInstanceType
} from "src/common/system-design";

type Fecha = {año: number, mes: number, día:number}

var typeDefs = {
    ...commonTypeDefs,
    fecha: {tsType: boxType<Fecha>()},
    email: commonTypeDefs.text
}

type RecordsDef = Record<string, RecordDef<typeof typeDefs>>

const cargo = {
    cargo            : {type: 'text' },
    denominacion     : {type: 'text' , label:'denomiación'},
    orden            : {type: 'integer'},
    puede_dirigir    : {type: 'boolean'},

} satisfies RecordsDef

const materia = {
    materia          : {type: 'text' },
    denominacion     : {type: 'text' , label:'denomiación'},
} satisfies RecordsDef

const docente = {
    docente          : {type: 'text' },
    apellido         : {type: 'text' , nullable:false},
    nombres          : {type: 'text' , nullable:false},
    cargo            : {type: 'text' },
    email            : {type: 'email'},
    email_alternativo: {type: 'email'},
} satisfies RecordsDef

const asignacion = {
    docente: docente.docente,
    materia: materia.materia,
    cargo  : cargo.cargo,
} satisfies RecordsDef

const recordDefs = {
    cargo,
    docente,
    materia,
    asignacion
}

/* candidatos a test */

function test_it_deduced_record_type(){
    type Cargo = {
        cargo        : string,
        denominacion : string,
        orden        : number,
        puede_dirigir: boolean
    }
    type CargoDeducido = RecordInstanceType<typeof typeDefs, typeof cargo>
    var jtp = {
        cargo        : 'JTP',
        denominacion : 'Jefe de Trabajos Prácticos',
        orden        : 4,
        puede_dirigir: true,
    }
    var cargoDeducido: CargoDeducido = jtp;
    var obtained = cargoDeducido;
    expect.deepEqual(jtp, cargoDeducido);
    expect.deepEqual(jtp, obtained);
}
