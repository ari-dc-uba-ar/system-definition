/* EJEMPLO: las reglas de aida */

import type { Problem } from "../../src/common/problem";
import { problem } from "../../src/common/problem";

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
