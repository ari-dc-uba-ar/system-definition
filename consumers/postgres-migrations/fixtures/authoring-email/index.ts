/**
 * Section 11 authoring fixture. This file is descriptive test data, not a live
 * system definition: the PostgreSQL integration harness reproduces these
 * serializable shapes when it builds immutable migration artifacts.
 */
export const authoringEmailFixture = {
    from: {
        alumnos: {
            alumno: {type: "integer", nullable: false},
            nombres: {type: "text", nullable: false},
            email_anterior: {type: "text", nullable: true},
            nota_legacy: {type: "text", nullable: true},
        },
    },
    to: {
        alumnos: {
            alumno: {type: "integer", nullable: false},
            nombres: {type: "text", nullable: false},
            email: {type: "text", nullable: true},
        },
    },
    decisions: [
        {
            source: "alumnos.email_anterior",
            resolution: {kind: "migrate", output: "email"},
        },
        {
            source: "alumnos.nota_legacy",
            resolution: {kind: "discard", reason: "legacy note is intentionally retired by the fixture"},
        },
    ],
} as const;
