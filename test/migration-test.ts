import * as assert from "assert";
import type {Problem} from "../src/common/problem";
import {
    completeMigration,
    decodeMigration,
    defineMigration,
    defineMigrations,
} from "../src/common/migration";

const context = {
    releases: {
        aida_001: {systemId: "aida", releaseId: "aida_001", releaseHash: "release-001"},
        aida_002: {systemId: "aida", releaseId: "aida_002", releaseHash: "release-002"},
        other_001: {systemId: "other", releaseId: "other_001", releaseHash: "other-release-001"},
    },
    resources: {
        email_source_complete_v1: {
            kind: "check",
            file: {path: "checks/email-source.sql", contentHash: "check-before-hash", byteLength: 10},
        },
        backfill_alumno_email_v1: {
            kind: "sql",
            file: {path: "sql/backfill-email.sql", contentHash: "sql-fill-hash", byteLength: 20},
        },
        require_alumno_email_v1: {
            kind: "sql",
            file: {path: "sql/require-email.sql", contentHash: "sql-require-hash", byteLength: 30},
        },
        alumno_email_required_v1: {
            kind: "check",
            file: {path: "checks/email-required.sql", contentHash: "check-after-hash", byteLength: 40},
        },
    },
} as const;

const fullDef = {
    id: "alumnos_email_required",
    from: "aida_001",
    to: "aida_002",
    description: "Require alumno email",
    before: ["email_source_complete_v1"],
    steps: [
        {id: "fill_email", run: "backfill_alumno_email_v1"},
        {id: "require_email", run: "require_alumno_email_v1"},
    ],
    after: ["alumno_email_required_v1"],
} as const;

function assertInvalid(result: {ok: boolean, problems?: readonly Problem[]}): void {
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.problems?.some((one: Problem) => one.severity === "blocking"));
    }
}

function completedCopy(): unknown {
    const result = completeMigration(context, fullDef);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("fixture migration did not complete");
    return JSON.parse(JSON.stringify(result.value));
}

describe("migration definition", function () {
    it("preserves literal defs and resolves release/resource refs without aliases", function () {
        const defined = defineMigration(context, fullDef);
        assert.equal(defined, fullDef);

        const result = completeMigration(context, defined);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(result.value.from, context.releases.aida_001);
        assert.deepEqual(result.value.to, context.releases.aida_002);
        assert.deepEqual(result.value.before[0], {
            name: "email_source_complete_v1",
            kind: "check",
            contentHash: "check-before-hash",
        });
        assert.deepEqual(result.value.steps[0], {
            id: "fill_email",
            run: {name: "backfill_alumno_email_v1", kind: "sql", contentHash: "sql-fill-hash"},
        });
        assert.deepEqual(result.value.after[0], {
            name: "alumno_email_required_v1",
            kind: "check",
            contentHash: "check-after-hash",
        });
        assert.notEqual(result.value.from, context.releases.aida_001);
        assert.notEqual(result.value.before[0], context.resources.email_source_complete_v1);
    });

    it("completes omitted description and checks to empty literals", function () {
        const result = completeMigration(context, {
            id: "metadata_only",
            from: "aida_001",
            to: "aida_002",
            steps: [],
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.description, "");
        assert.deepEqual(result.value.before, []);
        assert.deepEqual(result.value.after, []);
        assert.deepEqual(result.value.steps, []);
    });

    it("rejects typos, wrong resource kinds, and missing resource names at the runtime boundary", function () {
        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            befor: ["email_source_complete_v1"],
            steps: [],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            stepps: [],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            before: ["backfill_alumno_email_v1"],
            steps: [],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            steps: [{id: "one", run: "email_source_complete_v1"}],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            steps: [{id: "one", run: "missing_sql"}],
        } as never));
    });

    it("rejects empty or duplicate ids, self edges, and cross-system endpoints", function () {
        assertInvalid(completeMigration(context, {
            id: "",
            from: "aida_001",
            to: "aida_002",
            steps: [],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            steps: [{id: "", run: "backfill_alumno_email_v1"}],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_002",
            steps: [
                {id: "same", run: "backfill_alumno_email_v1"},
                {id: "same", run: "require_alumno_email_v1"},
            ],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "aida_001",
            steps: [],
        } as never));

        assertInvalid(completeMigration(context, {
            id: "bad",
            from: "aida_001",
            to: "other_001",
            steps: [],
        } as never));
    });

    it("checks migration map keys against the ids while preserving the map", function () {
        const migration = defineMigration(context, fullDef);
        const defs = {alumnos_email_required: migration} as const;
        const result = defineMigrations(context, defs);
        assert.equal(result, defs);
    });
});

describe("migration decoder", function () {
    it("accepts a completed serialized migration and returns a detached copy", function () {
        const source = completedCopy() as {
            from: {releaseId: string};
            before: {name: string}[];
            steps: {run: {name: string}}[];
        };
        const result = decodeMigration(source, context);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        source.from.releaseId = "changed";
        source.before[0].name = "changed";
        source.steps[0].run.name = "changed";
        assert.equal(result.value.from.releaseId, "aida_001");
        assert.equal(result.value.before[0].name, "email_source_complete_v1");
        assert.equal(result.value.steps[0].run.name, "backfill_alumno_email_v1");
    });

    it("rejects malformed info, mismatched refs/hashes, and wrong kinds", function () {
        const typo = completedCopy() as Record<string, unknown>;
        typo.befor = typo.before;
        delete typo.before;
        assertInvalid(decodeMigration(typo, context));

        const missingRelease = completedCopy() as {from: {releaseId: string}};
        missingRelease.from.releaseId = "missing";
        assertInvalid(decodeMigration(missingRelease, context));

        const wrongHash = completedCopy() as {steps: {run: {contentHash: string}}[]};
        wrongHash.steps[0].run.contentHash = "changed";
        assertInvalid(decodeMigration(wrongHash, context));

        const wrongKind = completedCopy() as {before: {kind: string}[]};
        wrongKind.before[0].kind = "sql";
        assertInvalid(decodeMigration(wrongKind, context));
    });

    it("rejects non-JSON input without invoking getters", function () {
        let calls = 0;
        const invalid = completedCopy() as Record<string, unknown>;
        Object.defineProperty(invalid, "danger", {
            enumerable: true,
            get() {
                calls++;
                throw new Error("getter executed");
            },
        });
        assertInvalid(decodeMigration(invalid, context));
        assert.equal(calls, 0);
    });
});
