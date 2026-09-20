/* EJEMPLO: el comportamiento de los tipos de aida */

import { TypeProvider, TypeBehaviour, commonTypeBehaviours, notParsed, parsed } from "../../src/common/type-behaviour";
import { HumanBehaviour, HumanProvider, Locale, commonHumanBehaviours } from "../../src/common/human";
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

/* EL PAR HUMANO. Nadie escribe 2026-07-15 en un formulario: en es-AR escribe 15/07/2026 y en
   en-US 7/15/2026, y las dos cosas son la misma fecha. El orden no se adivina ni se declara,
   lo sabe Intl para cada locale. */
function ordenDeLaFecha(locale: Locale): ('year' | 'month' | 'day')[] {
    return new Intl.DateTimeFormat(locale).formatToParts(new Date(Date.UTC(2026, 6, 15)))
        .map(parte => parte.type)
        .filter((tipo): tipo is 'year' | 'month' | 'day' => tipo === 'year' || tipo === 'month' || tipo === 'day');
}

export const fechaHumana: HumanBehaviour<Fecha> = {
    read: (text, locale) => {
        const partes = text.trim().split(/\D+/).filter(parte => parte !== '');
        const orden = ordenDeLaFecha(locale);
        if (partes.length !== 3 || orden.length !== 3) return notParsed('type.date');
        const leido: Record<string, number> = {};
        orden.forEach((cual, i) => leido[cual] = Number(partes[i]));
        try {
            return parsed(Temporal.PlainDate.from(
                {year: leido['year']!, month: leido['month']!, day: leido['day']!},
                {overflow: 'reject'},
            ));
        } catch {
            return notParsed('type.date');
        }
    },
    display: (value, locale) => value.toLocaleString(locale),
}

/* El booleano de aida, que es donde se ve que la forma humana la decide el sistema. Nadie en
   una secretaría escribe `true`: escribe S, Si, Sí o sí. El locale llega igual y aida elige no
   mirarlo, porque su oficina habla castellano; el día que atienda en otro idioma, ramifica acá
   y en ningún otro lado. Eso es también lo que deja ajustar la jerga de cada cliente sin tocar
   nada más que esta constante.

   Es humano y no canónico: el par canónico sigue leyendo y escribiendo `true`/`false`, que es
   lo que viaja por una url. */
export const booleanoHumano: HumanBehaviour<boolean> = {
    read: (text) => {
        const dicho = text.trim().toLowerCase();
        if (['s', 'si', 'sí'].includes(dicho)) return parsed(true);
        if (['n', 'no'].includes(dicho)) return parsed(false);
        return notParsed('type.boolean');
    },
    display: (value) => value ? 'Sí' : 'No',
}

export const humanBehaviours: HumanProvider<typeof aidaTypeDefs> = {
    ...commonHumanBehaviours,
    boolean: booleanoHumano,
    fecha: fechaHumana,
}
