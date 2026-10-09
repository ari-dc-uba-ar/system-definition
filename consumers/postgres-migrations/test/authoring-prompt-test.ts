import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {AuthoringFiles} from "../src/authoring-files";
import {promptDataMigration} from "../src/authoring-prompt";
import {authoringEmailContext} from "../fixtures/authoring-email";

describe("guided data migration authoring", () => {
    it("selects typed source ports, a transformation, destinations and stable row keys", async () => {
        const answers = ["copy", "move-email", "alumnos", "alumno", "email_anterior", "alumno", "alumnos", "update", "(skip)", "email", "alumno", "Copy legacy email"];
        const files = new AuthoringFiles();
        const result = await promptDataMigration(authoringEmailContext, "app", files, async () => answers.shift()!);
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        assert.equal(result.value.source.ports.email_anterior.field?.field, "email_anterior");
        assert.deepEqual(result.value.writes[0]?.values, [{output: "email", target: {side: "to", entity: "alumnos", field: "email"}}]);
        assert.equal(files.resources.has(result.value.source.query.name), true);
        assert.equal(answers.length, 0);
    });
    it("rejects an incompatible field before emitting source SQL", async () => {
        const answers = ["copy", "move-email", "alumnos", "email_anterior"];
        const files = new AuthoringFiles();
        const result = await promptDataMigration(authoringEmailContext, "app", files, async () => answers.shift()!);
        assert.equal(result.ok, false);
        assert.equal(files.resources.size, 0);
    });
});
