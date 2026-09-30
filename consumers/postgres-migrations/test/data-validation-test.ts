import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {problem, type Problem, type SystemSnapshotInfo} from "system-definition";
import {
    validateMachineEntityRows,
    validateMachinePortRows,
} from "../src/data-validation";

const hash = (digit: string): string => digit.repeat(64);

const snapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["text", "integer"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                email: {name: "email", type: "text", nullable: false},
                nickname: {name: "nickname", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: ["validEmail"],
        },
    },
    records: {},
};

const ports = {
    value: {
        domain: {side: "to" as const, type: "text", nullable: true},
        field: null,
    },
};

type HistoricalModule = {
    abi: "migration-validation-1";
    snapshotHash: string;
    validatePorts(
        declaredPorts: Readonly<Record<string, unknown>>,
        values: Readonly<Record<string, string | null>>,
    ): readonly Problem[];
    validateEntityRow(
        entity: string,
        values: Readonly<Record<string, string | null>>,
    ): readonly Problem[];
};

function moduleWith(overrides: Partial<HistoricalModule> = {}): HistoricalModule {
    return {
        abi: "migration-validation-1",
        snapshotHash: hash("1"),
        validatePorts: () => [],
        validateEntityRow: () => [],
        ...overrides,
    };
}

describe("T20 historical machine-row validation", () => {
    it("keeps null, empty string and the literal null string distinct at the historical module boundary", () => {
        const seen: Array<string | null> = [];
        const runtime = moduleWith({
            validatePorts: (_declared, values) => {
                seen.push(values.value ?? null);
                return [];
            },
        });

        const result = validateMachinePortRows(runtime, ports, [
            {value: null},
            {value: ""},
            {value: "null"},
        ]);

        assert.equal(result.ok, true);
        assert.deepEqual(seen, [null, "", "null"]);
    });

    it("treats every Problem as blocking evidence, including regular severity, and collects all rows", () => {
        const runtime = moduleWith({
            validatePorts: (_declared, values) => {
                if (values.value === "") return [problem(null, "demo.empty", "regular")];
                if (values.value === "null") return [problem(null, "demo.literalNull", "blocking")];
                return [];
            },
        });

        const result = validateMachinePortRows(runtime, ports, [
            {value: ""},
            {value: "null"},
        ]);

        assert.equal(result.ok, false);
        if (result.ok) assert.fail("validation problems must block");
        assert.equal(result.problems.length, 2);
        assert.deepEqual(result.problems.map((item: Problem) => item.messageKey), ["demo.empty", "demo.literalNull"]);
    });

    it("validates complete destination rows against the historical snapshot and rejects missing or extra columns before the module", () => {
        const seen: Readonly<Record<string, string | null>>[] = [];
        const runtime = moduleWith({
            validateEntityRow: (_entity, values) => {
                seen.push(values);
                return [];
            },
        });

        const complete = validateMachineEntityRows(snapshot, runtime, "people", [{
            id: "1",
            email: "a@example.test",
            nickname: "",
        }]);
        assert.equal(complete.ok, true);
        assert.deepEqual(seen, [{id: "1", email: "a@example.test", nickname: ""}]);

        const beforeBadShape = seen.length;
        assert.equal(validateMachineEntityRows(snapshot, runtime, "people", [{
            id: "1",
            email: "a@example.test",
        }]).ok, false);
        assert.equal(validateMachineEntityRows(snapshot, runtime, "people", [{
            id: "1",
            email: "a@example.test",
            nickname: null,
            unexpected: "x",
        }]).ok, false);
        assert.equal(seen.length, beforeBadShape, "malformed rows must be rejected before historical validators run");
    });

    it("blocks a type-correct row when the historical entity validator rejects it, including effective PK/nullability failures", () => {
        const runtime = moduleWith({
            validateEntityRow: (_entity, values) => {
                const problems: Problem[] = [];
                if (values.id === null) problems.push(problem(null, "record.required", "blocking", {field: "id"}));
                if (values.email === "invalid@example.test") {
                    problems.push(problem(null, "validator.validEmail", "regular", {field: "email"}));
                }
                return problems;
            },
        });

        assert.equal(validateMachineEntityRows(snapshot, runtime, "people", [{
            id: null,
            email: "a@example.test",
            nickname: null,
        }]).ok, false);

        assert.equal(validateMachineEntityRows(snapshot, runtime, "people", [{
            id: "2",
            email: "invalid@example.test",
            nickname: null,
        }]).ok, false);
    });
});