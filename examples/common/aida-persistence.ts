import {definePersistence} from "../../src/common/system-persistence";
import {aida, entityDefs} from "./aida";

export const aidaPersistence = definePersistence({...aida, entities: entityDefs}, {
    entities: [
        "docentes", "materias", "periodos", "cursos", "clases", "alumnos",
        "preguntas", "opciones", "inscripciones", "presencias", "mesas",
    ],
    representations: {
        postgres: {
            text: "text",
            integer: "integer",
            boolean: "boolean",
            fecha: "date",
            email: "text",
        },
    },
});
