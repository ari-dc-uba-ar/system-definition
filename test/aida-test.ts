import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { encode } from "@toon-format/toon";
import { strict as LikeAr } from "like-ar";

import { FieldDef, RecordDef, RecordInstanceType, completeRecord, defineRecord } from "../src/common/ssot-record";
import { AnyEntityDef, EntityDef, EntityInfoOf, EntityInstanceType,
    completeEntity, defineEntity, defineEntities, extractPk, mergePk, withRecords } from "../src/common/ssot-entity";
import { boxType, completeCoreField, defineTypes } from "../src/common/ssot-types";
import { parsed } from "../src/common/type-behaviour";
import { ExpandType, Optional } from "../src/common/type-utils";
import { aidaTypes, cargo, materia, docente, curso, clase, cursos, clases, opcion, opciones, inscripciones, presencia, presencias, docentes, materias, mesas, entityDefs, DefinedType, validarCargo,
    cargos, alumnoSearchParams, aidaMetaContext, aidaFieldInfo, AidaTypeName, AidaFieldDef, aida, aida1
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
        type CargoDeducido = RecordInstanceType<typeof aidaTypes, typeof cargo>
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
        var expected: ExpandType<Optional<EntityInstanceType<typeof aida, typeof cargos>>>;
        expected = miCargo;
        assert.equal(expected, miCargo);
    })
    it("reflects the nullability of the fields in the record instance type", function(){
        type Docente = RecordInstanceType<typeof aidaTypes, typeof docente>
        var pepe: Docente = {
            docente          : 'pepe',
            apellido         : 'Pérez',
            nombres          : 'José',
            cargo            : null,  // the fields without an explicit nullable default to nullable
            email            : null,
            email_alternativo: null,
            jefe             : null,
        };
        // nullable:false fields are plain values:
        var apellido: string = pepe.apellido;
        // @ts-expect-error a field that can be null is not assignable to a plain string
        var email: string = pepe.email;
        var emailOrNull: string | null = pepe.email;
        // @ts-expect-error null is not assignable to a nullable:false field
        pepe.apellido = null;
        assert.equal(apellido, 'Pérez');
        assert.equal(email, null);
        assert.equal(emailOrNull, null);
    })
    it("completes a record def into a record info", function(){
        var materiaInfo = completeRecord(aidaTypes, materia);
        assert.deepStrictEqual(materiaInfo, {
            materia      : {name: 'materia'     , type: 'text', label: 'materia'     , nullable: true , description: '', isName: false},
            denominacion : {name: 'denominacion', type: 'text', label: 'denominación', nullable: false, description: 'si corresponde a más de una carrera, aclarar en el nombre', isName: true},
        });
    })
    it("completes preserving the field set and the type literals", function(){
        var cargoInfo = completeRecord(aidaTypes, cargo);
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
            cargo        : {name: 'cargo'        , type: 'text'   , label: string, nullable: boolean, description: string, isName: boolean},
            denominacion : {name: 'denominacion' , type: 'text'   , label: string, nullable: boolean, description: string, isName: boolean},
            orden        : {name: 'orden'        , type: 'integer', label: string, nullable: boolean, description: string, isName: boolean},
            puede_dirigir: {name: 'puede_dirigir', type: 'boolean', label: string, nullable: boolean, description: string, isName: boolean},
        }
        // both assignments must compile: expected and deduced are mutually assignable
        // (this also checks that label, nullable and description are required, not optional)
        var expected: CargoInfoExpected = cargoInfo;
        var deducedBack: typeof cargoInfo = expected;
        assert.deepStrictEqual(deducedBack, expected);
    })
})

describe("aida entities", function(){
    it("keeps the pk literal tuple, in both directions", function(){
        var cursosPk: readonly ['periodo', 'materia'] = cursos.pk;
        var cursosPkBack: typeof cursos.pk = cursosPk;
        var clasesPk: readonly ['periodo', 'materia', 'orden'] = clases.pk;
        var clasesPkBack: typeof clases.pk = clasesPk;
        assert.deepStrictEqual(cursosPk, ['periodo', 'materia']);
        assert.deepStrictEqual(clasesPk, ['periodo', 'materia', 'orden']);
        assert.deepStrictEqual(cursosPkBack, cursosPk);
        assert.deepStrictEqual(clasesPkBack, clasesPk);
    })
    it("rejects pk keys that are not keys of fields", function(){
        // @ts-expect-error 'inexistente' is not a field of the record the entity names
        var wrong = defineEntity(aida, {name: 'materias', record: 'materia', pk: ['inexistente']});
        // @ts-expect-error a wrong key among valid ones is also rejected
        var wrong2 = defineEntity(aida, {name: 'materias', record: 'materia', pk: ['materia', 'inexistente']});
        // (the check is compile-time only: at runtime defineEntity only resolves the fields)
        assert.deepStrictEqual(wrong.pk, ['inexistente']);
        assert.deepStrictEqual(wrong2.pk, ['materia', 'inexistente']);
    })
    it("extracts the pk fields with their exact types and order", function(){
        var cursosPkFields = extractPk(cursos);
        type CursosPkExpected = {
            periodo : {type: 'text', description: string},
            materia : {type: 'text'},
        }
        // both assignments must compile: expected and extracted are mutually assignable
        var expected: CursosPkExpected = cursosPkFields;
        var extractedBack: typeof cursosPkFields = expected;
        // @ts-expect-error 'docente' is not part of the pk
        var noDocente = cursosPkFields.docente;
        assert.deepStrictEqual(cursosPkFields, {periodo: curso.periodo, materia: curso.materia});
        assert.deepStrictEqual(Object.keys(cursosPkFields), ['periodo', 'materia']);
        assert.deepStrictEqual(extractedBack, expected);
        assert.equal(noDocente, undefined);
    })
    it("inherits pk fields into other entities", function(){
        // curso got all its fields from the periodos, materias and docentes pks:
        assert.deepStrictEqual(Object.keys(curso), ['periodo', 'materia', 'docente']);
        // clase extends the cursos pk with its own fields:
        assert.deepStrictEqual(Object.keys(clase), ['periodo', 'materia', 'orden', 'fecha', 'tema']);
        // the inherited fields keep their type literals:
        var periodoType: 'text' = clases.fields.periodo.type;
        // @ts-expect-error the literal is preserved, not widened to string
        var wrongType: 'integer' = clases.fields.periodo.type;
        assert.equal(periodoType, 'text');
        assert.equal(wrongType, 'text');
    })
    it("chains pk inheritance (clases → preguntas → opciones)", function(){
        var opcionesPk: readonly ['periodo', 'materia', 'orden', 'pregunta', 'opcion'] = opciones.pk;
        var opcionesPkBack: typeof opciones.pk = opcionesPk;
        assert.deepStrictEqual(opciones.pk, ['periodo', 'materia', 'orden', 'pregunta', 'opcion']);
        assert.deepStrictEqual(Object.keys(opcion), ['periodo', 'materia', 'orden', 'pregunta', 'opcion', 'detalle']);
        assert.deepStrictEqual(opcionesPkBack, opcionesPk);
    })
    it("merges overlapping pks without repeating (inscripciones + clases)", function(){
        // periodo and materia are in both pks and must appear once, in order
        var merged = mergePk(inscripciones.pk, clases.pk);
        var mergedExpected: readonly ['periodo', 'materia', 'alumno', 'orden'] = merged;
        var mergedBack: typeof merged = mergedExpected;
        assert.deepStrictEqual(merged, ['periodo', 'materia', 'alumno', 'orden']);
        // presencias uses that merge as its pk:
        var presenciasPk: readonly ['periodo', 'materia', 'alumno', 'orden'] = presencias.pk;
        assert.deepStrictEqual(presencias.pk, ['periodo', 'materia', 'alumno', 'orden']);
        // and the fields spread dedups the shared fields by itself:
        assert.deepStrictEqual(Object.keys(presencia), ['periodo', 'materia', 'alumno', 'orden']);
        assert.deepStrictEqual(presenciasPk, mergedBack);
        // the whole chain still deduces the instance type:
        type Presencia = RecordInstanceType<typeof aidaTypes, typeof presencia>
        var unaPresencia: Presencia = {periodo: '2026-1c', materia: 'AlgoI', alumno: 'L1234', orden: 1};
        // the inherited pk fields are nullable like any other field: the record def alone does
        // not know which fields are part of the pk (that is what EntityInstanceType is for)
        var presenciaBack: {periodo: string | null, materia: string | null, alumno: string | null, orden: number | null} = unaPresencia;
        assert.deepStrictEqual(presenciaBack, unaPresencia);
    })
})

describe("aida fks, uks and isName", function(){
    it("keeps the fks with their literal types, in both directions", function(){
        type PresenciasFksExpected = {
            inscripciones: {entity: 'inscripciones', fields: readonly ['periodo', 'materia', 'alumno']},
            clases       : {entity: 'clases'       , fields: readonly ['periodo', 'materia', 'orden']},
        }
        var expected: PresenciasFksExpected = presencias.fks;
        var fksBack: typeof presencias.fks = expected;
        assert.deepStrictEqual(fksBack, {
            inscripciones: {entity: 'inscripciones', fields: ['periodo', 'materia', 'alumno']},
            clases       : {entity: 'clases'       , fields: ['periodo', 'materia', 'orden']},
        });
    })
    it("represents a reflexive fk with renamed fields (jefe → docente)", function(){
        var jefeFk: {entity: 'docentes', fields: {jefe: 'docente'}} = docentes.fks.jefe;
        var jefeFkBack: typeof docentes.fks.jefe = jefeFk;
        assert.deepStrictEqual(jefeFkBack, {entity: 'docentes', fields: {jefe: 'docente'}});
    })
    it("represents two fks to the same entity (mesas: presidente y vocal)", function(){
        assert.deepStrictEqual(mesas.fks.presidente, {entity: 'docentes', fields: {presidente: 'docente'}});
        assert.deepStrictEqual(mesas.fks.vocal     , {entity: 'docentes', fields: {vocal: 'docente'}});
        var presidenteTarget: 'docente' = mesas.fks.presidente.fields.presidente;
        assert.equal(presidenteTarget, 'docente');
    })
    it("marks the isName field and completes it as false elsewhere", function(){
        var denominacionIsName: boolean = materia.denominacion.isName;
        // @ts-expect-error the code field has no isName mark
        var codigoIsName = materia.materia.isName;
        assert.equal(denominacionIsName, true);
        assert.equal(codigoIsName, undefined);
    })
    it("rejects fk source fields and uk fields that are not fields", function(){
        const soloMateria = withRecords(aidaTypes, {materia});
        // @ts-expect-error 'inexistente' is not a field (array form)
        var wrongFk = defineEntity(soloMateria, {name: 'materias', record: 'materia', pk: ['materia'], fks: {x: {entity: 'materias', fields: ['inexistente']}}});
        // @ts-expect-error 'inexistente' is not a field (map form: the source is the key)
        var wrongFkMap = defineEntity(soloMateria, {name: 'materias', record: 'materia', pk: ['materia'], fks: {x: {entity: 'materias', fields: {inexistente: 'materia'}}}});
        // @ts-expect-error uk fields must be fields too
        var wrongUk = defineEntity(soloMateria, {name: 'materias', record: 'materia', pk: ['materia'], uks: {u: ['inexistente']}});
        // (the checks are compile-time only)
        assert.equal(wrongFk.fks.x.entity, 'materias');
        assert.deepStrictEqual(wrongUk.uks, {u: ['inexistente']});
        assert.equal(wrongFkMap.fks.x.entity, 'materias');
    })
    it("cross-checks the fks of the whole system", function(){
        // the aida entityDefs already went through defineEntities; spot-check it kept everything:
        assert.deepStrictEqual(Object.keys(entityDefs).length, 11);
        assert.equal(entityDefs.presencias, presencias);
        // a fk against a uk of the target entity is accepted:
        const otros = withRecords(aidaTypes, {
            apunte : defineRecord(aidaTypes, {apunte: {type: 'text'}, denominacion_materia: {type: 'text'}}),
            huerfano: defineRecord(aidaTypes, {x: {type: 'text'}}),
            franja : defineRecord(aidaTypes, {dia: {type: 'text'}, hora: {type: 'integer'}}),
            evento : defineRecord(aidaTypes, {evento: {type: 'text'}, dia: {type: 'text'}}),
        });
        const apuntes = defineEntity(otros, {name: 'apuntes', record: 'apunte', pk: ['apunte'], fks: {materia_por_nombre: {entity: 'materias', fields: {denominacion_materia: 'denominacion'}}}});
        const miniSystem = defineEntities({materias, apuntes});
        assert.deepStrictEqual(Object.keys(miniSystem), ['materias', 'apuntes']);
        // a fk to an entity that is not part of the system is rejected:
        const huerfanos = defineEntity(otros, {name: 'huerfanos', record: 'huerfano', pk: ['x'], fks: {rota: {entity: 'inexistentes', fields: {x: 'algo'}}}});
        // @ts-expect-error 'inexistentes' is not an entity of the system
        defineEntities({huerfanos});
        // a fk that references only a part of a composite pk (and no uk) is rejected:
        const franjas = defineEntity(otros, {name: 'franjas', record: 'franja', pk: ['dia', 'hora']});
        const eventos = defineEntity(otros, {name: 'eventos', record: 'evento', pk: ['evento'], fks: {franja: {entity: 'franjas', fields: {dia: 'dia'}}}});
        // @ts-expect-error 'hora' is missing: the fk must reference the complete pk or a uk
        defineEntities({franjas, eventos});
    })
})

describe("aida entity completion (Def → Info)", function(){
    it("normalizes array-form fks to the source→target map form", function(){
        var cursosInfo = completeEntity(aida, cursos);
        type CursosFksExpected = {
            periodos   : {entity: 'periodos', fields: {periodo: 'periodo'}},
            materias   : {entity: 'materias', fields: {materia: 'materia'}},
            responsable: {entity: 'docentes', fields: {docente: 'docente'}},
        }
        // both assignments must compile: expected and completed are mutually assignable
        var expected: CursosFksExpected = cursosInfo.fks;
        var fksBack: typeof cursosInfo.fks = expected;
        // @ts-expect-error 'inexistente' is not a fk
        var noFk = cursosInfo.fks.inexistente;
        // @ts-expect-error the target field literal is preserved, not widened to string
        var wrongTarget: 'materia' = cursosInfo.fks.periodos.fields.periodo;
        assert.deepStrictEqual(fksBack, {
            periodos   : {entity: 'periodos', fields: {periodo: 'periodo'}},
            materias   : {entity: 'materias', fields: {materia: 'materia'}},
            responsable: {entity: 'docentes', fields: {docente: 'docente'}},
        });
        assert.equal(noFk, undefined);
        assert.equal(wrongTarget, 'periodo');
    })
    it("keeps map-form fks as they are", function(){
        var mesasInfo = completeEntity(aida, mesas);
        var presidenteFk: {entity: 'docentes', fields: {presidente: 'docente'}} = mesasInfo.fks.presidente;
        var presidenteFkBack: typeof mesasInfo.fks.presidente = presidenteFk;
        // @ts-expect-error after completion the array form is gone: fields is always a map
        var noArray: readonly string[] = mesasInfo.fks.cursos.fields;
        assert.deepStrictEqual(presidenteFkBack, {entity: 'docentes', fields: {presidente: 'docente'}});
        assert.deepStrictEqual(mesasInfo.fks.cursos.fields, {periodo: 'periodo', materia: 'materia'});
        assert.deepStrictEqual(noArray, {periodo: 'periodo', materia: 'materia'});
    })
    it("dedups the pk, so overlapping pks can be spread without mergePk", function(){
        var presenciasAlt = defineEntity(aida, {
            name: 'presencias',
            record: 'presencia',
            // periodo and materia appear twice in the spread:
            pk: [...inscripciones.pk, ...clases.pk],
        });
        var presenciasAltInfo = completeEntity(aida, presenciasAlt);
        var pkExpected: readonly ['periodo', 'materia', 'alumno', 'orden'] = presenciasAltInfo.pk;
        var pkBack: typeof presenciasAltInfo.pk = pkExpected;
        assert.deepStrictEqual(presenciasAltInfo.pk, ['periodo', 'materia', 'alumno', 'orden']);
        assert.deepStrictEqual(pkBack, pkExpected);
    })
    it("completes the pk fields as not nullable", function(){
        var clasesInfo = completeEntity(aida, clases);
        /* the type checks come first: assert.deepStrictEqual is an assertion signature, so it
           narrows the type of what it receives and any type check after it would be vacuous */
        var periodoNullable: false = clasesInfo.fields.periodo.nullable;
        var temaNullable: boolean = clasesInfo.fields.tema.nullable;
        // @ts-expect-error a pk field is known to be not nullable
        var wrongNullable: true = clasesInfo.fields.periodo.nullable;
        // the pk fields of the entity are not nullable, whatever the record def says:
        assert.equal(clasesInfo.fields.periodo.nullable, false);
        assert.equal(clasesInfo.fields.orden.nullable, false);
        // the fields outside the pk keep the default:
        assert.equal(clasesInfo.fields.tema.nullable, true);
        assert.equal(periodoNullable, false);
        assert.equal(temaNullable, true);
        assert.equal(wrongNullable, false);
    })
    it("deduces the entity instance type with the pk fields not nullable", function(){
        type Clase = EntityInstanceType<typeof aida, typeof clases>
        var unaClase: Clase = {
            periodo: '2026-1c', materia: 'AlgoI', orden: 1,  // the pk admits no null
            fecha  : null, tema: null,                       // the rest keeps its nullability
        };
        var pkExpected: {periodo: string, materia: string, orden: number} = unaClase;
        // @ts-expect-error null is not assignable to a pk field
        unaClase.orden = null;
        // @ts-expect-error a field outside the pk is nullable
        var tema: string = unaClase.tema;
        assert.deepStrictEqual(pkExpected, unaClase);
        assert.equal(tema, null);
    })
    it("completes the fields and keeps the uks", function(){
        var materiasInfo = completeEntity(aida, materias);
        // the pk field completes as not nullable; the rest, as the plain record does:
        assert.deepStrictEqual(materiasInfo.fields, {
            ...completeRecord(aidaTypes, materia),
            materia: {...completeRecord(aidaTypes, materia).materia, nullable: false},
        });
        var uksExpected: {denominacion: readonly ['denominacion']} = materiasInfo.uks;
        var uksBack: typeof materiasInfo.uks = uksExpected;
        assert.deepStrictEqual(uksBack, {denominacion: ['denominacion']});
        // the defaulted empty fks stay explicit and empty:
        assert.deepStrictEqual(materiasInfo.fks, {});
    })
})

describe("extended declaractions", function(){
    /* a system that wants its own properties in a field declares them in its field def, which
       is the one the context carries. Extending aida is extending its completer: the extras
       come out in the info with the defaults this variant chose. */
    const extendedContext = defineTypes({
        types: aidaTypes.types,
        behaviours: aidaTypes.behaviours,
        completeField: (fieldDef: AidaFieldDef & {otherText?: string, otherBool?: boolean}, name: string) => ({
            ...aidaTypes.completeField(fieldDef, name),
            otherText: fieldDef.otherText ?? '',
            otherBool: fieldDef.otherBool ?? false,
        }),
    })
    const extendedCargo = defineRecord(extendedContext, {
        cargo            : {type: 'text'    , otherBool:true},
        denominacion     : {type: 'text'    , otherBool:true, label:'denominación'},
        orden            : {type: 'integer' , otherBool:true, otherText:'lo que el sistema quiera'},
        puede_dirigir    : {type: 'boolean' , otherBool:true},
    })
    const extendedSystem = withRecords(extendedContext, {cargo: extendedCargo})
    const extendedCargos = defineEntity(extendedSystem, {
        name: 'cargos',
        record: 'cargo',
        pk: ['cargo']
    });
    it("all ok with extended", function(){
        var miCargo = {cargo: '7'}
        var expected: ExpandType<Optional<DefinedType<typeof extendedCargos>>>;
        expected = miCargo;
    })
    it("keeps the properties the system declared, in the def and in the info", function(){
        var otherBool: boolean = extendedCargo.orden.otherBool;
        var otherText: string = extendedCargo.orden.otherText;
        // @ts-expect-error the extra written in one field does not leak into the others
        var noExtra = extendedCargo.cargo.otherText;
        assert.deepStrictEqual(completeRecord(extendedContext, extendedCargo).cargo, {
            name: 'cargo', type: 'text', isName: false, nullable: true, label: 'cargo', description: '',
            otherText: '', otherBool: true,
        });
        assert.equal(otherBool, true);
        assert.equal(otherText, 'lo que el sistema quiera');
        assert.equal(noExtra, undefined);
    })
    it("rejects what no system declared", function(){
        // @ts-expect-error other_text2 is in nobody's field def, not even the extended one
        defineRecord(extendedContext, {mal: {type: 'text', other_text2: 'no existe'}});
        // @ts-expect-error a typo in label is a property nobody declared, not a new property
        defineRecord(aidaTypes, {mal: {type: 'text', labl: 'typo'}});
        // @ts-expect-error the extras of the variant are not available in the plain aida context
        defineRecord(aidaTypes, {mal: {type: 'text', otherBool: true}});
        // @ts-expect-error and the type is still checked against the context
        defineRecord(aidaTypes, {mal: {type: 'importe'}});
    })
})
describe("aida design snapshot", function(){
    it("matches aida-design.toon", function(){
        /* provisional flattening until TOLON exists: toon only formats arrays of uniform objects
           as tables, so the fields map becomes an array. Nothing has to be reinjected: the info
           says its own name, which is exactly what makes the array form lossless. */
        type FieldInfoRow<TEntityDef extends EntityDef<typeof aida>> =
            EntityInfoOf<typeof aida, TEntityDef>['fields'][keyof TEntityDef['fields']]
        type DesignSnapshot<TEntities extends Record<string, EntityDef<typeof aida>>> = {
            [E in keyof TEntities]: Omit<EntityInfoOf<typeof aida, TEntities[E]>, 'fields'> & {fields: FieldInfoRow<TEntities[E]>[]}
        }
        function designSnapshot<const TEntities extends Record<string, EntityDef<typeof aida>>>(eds: TEntities): DesignSnapshot<TEntities> {
            return LikeAr(eds).map((ed, name) => {
                var entityInfo = completeEntity(aida, ed);
                return {
                    ...entityInfo,
                    fields: Object.values(entityInfo.fields),
                };
            /* the cast recovers what LikeAr's map loses: its signature collapses the values
               into a union, while the mapping is done key by key */
            }).plain() as unknown as DesignSnapshot<TEntities>;
        }
        var design = designSnapshot(entityDefs);
        /* the snapshot must be built with the precise type of each entity: with the wide
           EntityDef the pk is readonly string[], and then nothing of the pk survives */
        var clasesPk: readonly ['periodo', 'materia', 'orden'] = design.clases.pk;
        var docentesFieldName: 'docente' | 'apellido' | 'nombres' | 'cargo' | 'email' | 'email_alternativo' | 'jefe' = design.docentes.fields[0].name;
        // @ts-expect-error the entities of the system are known
        var noEntity = design.inexistente;
        var generated = encode(design) + '\n';
        var snapshotPath = (prefix:string) => path.join(__dirname, '..', '..', 'test', prefix+'aida-design.toon');
        fs.writeFileSync(snapshotPath('local-'), generated);
        var expected = fs.readFileSync(snapshotPath(''), 'utf8').replace(/\r\n/g, '\n');
        assert.deepStrictEqual(clasesPk, ['periodo', 'materia', 'orden']);
        assert.equal(docentesFieldName, 'docente');
        assert.equal(noEntity, undefined);
        assert.equal(generated, expected);
    })
})

describe("the parametric type collection must be explicit", function(){
    it("types an instance of an entity that uses a type of its own system", function(){
        /* clases has a field of type 'fecha', which belongs to the aida context and not to
           commonTypeDefs: the default of the parametric type hides which collection is in use */
        var unaClase: DefinedType<typeof clases> = {
            periodo: '2025-1',
            materia: 'ALG',
            orden  : 1,
            fecha  : Temporal.PlainDate.from('2025-03-10'),
            tema   : 'introducción',
        };
        assert.equal(unaClase.orden, 1);
    })
    it("rejects the defs that omit the type collection", function(){
        // @ts-expect-error FieldDef has no default collection: which types exist must be said
        type LooseFieldDef = FieldDef
        // @ts-expect-error idem RecordDef
        type LooseRecordDef = RecordDef
        // @ts-expect-error idem EntityDef
        type LooseEntityDef = EntityDef
    })
})

describe("one context per system, shared by every layer", function(){
    /* each layer requires only the part of the context it uses, so a system can define one
       context with everything in it and hand the same one to all of them */
    const extendedContext = {...aidaTypes, records: {cargo}, whatever: true}
    it("accepts a context that carries more than the types", function(){
        type ExtendedCargo = RecordInstanceType<typeof extendedContext, typeof cargo>
        var jtp: ExtendedCargo = {cargo: 'JTP', denominacion: null, orden: 4, puede_dirigir: null};
        // the deduced type does not depend on the part of the context the layer ignores
        var alsoAida: RecordInstanceType<typeof aidaTypes, typeof cargo> = jtp;
        var back: ExtendedCargo = alsoAida;
        assert.deepStrictEqual(back, jtp);
    })
    it("rejects a bare type collection, which is not a context", function(){
        // @ts-expect-error the collection has to come inside the types property
        type NotAContext = RecordDef<typeof aidaTypes.types>
    })
})

describe("defineRecord: the def checked against the context it is written against", function(){
    it("gives back the very same def, plain and serializable", function(){
        var plainDef = {apellido: {type: 'text'}, desde: {type: 'fecha'}};
        assert.deepStrictEqual(alumnoSearchParams, plainDef);
        // the def travels as JSON; the context is what both ends have to share beforehand
        assert.deepStrictEqual(JSON.parse(JSON.stringify(alumnoSearchParams)), plainDef);
    })
    it("deduces the instance type without naming the context again", function(){
        type SearchParams = {apellido: string | null, desde: Temporal.PlainDate | null}
        type Deduced = RecordInstanceType<typeof aidaTypes, typeof alumnoSearchParams>
        var params: SearchParams = {apellido: 'Pérez', desde: null};
        // both assignments must compile: SearchParams and Deduced are mutually assignable
        var deduced: Deduced = params;
        var back: SearchParams = deduced;
        // @ts-expect-error a field outside the def cannot be accessed
        var noField = deduced.nombres;
        assert.deepStrictEqual(back, params);
        assert.equal(noField, undefined);
    })
    it("rejects a type that the context does not have", function(){
        // @ts-expect-error 'importe' is not one of the types of the aida context
        var noSuchType = defineRecord(aidaTypes, {total: {type: 'importe'}});
        assert.deepStrictEqual(noSuchType, {total: {type: 'importe'}});
    })
    it("does not complete: completing is up to whoever needs it", function(){
        assert.deepStrictEqual(completeRecord(aidaTypes, alumnoSearchParams).apellido, {
            name: 'apellido', type: 'text', isName: false, nullable: true, label: 'apellido', description: '',
        });
    })
})

describe("each system decides what a field is and how it completes", function(){
    /* another system entirely, with its own field def and its own defaults: the framework
       dictates neither. Only type and nullable are the core it needs to read itself. */
    const billing = defineTypes({
        types: {code: {tsType: boxType<string>()}, amount: {tsType: boxType<number>()}},
        behaviours: {
            code  : {parse: (texto) => parsed(texto), format: (valor) => valor, check: (valor): valor is string => typeof valor === 'string'},
            amount: {parse: (texto) => parsed(Number(texto)), format: (valor) => String(valor), check: (valor): valor is number => typeof valor === 'number'},
        },
        completeField: (fieldDef: {type: 'code' | 'amount', nullable?: boolean, defaultValue?: string}, name: string) => ({
            ...completeCoreField(fieldDef, name),
            defaultValue: fieldDef.defaultValue ?? null,
            title       : name.toUpperCase(),
        }),
    })
    const invoice = defineRecord(billing, {
        number: {type: 'code'  , nullable: false},
        total : {type: 'amount', defaultValue: '0'},
    })
    it("completes with the properties and the defaults of that system", function(){
        assert.deepStrictEqual(completeRecord(billing, invoice), {
            number: {name: 'number', type: 'code'  , nullable: false, defaultValue: null, title: 'NUMBER'},
            total : {name: 'total' , type: 'amount', nullable: true , defaultValue: '0' , title: 'TOTAL' },
        });
    })
    it("deduces the instance type against the types of that system", function(){
        type Invoice = {number: string, total: number | null}
        type Deduced = RecordInstanceType<typeof billing, typeof invoice>
        var una: Invoice = {number: 'A-0001', total: null};
        var deducida: Deduced = una;
        var back: Invoice = deducida;
        // @ts-expect-error aida's isName means nothing here: this system never declared it
        var noIsName = completeRecord(billing, invoice).number.isName;
        assert.deepStrictEqual(back, una);
        assert.equal(noIsName, undefined);
    })
    it("rejects a completer that does not fill in the core", function(){
        defineTypes({
            types: {code: {tsType: boxType<string>()}},
            // @ts-expect-error the completed info has to carry nullable: the ssot reads it
            completeField: (fieldDef: {type: 'code'}, name: string) => ({name, type: fieldDef.type, title: 'x'}),
        });
    })
})

describe("the system describing itself", function(){
    /* the meta record and the static declaration are two halves of the same thing: one is
       what the tools read at runtime, the other is what the compiler checks. If they drift
       apart, this test is what notices. */
    type Deduced  = RecordInstanceType<typeof aidaMetaContext, typeof aidaFieldInfo>
    type Declared = ReturnType<typeof aidaTypes.completeField>
    it("deduces exactly the field info that the completer of the system produces", function(){
        var completed: Declared = completeRecord(aidaTypes, materia).denominacion;
        // both assignments must compile: the deduced and the declared are mutually assignable
        var deduced: Deduced = completed;
        var back: Declared = deduced;
        assert.deepStrictEqual(back, {
            name: 'denominacion', type: 'text', isName: true, nullable: false,
            label: 'denominación', description: 'si corresponde a más de una carrera, aclarar en el nombre',
        });
    })
    it("says the type of a field with the type names of the system", function(){
        var nombreDeTipo: AidaTypeName = 'fecha';
        var deducido: Deduced['type'] = nombreDeTipo;
        // @ts-expect-error a type name the system does not have
        var noExiste: Deduced['type'] = 'importe';
        // @ts-expect-error and the meta record is a record like any other: no invented fields
        var noField = aidaFieldInfo.inexistente;
        assert.equal(deducido, 'fecha');
        assert.equal(noExiste, 'importe');
        assert.equal(noField, undefined);
    })
    it("is a plain serializable def, like every other one", function(){
        assert.deepStrictEqual(JSON.parse(JSON.stringify(aidaFieldInfo)), {
            name       : {type: 'text'    , nullable: false},
            type       : {type: 'typeName', nullable: false},
            isName     : {type: 'boolean' , nullable: false},
            nullable   : {type: 'boolean' , nullable: false},
            label      : {type: 'text'    , nullable: false},
            description: {type: 'text'    , nullable: false},
        });
    })
})

describe("the entity names its record, and the context grows in stages", function(){
    it("resolves the fields from the record that the entity names", function(){
        var elNombre: 'curso' = cursos.record;
        assert.equal(elNombre, 'curso');
        assert.deepStrictEqual(cursos.fields, curso);
        // resolved with the precise type, not with the wide record def
        var unCampo: {type: 'text'} = cursos.fields.docente;
        // @ts-expect-error a field that the named record does not have
        var noCampo = cursos.fields.inexistente;
        assert.deepStrictEqual(unCampo, {type: 'text'});
        assert.equal(noCampo, undefined);
    })
    it("carries the name into the info, so the link survives the serialization", function(){
        var info = completeEntity(aida, cursos);
        var elNombre: 'curso' = info.record;
        assert.equal(JSON.parse(JSON.stringify(info)).record, 'curso');
        assert.equal(elNombre, 'curso');
    })
    it("accumulates the records of every stage", function(){
        // the last stage has what the first one had, with its precise type
        var delPrimerNivel: typeof cargo = aida.records.cargo;
        var delUltimo: typeof presencia = aida.records.presencia;
        assert.equal(Object.keys(aida.records).length, 13);
        assert.deepStrictEqual(delPrimerNivel, cargo);
        assert.deepStrictEqual(delUltimo, presencia);
    })
    it("cannot define an entity before the stage that defines its record", function(){
        // @ts-expect-error curso only enters the context at the second stage
        defineEntity(aida1, {name: 'cursos', record: 'curso', pk: ['periodo']});
        // @ts-expect-error and a record that no stage ever defines is rejected too
        defineEntity(aida, {name: 'lo_que_sea', record: 'inexistente', pk: ['x']});
        // the same entity against the stage that does have it compiles:
        assert.equal(defineEntity(aida, {name: 'cursos', record: 'curso', pk: ['periodo']}).record, 'curso');
    })
})

describe("the info says its own name", function(){
    it("pins the name to the key of the field, not to a wide string", function(){
        var cargoInfo = completeRecord(aidaTypes, cargo);
        var elNombre: 'orden' = cargoInfo.orden.name;
        // @ts-expect-error it is the key of that field and of no other
        var otro: 'cargo' = cargoInfo.orden.name;
        assert.equal(elNombre, 'orden');
        assert.equal(otro, 'orden');
    })
    it("survives the trip through an array, which is what fixes the order", function(){
        /* a map of infos can travel as an array to a system that does not share the key order
           rules of js, and be reindexed on the other side without losing anything: that is
           what having the name inside each info buys */
        var cargoInfo = completeRecord(aidaTypes, cargo);
        var comoArray = Object.values(cargoInfo);
        var reindexado = Object.fromEntries(comoArray.map(fieldInfo => [fieldInfo.name, fieldInfo]));
        assert.deepStrictEqual(comoArray.map(fieldInfo => fieldInfo.name), ['cargo', 'denominacion', 'orden', 'puede_dirigir']);
        assert.deepStrictEqual(reindexado, cargoInfo);
    })
    it("does the same for the entity, whose name comes from the map of the system", function(){
        var cursosInfo = completeEntity(aida, cursos);
        var elNombre: 'cursos' = cursosInfo.name;
        assert.equal(JSON.parse(JSON.stringify(cursosInfo)).name, 'cursos');
        assert.equal(elNombre, 'cursos');
    })
})

describe("the core of the completion comes from the framework", function(){
    it("gives name, type and nullable without the system writing them", function(){
        assert.deepStrictEqual(completeCoreField({type: 'text'}, 'apellido'),
            {name: 'apellido', type: 'text', nullable: true});
        assert.deepStrictEqual(completeCoreField({type: 'fecha', nullable: false}, 'desde'),
            {name: 'desde', type: 'fecha', nullable: false});
    })
    it("keeps the info and the deduced type saying the same about nullability", function(){
        /* the two sides of one rule: completeCoreField writes it into the info and NullPart
           deduces it from the def. A system that overrode nullable would split them in silence,
           which is exactly why the default lives in the framework and gets spread in. */
        var docenteInfo = completeRecord(aidaTypes, docente);
        type Docente = RecordInstanceType<typeof aidaTypes, typeof docente>
        // @ts-expect-error apellido says nullable:false, so the deduced type refuses null
        var conNull: Docente = {docente: null, apellido: null, nombres: 'N', cargo: null,
            email: null, email_alternativo: null, jefe: null};
        assert.equal(docenteInfo.apellido.nullable, false);
        // and the field that says nothing is nullable on both sides
        assert.equal(docenteInfo.cargo.nullable, true);
        assert.equal(conNull.nombres, 'N');
    })
})

describe("the entity carries its own name, and the key has to agree", function(){
    it("takes the name from the def, so completing does not need it", function(){
        var elNombre: 'cursos' = cursos.name;
        var info = completeEntity(aida, cursos);
        var elNombreEnLaInfo: 'cursos' = info.name;
        assert.equal(elNombre, 'cursos');
        assert.equal(elNombreEnLaInfo, 'cursos');
    })
    it("rejects an entity whose name is not the key it gets in the system", function(){
        const mal = defineEntity(aida, {name: 'otro_nombre', record: 'curso', pk: ['periodo', 'materia']});
        // @ts-expect-error the entity says 'otro_nombre' but the key here is 'cursos'
        defineEntities({cursos: mal});
        // and with the key it says, it goes through
        assert.equal(defineEntities({otro_nombre: mal}).otro_nombre.name, 'otro_nombre');
    })
})
