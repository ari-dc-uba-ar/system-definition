import { Problem, ValidationResult, problem } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
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

function parseFields<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    options: ParseOptions,
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
        const behaviour = context.behaviours[typeName];
        if (behaviour == null) {
            throw new Error('no behaviour declared for type "' + typeName + '" in this system');
        }
        const result = behaviour.parse(raw);
        if (result.ok) {
            values[name] = result.value;
        } else {
            problems.push(problem(name, result.messageKey, 'blocking', {type: typeName}));
        }
    }
    return {problems, values};
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
    const {problems, values} = parseFields(context, recordDef, text, options);
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
    return parseFields(context, recordDef, text, options).problems;
}
