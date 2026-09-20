/* EJEMPLO: el comportamiento de los tipos de aida */

import { TypeProvider, TypeBehaviour, commonTypeBehaviours, notParsed, parsed } from "../../src/common/type-behaviour";
import type { aidaTypeDefs } from "./aida";

/* aida declares its own types in aida.ts; this is what reading and writing each of them
   looks like. The two halves are apart on purpose — a description stays serializable and
   a behaviour is code — but they belong to the same system and they are kept in the same
   place, so nobody has to write `fecha` twice.

   `aidaTypeDefs` is imported here only as a type, so this module carries no entity definition
   at runtime. That is what the `system-definition/examples/behaviour` entry point is for:
   a browser that already receives the description it needs over the wire imports the
   behaviour — which cannot travel, because it is functions — without dragging the whole
   description of the system along with it. */

type Fecha = typeof aidaTypeDefs['fecha']['tsType']

/* la forma canónica de una fecha es la del calendario ISO y nada más: Temporal.PlainDate.from
   acepta bastante más que eso, y lo de más no es canónico */
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export const fechaBehaviour: TypeBehaviour<Fecha> = {
    parse: (text) => {
        const trimmed = text.trim();
        if (!DATE_FORMAT.test(trimmed)) return notParsed('type.date');
        try {
            /* reject y no el constrain que viene por default: 2026-02-31 tiene la forma
               correcta y no existe, y constrain la convertiría en el 28 sin avisar */
            return parsed(Temporal.PlainDate.from(trimmed, {overflow: 'reject'}));
        } catch {
            return notParsed('type.date');
        }
    },
    format: (value) => value.toString(),
    check: (value): value is Fecha => value instanceof Temporal.PlainDate,
}

export const typeBehaviours: TypeProvider<typeof aidaTypeDefs> = {
    ...commonTypeBehaviours,
    /* email is text in aida (the same definition), so it reads and writes the same way:
       that it looks like an email is a rule, not a parse */
    email: commonTypeBehaviours.text,
    fecha: fechaBehaviour,
}
