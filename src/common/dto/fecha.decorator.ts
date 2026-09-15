import { Matches } from 'class-validator';

/**
 * Una fecha de calendario: `AAAA-MM-DD` y nada más.
 *
 * `IsISO8601` deja pasar `2026-07-08T05:00:00.000Z`, que es lo que devuelve
 * la misma API al leer un documento. Reenviarla tal cual hacía que Postgres
 * rechazara la conversión de una cotización con un 500 sin explicación. Un
 * día contable no tiene hora ni zona: se valida como lo que es.
 */
export const EsFechaCalendario = (): PropertyDecorator =>
  Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'La fecha va como AAAA-MM-DD',
  });
