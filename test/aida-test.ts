import * as assert from "assert";

import { RecordInstanceType } from "../src/common/system-design";
import { typeDefs, cargo } from "../examples/common/aida";

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
})
