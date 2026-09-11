import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { encode } from "@toon-format/toon";
import { strict as LikeAr } from "like-ar";

import { FieldDef, RecordDef, RecordInstanceType, completeRecord, recordDef } from "../src/common/ssot-record";
import { AnyEntityDef, EntityDef, EntityInfoOf, EntityInstanceType,
    completeEntity, defineEntity, defineEntities, extractPk, mergePk } from "../src/common/ssot-entity";
import { boxType, defineTypes } from "../src/common/ssot-types";
import { ExpandType, Optional } from "../src/common/type-utils";
import { aidaContext, cargo, materia, docente, curso, clase, cursos, clases, opcion, opciones, inscripciones, presencia, presencias, docentes, materias, mesas, entityDefs, DefinedType, validarCargo,
    cargos, alumnoSearchParams, Fecha
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
        type CargoDeducido = RecordInstanceType<typeof aidaContext, typeof cargo>
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
        var expected: ExpandType<Optional<EntityInstanceType<typeof aidaContext, typeof cargos>>>;
        expected = miCargo;
        assert.equal(expected, miCargo);
    })
    it("reflects the nullability of the fields in the record instance type", function(){
        type Docente = RecordInstanceType<typeof aidaContext, typeof docente>
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
        var materiaInfo = completeRecord(aidaContext, materia);
        assert.deepStrictEqual(materiaInfo, {
            materia      : {type: 'text', label: 'materia'     , nullable: true , description: '', isName: false},
            denominacion : {type: 'text', label: 'denominación', nullable: false, description: 'si corresponde a más de una carrera, aclarar en el nombre', isName: true},
        });
    })
    it("completes preserving the field set and the type literals", function(){
        var cargoInfo = completeRecord(aidaContext, cargo);
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
        // @ts-expect-error 'inexistente' is not a field
        var wrong = defineEntity({pk: ['inexistente'], fields: materia});
        // @ts-expect-error a wrong key among valid ones is also rejected
        var wrong2 = defineEntity({pk: ['materia', 'inexistente'], fields: materia});
        // (the check is compile-time only: at runtime defineEntity is the identity)
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
        type Presencia = RecordInstanceType<typeof aidaContext, typeof presencia>
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
        // @ts-expect-error 'inexistente' is not a field (array form)
        var wrongFk = defineEntity({pk: ['materia'], fks: {x: {entity: 'materias', fields: ['inexistente']}}, fields: materia});
        // @ts-expect-error 'inexistente' is not a field (map form: the source is the key)
        var wrongFkMap = defineEntity({pk: ['materia'], fks: {x: {entity: 'materias', fields: {inexistente: 'materia'}}}, fields: materia});
        // @ts-expect-error uk fields must be fields too
        var wrongUk = defineEntity({pk: ['materia'], uks: {u: ['inexistente']}, fields: materia});
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
        const apuntes = defineEntity({pk: ['apunte'], fks: {materia_por_nombre: {entity: 'materias', fields: {denominacion_materia: 'denominacion'}}}, fields: {apunte: {type: 'text'}, denominacion_materia: {type: 'text'}}});
        const miniSystem = defineEntities({materias, apuntes});
        assert.deepStrictEqual(Object.keys(miniSystem), ['materias', 'apuntes']);
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

describe("aida entity completion (Def → Info)", function(){
    it("normalizes array-form fks to the source→target map form", function(){
        var cursosInfo = completeEntity(aidaContext, cursos);
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
        var mesasInfo = completeEntity(aidaContext, mesas);
        var presidenteFk: {entity: 'docentes', fields: {presidente: 'docente'}} = mesasInfo.fks.presidente;
        var presidenteFkBack: typeof mesasInfo.fks.presidente = presidenteFk;
        // @ts-expect-error after completion the array form is gone: fields is always a map
        var noArray: readonly string[] = mesasInfo.fks.cursos.fields;
        assert.deepStrictEqual(presidenteFkBack, {entity: 'docentes', fields: {presidente: 'docente'}});
        assert.deepStrictEqual(mesasInfo.fks.cursos.fields, {periodo: 'periodo', materia: 'materia'});
        assert.deepStrictEqual(noArray, {periodo: 'periodo', materia: 'materia'});
    })
    it("dedups the pk, so overlapping pks can be spread without mergePk", function(){
        var presenciasAlt = defineEntity({
            // periodo and materia appear twice in the spread:
            pk: [...inscripciones.pk, ...clases.pk],
            fields: presencia,
        });
        var presenciasAltInfo = completeEntity(aidaContext, presenciasAlt);
        var pkExpected: readonly ['periodo', 'materia', 'alumno', 'orden'] = presenciasAltInfo.pk;
        var pkBack: typeof presenciasAltInfo.pk = pkExpected;
        assert.deepStrictEqual(presenciasAltInfo.pk, ['periodo', 'materia', 'alumno', 'orden']);
        assert.deepStrictEqual(pkBack, pkExpected);
    })
    it("completes the pk fields as not nullable", function(){
        var clasesInfo = completeEntity(aidaContext, clases);
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
        type Clase = EntityInstanceType<typeof aidaContext, typeof clases>
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
        var materiasInfo = completeEntity(aidaContext, materias);
        // the pk field completes as not nullable; the rest, as the plain record does:
        assert.deepStrictEqual(materiasInfo.fields, {
            ...completeRecord(aidaContext, materia),
            materia: {...completeRecord(aidaContext, materia).materia, nullable: false},
        });
        var uksExpected: {denominacion: readonly ['denominacion']} = materiasInfo.uks;
        var uksBack: typeof materiasInfo.uks = uksExpected;
        assert.deepStrictEqual(uksBack, {denominacion: ['denominacion']});
        // the defaulted empty fks stay explicit and empty:
        assert.deepStrictEqual(materiasInfo.fks, {});
    })
})

describe("extended declaractions", function(){
    /* a system can put its own properties in a field: recordDef checks against the context
       through the constraint of a type parameter, which does no excess property check, so
       there is no need to declare a wider FieldDef as the satisfies used to require */
    const extendedCargo = recordDef(aidaContext, {
        cargo            : {type: 'text'    , otherBool:true},
        denominacion     : {type: 'text'    , otherBool:true, label:'denominación'},
        orden            : {type: 'integer' , otherBool:true, otherText:'lo que el sistema quiera'},
        puede_dirigir    : {type: 'boolean' , otherBool:true},
    })
    const extendedCargos = defineEntity({
        fields: extendedCargo,
        pk: ['cargo']
    });
    it("all ok with extended", function(){
        var miCargo = {cargo: '7'}
        var expected: ExpandType<Optional<DefinedType<typeof extendedCargos>>>;
        expected = miCargo;
    })
    it("keeps the properties the ssot knows nothing about", function(){
        var otherBool: boolean = extendedCargo.orden.otherBool;
        var otherText: string = extendedCargo.orden.otherText;
        // @ts-expect-error the extra of one field does not leak into the others
        var noExtra = extendedCargo.cargo.otherText;
        // @ts-expect-error the extras do not loosen the check: the type must still be in the context
        recordDef(aidaContext, {mal: {type: 'importe', otherBool: true}});
        assert.equal(otherBool, true);
        assert.equal(otherText, 'lo que el sistema quiera');
        assert.equal(noExtra, undefined);
    })
})

describe("aida design snapshot", function(){
    it("matches aida-design.toon", function(){
        /* provisional flattening until TOLON exists: toon only formats arrays of uniform
           objects as tables, so the fields map becomes an array with the name inside */
        type FieldInfoRow<TEntityDef extends EntityDef<typeof aidaContext>> = {
            [K in keyof EntityInfoOf<typeof aidaContext, TEntityDef>['fields']]: {name: K} & EntityInfoOf<typeof aidaContext, TEntityDef>['fields'][K]
        }[keyof TEntityDef['fields']]
        type DesignSnapshot<TEntities extends Record<string, EntityDef<typeof aidaContext>>> = {
            [E in keyof TEntities]: Omit<EntityInfoOf<typeof aidaContext, TEntities[E]>, 'fields'> & {fields: FieldInfoRow<TEntities[E]>[]}
        }
        function designSnapshot<const TEntities extends Record<string, EntityDef<typeof aidaContext>>>(eds: TEntities): DesignSnapshot<TEntities> {
            return LikeAr(eds).map(ed => {
                var entityInfo = completeEntity(aidaContext, ed);
                return {
                    ...entityInfo,
                    fields: LikeAr(entityInfo.fields).map((fieldInfo, name)=>({name, ...fieldInfo})).array(),
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
            fecha  : {año: 2025, mes: 3, día: 10},
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
    const extendedContext = {...aidaContext, records: {cargo}, whatever: true}
    it("accepts a context that carries more than the types", function(){
        type ExtendedCargo = RecordInstanceType<typeof extendedContext, typeof cargo>
        var jtp: ExtendedCargo = {cargo: 'JTP', denominacion: null, orden: 4, puede_dirigir: null};
        // the deduced type does not depend on the part of the context the layer ignores
        var alsoAida: RecordInstanceType<typeof aidaContext, typeof cargo> = jtp;
        var back: ExtendedCargo = alsoAida;
        assert.deepStrictEqual(back, jtp);
    })
    it("rejects a bare type collection, which is not a context", function(){
        // @ts-expect-error the collection has to come inside the types property
        type NotAContext = RecordDef<typeof aidaContext.types>
    })
})

describe("recordDef: the def checked against the context it is written against", function(){
    it("gives back the very same def, plain and serializable", function(){
        var plainDef = {apellido: {type: 'text'}, desde: {type: 'fecha'}};
        assert.deepStrictEqual(alumnoSearchParams, plainDef);
        // the def travels as JSON; the context is what both ends have to share beforehand
        assert.deepStrictEqual(JSON.parse(JSON.stringify(alumnoSearchParams)), plainDef);
    })
    it("deduces the instance type without naming the context again", function(){
        type SearchParams = {apellido: string | null, desde: Fecha | null}
        type Deduced = RecordInstanceType<typeof aidaContext, typeof alumnoSearchParams>
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
        var noSuchType = recordDef(aidaContext, {total: {type: 'importe'}});
        assert.deepStrictEqual(noSuchType, {total: {type: 'importe'}});
    })
    it("does not complete: completing is up to whoever needs it", function(){
        assert.deepStrictEqual(completeRecord(aidaContext, alumnoSearchParams).apellido, {
            type: 'text', isName: false, nullable: true, label: 'apellido', description: '',
        });
    })
})

describe("each system decides what a field is and how it completes", function(){
    /* another system entirely, with its own field def and its own defaults: the framework
       dictates neither. Only type and nullable are the core it needs to read itself. */
    const billing = defineTypes({
        types: {code: {tsType: boxType<string>()}, amount: {tsType: boxType<number>()}},
        completeField: (fieldDef: {type: 'code' | 'amount', nullable?: boolean, defaultValue?: string}, name: string) => ({
            type        : fieldDef.type,
            nullable    : fieldDef.nullable ?? true,
            defaultValue: fieldDef.defaultValue ?? null,
            title       : name.toUpperCase(),
        }),
    })
    const invoice = recordDef(billing, {
        number: {type: 'code'  , nullable: false},
        total : {type: 'amount', defaultValue: '0'},
    })
    it("completes with the properties and the defaults of that system", function(){
        assert.deepStrictEqual(completeRecord(billing, invoice), {
            number: {type: 'code'  , nullable: false, defaultValue: null, title: 'NUMBER'},
            total : {type: 'amount', nullable: true , defaultValue: '0' , title: 'TOTAL' },
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
            completeField: (fieldDef: {type: 'code'}) => ({type: fieldDef.type, title: 'x'}),
        });
    })
})
