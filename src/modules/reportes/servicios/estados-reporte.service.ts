import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { EstadosFinancierosService } from '../../estados-financieros/estados-financieros.service';
import {
  filasBalance,
  filasFlujo,
  filasResultados,
  hojaEstado,
  libroEstado,
  TITULO_ESTADO,
  type FilaEstado,
  type TipoEstado,
} from '../reportes/estados';
import { ExcelService } from './excel.service';
import { GotenbergService } from './gotenberg.service';
import { MembreteService } from './membrete.service';
import { PlantillaService } from './plantilla.service';

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

/** «septiembre de 2026». */
function nombreMes(mes: string): string {
  const [anio, n] = mes.split('-').map(Number);
  return `${MESES[n - 1]} de ${anio}`;
}

/** «sep 2026», para la cabecera de una columna. */
function columnaMes(mes: string): string {
  const [anio, n] = mes.split('-').map(Number);
  return `${MESES[n - 1].slice(0, 3)} ${anio}`;
}

interface Armado {
  filas: FilaEstado[];
  parametros: string[];
  columnas: { actual: string; comparado?: string };
  notas: string[];
}

/**
 * Los estados financieros en PDF y en Excel. Las cifras las calcula
 * `EstadosFinancierosService` —las mismas que ve la pantalla—; acá solo se
 * vuelven filas y hoja.
 */
@Injectable()
export class EstadosReporteService {
  constructor(
    private readonly estados: EstadosFinancierosService,
    private readonly plantillas: PlantillaService,
    private readonly gotenberg: GotenbergService,
    private readonly membretes: MembreteService,
    private readonly excel: ExcelService,
  ) {}

  private async armar(
    ctx: CtxEmpresa,
    tipo: TipoEstado,
    mes: string,
    comparar?: string,
  ): Promise<Armado> {
    if (tipo === 'RESULTADOS') {
      const r = await this.estados.resultados(ctx, mes, comparar);
      return {
        filas: filasResultados(r.actual, r.comparado?.estado),
        parametros: [
          `del ${r.periodo.desde} al ${r.periodo.hasta}`,
          ...(r.comparado
            ? [`comparado con ${nombreMes(r.comparado.periodo.mes)}`]
            : []),
        ],
        columnas: {
          actual: columnaMes(mes),
          ...(r.comparado && {
            comparado: columnaMes(r.comparado.periodo.mes),
          }),
        },
        notas: notasPeriodo(r.periodo.estado),
      };
    }
    if (tipo === 'BALANCE') {
      const b = await this.estados.balance(ctx, mes, comparar);
      return {
        filas: filasBalance(b.actual, b.comparado?.balance),
        parametros: [
          `corte al ${b.periodo.corte}`,
          ...(b.comparado
            ? [`comparado con el ${b.comparado.periodo.corte}`]
            : []),
        ],
        columnas: {
          actual: b.periodo.corte,
          ...(b.comparado && { comparado: b.comparado.periodo.corte }),
        },
        notas: [
          ...notasPeriodo(b.periodo.estado),
          ...(b.actual.diferencia !== 0
            ? [
                `El libro no cuadra: el activo difiere del pasivo más el patrimonio en ${b.actual.diferencia.toLocaleString('es-CO')}. Revise el balance de prueba.`,
              ]
            : []),
          'Mientras no haya asiento de cierre, lo ganado o perdido figura en el patrimonio como resultado sin cerrar.',
        ],
      };
    }
    const f = await this.estados.flujo(ctx, mes);
    return {
      filas: filasFlujo(f.directo),
      parametros: [
        `del ${f.periodo.desde} al ${f.periodo.hasta}`,
        'método directo',
      ],
      columnas: { actual: columnaMes(mes) },
      notas: [
        ...notasPeriodo(f.periodo.estado),
        'Cada movimiento de caja y bancos va a la actividad de su concepto; sin concepto, a la de su cuenta contraria. Los traslados entre caja y bancos no cambian el disponible y no aparecen.',
        ...(f.directo.diferencia !== 0
          ? [
              `Hay ${f.directo.diferencia.toLocaleString('es-CO')} que el flujo no explica: revise los asientos de las cuentas 11.`,
            ]
          : []),
      ],
    };
  }

  async pdf(
    ctx: CtxEmpresa,
    tipo: TipoEstado,
    mes: string,
    comparar: string | undefined,
    quien: { nombre: string; rol: string },
  ): Promise<Buffer> {
    const [a, empresa] = await Promise.all([
      this.armar(ctx, tipo, mes, comparar),
      this.membretes.de(ctx),
    ]);
    const cuerpo = this.plantillas.cuerpo('estados-financieros', {
      ...hojaEstado(a.filas, a.columnas),
      notas: a.notas,
    });
    const { html, assets } = this.plantillas.armar({
      titulo: TITULO_ESTADO[tipo],
      parametros: a.parametros,
      empresa,
      elaboro: quien.nombre,
      cuerpo,
      orientacion: 'VERTICAL',
      // Un estado financiero se entrega firmado: representante y contador.
      conFirmas: true,
      destino: 'PDF',
    });
    return this.gotenberg.aPdf(html, assets);
  }

  async xlsx(
    ctx: CtxEmpresa,
    tipo: TipoEstado,
    mes: string,
    comparar?: string,
  ): Promise<Buffer> {
    const [a, empresa] = await Promise.all([
      this.armar(ctx, tipo, mes, comparar),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(
      libroEstado(tipo, a.filas, a.parametros, a.columnas, a.notas),
      empresa,
    );
  }
}

function notasPeriodo(estado: 'ABIERTO' | 'CERRADO' | 'SIN_PERIODO'): string[] {
  return estado === 'CERRADO'
    ? []
    : [
        'El período está abierto: las cifras pueden cambiar mientras se registre.',
      ];
}
