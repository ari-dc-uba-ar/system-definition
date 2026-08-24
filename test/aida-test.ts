import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { encode } from "@toon-format/toon";
import { strict as LikeAr } from "like-ar";

import { RecordInstanceType, EntityInstanceType, completeRecord, completeEntity, defineEntity, defineEntities, extractPk, mergePk,
    EntityDef, EntityInfoOf, ExpandType, FieldDef, Optional, TypeCollection
} from "../src/common/system-design";
import { typeDefs, cargo, cargos, docente, docentes, periodo, periodos, sede, curso, cursos, comision, comisiones,
    respuestas_selecciones,
    clase, clases, pregunta, preguntas, opcion, opciones, inscripciones, presente, presentes,
    entityDefs, DefinedType, validarCargo, validarPregunta, PlainDate
} from "../examples/common/aida";

describe("aida example", function(){
    it("deduces the record instance type", function(){
        // no field of cargo is marked nullable:false, so they all default to nullable
        type Cargo = {
            cargo        : string  | null,
            denominacion : string  | null,
            orden        : number  | null,
            puede_dirigir: boolean | null
        }
        type CargoDeducido = RecordInstanceType<typeof typeDefs, typeof cargo>
        var jtp: Cargo = {
            cargo        : 'JTP',
            denominacion : 'Jefe de Trabajos Prácticos',
            orden        : 4,
            puede_dirigir: true,
        }
        // both assignments must compile: Cargo and CargoDeducido are mutually assignable
        var cargoDeducido: CargoDeducido = jtp;
        var obtained: Cargo = cargoDeducido;
        assert.deepStrictEqual(cargoDeducido, jtp);
        assert.deepStrictEqual(obtained, jtp);
    })
    it("types record instances anywhere with DefinedType", function(){
        var titular: DefinedType<typeof cargos> = {
            cargo        : 'TIT',
            denominacion : 'Titular',
            orden        : 1,
            puede_dirigir: true,
        };
        // a valid instance compiles and passes the validation:
        assert.doesNotThrow(() => validarCargo(titular));
        // and the validation logic runs over the typed instance:
        assert.throws(() => validarCargo({cargo: 'AY1', denominacion: 'Ayudante de primera', orden: 5, puede_dirigir: true}));
        // @ts-expect-error a field with the wrong type is rejected
        var malTipado: DefinedType<typeof cargos> = {cargo: 'TIT', denominacion: 'Titular', orden: '1', puede_dirigir: true};
        // @ts-expect-error a missing field is rejected
        validarCargo({cargo: 'ADJ', denominacion: 'Adjunto', orden: 2});
        // @ts-expect-error fields outside the def cannot be accessed
        var noField = titular.inexistente;
        assert.equal(noField, undefined);
        assert.equal(malTipado.orden, '1');
    })
    it("can deduce the type from DefinedType", function(){
        var miCargo = {cargo: 'A1'}
        // var expected: ExpandType<Optional<DefinedType<typeof cargo>>>;
        var expected: ExpandType<Optional<EntityInstanceType<typeof typeDefs, typeof cargos>>>;
        expected = miCargo;
        assert.equal(expected, miCargo);
    })
    it("reflects the nullability of the fields in the record instance type", function(){
        type Docente = RecordInstanceType<typeof typeDefs, typeof docente>
        var pepe: Docente = {
            legajo           : 'L-1234',
            username         : 'pperez',
            apellido         : 'Pérez',
            nombres          : 'José',
            cargo            : null,  // the fields without an explicit nullable default to nullable
            email            : 'pperez@ejemplo.edu',
            email_alternativo: null,
            hash_pass        : null,
            hash_type        : 'scram-sha-256',
            last_pass_change : null,
        };
        // nullable:false fields are plain values:
        var apellido: string = pepe.apellido;
        // @ts-expect-error a field that can be null is not assignable to a plain string
        var cargoDocente: string = pepe.cargo;
        var cargoOrNull: string | null = pepe.cargo;
        // @ts-expect-error null is not assignable to a nullable:false field
        pepe.apellido = null;
        assert.equal(apellido, 'Pérez');
        assert.equal(cargoDocente, null);
        assert.equal(cargoOrNull, null);
    })
    it("completes a record def into a record info", function(){
        var sedeInfo = completeRecord(sede);
        assert.deepStrictEqual(sedeInfo, {
            sede   : {type: 'text', label: 'sede'  , nullable: true , description: '', isName: false},
            nombre : {type: 'text', label: 'nombre', nullable: false, description: '', isName: true },
        });
    })
    it("completes preserving the field set and the type literals", function(){
        var cargoInfo = completeRecord(cargo);
        // the type literals from the def must survive the completion:
        var cargoType: 'text' = cargoInfo.cargo.type;
        // @ts-expect-error
        cargoInfo.cargo.type = 'integer'
        assert.equal(cargoType, 'text');
        assert.throws(()=>{
            // @ts-expect-error Must know which fields exists
            var dummy = cargoInfo.inexistente.type
        })
        type CargoInfoExpected = {
            cargo        : {type: 'text'   , label: string, nullable: boolean, description: string, isName: boolean},
            denominacion : {type: 'text'   , label: string, nullable: boolean, description: string, isName: boolean},
            orden        : {type: 'integer', label: string, nullable: boolean, description: string, isName: boolean},
            puede_dirigir: {type: 'boolean', label: string, nullable: boolean, description: string, isName: boolean},
        }
        // both assignments must compile: expected and deduced are mutually assignable
        // (this also checks that label, nullable and description are required, not optional)
        var expected: CargoInfoExpected = cargoInfo;
        var deducedBack: typeof cargoInfo = expected;
        assert.deepStrictEqual(deducedBack, expected);
    })
    it("keeps the label and the nullable written in the def", function(){
        var comisionInfo = completeRecord(comision);
        // the labels written in the def survive; the others come from the field name:
        assert.equal(comisionInfo.comision.label, 'comisión');
        assert.equal(comisionInfo.hora_desde.label, 'hora desde');
        assert.equal(comisionInfo.denominacion.nullable, false);
        assert.equal(comisionInfo.hora_hasta.nullable, true);
    })
    it("carries the properties this system added to the field def", function(){
        // defaultValue, options and secreto are not part of FieldDef: this system adds them
        var cerradoDefault: boolean = periodo.cerrado.defaultValue;
        var tipoOptions: readonly string[] = pregunta.tipo.options;
        assert.equal(cerradoDefault, false);
        assert.deepStrictEqual(tipoOptions, ['int', 'texto', 'opciones', 'multiple_opcion']);
        assert.equal(docente.hash_pass.secreto, true);
        var cerradoInfo = completeRecord(periodo).cerrado;
        // @ts-expect-error the Info type keeps only what the framework knows about
        var infoDefault = cerradoInfo.defaultValue;
        // although completeRecord does copy the added properties into the Info:
        assert.equal(infoDefault, false);
    })
    it("validates a record instance with the rules of the system", function(){
        var unaPregunta: DefinedType<typeof preguntas> = {
            periodo            : '2026-1c',
            cod_mat            : 'AlgoI',
            comision           : 'T1',
            fecha              : {year: 2026, month: 3, day: 16},
            id_pregunta        : 1,
            pregunta           : '¿Cuál es la complejidad de la búsqueda binaria?',
            aclaracion         : 'en el peor caso',
            tipo               : 'opciones',
            abierta            : false,
            respuesta_correcta : 'b',
        };
        assert.doesNotThrow(() => validarPregunta(unaPregunta));
        assert.throws(() => validarPregunta({...unaPregunta, abierta: true}));
        // @ts-expect-error a field with the wrong type is rejected
        var malTipado: DefinedType<typeof preguntas> = {...unaPregunta, id_pregunta: '1'};
        assert.equal(malTipado.id_pregunta, '1');
    })
})

describe("aida entities", function(){
    it("keeps the pk literal tuple, in both directions", function(){
        var cursosPk: readonly ['periodo', 'cod_mat'] = cursos.pk;
        var cursosPkBack: typeof cursos.pk = cursosPk;
        var clasesPk: readonly ['periodo', 'cod_mat', 'comision', 'fecha'] = clases.pk;
        var clasesPkBack: typeof clases.pk = clasesPk;
        assert.deepStrictEqual(cursosPk, ['periodo', 'cod_mat']);
        assert.deepStrictEqual(clasesPk, ['periodo', 'cod_mat', 'comision', 'fecha']);
        assert.deepStrictEqual(cursosPkBack, cursosPk);
        assert.deepStrictEqual(clasesPkBack, clasesPk);
    })
    it("rejects pk keys that are not keys of fields", function(){
        // @ts-expect-error 'inexistente' is not a field
        var wrong = defineEntity({pk: ['inexistente'], fields: sede});
        // @ts-expect-error a wrong key among valid ones is also rejected
        var wrong2 = defineEntity({pk: ['sede', 'inexistente'], fields: sede});
        // (the check is compile-time only: at runtime defineEntity is the identity)
        assert.deepStrictEqual(wrong.pk, ['inexistente']);
        assert.deepStrictEqual(wrong2.pk, ['sede', 'inexistente']);
    })
    it("extracts the pk fields with their exact types and order", function(){
        var cursosPkFields = extractPk(cursos);
        type CursosPkExpected = {
            periodo : {type: 'text', label: string},
            cod_mat : {type: 'text'},
        }
        // both assignments must compile: expected and extracted are mutually assignable
        var expected: CursosPkExpected = cursosPkFields;
        var extractedBack: typeof cursosPkFields = expected;
        // @ts-expect-error 'nombre_materia' is not part of the pk
        var noNombre = cursosPkFields.nombre_materia;
        assert.deepStrictEqual(cursosPkFields, {periodo: curso.periodo, cod_mat: curso.cod_mat});
        assert.deepStrictEqual(Object.keys(cursosPkFields), ['periodo', 'cod_mat']);
        assert.deepStrictEqual(extractedBack, expected);
        assert.equal(noNombre, undefined);
    })
    it("inherits pk fields into other entities", function(){
        // curso got the periodos pk and added its own fields:
        assert.deepStrictEqual(Object.keys(curso), ['periodo', 'cod_mat', 'nombre_materia', 'abierto']);
        // clase extends the comisiones pk with its own fields (the aulas pk goes last):
        assert.deepStrictEqual(Object.keys(clase), [
            'periodo', 'cod_mat', 'comision', 'fecha',
            'tema', 'filas', 'asientos_por_fila', 'empezada', 'escritorios', 'sede', 'aula'
        ]);
        // the inherited fields keep their type literals:
        var periodoType: 'text' = clases.fields.periodo.type;
        // @ts-expect-error the literal is preserved, not widened to string
        var wrongType: 'integer' = clases.fields.periodo.type;
        assert.equal(periodoType, 'text');
        assert.equal(wrongType, 'text');
    })
    it("chains pk inheritance (clases → preguntas → opciones)", function(){
        var opcionesPk: readonly ['periodo', 'cod_mat', 'comision', 'fecha', 'id_pregunta', 'id_opcion'] = opciones.pk;
        var opcionesPkBack: typeof opciones.pk = opcionesPk;
        assert.deepStrictEqual(opciones.pk, ['periodo', 'cod_mat', 'comision', 'fecha', 'id_pregunta', 'id_opcion']);
        assert.deepStrictEqual(Object.keys(opcion), ['periodo', 'cod_mat', 'comision', 'fecha', 'id_pregunta', 'id_opcion', 'detalle']);
        assert.deepStrictEqual(opcionesPkBack, opcionesPk);
    })
    it("merges overlapping pks without repeating (clases + inscripciones)", function(){
        // periodo and cod_mat are in both pks and must appear once, in order
        var merged = mergePk(clases.pk, inscripciones.pk);
        var mergedExpected: readonly ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta'] = merged;
        var mergedBack: typeof merged = mergedExpected;
        assert.deepStrictEqual(merged, ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta']);
        // presentes uses that merge as its pk:
        var presentesPk: readonly ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta'] = presentes.pk;
        assert.deepStrictEqual(presentes.pk, ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta']);
        // and the fields spread dedups the shared fields by itself:
        assert.deepStrictEqual(Object.keys(presente), [
            'periodo', 'cod_mat', 'comision', 'fecha', 'libreta',
            'presente', 'retiro', 'fila', 'asiento', 'horarios'
        ]);
        assert.deepStrictEqual(presentesPk, mergedBack);
        // the whole chain still deduces the instance type:
        type Presente = RecordInstanceType<typeof typeDefs, typeof presente>
        var fecha: PlainDate = {year: 2026, month: 3, day: 16};
        var unPresente: Presente = {
            // the inherited pk fields are nullable like any other field: the record def alone
            // does not know which fields are part of the pk (that is EntityInstanceType's job)
            periodo: '2026-1c', cod_mat: 'AlgoI', comision: 'T1', fecha, libreta: '123/26',
            presente: true, retiro: false, fila: null, asiento: null, horarios: [],
        };
        var presenteBack: {libreta: string | null, fecha: PlainDate | null, presente: boolean, fila: number | null} = unPresente;
        assert.deepStrictEqual(presenteBack, unPresente);
    })
})

describe("aida fks and isName", function(){
    it("keeps the fks with their literal types, in both directions", function(){
        type PresentesFksExpected = {
            clases       : {entity: 'clases'       , fields: readonly ['periodo', 'cod_mat', 'comision', 'fecha']},
            inscripciones: {entity: 'inscripciones', fields: readonly ['periodo', 'cod_mat', 'libreta']},
        }
        var expected: PresentesFksExpected = presentes.fks;
        var fksBack: typeof presentes.fks = expected;
        assert.deepStrictEqual(fksBack, {
            clases       : {entity: 'clases'       , fields: ['periodo', 'cod_mat', 'comision', 'fecha']},
            inscripciones: {entity: 'inscripciones', fields: ['periodo', 'cod_mat', 'libreta']},
        });
    })
    it("represents a fk with renamed fields (email_normalizado → email)", function(){
        var alumnosFk: {entity: 'alumnos', fields: {email_normalizado: 'email'}} = inscripciones.fks.alumnos;
        var alumnosFkBack: typeof inscripciones.fks.alumnos = alumnosFk;
        assert.deepStrictEqual(alumnosFkBack, {entity: 'alumnos', fields: {email_normalizado: 'email'}});
    })
    it("represents circular fks (alumnos ↔ inscripciones)", function(){
        // the fk names its target entity instead of referencing the object, so both sides
        // can be written in place
        assert.deepStrictEqual(entityDefs.alumnos.fks.inscripciones,
            {entity: 'inscripciones', fields: ['periodo', 'cod_mat', 'libreta']});
        assert.equal(entityDefs.inscripciones.fks.alumnos.entity, 'alumnos');
    })
    it("marks the isName field and completes it as false elsewhere", function(){
        var denominacionIsName: true = comision.denominacion.isName;
        // @ts-expect-error the comision code field has no isName mark
        var codigoIsName = comision.comision.isName;
        assert.equal(denominacionIsName, true);
        assert.equal(codigoIsName, undefined);
    })
    it("rejects fk source fields and uk fields that are not fields", function(){
        // @ts-expect-error 'inexistente' is not a field (array form)
        var wrongFk = defineEntity({pk: ['sede'], fks: {x: {entity: 'sedes', fields: ['inexistente']}}, fields: sede});
        // @ts-expect-error 'inexistente' is not a field (map form: the source is the key)
        var wrongFkMap = defineEntity({pk: ['sede'], fks: {x: {entity: 'sedes', fields: {inexistente: 'sede'}}}, fields: sede});
        // @ts-expect-error uk fields must be fields too
        var wrongUk = defineEntity({pk: ['sede'], uks: {u: ['inexistente']}, fields: sede});
        // (the checks are compile-time only)
        assert.equal(wrongFk.fks.x.entity, 'sedes');
        assert.deepStrictEqual(wrongUk.uks, {u: ['inexistente']});
        assert.equal(wrongFkMap.fks.x.entity, 'sedes');
    })
    it("cross-checks the fks of the whole system", function(){
        // the aida entityDefs already went through defineEntities; spot-check it kept everything:
        assert.deepStrictEqual(Object.keys(entityDefs).length, 24);
        assert.equal(entityDefs.presentes, presentes);
        // a fk to an entity that is not part of the system is rejected:
        const huerfanos = defineEntity({pk: ['x'], fks: {rota: {entity: 'inexistentes', fields: {x: 'algo'}}}, fields: {x: {type: 'text'}}});
        // @ts-expect-error 'inexistentes' is not an entity of the system
        defineEntities({huerfanos});
        // a fk that references only a part of a composite pk (and no uk) is rejected:
        const franjas = defineEntity({pk: ['dia', 'hora'], fields: {dia: {type: 'text'}, hora: {type: 'integer'}}});
        const eventos = defineEntity({pk: ['evento'], fks: {franja: {entity: 'franjas', fields: {dia: 'dia'}}}, fields: {evento: {type: 'text'}, dia: {type: 'text'}}});
        // @ts-expect-error 'hora' is missing: the fk must reference the complete pk or a uk
        defineEntities({franjas, eventos});
    })
})

/* the example system has no uks, no reflexive fk and no two fks to the same entity, so
   those framework cases are kept here as minimal defs, outside the example system */
describe("framework cases the example system does not use", function(){
    const materias = defineEntity({
        pk: ['materia'],
        uks: {denominacion: ['denominacion']},
        fields: {materia: {type: 'text'}, denominacion: {type: 'text', isName: true}},
    });
    const catedras = defineEntity({
        pk: ['legajo'],
        // reflexive fk: inside its own definition the entity is referenced by name,
        // and the source field (jefe) is mapped to the target field (legajo)
        fks: {jefe: {entity: 'catedras', fields: {jefe: 'legajo'}}},
        fields: {legajo: {type: 'text'}, jefe: {type: 'text'}},
    });
    const mesas = defineEntity({
        pk: ['mesa'],
        fks: {
            presidente: {entity: 'catedras', fields: {presidente: 'legajo'}},
            vocal     : {entity: 'catedras', fields: {vocal: 'legajo'}},
        },
        fields: {mesa: {type: 'text'}, presidente: {type: 'text'}, vocal: {type: 'text'}},
    });
    it("represents a reflexive fk with renamed fields (jefe → legajo)", function(){
        var jefeFk: {entity: 'catedras', fields: {jefe: 'legajo'}} = catedras.fks.jefe;
        var jefeFkBack: typeof catedras.fks.jefe = jefeFk;
        assert.deepStrictEqual(jefeFkBack, {entity: 'catedras', fields: {jefe: 'legajo'}});
    })
    it("represents two fks to the same entity (presidente y vocal)", function(){
        assert.deepStrictEqual(mesas.fks.presidente, {entity: 'catedras', fields: {presidente: 'legajo'}});
        assert.deepStrictEqual(mesas.fks.vocal     , {entity: 'catedras', fields: {vocal: 'legajo'}});
        var presidenteTarget: 'legajo' = mesas.fks.presidente.fields.presidente;
        assert.equal(presidenteTarget, 'legajo');
    })
    it("accepts a fk against a uk of the target entity", function(){
        const apuntes = defineEntity({pk: ['apunte'], fks: {materia_por_nombre: {entity: 'materias', fields: {denominacion_materia: 'denominacion'}}}, fields: {apunte: {type: 'text'}, denominacion_materia: {type: 'text'}}});
        const miniSystem = defineEntities({materias, apuntes, catedras, mesas});
        assert.deepStrictEqual(Object.keys(miniSystem), ['materias', 'apuntes', 'catedras', 'mesas']);
    })
    it("completes the fields and keeps the uks", function(){
        var materiasInfo = completeEntity(materias);
        // the pk field completes as not nullable; the rest, as the plain record does:
        assert.deepStrictEqual(materiasInfo.fields, {
            ...completeRecord(materias.fields),
            materia: {...completeRecord(materias.fields).materia, nullable: false},
        });
        var uksExpected: {denominacion: readonly ['denominacion']} = materiasInfo.uks;
        var uksBack: typeof materiasInfo.uks = uksExpected;
        assert.deepStrictEqual(uksBack, {denominacion: ['denominacion']});
        // the defaulted empty fks stay explicit and empty:
        assert.deepStrictEqual(materiasInfo.fks, {});
    })
})

describe("aida entity completion (Def → Info)", function(){
    it("normalizes array-form fks to the source→target map form", function(){
        var presentesInfo = completeEntity(presentes);
        type PresentesFksExpected = {
            clases       : {entity: 'clases'       , fields: {periodo: 'periodo', cod_mat: 'cod_mat', comision: 'comision', fecha: 'fecha'}},
            inscripciones: {entity: 'inscripciones', fields: {periodo: 'periodo', cod_mat: 'cod_mat', libreta: 'libreta'}},
        }
        // both assignments must compile: expected and completed are mutually assignable
        var expected: PresentesFksExpected = presentesInfo.fks;
        var fksBack: typeof presentesInfo.fks = expected;
        // @ts-expect-error 'inexistente' is not a fk
        var noFk = presentesInfo.fks.inexistente;
        // @ts-expect-error the target field literal is preserved, not widened to string
        var wrongTarget: 'cod_mat' = presentesInfo.fks.clases.fields.periodo;
        assert.deepStrictEqual(fksBack, {
            clases       : {entity: 'clases'       , fields: {periodo: 'periodo', cod_mat: 'cod_mat', comision: 'comision', fecha: 'fecha'}},
            inscripciones: {entity: 'inscripciones', fields: {periodo: 'periodo', cod_mat: 'cod_mat', libreta: 'libreta'}},
        });
        assert.equal(noFk, undefined);
        assert.equal(wrongTarget, 'periodo');
    })
    it("keeps map-form fks as they are", function(){
        var inscripcionesInfo = completeEntity(inscripciones);
        var alumnosFk: {entity: 'alumnos', fields: {email_normalizado: 'email'}} = inscripcionesInfo.fks.alumnos;
        var alumnosFkBack: typeof inscripcionesInfo.fks.alumnos = alumnosFk;
        // @ts-expect-error after completion the array form is gone: fields is always a map
        var noArray: readonly string[] = inscripcionesInfo.fks.cursos.fields;
        assert.deepStrictEqual(alumnosFkBack, {entity: 'alumnos', fields: {email_normalizado: 'email'}});
        assert.deepStrictEqual(inscripcionesInfo.fks.cursos.fields, {periodo: 'periodo', cod_mat: 'cod_mat'});
        assert.deepStrictEqual(noArray, {periodo: 'periodo', cod_mat: 'cod_mat'});
    })
    it("dedups the pk, so overlapping pks can be spread without mergePk", function(){
        var presentesAlt = defineEntity({
            // periodo and cod_mat appear twice in the spread:
            pk: [...clases.pk, ...inscripciones.pk],
            fields: presente,
        });
        var presentesAltInfo = completeEntity(presentesAlt);
        var pkExpected: readonly ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta'] = presentesAltInfo.pk;
        var pkBack: typeof presentesAltInfo.pk = pkExpected;
        assert.deepStrictEqual(presentesAltInfo.pk, ['periodo', 'cod_mat', 'comision', 'fecha', 'libreta']);
        assert.deepStrictEqual(pkBack, pkExpected);
    })
    it("completes the pk fields as not nullable", function(){
        var clasesInfo = completeEntity(clases);
        /* the type checks come first: assert.deepStrictEqual is an assertion signature, so it
           narrows the type of what it receives and any type check after it would be vacuous */
        var periodoNullable: false = clasesInfo.fields.periodo.nullable;
        var escritoriosNullable: boolean = clasesInfo.fields.escritorios.nullable;
        // @ts-expect-error a pk field is known to be not nullable
        var wrongNullable: true = clasesInfo.fields.periodo.nullable;
        // the pk fields of the entity are not nullable, whatever the record def says:
        assert.equal(clasesInfo.fields.periodo.nullable, false);
        assert.equal(clasesInfo.fields.fecha.nullable, false);
        // the fields outside the pk keep the default:
        assert.equal(clasesInfo.fields.escritorios.nullable, true);
        assert.equal(periodoNullable, false);
        assert.equal(escritoriosNullable, true);
        assert.equal(wrongNullable, false);
    })
    it("deduces the entity instance type with the pk fields not nullable", function(){
        type Clase = EntityInstanceType<typeof typeDefs, typeof clases>
        var unaClase: Clase = {
            // the pk admits no null:
            periodo: '2026-1c', cod_mat: 'AlgoI', comision: 'T1', fecha: {year: 2026, month: 3, day: 16},
            tema: 'búsqueda binaria', empezada: false,
            // the rest keeps its nullability:
            filas: null, asientos_por_fila: null, escritorios: null, sede: null, aula: null,
        };
        var pkExpected: {periodo: string, cod_mat: string, comision: string, fecha: PlainDate} = unaClase;
        // @ts-expect-error null is not assignable to a pk field
        unaClase.comision = null;
        // @ts-expect-error a field outside the pk is nullable
        var escritorios: string = unaClase.escritorios;
        assert.deepStrictEqual(pkExpected, unaClase);
        assert.equal(escritorios, null);
    })
    it("completes the fields and defaults the empty fks and uks", function(){
        var docentesInfo = completeEntity(docentes);
        assert.deepStrictEqual(docentesInfo.fields, {
            ...completeRecord(docentes.fields),
            legajo: {...completeRecord(docentes.fields).legajo, nullable: false},
        });
        assert.deepStrictEqual(docentesInfo.fks, {});
        assert.deepStrictEqual(docentesInfo.uks, {});
    })
})

describe("extended declaractions", function(){
    it("defineEntity and completeEntity pass through the properties they do not know", function(){
        /* the properties the framework does not know are not lost, but the types do not
           carry them yet: hence the @ts-expect-error on every use. It is left this way
           because I don't know how to declare a generic that extends the table definition
           and from which the completed one can be derived, without adding an extra type
           parameter or touching anything else in the types. */
        const cosas = defineEntity({
            pk: ['cosa'],
            fields: {cosa: {type: 'text'}},
            // @ts-expect-error (see above)
            title: 'las cosas',
            skipCrud: true,
        });
        // @ts-expect-error (see above) the property is there at runtime, not in the type
        var title: string = cosas.title;
        // @ts-expect-error (see above)
        var skipCrud: boolean = cosas.skipCrud;
        // and what the framework does know keeps working:
        var pk: readonly ['cosa'] = cosas.pk;
        assert.equal(title, 'las cosas');
        assert.equal(skipCrud, true);
        assert.deepStrictEqual(cosas.pk, ['cosa']);
        assert.deepStrictEqual(cosas.fks, {});
        assert.deepStrictEqual(pk, cosas.pk);
        // completeEntity keeps them too, next to what it completes:
        var cosasInfo = completeEntity(cosas);
        // @ts-expect-error (see above)
        var infoTitle: string = cosasInfo.title;
        assert.equal(infoTitle, 'las cosas');
        assert.deepStrictEqual(cosasInfo.pk, ['cosa']);
        assert.equal(cosasInfo.fields.cosa.nullable, false);
    })

    type MyFieldDef = FieldDef<typeof typeDefs> & {otherText?:string, otherBool:boolean};
    const extendedCargo = {
        cargo            : {type: 'text'    , otherBool:true},
        denominacion     : {type: 'text'    , otherBool:true, label:'denominación'},
        orden            : {type: 'integer' , otherBool:true},
        puede_dirigir    : {type: 'boolean' , otherBool:true},
    } satisfies Record<string, MyFieldDef>
    const extendedCargos = defineEntity({
        fields: extendedCargo,
        pk: ['cargo']
    });
    it("keeps the properties this system added to its entities", function(){
        // @ts-expect-error the properties of the system are not in the types (see above)
        var titulo: string = periodos.title;
        // @ts-expect-error (see above)
        var skipCrud: boolean = respuestas_selecciones.skipCrud;
        // @ts-expect-error (see above)
        var descripcion: string = cursos.description;
        assert.equal(titulo, 'períodos');
        assert.equal(skipCrud, true);
        assert.equal(descripcion, 'materias por período lectivo');
        // and they reach the Info: the design does not lose them
        // @ts-expect-error (see above)
        var infoTitle: string = completeEntity(periodos).title;
        assert.equal(infoTitle, 'períodos');
    })
    it("all ok with extended", function(){
        var miCargo = {cargo: '7'}
        var expected: ExpandType<Optional<DefinedType<typeof extendedCargos>>>;
        expected = miCargo;
    })
})

describe("aida design snapshot", function(){
    it("matches aida-design.toon", function(){
        /* provisional flattening until TOLON exists: toon only formats arrays of uniform
           objects as tables, so the fields map becomes an array with the name inside */
        type FieldInfoRow<TEntityDef extends EntityDef<TypeCollection>> = {
            [K in keyof EntityInfoOf<TEntityDef>['fields']]: {name: K} & EntityInfoOf<TEntityDef>['fields'][K]
        }[keyof TEntityDef['fields']]
        type DesignSnapshot<TEntities extends Record<string, EntityDef<TypeCollection>>> = {
            [E in keyof TEntities]: Omit<EntityInfoOf<TEntities[E]>, 'fields'> & {fields: FieldInfoRow<TEntities[E]>[]}
        }
        function designSnapshot<const TEntities extends Record<string, EntityDef<TypeCollection>>>(eds: TEntities): DesignSnapshot<TEntities> {
            return LikeAr(eds).map(ed => {
                var entityInfo = completeEntity(ed);
                return {
                    ...entityInfo,
                    fields: LikeAr(entityInfo.fields).map((fieldInfo, name)=>({name, ...fieldInfo})).array(),
                };
            /* the cast recovers what LikeAr's map loses: its signature collapses the values
               into a union, while the mapping is done key by key */
            }).plain() as DesignSnapshot<TEntities>;
        }
        var design = designSnapshot(entityDefs);
        /* the snapshot must be built with the precise type of each entity: with the wide
           EntityDef the pk is readonly string[], and then nothing of the pk survives */
        var clasesPk: readonly ['periodo', 'cod_mat', 'comision', 'fecha'] = design.clases.pk;
        var docentesFieldName: 'legajo' | 'username' | 'apellido' | 'nombres' | 'cargo' | 'email' | 'email_alternativo' | 'hash_pass' | 'hash_type' | 'last_pass_change' = design.docentes.fields[0].name;
        // @ts-expect-error the entities of the system are known
        var noEntity = design.inexistente;
        var generated = encode(design) + '\n';
        var snapshotPath = (prefix:string) => path.join(__dirname, '..', '..', 'test', prefix+'aida-design.toon');
        fs.writeFileSync(snapshotPath('local-'), generated);
        var expected = fs.readFileSync(snapshotPath(''), 'utf8').replace(/\r\n/g, '\n');
        assert.deepStrictEqual(clasesPk, ['periodo', 'cod_mat', 'comision', 'fecha']);
        assert.equal(docentesFieldName, 'legajo');
        assert.equal(noEntity, undefined);
        assert.equal(generated, expected);
    })
})
