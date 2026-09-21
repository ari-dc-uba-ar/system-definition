/* EJEMPLO: las reglas de aida */

import type { Problem } from "../../src/common/problem";
import { problem } from "../../src/common/problem";
import type { DefinedType, cargos } from "./aida";

/* Cada regla declara la forma que necesita y no la entidad a la que pertenece, así que
   `emailRazonable` sirve para docentes y para alumnos sin duplicarse, y nombrarla desde una
   entidad que no tiene `email` no compila.

   Son funciones del lenguaje, no datos: la definición las referencia por nombre, igual que
   una entidad referencia su record. */

const FORMA_DE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const emailRazonable = (fila: {email: string | null}): readonly Problem[] => {
    /* sin dato no hay nada que validar: que sea obligatorio lo dice nullable y lo controla
       la etapa de parseo */
    if (fila.email == null || FORMA_DE_EMAIL.test(fila.email)) return [];
    return [problem('email', 'email.forma', 'regular')];
}

export const ordenPositivo = (fila: {orden: number | null}): readonly Problem[] => {
    if (fila.orden == null || fila.orden > 0) return [];
    return [problem('orden', 'orden.positivo', 'regular', {recibido: String(fila.orden)})];
}

export const validadores = {emailRazonable, ordenPositivo};

/* Escrita a mano y no como una de las de arriba: está para mostrar que el tipo deducido de la
   definición obliga al chequeo de null, porque `denominacion` es nulleable en la def. */
export function validarCargo(cargoSinValidar: DefinedType<typeof cargos>){
    if (cargoSinValidar.puede_dirigir && cargoSinValidar.denominacion?.match(/ayudante/i)) {
        throw new Error('Los ayudantes no pueden dirigir. Recibido:"' + cargoSinValidar.denominacion + '"');
    }
}
