/* EJEMPLO: el contexto de aida, que es donde vive lo que no es descripción.

   La descripción de aida está en aida.ts y no declara una sola función. Acá están las que
   esa descripción necesita para existir: cómo se completa un campo de este sistema, qué
   comportamiento tiene cada tipo y qué reglas hay para que las entidades las nombren.

   La colección de tipos está acá y no allá porque el contexto se arma con ella y el
   comportamiento se tipa contra ella: dejarla del otro lado haría que los dos archivos se
   necesitaran mutuamente en runtime. */

import { boxType, commonTypeDefs, completeCoreField, CoreFieldDef, defineTypes } from "../../src/common/ssot-types";
import { commonTypeBehaviours, notParsed, parsed } from "../../src/common/type-behaviour";
import { withValidators } from "../../src/common/ssot-entity";
import { humanBehaviours, typeBehaviours } from "./aida-behaviour";
import { validadores } from "./aida-validators";

/* los tipos salen a su propia constante para que el comportamiento pueda tiparse contra
   ellos sin depender del contexto, que es el que va a llevar el comportamiento adentro */
export const aidaTypeDefs = {
    ...commonTypeDefs,
    fecha: {tsType: boxType<Temporal.PlainDate>()},
    email: commonTypeDefs.text,
}

const types = aidaTypeDefs;

/* what a field of THIS system looks like: the core the ssot needs plus what aida wants. isName
   is not a concept of the framework, it is a decision of this system, and so are the defaults */
export type AidaFieldDef = CoreFieldDef<typeof types> & {
    isName?: boolean
    label?: string
    description?: string
}

/* the context this system is described against: one value that every layer of the SSOT
   receives, so a def never has to say twice which types it is talking about. The completer
   builds the info key by key, which also fixes the order the generators will see. */
export const aidaTypes = defineTypes({
    types,
    behaviours: typeBehaviours,
    human: humanBehaviours,
    completeField: (fieldDef: AidaFieldDef, name: string) => ({
        ...completeCoreField(fieldDef, name),
        isName     : fieldDef.isName ?? false,
        label      : fieldDef.label ?? name.replace(/_/g,' '),
        description: fieldDef.description ?? '',
    }),
})

/* las reglas entran al contexto antes que las entidades, porque son las entidades las que
   las nombran */
export const aidaConReglas = withValidators(aidaTypes, validadores)

export type AidaTypeName = keyof typeof types

const metaTypes = {
    ...commonTypeDefs,
    typeName: {tsType: boxType<AidaTypeName>()},
}

/* el comportamiento de typeName no es de adorno: leer un nombre de tipo desde un texto es
   verificar que sea uno de los que el sistema declara, y eso lo sabe esta misma constante */
const nombresDeTipo = Object.keys(aidaTypeDefs) as AidaTypeName[];

export const aidaMetaContext = defineTypes({
    types: metaTypes,
    behaviours: {
        ...commonTypeBehaviours,
        typeName: {
            deserialize: (texto) => nombresDeTipo.includes(texto.trim() as AidaTypeName)
                ? parsed(texto.trim() as AidaTypeName)
                : notParsed('type.typeName'),
            serialize: (valor) => valor,
            check: (valor): valor is AidaTypeName => nombresDeTipo.includes(valor as AidaTypeName),
        },
    },
    completeField: (fieldDef: CoreFieldDef<typeof metaTypes> & {label?: string}, name: string) => ({
        ...completeCoreField(fieldDef, name),
        label: fieldDef.label ?? name.replace(/_/g,' '),
    }),
})
