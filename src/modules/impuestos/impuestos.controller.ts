import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../common/auth/decoradores';
import type { CtxEmpresa } from '../../common/ctx';
import { hoyEnColombia } from '../../common/fecha';
import type { Obligacion, PeriodicidadIva } from './impuestos.reglas';
import { ImpuestosService, type ZomacTamano } from './impuestos.service';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO = /^\d{4}(-(0[1-9]|1[0-2]|B[1-6]|C[1-3]|T[1-4]))?$/;
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const OBLIGACIONES: Obligacion[] = [
  'RETENCION',
  'IVA',
  'RETEICA',
  'ICA',
  'RENTA',
];

export class AnioDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  anio?: number;
}

export class MesDto {
  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes?: string;
}

export class PeriodoDto {
  @IsOptional()
  @Matches(PERIODO, { message: 'El período va como 2026-C3 o 2026-B5.' })
  periodo?: string;
}

export class IcaDto extends PeriodoDto {
  @IsOptional()
  @Matches(/^\d{5}$/, { message: 'El municipio va con su código DANE.' })
  municipio?: string;
}

export class AvisosDto {
  @Matches(/^\d{5}$/, { message: 'El municipio va con su código DANE.' })
  municipioCodigo!: string;

  @IsBoolean()
  avisosTableros!: boolean;
}

export class ConfiguracionDto {
  @IsOptional()
  @IsIn(['BIMESTRAL', 'CUATRIMESTRAL', null])
  periodicidadIva!: PeriodicidadIva | null;
}

class PresentacionBase {
  @IsString()
  @MinLength(1, { message: 'Escribí el número del formulario.' })
  @MaxLength(40)
  numeroFormulario!: string;

  @Matches(FECHA, { message: 'La fecha va como 2026-10-14.' })
  presentadaEl!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  valorAPagar!: number;

  @IsOptional()
  @Matches(FECHA, { message: 'La fecha va como 2026-10-21.' })
  vence?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  archivoClave?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  archivoNombre?: string | null;

  /** Renta: el impuesto neto del 110. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  impuestoNeto?: number | null;

  /** Renta: el anticipo que se liquidó para el año siguiente. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  anticipoSiguiente?: number | null;
}

export class ZomacDto {
  @IsOptional()
  @IsIn(['MICRO', 'PEQUENA', 'MEDIANA', 'GRANDE', null])
  zomacTamano!: ZomacTamano | null;
}

export class PresentarDto extends PresentacionBase {
  @IsIn(OBLIGACIONES)
  obligacion!: Obligacion;

  @Matches(PERIODO, {
    message: 'El período va como 2026-09, 2026-B5, 2026-C3 o 2026.',
  })
  periodo!: string;

  @IsOptional()
  @Matches(/^\d{5}$/)
  municipioCodigo?: string | null;
}

export class CorregirDto extends PresentacionBase {}

export class FirmarArchivoDto {
  @IsString()
  tipoMime!: string;
}

export class PrevioDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  intereses?: number;
}

export class PagarDto {
  @IsIn(['CAJA', 'BANCO'])
  medio!: 'CAJA' | 'BANCO';

  @IsOptional()
  @IsUUID()
  cajaId?: string | null;

  @IsOptional()
  @IsUUID()
  cuentaBancariaId?: string | null;

  @Matches(FECHA, { message: 'La fecha va como 2026-10-14.' })
  fecha!: string;

  @IsString()
  @MinLength(1, { message: 'Escribí el número del recibo 490.' })
  @MaxLength(40)
  recibo490!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  intereses!: number;
}

/** Quien ve la plata de la empresa entera, como los estados financieros. */
const LEEN = ['DIRECTOR', 'CONTADOR', 'CONSULTA'] as const;
/** Quien registra la presentación: el que la hizo en MUISCA. */
const PRESENTAN = ['DIRECTOR', 'CONTADOR'] as const;
/** Quien paga: los mismos que pagan una compra, más el contador. */
const PAGAN = ['DIRECTOR', 'CONTADOR', 'CAJA'] as const;

@Controller('impuestos')
@ExigeEmpresa()
export class ImpuestosController {
  constructor(private readonly impuestos: ImpuestosService) {}

  @Roles(...LEEN)
  @Get('configuracion')
  configuracion(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.configuracion(ctx);
  }

  @Roles(...PRESENTAN)
  @Put('configuracion')
  guardarConfiguracion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: ConfiguracionDto,
  ) {
    return this.impuestos.guardarConfiguracion(ctx, {
      periodicidadIva: dto.periodicidadIva ?? null,
    });
  }

  @Roles(...LEEN)
  @Get('calendario')
  calendario(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: AnioDto) {
    return this.impuestos.calendario(
      ctx,
      q.anio ?? Number(hoyEnColombia().slice(0, 4)),
    );
  }

  /** El 350 del mes. Sin mes, el anterior: el que toca presentar. */
  @Roles(...LEEN)
  @Get('retencion')
  retencion(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: MesDto) {
    return this.impuestos.retencion(ctx, q.mes ?? mesAnterior());
  }

  /** El IVA de un período («2026-C3», «2026-B5»). Sin período, el que va corriendo. */
  @Roles(...LEEN)
  @Get('iva')
  iva(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: PeriodoDto) {
    return this.impuestos.iva(ctx, q.periodo);
  }

  /**
   * ICA y ReteICA: el ReteICA de un municipio y un período (sin ellos, el
   * primero y el que va corriendo), y el ICA propio de cada municipio.
   */
  @Roles(...LEEN)
  @Get('ica')
  ica(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: IcaDto) {
    return this.impuestos.ica(ctx, q.municipio, q.periodo);
  }

  @Roles(...PRESENTAN)
  @Put('ica/avisos')
  async guardarAvisos(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AvisosDto) {
    await this.impuestos.guardarAvisos(
      ctx,
      dto.municipioCodigo,
      dto.avisosTableros,
    );
    return { ok: true };
  }

  /** Renta: el estimado del año y la declaración del anterior con sus cuotas. */
  @Roles(...LEEN)
  @Get('renta')
  renta(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.renta(ctx);
  }

  @Roles(...PRESENTAN)
  @Put('renta/zomac')
  guardarZomac(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: ZomacDto) {
    return this.impuestos.guardarZomac(ctx, dto.zomacTamano ?? null);
  }

  /** Lo que Inicio avisa de impuestos: la más urgente, o la recién pagada. */
  @Roles(...LEEN, 'CAJA')
  @Get('aviso')
  aviso(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.aviso(ctx);
  }

  @Roles(...LEEN, 'CAJA')
  @Get('por-pagar')
  porPagar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.porPagar(ctx);
  }

  @Roles(...PRESENTAN)
  @Post('declaraciones')
  presentar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: PresentarDto) {
    return this.impuestos.presentar(ctx, dto);
  }

  @Roles(...PRESENTAN)
  @Put('declaraciones/:id')
  corregir(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorregirDto,
  ) {
    return this.impuestos.corregir(ctx, id, dto);
  }

  @Roles(...PRESENTAN)
  @Post('declaraciones/archivo')
  firmarArchivo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FirmarArchivoDto,
  ) {
    return this.impuestos.firmarArchivo(ctx, dto.tipoMime);
  }

  @Roles(...LEEN, 'CAJA')
  @Get('declaraciones/:id/archivo')
  archivo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.impuestos.archivo(ctx, id);
  }

  @Roles(...PAGAN)
  @Get('declaraciones/:id/pago-previo')
  pagoPrevio(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PrevioDto,
  ) {
    return this.impuestos.pagoPrevio(ctx, id, q.intereses ?? 0);
  }

  @Roles(...PAGAN)
  @Post('declaraciones/:id/pagar')
  pagar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PagarDto,
  ) {
    return this.impuestos.pagar(ctx, id, dto);
  }
}

function mesAnterior(): string {
  const hoy = hoyEnColombia();
  const [a, m] = hoy.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}
