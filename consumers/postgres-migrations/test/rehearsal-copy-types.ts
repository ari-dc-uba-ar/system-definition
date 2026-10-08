import {
    decodeRehearsalCopyRef,
    hasWellFormedRehearsalCopyIdentity,
    sameRehearsalCopyRef,
    type RehearsalCopyRef,
} from "../src/rehearsal-copy";
import type {ValidationResult} from "system-definition";

const copy: RehearsalCopyRef = {
    copyId: "copy-1",
    provenance: "snapshot-1",
    installationId: "install-1",
    source: {systemId: "system", releaseId: "release", releaseHash: "a".repeat(64)},
    schemas: ["app"],
};

const refined: boolean = hasWellFormedRehearsalCopyIdentity(copy);
const equal: boolean = sameRehearsalCopyRef(copy, copy);
const decoded: ValidationResult<RehearsalCopyRef> = decodeRehearsalCopyRef(
    copy,
    "$",
    () => ({ok: false, problems: []}),
);
void refined;
void equal;
void decoded;

// Preparation refinement consumes an already typed copy; it must not become an unknown-boundary API.
// @ts-expect-error unknown values require decodeRehearsalCopyRef first
hasWellFormedRehearsalCopyIdentity({});
