/* Migration examples use the same Def/Info and behaviour separation as examples/common.
   Definitions contain no functions. Machine conversion and validation live in the context. */
import {commonTypeBehaviours, commonTypeDefs, completeCoreField, defineTypes} from "system-definition";

type StudentFieldDef = {type: keyof typeof commonTypeDefs; nullable?: boolean};
export const studentTypes = defineTypes({
    types: commonTypeDefs,
    behaviours: commonTypeBehaviours,
    completeField: (field: StudentFieldDef, name: string) => completeCoreField(field, name),
});
