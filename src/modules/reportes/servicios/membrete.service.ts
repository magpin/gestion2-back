import { Injectable } from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';

export interface Membrete {
  razonSocial: string;
  nit: string;
  dv?: string;
  ciudad?: string;
}

/** Quién firma «Elaboró», y con qué papel. */
export interface Firmante {
  nombre: string;
  rol: string;
}

/**
 * El papel que se imprime al lado del nombre, cuando alguien tiene varios.
 *
 * Va el de más responsabilidad sobre lo que dice la hoja: un reporte que sacó
 * alguien que es director y contador lo firma como contador, porque es el
 * contador quien responde por las cifras. El orden no es jerarquía de la
 * empresa, es **quién responde por un reporte contable**.
 */
const PAPEL: ReadonlyArray<[RolCodigo, string]> = [
  ['CONTADOR', 'Contador'],
  ['DIRECTOR', 'Director'],
  ['ADMIN_TENANT', 'Administrador'],
  ['VENTAS', 'Ventas'],
  ['COMPRAS', 'Compras'],
  ['CAJA', 'Caja'],
  ['INVENTARIO', 'Inventario'],
  ['CONSULTA', 'Consulta'],
];

/**
 * De quién es la hoja: razón social, NIT y la ciudad de la sede principal.
 *
 * Es su propio servicio porque lo necesitan **todos** los reportes y ninguno es
 * su dueño. Tenerlo colgado del primero que lo escribió obligaría al segundo a
 * importar «el servicio de ventas» para poner un membrete, que es la clase de
 * dependencia que después nadie se atreve a desenredar.
 *
 * Sale de la base en cada reporte y no del token: el token dice quién sos y a
 * qué empresa entraste, no cómo se llama esa empresa **hoy**. Una razón social
 * corregida esta mañana tiene que salir corregida en la hoja de esta tarde.
 */
@Injectable()
export class MembreteService {
  constructor(private readonly tx: TxService) {}

  async de(ctx: CtxEmpresa): Promise<Membrete> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = filas<{
        razonSocial: string;
        nit: string;
        dv: string | null;
        ciudad: string | null;
      }>(
        await t.query<Array<Record<string, unknown>>>(
          `SELECT e.razon_social AS "razonSocial", e.nit, e.dv,
                  CONCAT_WS(', ', m.nombre, d.nombre) AS ciudad
             FROM empresa e
             LEFT JOIN empresa_sede s
               ON s.empresa_id = e.id AND s.es_principal AND s.activo
             LEFT JOIN municipio m ON m.codigo = s.municipio_codigo
             LEFT JOIN departamento d ON d.codigo = LEFT(m.codigo, 2)
            WHERE e.id = $1`,
          [ctx.empresaId],
        ),
      );

      // Una empresa siempre tiene razón social y NIT —son obligatorios al
      // crearla—; la ciudad no, porque la sede puede no estar configurada
      // todavía. Por eso las dos últimas son opcionales y el membrete se
      // dibuja igual sin ellas.
      return {
        razonSocial: fila?.razonSocial ?? '',
        nit: fila?.nit ?? '',
        ...(fila?.dv ? { dv: fila.dv } : {}),
        ...(fila?.ciudad ? { ciudad: fila.ciudad } : {}),
      };
    });
  }

  /**
   * Quién firma «Elaboró»: quien apretó el botón.
   *
   * El nombre sale de la base y no del token: el token trae el id, no el
   * nombre. Y va el de hoy —si alguien corrigió su nombre esta mañana, la hoja
   * de esta tarde lo trae corregido—.
   *
   * Vive acá, junto al membrete, porque las dos cosas son lo mismo visto desde
   * dos lados: **de quién es la hoja** y **quién la hizo**.
   */
  async firmante(ctx: CtxEmpresa): Promise<Firmante> {
    const nombre = await this.tx.enContexto(ctx, async (t) => {
      const [fila] = filas<{ nombre: string }>(
        await t.query<Array<Record<string, unknown>>>(
          `SELECT nombre_completo AS nombre FROM usuario WHERE id = $1`,
          [ctx.usuarioId],
        ),
      );
      return fila?.nombre ?? '';
    });
    const papel = PAPEL.find(([codigo]) => ctx.roles.includes(codigo));
    return { nombre, rol: papel?.[1] ?? '' };
  }
}
