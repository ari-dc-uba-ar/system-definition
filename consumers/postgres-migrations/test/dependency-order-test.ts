import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {dependencyReachability, orderDependencies} from "../src/dependency-order";

describe("shared dependency traversal", () => {
    const operations = [{id: "z", dependsOn: []}, {id: "b", dependsOn: ["a"]}, {id: "a", dependsOn: []}];
    it("preserves both the lexical queue and the data-capture layer order", () => {
        assert.deepEqual(orderDependencies(operations)?.map(one => one.id), ["a", "b", "z"]);
        assert.deepEqual(orderDependencies(operations, "layers")?.map(one => one.id), ["a", "z", "b"]);
    });
    it("rejects missing dependencies and cycles under either policy", () => {
        for (const policy of ["lexical", "layers"] as const) {
            assert.equal(orderDependencies([{id: "a", dependsOn: ["missing"]}], policy), null);
            assert.equal(orderDependencies([{id: "a", dependsOn: ["b"]}, {id: "b", dependsOn: ["a"]}], policy), null);
        }
    });
    it("distinguishes transitive ordering from unrelated writers", () => {
        const reaches = dependencyReachability([...operations, {id: "c", dependsOn: ["b"]}]);
        assert.equal(reaches("c", "a"), true);
        assert.equal(reaches("c", "b"), true);
        assert.equal(reaches("c", "z"), false);
        assert.equal(reaches("a", "c"), false);
    });
});
