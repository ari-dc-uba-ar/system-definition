/* EJEMPLO: el comportamiento de los tipos de aida */

import { TypeProvider, TypeBehaviour, commonTypeBehaviours, notParsed, parsed } from "../../src/common/type-behaviour";
import { typeDefs } from "./aida";

/* aida declares its own types in aida.ts; this is what reading and writing each of them
   looks like. The two halves are apart on purpose — a description stays serializable and
   a behaviour is code — but they belong to the same system and they are kept in the same
   place, so nobody has to write `fecha` twice.

   `typeDefs` is imported here only as a type, so this module carries no entity definition
   at runtime. That is what the `system-definition/examples/behaviour` entry point is for:
   a browser that already receives the description it needs over the wire imports the
   behaviour — which cannot travel, because it is functions — without dragging the whole
   description of the system along with it. */

type Fecha = typeof typeDefs['fecha']['tsType']

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

function twoDigits(number: number): string {
    return String(number).padStart(2, '0');
}

export const fechaBehaviour: TypeBehaviour<Fecha> = {
    parse: (text) => {
        const parts = DATE_FORMAT.exec(text.trim());
        if (parts == null) return notParsed('type.date');
        const año = Number(parts[1]);
        const mes = Number(parts[2]);
        const día = Number(parts[3]);
        /* having the right shape is not enough: 2026-02-31 has it */
        const check = new Date(Date.UTC(año, mes - 1, día));
        if (
            check.getUTCFullYear() !== año
            || check.getUTCMonth() !== mes - 1
            || check.getUTCDate() !== día
        ) return notParsed('type.date');
        return parsed<Fecha>({año, mes, día});
    },
    format: (value) => String(value.año).padStart(4, '0') + '-' + twoDigits(value.mes) + '-' + twoDigits(value.día),
}

/* A system may also specialize a common type: aida's users type `sí` and `no`, so its
   boolean reads them, while the common one stays language neutral. */
export const booleanoDeAida: TypeBehaviour<boolean> = {
    parse: (text) => {
        const normalizado = text.trim().toLowerCase();
        if (normalizado === 'sí' || normalizado === 'si') return parsed(true);
        if (normalizado === 'no') return parsed(false);
        return commonTypeBehaviours.boolean.parse(text);
    },
    format: commonTypeBehaviours.boolean.format,
}

export const typeBehaviours: TypeProvider<typeof typeDefs> = {
    ...commonTypeBehaviours,
    boolean: booleanoDeAida,
    /* email is text in aida (the same definition), so it reads and writes the same way:
       that it looks like an email is a rule, not a parse */
    email: commonTypeBehaviours.text,
    fecha: fechaBehaviour,
}
