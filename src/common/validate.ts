import { Problem } from "./problem";

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
