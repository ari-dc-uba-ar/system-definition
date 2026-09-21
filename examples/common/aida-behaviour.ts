/* EJEMPLO: el comportamiento de los tipos de aida */

import { TypeProvider, TypeBehaviour, commonTypeBehaviours, notParsed, parsed } from "../../src/common/type-behaviour";
import { HumanBehaviour, HumanProvider, Locale, commonHumanBehaviours } from "../../src/common/human";
import type { aidaTypeDefs } from "./aida-context";

/* aida declara sus tipos en aida-context.ts; acá está cómo se lee y cómo se escribe cada uno.
   Las dos mitades están separadas a propósito —una descripción es serializable y un
   comportamiento es código— pero son del mismo sistema y viven al lado, así que nadie escribe
   `fecha` dos veces.

   `aidaTypeDefs` se importa solamente como tipo, así que este módulo no arrastra ninguna
   definición en runtime. Para eso está el entry point `system-definition/examples/behaviour`:
   un navegador que ya recibió la descripción que necesita importa el comportamiento —que no
   puede viajar, porque son funciones— sin traerse la descripción entera del sistema. */

type Fecha = typeof aidaTypeDefs['fecha']['tsType']

/* serializada, una fecha es la del calendario ISO y nada más: Temporal.PlainDate.from acepta
   bastante más que eso, y lo de más no es una fecha serializada */
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export const fechaBehaviour: TypeBehaviour<Fecha> = {
    deserialize: (text) => {
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
    serialize: (value) => value.toString(),
    check: (value): value is Fecha => value instanceof Temporal.PlainDate,
}

export const typeBehaviours: TypeProvider<typeof aidaTypeDefs> = {
    ...commonTypeBehaviours,
    /* email es text en aida (la misma definición), así que se lee y se escribe igual: que
       tenga forma de email es una regla, no una conversión */
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
    parse: (text, locale) => {
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
    format: (value, locale) => value.toLocaleString(locale),
}

/* El booleano de aida, que es donde se ve que la forma humana la decide el sistema. Nadie en
   una secretaría escribe `true`: escribe S, Si, Sí o sí. El locale llega igual y aida elige no
   mirarlo, porque su oficina habla castellano; el día que atienda en otro idioma, ramifica acá
   y en ningún otro lado. Eso es también lo que deja ajustar la jerga de cada cliente sin tocar
   nada más que esta constante.

   Es el par humano: deserialize/serialize siguen leyendo y escribiendo `true`/`false`, que es
   lo que va en una url. */
export const booleanoHumano: HumanBehaviour<boolean> = {
    parse: (text) => {
        const dicho = text.trim().toLowerCase();
        if (['s', 'si', 'sí'].includes(dicho)) return parsed(true);
        if (['n', 'no'].includes(dicho)) return parsed(false);
        return notParsed('type.boolean');
    },
    format: (value) => value ? 'Sí' : 'No',
}

export const humanBehaviours: HumanProvider<typeof aidaTypeDefs> = {
    ...commonHumanBehaviours,
    boolean: booleanoHumano,
    fecha: fechaHumana,
}
