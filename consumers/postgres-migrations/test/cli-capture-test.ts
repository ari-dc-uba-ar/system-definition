import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {decodeSystemSnapshot} from "system-definition";
import {aida, entityDefs} from "system-definition/examples";
import type {MigrationProject} from "../src/cli-project";
import {dispatchCommand} from "../src/cli-main";

// A normal consumer must be able to configure capture without a cast or never fields.
const project: MigrationProject = {
    capture: [aida, {systemId: "aida", entities: entityDefs, records: aida.records}],
};

describe("typed CLI snapshot capture", () => {
    it("accepts a concrete context and captures its entities", async () => {
        const result = await dispatchCommand("capture", new Map(), project);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const snapshot = decodeSystemSnapshot(result.value);
        assert.equal(snapshot.ok, true);
        if (!snapshot.ok) return;
        assert.deepEqual(Object.keys(snapshot.value.entities), Object.keys(entityDefs));
        assert.equal(snapshot.value.systemId, "aida");
    });
});
