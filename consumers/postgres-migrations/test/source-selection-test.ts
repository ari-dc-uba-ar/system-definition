import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {SystemSnapshotInfo, ValidationResult} from "system-definition";
import type {AuthoringContext} from "../src/migration-authoring";
import {
    buildSourceSelection,
    type GeneratedSourceSelectionInfo,
} from "../src/source-selection";

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
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
        contacts: {
            name: "contacts",
            record: "contacts",
            fields: {
                person_id: {name: "person_id", type: "integer", nullable: false},
                email: {name: "email", type: "text", nullable: false},
            },
            pk: ["person_id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

const context: AuthoringContext = {
    from: fromSnapshot,
    to: fromSnapshot,
    transformations: {},
};

const check = (name: string, digit: string) => ({
    name,
    kind: "check" as const,
    contentHash: hash(digit),
});

function ok(result: unknown): GeneratedSourceSelectionInfo {
    const typed = result as ValidationResult<GeneratedSourceSelectionInfo>;
    if (!typed.ok) assert.fail(JSON.stringify(typed.problems));
    return typed.value;
}

describe("T19 source selection", () => {
    it("derives single-table ports from from-snapshot fields and produces a deterministic query", () => {
        const first = ok(buildSourceSelection(context, {
            queryName: "people-source.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [],
            ports: {
                first: {alias: "p", field: "first"},
                id: {alias: "p", field: "id"},
            },
            identity: ["id"],
            coverageChecks: [],
        }));
        const reordered = ok(buildSourceSelection(context, {
            queryName: "people-source.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [],
            ports: {
                id: {alias: "p", field: "id"},
                first: {alias: "p", field: "first"},
            },
            identity: ["id"],
            coverageChecks: [],
        }));

        assert.equal(first.sql, reordered.sql);
        assert.equal(first.selection.query.contentHash, reordered.selection.query.contentHash);
        assert.deepEqual(first.selection.ports.id, {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "people", field: "id"},
        });
        assert.deepEqual(first.selection.identity, ["id"]);
        assert.match(first.sql, /FROM "app"\."people" AS "p"/);
        assert.match(first.sql, /"p"\."id" AS "id"/);
    });

    it("requires explicit equality joins and widens right-side ports for LEFT JOIN", () => {
        const joined: GeneratedSourceSelectionInfo = ok(buildSourceSelection(context, {
            queryName: "people-contact-source.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [{
                kind: "left",
                entity: "contacts",
                alias: "c",
                on: [{
                    left: {alias: "p", field: "id"},
                    right: {alias: "c", field: "person_id"},
                }],
                whenUnmatched: "include",
            }],
            ports: {
                id: {alias: "p", field: "id"},
                email: {alias: "c", field: "email"},
            },
            identity: ["id"],
            coverageChecks: [],
        }));

        assert.equal(joined.selection.ports.email?.domain.nullable, true);
        assert.deepEqual(joined.selection.ports.email?.field, {
            side: "from",
            entity: "contacts",
            field: "email",
        });
        assert.match(joined.sql, /LEFT JOIN "app"\."contacts" AS "c" ON "p"\."id" = "c"\."person_id"/);

        const missingJoin = buildSourceSelection(context, {
            queryName: "guessing-is-forbidden.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [{
                kind: "left",
                entity: "contacts",
                alias: "c",
                on: [],
                whenUnmatched: "include",
            }],
            ports: {id: {alias: "p", field: "id"}},
            identity: ["id"],
            coverageChecks: [],
        });
        assert.equal(missingJoin.ok, false);
    });

    it("does not silently exclude unmatched rows", () => {
        const noCoverage = buildSourceSelection(context, {
            queryName: "matching-only.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [{
                kind: "inner",
                entity: "contacts",
                alias: "c",
                on: [{
                    left: {alias: "p", field: "id"},
                    right: {alias: "c", field: "person_id"},
                }],
                whenUnmatched: "exclude",
            }],
            ports: {
                id: {alias: "p", field: "id"},
                email: {alias: "c", field: "email"},
            },
            identity: ["id"],
            coverageChecks: [],
        });
        assert.equal(noCoverage.ok, false);

        const covered = ok(buildSourceSelection(context, {
            queryName: "matching-only.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [{
                kind: "inner",
                entity: "contacts",
                alias: "c",
                on: [{
                    left: {alias: "p", field: "id"},
                    right: {alias: "c", field: "person_id"},
                }],
                whenUnmatched: "exclude",
            }],
            ports: {
                id: {alias: "p", field: "id"},
                email: {alias: "c", field: "email"},
            },
            identity: ["id"],
            coverageChecks: [check("excluded-rows-accounted-for", "8")],
        }));
        assert.equal(covered.selection.coverageChecks[0]?.name, "excluded-rows-accounted-for");
    });

    it("requires identity ports to exist and remain non-null", () => {
        const nullableIdentity = buildSourceSelection(context, {
            queryName: "nullable-identity.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [{
                kind: "left",
                entity: "contacts",
                alias: "c",
                on: [{
                    left: {alias: "p", field: "id"},
                    right: {alias: "c", field: "person_id"},
                }],
                whenUnmatched: "include",
            }],
            ports: {
                id: {alias: "p", field: "id"},
                email: {alias: "c", field: "email"},
            },
            identity: ["email"],
            coverageChecks: [],
        });
        assert.equal(nullableIdentity.ok, false);

        const unknownIdentity = buildSourceSelection(context, {
            queryName: "unknown-identity.sql",
            schema: "app",
            base: {entity: "people", alias: "p"},
            joins: [],
            ports: {id: {alias: "p", field: "id"}},
            identity: ["missing"],
            coverageChecks: [],
        });
        assert.equal(unknownIdentity.ok, false);
    });
});
