import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import type {MigrationDraftInfo, PendingQuestionInfo} from "../src/authoring-contract";
import type {AuthoringContext, DataMigrationDef} from "../src/migration-authoring";
import {runAddDataSession} from "../src/authoring-cli";

const hash = (digit: string): string => digit.repeat(64);

const snapshot = {
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
    },
    records: {},
} as const;

const context: AuthoringContext = {
    from: snapshot,
    to: snapshot,
    transformations: {
        copyFirst: {
            name: "copyFirst",
            version: "1",
            inputs: {
                id: {
                    domain: {side: "from", type: "integer", nullable: false},
                    field: {side: "from", entity: "people", field: "id"},
                },
                first: {
                    domain: {side: "from", type: "text", nullable: false},
                    field: {side: "from", entity: "people", field: "first"},
                },
            },
            parameters: {},
            outputs: {
                id: {
                    domain: {side: "to", type: "integer", nullable: false},
                    field: {side: "to", entity: "people", field: "id"},
                },
                firstCopy: {
                    domain: {side: "to", type: "text", nullable: false},
                    field: {side: "to", entity: "people", field: "first"},
                },
            },
            mode: "row",
            query: {name: "copy-first.sql", kind: "query", contentHash: hash("2")},
            lineage: null,
            before: [],
            after: [],
        },
    },
};

const draft: MigrationDraftInfo = {
    formatVersion: 1,
    id: "A-B-data",
    base: {
        from: {systemId: "demo", releaseId: "A", releaseHash: hash("a")},
        to: {systemId: "demo", releaseId: "B", releaseHash: hash("b")},
        fromSnapshotHash: hash("c"),
        toSnapshotHash: hash("d"),
        fromPersistenceHash: hash("e"),
        toPersistenceHash: hash("f"),
    },
    revisionHash: hash("9"),
    renames: [],
    changes: [],
    data: [],
    decisions: [],
    manual: [],
    pending: [],
};

const migration: DataMigrationDef<typeof context> = {
    id: "copy-first",
    source: {
        query: {name: "people-source.sql", kind: "query", contentHash: hash("1")},
        ports: {
            id: {
                domain: {side: "from", type: "integer", nullable: false},
                field: {side: "from", entity: "people", field: "id"},
            },
            first: {
                domain: {side: "from", type: "text", nullable: false},
                field: {side: "from", entity: "people", field: "first"},
            },
        },
        identity: ["id"],
    },
    transformation: "copyFirst",
    arguments: {},
    writes: [{
        kind: "update",
        entity: "people",
        values: [{
            output: "firstCopy",
            target: {side: "to", entity: "people", field: "first"},
        }],
        match: [{output: "id", targetField: "id"}],
        whenMissing: "error",
    }],
};

type AddDataAnswer = {
    questionId: string;
    kind: "add-data";
    dataMigration: DataMigrationDef<typeof context>;
};

type AnswersFile = {
    formatVersion: 1;
    draftHash: string;
    answers: readonly AddDataAnswer[];
};

type Report = {
    ok: boolean;
    command: "add-data";
    draftPath: string;
    revisionHash: string;
    validation: {
        contracts: "passed" | "pending" | "failed";
        data: "notRun";
        problems: readonly {messageKey: string}[];
    };
    questions: readonly PendingQuestionInfo[];
    problems: readonly {messageKey: string}[];
    files: readonly {path: string; contentHash: string}[];
};

function cloneDraft(value: MigrationDraftInfo): MigrationDraftInfo {
    return JSON.parse(JSON.stringify(value)) as MigrationDraftInfo;
}

class MemoryStore {
    current: MigrationDraftInfo;
    writes = 0;

    constructor(initial: MigrationDraftInfo) {
        this.current = cloneDraft(initial);
    }

    async readDraft(_path: string): Promise<ValidationResult<MigrationDraftInfo>> {
        return {ok: true, value: cloneDraft(this.current)};
    }

    async replaceDraftAtomic(_path: string, next: MigrationDraftInfo): Promise<ValidationResult<true>> {
        this.writes += 1;
        this.current = cloneDraft(next);
        return {ok: true, value: true};
    }
}

function asReport(value: unknown): Report {
    return value as Report;
}

async function pendingQuestion(store: MemoryStore): Promise<PendingQuestionInfo> {
    const result = asReport(await runAddDataSession({
        draftPath: "drafts/A-B.json",
        context,
        store,
        nonInteractive: true,
    }));
    assert.equal(result.ok, false);
    assert.equal(result.questions.length, 1);
    return result.questions[0]!;
}

function answersFor(questionId: string, draftHash: string = draft.revisionHash): AnswersFile {
    return {
        formatVersion: 1,
        draftHash,
        answers: [{questionId, kind: "add-data", dataMigration: migration}],
    };
}

describe("T19 reproducible add-data authoring CLI", () => {
    it("reports a deterministic pending question in non-interactive mode without reading stdin", async () => {
        const store = new MemoryStore(draft);
        let prompts = 0;
        const result = asReport(await runAddDataSession({
            draftPath: "drafts/A-B.json",
            context,
            store,
            nonInteractive: true,
            prompt: {
                ask: async (_question: PendingQuestionInfo): Promise<AddDataAnswer | null> => {
                    prompts += 1;
                    return null;
                },
            },
        }));

        assert.deepEqual(Object.keys(result).sort(), [
            "command", "draftPath", "files", "ok", "problems", "questions", "revisionHash", "validation",
        ]);
        assert.equal(result.ok, false);
        assert.equal(result.command, "add-data");
        assert.equal(result.draftPath, "drafts/A-B.json");
        assert.equal(result.revisionHash, draft.revisionHash);
        assert.equal(result.questions.length, 1);
        assert.equal(result.questions[0]?.kind, "dataRequired");
        assert.equal(result.problems[0]?.messageKey, "migration.authoringPending");
        assert.equal(result.validation.contracts, "pending");
        assert.equal(result.validation.data, "notRun");
        assert.deepEqual(result.files, []);
        assert.equal(prompts, 0);
        assert.equal(store.writes, 0);
    });

    it("applies matching serializable answers atomically and computes a deterministic new revision", async () => {
        const firstStore = new MemoryStore(draft);
        const secondStore = new MemoryStore(draft);
        const question = await pendingQuestion(firstStore);
        firstStore.writes = 0;

        const first = asReport(await runAddDataSession({
            draftPath: "drafts/A-B.json",
            context,
            store: firstStore,
            nonInteractive: true,
            answers: answersFor(question.id),
        }));
        const second = asReport(await runAddDataSession({
            draftPath: "drafts/A-B.json",
            context,
            store: secondStore,
            nonInteractive: true,
            answers: answersFor(question.id),
        }));

        assert.equal(first.ok, true);
        assert.equal(first.revisionHash === draft.revisionHash, false);
        assert.equal(first.revisionHash, second.revisionHash);
        assert.equal(first.validation.contracts, "passed");
        assert.equal(first.validation.data, "notRun");
        assert.deepEqual(first.questions, []);
        assert.deepEqual(first.problems, []);
        assert.deepEqual(first.files, [{path: "drafts/A-B.json", contentHash: first.revisionHash}]);
        assert.equal(firstStore.writes, 1);
        assert.equal(secondStore.writes, 1);
        assert.equal(firstStore.current.data.length, 1);
        assert.equal(firstStore.current.data[0]?.id, "copy-first");
        assert.deepEqual(firstStore.current, secondStore.current);
    });

    it("rejects stale answer files without modifying the draft", async () => {
        const store = new MemoryStore(draft);
        const question = await pendingQuestion(store);
        store.writes = 0;
        const before = cloneDraft(store.current);

        const result = asReport(await runAddDataSession({
            draftPath: "drafts/A-B.json",
            context,
            store,
            nonInteractive: true,
            answers: answersFor(question.id, hash("0")),
        }));

        assert.equal(result.ok, false);
        assert.equal(result.problems[0]?.messageKey, "migration.authoringStaleAnswers");
        assert.equal(store.writes, 0);
        assert.deepEqual(store.current, before);
    });

    it("treats interactive cancellation as non-success and preserves the exact draft", async () => {
        const store = new MemoryStore(draft);
        const before = cloneDraft(store.current);
        let prompts = 0;

        const result = asReport(await runAddDataSession({
            draftPath: "drafts/A-B.json",
            context,
            store,
            nonInteractive: false,
            prompt: {
                ask: async (_question: PendingQuestionInfo): Promise<AddDataAnswer | null> => {
                    prompts += 1;
                    return null;
                },
            },
        }));

        assert.equal(result.ok, false);
        assert.equal(result.questions.length, 1);
        assert.equal(prompts, 1);
        assert.equal(store.writes, 0);
        assert.deepEqual(store.current, before);
    });
});
