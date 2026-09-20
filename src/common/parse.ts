import { Problem, ValidationResult, problem } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
import { ParseResult } from "./type-behaviour";
import { SystemTypeContext } from "./ssot-types";

/* Turning text into the values a record declares. Text and not another interchange format
   because text is what every boundary outside the domain already carries: an http body, a url
   parameter, a form input, a csv cell. Which is also why this is the only place that converts:
   the name of an entity arriving from a POST is not a problem to be worked around, it is an
   input to be parsed, and past this point everything is a value of the type the SSOT declares. */

export type TextRecord = Readonly<Record<string, string | null>>

export type ParseOptions = {
    /* a half-filled form has no reason to report the mandatory fields still missing: the
       caller says whether this text is meant to be complete */
    requireMandatory?: boolean
}

/* The walk over the fields of a record, shared by the canonical reading and the human one:
   what changes between them is how one value is read, and nothing else. */
export function walkTextRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions,
    readOne: (typeName: string, raw: string) => ParseResult<unknown>,
): {problems: Problem[], values: Record<string, unknown>} {
    const requireMandatory = options.requireMandatory ?? true;
    const problems: Problem[] = [];
    const values: Record<string, unknown> = {};
    /* completed and not read raw, because the default of nullable lives in completeCoreField
       and nowhere else. It costs a completion per parse; when that matters, the caller that
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
        const result = readOne(typeName, raw);
        if (result.ok) {
            values[name] = result.value;
        } else {
            problems.push(problem(name, result.messageKey, 'blocking', {type: typeName}));
        }
    }
    return {problems, values};
}

export function canonicalReader(context: SystemTypeContext): (typeName: string, raw: string) => ParseResult<unknown> {
    return (typeName, raw) => {
        const behaviour = context.behaviours[typeName];
        if (behaviour == null) {
            throw new Error('no behaviour declared for type "' + typeName + '" in this system');
        }
        return behaviour.parse(raw);
    };
}

/* THE ONE CONVERSION. Every value in `values` came out of the behaviour of the very type the
   field declares, so the record is an instance of what the def says; what the compiler cannot
   follow is the trip through the runtime string that indexes the behaviours. Nothing else in
   this package converts: if another place seems to need it, the parsing happened too late. */
export function parseRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions = {},
): ValidationResult<RecordInstanceType<TContext, TRecordDef>> {
    const {problems, values} = walkTextRecord(context, recordDef, text, options, canonicalReader(context));
    if (problems.length > 0) return {ok: false, problems};
    return {ok: true, value: values as RecordInstanceType<TContext, TRecordDef>};
}

/* Asking only whether the text reads, without building anything: what a field-by-field check
   in a form needs, where most of the record is still empty. */
export function parseProblems<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions = {},
): readonly Problem[] {
    return walkTextRecord(context, recordDef, text, options, canonicalReader(context)).problems;
}
