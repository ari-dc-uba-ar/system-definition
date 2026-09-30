import type {SystemSnapshotInfo} from "system-definition";
import {
    type AuthoringContext,
    type TransformationInfo,
    defineDataMigration,
    defineTransformation,
} from "../src/migration-authoring";

const hash = (digit: string): string => digit.repeat(64);

const fromSnapshot = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["text", "integer"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                email_old: {name: "email_old", type: "text", nullable: false},
                nickname: {name: "nickname", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {email: ["email_old"]},
            fks: {},
            validators: [],
        },
    },
    records: {},
} as const satisfies SystemSnapshotInfo;

const toSnapshot = {
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
                alias: {name: "alias", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {email: ["email"]},
            fks: {},
            validators: [],
        },
    },
    records: {},
} as const satisfies SystemSnapshotInfo;

const copyEmail = {
    name: "copy-email",
    version: "1",
    inputs: {
        value: {
            domain: {side: "from", type: "text", nullable: false},
            field: {side: "from", entity: "people", field: "email_old"},
        },
    },
    parameters: {
        suffix: {side: "to", type: "text", nullable: false},
    },
    outputs: {
        value: {
            domain: {side: "to", type: "text", nullable: false},
            field: {side: "to", entity: "people", field: "email"},
        },
    },
    mode: "row",
    query: {name: "copy-email.sql", kind: "query", contentHash: hash("1")},
    lineage: null,
    before: [],
    after: [],
} as const satisfies TransformationInfo;

const nullableOutput = {
    ...copyEmail,
    name: "nullable-email",
    outputs: {
        value: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "people", field: "alias"},
        },
    },
} as const satisfies TransformationInfo;

const integerOutput = {
    ...copyEmail,
    name: "integer-output",
    outputs: {
        value: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "people", field: "id"},
        },
    },
} as const satisfies TransformationInfo;

const context = {
    from: fromSnapshot,
    to: toSnapshot,
    transformations: {
        "copy-email": copyEmail,
        "nullable-email": nullableOutput,
        "integer-output": integerOutput,
    },
} as const satisfies AuthoringContext;

const valid = defineDataMigration(context, {
    id: "move-email",
    source: {
        query: {name: "source.sql", kind: "query", contentHash: hash("2")},
        ports: {
            value: {
                domain: {side: "from", type: "text", nullable: false},
                field: {side: "from", entity: "people", field: "email_old"},
            },
        },
        identity: ["value"],
    },
    transformation: "copy-email",
    arguments: {
        suffix: {
            domain: {side: "to", type: "text", nullable: false},
            value: "",
        },
    },
    writes: [{
        kind: "update",
        entity: "people",
        values: [{output: "value", target: {side: "to", entity: "people", field: "email"}}],
        match: [{output: "value", targetField: "email"}],
        whenMissing: "error",
    }],
});

const exactId: "move-email" = valid.id;
const exactTransformation: "copy-email" = valid.transformation;
const exactIdentity: readonly ["value"] = valid.source.identity;
void exactId;
void exactTransformation;
void exactIdentity;

function rejectedStaticDefinitions(): void {
    const typoSource = {
        ...valid,
        source: {
            ...valid.source,
            ports: {
                value: {
                    domain: {side: "from", type: "text", nullable: false},
                    field: {side: "from", entity: "people", field: "email_typo"},
                },
            },
        },
    } as const;
    // @ts-expect-error source field names come from the literal `from` snapshot.
    defineDataMigration(context, typoSource);

    const wrongSide = {
        ...valid,
        source: {
            ...valid.source,
            ports: {
                value: {
                    domain: {side: "to", type: "text", nullable: false},
                    field: {side: "to", entity: "people", field: "email"},
                },
            },
        },
    } as const;
    // @ts-expect-error business sources are `from` refs, never `to` refs.
    defineDataMigration(context, wrongSide);

    const typoTransformation = {...valid, transformation: "copy-emali"} as const;
    // @ts-expect-error transformation names stay literal and come from the context registry.
    defineDataMigration(context, typoTransformation);

    const typoArgument = {
        ...valid,
        arguments: {
            suffxi: valid.arguments.suffix,
        },
    } as const;
    // @ts-expect-error argument keys must exactly match the selected transformation parameters.
    defineDataMigration(context, typoArgument);

    const typoOutput = {
        ...valid,
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "vale", target: {side: "to", entity: "people", field: "email"}}],
            match: [{output: "value", targetField: "email"}],
            whenMissing: "error",
        }],
    } as const;
    // @ts-expect-error write output names must come from the selected transformation outputs.
    defineDataMigration(context, typoOutput);

    const wrongTarget = {
        ...valid,
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "value", target: {side: "to", entity: "people", field: "email_typo"}}],
            match: [{output: "value", targetField: "email"}],
            whenMissing: "error",
        }],
    } as const;
    // @ts-expect-error target field names come from the literal `to` snapshot.
    defineDataMigration(context, wrongTarget);

    const incompatibleDomain = {
        ...valid,
        transformation: "integer-output",
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "value", target: {side: "to", entity: "people", field: "email"}}],
            match: [{output: "value", targetField: "email"}],
            whenMissing: "error",
        }],
    } as const;
    // @ts-expect-error an integer output cannot satisfy a text target without an explicit text output.
    defineDataMigration(context, incompatibleDomain);

    const extraWriteProperty = {
        ...valid,
        writes: [{
            kind: "update",
            entity: "people",
            values: valid.writes[0].values,
            match: valid.writes[0].match,
            whenMissing: "error",
            unexpectedPolicy: "last-wins",
        }],
    } as const;
    // @ts-expect-error write variants are recursively exact; policy typos are not extension points.
    defineDataMigration(context, extraWriteProperty);

    const extraPortProperty = {
        ...copyEmail,
        inputs: {
            value: {
                ...copyEmail.inputs.value,
                unexpectedNullable: false,
            },
        },
    } as const;
    // @ts-expect-error transformation ports are recursively exact.
    defineTransformation(context, extraPortProperty);

    const nullableToRequired = {
        ...valid,
        transformation: "nullable-email",
        source: {
            ...valid.source,
            ports: {
                value: {
                    domain: {side: "from", type: "text", nullable: false},
                    field: {side: "from", entity: "people", field: "email_old"},
                },
            },
        },
        arguments: {suffix: valid.arguments.suffix},
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "value", target: {side: "to", entity: "people", field: "email"}}],
            match: [{output: "value", targetField: "email"}],
            whenMissing: "error",
        }],
    } as const;
    // @ts-expect-error nullable output cannot satisfy a NOT NULL target without an explicit compatible transformation output.
    defineDataMigration(context, nullableToRequired);
}
void rejectedStaticDefinitions;
