import { Problem, ValidationResult, problem } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
import { ParseResult } from "./type-behaviour";
import { SystemTypeContext } from "./ssot-types";

/* Turning a record into text a machine reads back, and the other way around. Text and not
   another interchange format because text is what every boundary outside the domain already
   carries: an http body, a url parameter, a form input, a csv cell.

   This is the only place that converts. The name of an entity arriving from a POST is not a
   problem to be worked around, it is an input to be deserialized, and past this point
   everything is a value of the type the SSOT declares.

   The human counterpart — what a person types and is shown, which depends on the locale —
   is in human.ts. */

export type TextRecord = Readonly<Record<string, string | null>>

export type ParseOptions = {
    /* a half-filled form has no reason to report the mandatory fields still missing: the
       caller says whether this text is meant to be complete */
    requireMandatory?: boolean
}

/* The walk over the fields of a record, shared by the machine conversion and the human one:
   what changes between them is how one value is converted, and nothing else. */
export function walkTextRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions,
    convertOne: (typeName: string, raw: string) => ParseResult<unknown>,
): {problems: Problem[], values: Record<string, unknown>} {
    const requireMandatory = options.requireMandatory ?? true;
    const problems: Problem[] = [];
    const values: Record<string, unknown> = {};
    /* completed and not read raw, because the default of nullable lives in completeCoreField
       and nowhere else. It costs a completion per call; when that matters, the caller that
       already holds the info is the one to receive it. */
    const fields = completeRecord(context, recordDef);
    for (const [name, field] of Object.entries(fields)) {
        const raw = text[name] ?? null;
        /* an empty input is the absence of a value and not the empty string: a generic form
           has no other way of saying null */
        if (raw === null || raw === '') {
            if (!field.nullable && requireMandatory) {
                problems.push(problem(name, 'field.required', 'blocking'));
            }
            values[name] = null;
            continue;
        }
        const typeName = String(field.type);
        const result = convertOne(typeName, raw);
        if (result.ok) {
            values[name] = result.value;
        } else {
            problems.push(problem(name, result.messageKey, 'blocking', {type: typeName}));
        }
    }
    return {problems, values};
}

export function behaviourOf(context: SystemTypeContext, typeName: string) {
    const behaviour = context.behaviours[typeName];
    if (behaviour == null) {
        throw new Error('no behaviour declared for type "' + typeName + '" in this system');
    }
    return behaviour;
}

/* THE ONE CONVERSION. Every value in `values` came out of the behaviour of the very type the
   field declares, so the record is an instance of what the def says; what the compiler cannot
   follow is the trip through the runtime string that indexes the behaviours. Nothing else in
   this package converts: if another place seems to need it, the conversion happened too late. */
export function deserializeRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions = {},
): ValidationResult<RecordInstanceType<TContext, TRecordDef>> {
    const {problems, values} = walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => behaviourOf(context, typeName).deserialize(raw));
    if (problems.length > 0) return {ok: false, problems};
    return {ok: true, value: values as RecordInstanceType<TContext, TRecordDef>};
}

/* Asking only whether the text converts, without building anything: what a field-by-field
   check in a form needs, where most of the record is still empty. */
export function deserializeProblems<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions = {},
): readonly Problem[] {
    return walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => behaviourOf(context, typeName).deserialize(raw)).problems;
}

/* Field by field and not the whole record in one string, because the caller decides the
   envelope: the same fields go into a query string, a csv row or a json object. A null stays
   null and does not become the text "null". */
export function serializeFields<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | null>> {
    const text: Record<string, string | null> = {};
    for (const [name, field] of Object.entries(completeRecord(context, recordDef))) {
        const value = row[name];
        text[name] = value == null ? null : behaviourOf(context, String(field.type)).serialize(value as never);
    }
    return text;
}
