/* Each release describes the desired system. The migration does not replace this SSOT.
   Shared field definitions keep unchanged contracts identical without copying SQL. */
import {captureSystemSnapshot, defineEntities, defineEntity, defineRecord, withRecords} from "system-definition";
import {studentTypes} from "./student-context";
import {valueOf} from "./support";

const student = defineRecord(studentTypes, {
    studentId: {type: "integer", nullable: false},
    name: {type: "text", nullable: false},
});

// Initial release: the legacy address and note still belong to the system.
const legacyStudent = defineRecord(studentTypes, {
    ...student, legacyEmail: {type: "text"}, legacyNote: {type: "text"},
});
const legacyContext = withRecords(studentTypes, {student: legacyStudent});
const legacyEntities = defineEntities({
    students: defineEntity(legacyContext, {name: "students", record: "student", pk: ["studentId"], fks: {}, uks: {}, validators: []}),
});
export const legacySnapshot = valueOf(captureSystemSnapshot(legacyContext, {systemId: "students", entities: legacyEntities}));

// A harmless structural addition needs no data transformation: infer creates ADD COLUMN.
const expandedStudent = defineRecord(studentTypes, {...legacyStudent, email: {type: "text"}});
const expandedContext = withRecords(studentTypes, {student: expandedStudent});
const expandedEntities = defineEntities({
    students: defineEntity(expandedContext, {name: "students", record: "student", pk: ["studentId"], fks: {}, uks: {}, validators: []}),
});
export const expandedSnapshot = valueOf(captureSystemSnapshot(expandedContext, {systemId: "students", entities: expandedEntities}));

// Removing legacy fields requires individual decisions, even though DROP can be inferred.
const currentStudent = defineRecord(studentTypes, {...student, email: {type: "text"}});
const currentContext = withRecords(studentTypes, {student: currentStudent});
const currentEntities = defineEntities({
    students: defineEntity(currentContext, {name: "students", record: "student", pk: ["studentId"], fks: {}, uks: {}, validators: []}),
});
export const currentSnapshot = valueOf(captureSystemSnapshot(currentContext, {systemId: "students", entities: currentEntities}));
