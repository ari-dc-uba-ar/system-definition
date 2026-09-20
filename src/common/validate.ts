import { Problem, problem } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
import { SystemTypeContext } from "./ssot-types";

/* The rules over a record that is already built. Parsing said the values are of the type the
   field declares; these say whether the record makes sense.

   A validator declares the shape it needs and not the record it belongs to:

       const minAge = (row: {fechaNacimiento: Fecha}) => Problem[]

   so the same rule serves every record that happens to have that shape, and naming it from one
   that has not got it does not compile. The check is assignability, which is what makes this
   duck typing with the compiler watching. */

export type Validator<TRow> = (row: TRow) => readonly Problem[]

/* `never` as the parameter is the bottom of the contravariant order: every unary validator,
   whatever shape it asks for, fits this collection. */
export type ValidatorCollection = Readonly<Record<string, (row: never) => readonly Problem[]>>

/* The names a given record may use: those whose validator asks for a shape the record has. */
export type ValidatorNamesFor<TRow, TValidators extends ValidatorCollection> = {
    [N in keyof TValidators]: TRow extends Parameters<TValidators[N]>[0] ? N : never
}[keyof TValidators]

/* Every rule runs and every problem is collected, so whoever is filling the record sees them
   all at once instead of correcting one per round trip. Stopping early is the caller's
   decision and it is taken before getting here: a value that did not parse is blocking, and
   running a rule over it only produces noise about something nobody understood. */
export function validateInstance<TRow>(
    validators: ValidatorCollection,
    names: readonly string[],
    row: TRow,
): readonly Problem[] {
    return names.flatMap(name => {
        const validator = validators[name];
        if (validator == null) {
            throw new Error('no validator named "' + name + '" in this system');
        }
        return validator(row as never);
    });
}

/* Typing a record that did not come through the parser. The parameters of a procedure, a row
   handed over by somebody else: the values are already built, so there is no text to read, and
   what says whether each one belongs to the type its field declares is `check`.

   It reports which field is wrong, because a bare false is useless to whoever has to fix it. */
export function instanceProblems<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    value: unknown,
): readonly Problem[] {
    if (value == null || typeof value !== 'object') {
        return [problem(null, 'record.notAnObject', 'blocking')];
    }
    const row = value as Record<string, unknown>;
    const problems: Problem[] = [];
    for (const [name, field] of Object.entries(completeRecord(context, recordDef))) {
        const each = row[name];
        if (each == null) {
            if (!field.nullable) problems.push(problem(name, 'field.required', 'blocking'));
            continue;
        }
        const typeName = String(field.type);
        const behaviour = context.behaviours[typeName];
        if (behaviour == null) {
            throw new Error('no behaviour declared for type "' + typeName + '" in this system');
        }
        if (!behaviour.check(each)) {
            problems.push(problem(name, 'field.notOfItsType', 'blocking', {type: typeName}));
        }
    }
    return problems;
}

/* The same thing as a type predicate: past this call the compiler knows the record is what the
   definition says, and it knows it because every value was looked at, not because somebody
   asserted it. */
export function isRecordInstance<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    value: unknown,
): value is RecordInstanceType<TContext, TRecordDef> {
    return instanceProblems(context, recordDef, value).length === 0;
}
