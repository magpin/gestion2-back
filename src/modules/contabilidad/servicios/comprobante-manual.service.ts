import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import type { CrearAsientoDto } from '../dto/asiento.dto';
import type { PropuestaDto } from '../dto/comprobante-manual.dto';
import { AsientoService } from './asiento.service';
import {
  depreciacion,
  inventario,
  prima,
  reconocerClase,
  reconocerPlantilla,
  seguros,
  type Plantilla,
  type Propuesta,
} from './plantillas.reglas';

/** Un renglón de la propuesta, con la cuenta de la empresa ya resuelta. */
export interface RenglonResuelto {
  codigo: string;
  detalle: string;
  debito: number;
  credito: number;
  /** `null` si la empresa no tiene la cuenta, o la tiene inactiva: lo dice `problema`. */
  cuenta: { id: string; codigo: string; nombre: string } | null;
  problema: string | null;
}

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «2026-09-30» → «septiembre de 2026». */
export function periodoEnPalabras(fecha: string): string {
  const [anio, mes] = fecha.split('-').map(Number);
  return `${MESES[mes - 1]} de ${anio}`;
}

/**
 * El comprobante manual asistido (Fase 9, pantalla 52): las plantillas que
 * proponen el asiento y el soporte adjunto. Contabilizar sigue siendo
 * `AsientoService.crear`: esto no escribe asientos por su cuenta.
 */
@Injectable()
export class ComprobanteManualService {
  constructor(
    private readonly tx: TxService,
    private readonly asientos: AsientoService,
    private readonly almacenamiento: AlmacenamientoApi,
  ) {}

  /**
   * Lo que María propone. Con `texto`, primero reconoce la plantilla: si no
   * la reconoce, devuelve `plantilla: null` y la pantalla ofrece las cuatro.
   * Sin los datos que la plantilla necesita, devuelve solo cuáles faltan.
   */
  async propuesta(
    ctx: CtxEmpresa,
    dto: PropuestaDto,
    tx?: Tx,
  ): Promise<
    | { plantilla: null; mensaje: string }
    | {
        plantilla: Plantilla;
        faltan: string[];
        sugerido: { clase?: string };
        propuesta:
          | (Omit<Propuesta, 'renglones'> & { renglones: RenglonResuelto[] })
          | null;
      }
  > {
    const plantilla =
      dto.plantilla ?? (dto.texto ? reconocerPlantilla(dto.texto) : null);
    if (plantilla === null) {
      return {
        plantilla: null,
        mensaje:
          'No reconozco qué es. Elegí una plantilla, o armalo a mano en las líneas.',
      };
    }
    const d = dto.datos ?? {};
    const periodo = periodoEnPalabras(dto.fecha);
    const clase = d.clase ?? (dto.texto ? reconocerClase(dto.texto) : null);
    const sugerido = clase ? { clase } : {};

    let propuesta: Propuesta | null = null;
    const faltan: string[] = [];
    const exigir = (valor: unknown, nombre: string) => {
      if (valor === undefined || valor === null) faltan.push(nombre);
    };
    switch (plantilla) {
      case 'DEPRECIACION':
        exigir(clase, 'clase');
        exigir(d.costo, 'costo');
        exigir(d.meses, 'meses');
        if (faltan.length === 0)
          propuesta = depreciacion({
            clase: clase!,
            costo: d.costo!,
            meses: d.meses!,
            periodo,
          });
        break;
      case 'PRIMA':
        exigir(d.salarios, 'salarios');
        if (faltan.length === 0)
          propuesta = prima({ salarios: d.salarios!, periodo });
        break;
      case 'SEGUROS':
        exigir(d.ramo, 'ramo');
        exigir(d.valor, 'valor');
        exigir(d.meses, 'meses');
        if (faltan.length === 0)
          propuesta = seguros({
            ramo: d.ramo!,
            valor: d.valor!,
            meses: d.meses!,
            periodo,
          });
        break;
      case 'INVENTARIO':
        propuesta = inventario();
        break;
    }
    if (propuesta === null) {
      return { plantilla, faltan, sugerido, propuesta: null };
    }

    const renglones = await this.resolver(ctx, propuesta.renglones, tx);
    return {
      plantilla,
      faltan,
      sugerido,
      propuesta: { ...propuesta, renglones },
    };
  }

  /** Cada código a la cuenta de la empresa; si falta o está inactiva, se dice. */
  private async resolver(
    ctx: CtxEmpresa,
    renglones: Propuesta['renglones'],
    tx?: Tx,
  ): Promise<RenglonResuelto[]> {
    if (renglones.length === 0) return [];
    const cuentas = await this.tx.enContexto(
      ctx,
      async (t) =>
        filas<{ id: string; codigo: string; nombre: string; activa: boolean }>(
          await t.query(
            `SELECT id, codigo, nombre, activa FROM empresa_cuenta WHERE codigo = ANY($1)`,
            [renglones.map((r) => r.codigo)],
          ),
        ),
      tx,
    );
    const porCodigo = new Map(cuentas.map((c) => [c.codigo, c]));
    return renglones.map((r) => {
      const c = porCodigo.get(r.codigo);
      return {
        ...r,
        cuenta:
          c && c.activa
            ? { id: c.id, codigo: c.codigo, nombre: c.nombre }
            : null,
        problema:
          c === undefined
            ? `La cuenta ${r.codigo} no está en tu plan de cuentas. Agregala en Plan de cuentas.`
            : !c.activa
              ? `La cuenta ${r.codigo} está inactiva. Activala en Plan de cuentas.`
              : null,
      };
    });
  }

  /** Dónde subir el soporte. La llave la decide el servidor, con el prefijo de la empresa. */
  firmarSoporte(ctx: CtxEmpresa, tipoMime: string) {
    if (!this.almacenamiento.disponible) {
      throw new BadRequestException(
        'Subir archivos no está disponible en este ambiente.',
      );
    }
    return this.almacenamiento.firmarSubida(
      `asientos/${ctx.empresaId}`,
      tipoMime,
    );
  }

  /**
   * Contabilizar el comprobante manual, con su soporte si lo trae. Es el
   * mismo `AsientoService.crear` de siempre; el soporte se inserta en la misma
   * transacción, así que no queda un asiento con un soporte a medias.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: CrearAsientoDto,
    tx?: Tx,
  ): Promise<{ id: string; numero: string }> {
    const soporte = dto.soporte;
    if (soporte && !soporte.clave.startsWith(`asientos/${ctx.empresaId}/`)) {
      throw new BadRequestException('Ese soporte no es de esta empresa.');
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const asiento = await this.asientos.crear(ctx, dto, null, t);
        if (soporte) {
          await t.query(
            `INSERT INTO asiento_soporte (empresa_id, asiento_id, clave, nombre, creado_por)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              ctx.empresaId,
              asiento.id,
              soporte.clave,
              soporte.nombre.trim(),
              ctx.usuarioId,
            ],
          );
        }
        return asiento;
      },
      tx,
    );
  }

  /** Los soportes del asiento, con un enlace de lectura. */
  async soportes(
    ctx: CtxEmpresa,
    asientoId: string,
  ): Promise<Array<{ nombre: string; url: string | null }>> {
    const filasSoporte = await this.tx.enContexto(ctx, async (t) =>
      filas<{ clave: string; nombre: string }>(
        await t.query(
          `SELECT clave, nombre FROM asiento_soporte WHERE asiento_id = $1 ORDER BY creado_en`,
          [asientoId],
        ),
      ),
    );
    return Promise.all(
      filasSoporte.map(async (s) => ({
        nombre: s.nombre,
        url: this.almacenamiento.disponible
          ? await this.almacenamiento.firmarLectura(s.clave)
          : null,
      })),
    );
  }
}
