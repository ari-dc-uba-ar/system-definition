import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {SystemSnapshotInfo, ValidationResult} from "system-definition";
import {
    type AuthoringContext,
    type DataMigrationInfo,
    type TransformationInfo,
    completeDataMigration,
    completeTransformation,
    decodeDataMigration,
} from "../src/migration-authoring";

const hash = (digit: string): string => digit.repeat(64);

const fromSnapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["text", "integer"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                first: {name: "first", type: "text", nullable: false},
                last: {name: "last", type: "text", nullable: false},
                nickname: {name: "nickname", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

const toSnapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["text", "integer"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                display_name: {name: "display_name", type: "text", nullable: false},
                alias: {name: "alias", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

const query = (name: string, digit: string) => ({
    name,
    kind: "query" as const,
    contentHash: hash(digit),
});

const check = (name: string, digit: string) => ({
    name,
    kind: "check" as const,
    contentHash: hash(digit),
});

function ok<T>(result: ValidationResult<T>): T {
    if (!result.ok) {
        assert.fail(JSON.stringify(result.problems));
    }
    return result.value;
}

const emptyContext: AuthoringContext = {
    from: fromSnapshot,
    to: toSnapshot,
    transformations: {},
};

const rowTransformation: TransformationInfo = ok(completeTransformation(emptyContext, {
    name: "join-name",
    version: "1",
    inputs: {
        first: {
            domain: {side: "from", type: "text", nullable: false},
            field: {side: "from", entity: "people", field: "first"},
        },
        last: {
            domain: {side: "from", type: "text", nullable: false},
            field: {side: "from", entity: "people", field: "last"},
        },
    },
    parameters: {},
    outputs: {
        display: {
            domain: {side: "to", type: "text", nullable: false},
            field: {side: "to", entity: "people", field: "display_name"},
        },
        alias: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "people", field: "alias"},
        },
    },
    mode: "row",
    query: query("join-name.sql", "1"),
}) as ValidationResult<TransformationInfo>);

const context: AuthoringContext = {
    from: fromSnapshot,
    to: toSnapshot,
    transformations: {"join-name": rowTransformation},
};

const _transformationSignature: (
    context: AuthoringContext,
    def: Parameters<typeof completeTransformation>[1],
) => ValidationResult<TransformationInfo> = completeTransformation;
const _dataSignature: (
    context: AuthoringContext,
    def: Parameters<typeof completeDataMigration>[1],
) => ValidationResult<DataMigrationInfo> = completeDataMigration;
void _transformationSignature;
void _dataSignature;

describe("typed data migration authoring contract", () => {
    it("completes row transformations without inventing lineage or checks", () => {
        assert.equal(rowTransformation.mode, "row");
        assert.equal(rowTransformation.lineage, null);
        assert.deepEqual(rowTransformation.before, []);
        assert.deepEqual(rowTransformation.after, []);
        assert.deepEqual(Object.keys(rowTransformation.inputs), ["first", "last"]);
        assert.deepEqual(Object.keys(rowTransformation.outputs), ["display", "alias"]);
    });

    it("preserves multiple sources/outputs and completes only documented data-migration defaults", () => {
        const info: DataMigrationInfo = ok(completeDataMigration(context, {
            id: "people-display-name",
            source: {
                query: query("people-source.sql", "2"),
                ports: {
                    first: {
                        domain: {side: "from", type: "text", nullable: false},
                        field: {side: "from", entity: "people", field: "first"},
                    },
                    last: {
                        domain: {side: "from", type: "text", nullable: false},
                        field: {side: "from", entity: "people", field: "last"},
                    },
                },
                identity: ["first", "last"],
            },
            transformation: "join-name",
            arguments: {},
            writes: [{
                kind: "update",
                entity: "people",
                values: [
                    {output: "display", target: {side: "to", entity: "people", field: "display_name"}},
                    {output: "alias", target: {side: "to", entity: "people", field: "alias"}},
                ],
                match: [{output: "display", targetField: "display_name"}],
                whenMissing: "error",
            }],
        }) as ValidationResult<DataMigrationInfo>);

        assert.equal(info.description, "");
        assert.deepEqual(info.dependsOn, []);
        assert.deepEqual(info.source.coverageChecks, []);
        assert.deepEqual(info.conservationChecks, []);
        assert.deepEqual(info.source.identity, ["first", "last"]);
        assert.deepEqual(info.writes[0]?.values.map((binding: {output: string}) => binding.output), ["display", "alias"]);
    });

    it("supports a technical source port and set lineage without inventing a business source", () => {
        const setTransformation: TransformationInfo = ok(completeTransformation(emptyContext, {
            name: "constant-set",
            version: "1",
            inputs: {
                seed: {
                    domain: {side: "from", type: "integer", nullable: false},
                    field: null,
                },
            },
            parameters: {
                label: {side: "to", type: "text", nullable: false},
            },
            outputs: {
                display: {
                    domain: {side: "to", type: "text", nullable: false},
                    field: {side: "to", entity: "people", field: "display_name"},
                },
            },
            mode: "set",
            query: query("constant-set.sql", "3"),
            lineage: query("constant-set-lineage.sql", "4"),
            before: [check("constant-before", "5")],
            after: [check("constant-after", "6")],
        }) as ValidationResult<TransformationInfo>);

        assert.equal(setTransformation.mode, "set");
        assert.equal(setTransformation.inputs.seed?.field, null);
        assert.equal(setTransformation.lineage?.name, "constant-set-lineage.sql");
        assert.equal(setTransformation.before[0]?.kind, "check");
        assert.equal(setTransformation.after[0]?.kind, "check");

        const missingLineage = completeTransformation(emptyContext, {
            name: "broken-set",
            version: "1",
            inputs: setTransformation.inputs,
            parameters: setTransformation.parameters,
            outputs: setTransformation.outputs,
            mode: "set",
            query: query("broken-set.sql", "7"),
        });
        assert.equal(missingLineage.ok, false);
    });

    it("rejects wrong-side refs, incompatible domains/nullability and invalid external JSON", () => {
        const wrongSide = completeDataMigration(context, {
            id: "wrong-side",
            source: {
                query: query("wrong-side-source.sql", "8"),
                ports: {
                    first: {
                        domain: {side: "to", type: "text", nullable: false},
                        field: {side: "to", entity: "people", field: "display_name"},
                    },
                    last: {
                        domain: {side: "from", type: "text", nullable: false},
                        field: {side: "from", entity: "people", field: "last"},
                    },
                },
                identity: ["first", "last"],
            },
            transformation: "join-name",
            arguments: {},
            writes: [],
        });
        assert.equal(wrongSide.ok, false);

        const incompatible = completeDataMigration(context, {
            id: "incompatible",
            source: {
                query: query("bad-domain-source.sql", "9"),
                ports: {
                    first: {
                        domain: {side: "from", type: "integer", nullable: false},
                        field: {side: "from", entity: "people", field: "id"},
                    },
                    last: {
                        domain: {side: "from", type: "text", nullable: true},
                        field: {side: "from", entity: "people", field: "nickname"},
                    },
                },
                identity: ["first", "last"],
            },
            transformation: "join-name",
            arguments: {},
            writes: [],
        });
        assert.equal(incompatible.ok, false);

        const decoded = decodeDataMigration(context, {
            id: "external-cast-does-not-help",
            source: {
                query: query("decode.sql", "a"),
                ports: {},
                identity: [],
                unexpected: true,
            },
            transformation: "join-name",
            arguments: {},
            writes: [],
        });
        assert.equal(decoded.ok, false);
    });
});
