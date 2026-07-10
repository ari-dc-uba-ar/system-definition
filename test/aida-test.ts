import * as assert from "assert";

import { RecordInstanceType, completeRecord } from "../src/common/system-design";
import { typeDefs, cargo, materia } from "../examples/common/aida";

describe("aida example", function(){
    it("deduces the record instance type", function(){
        type Cargo = {
            cargo        : string,
            denominacion : string,
            orden        : number,
            puede_dirigir: boolean
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
    it("completes a record def into a record info", function(){
        var materiaInfo = completeRecord(materia);
        assert.deepStrictEqual(materiaInfo, {
            materia      : {type: 'text', label: 'materia'     , nullable: true , description: ''},
            denominacion : {type: 'text', label: 'denominación', nullable: false, description: 'si corresponde a más de una carrera, aclarar en el nombre'},
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
            cargo        : {type: 'text'   , label: string, nullable: boolean, description: string},
            denominacion : {type: 'text'   , label: string, nullable: boolean, description: string},
            orden        : {type: 'integer', label: string, nullable: boolean, description: string},
            puede_dirigir: {type: 'boolean', label: string, nullable: boolean, description: string},
        }
        // both assignments must compile: expected and deduced are mutually assignable
        // (this also checks that label, nullable and description are required, not optional)
        var expected: CargoInfoExpected = cargoInfo;
        var deducedBack: typeof cargoInfo = expected;
        assert.deepStrictEqual(deducedBack, expected);
    })
})
