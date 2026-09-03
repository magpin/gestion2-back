import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Sin 'MIXTO': decia "tengo varios" sin decir cuales, y por eso no servia para
 * filtrar nada. Ahora se marcan los que sean.
 */
const SECTORES = ['COMERCIO', 'SERVICIOS', 'MANUFACTURA'] as const;
const GRUPOS_NIIF = ['GRUPO_1', 'GRUPO_2', 'GRUPO_3'] as const;
const METODOS_VALORACION = ['PROMEDIO_PONDERADO', 'PEPS'] as const;

export class CrearEmpresaDto {
  @IsIn(['JURIDICA', 'NATURAL'])
  tipoPersona!: 'JURIDICA' | 'NATURAL';

  @IsString()
  @Length(3, 200)
  razonSocial!: string;

  @IsOptional()
  @IsString()
  nombreComercial?: string;

  @Matches(/^[0-9]{5,15}$/, {
    message: 'El NIT debe tener entre 5 y 15 digitos, sin puntos ni guiones',
  })
  nit!: string;

  /** Se verifica contra `fn_dv_nit` en la base: un DV que no cuadra no entra. */
  @Matches(/^[0-9]$/)
  dv!: string;

  /**
   * A que se dedica, en grueso. Puede ser mas de uno: una empresa que comercia y
   * ademas fabrica marca los dos. Opcional porque al dar de alta todavia no hay
   * actividad CIIU declarada y forzar una respuesta aca solo produce adivinanzas.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SECTORES, { each: true })
  sectores?: Array<(typeof SECTORES)[number]>;

  /** RUT casilla 63. Solo personas juridicas; la S.A.S. es el codigo 12. */
  @IsOptional()
  @Matches(/^[0-9]{2}$/, { message: 'La forma asociativa son dos digitos' })
  formaAsociativaCodigo?: string;

  // Configuracion contable: va junto porque una empresa sin ella no puede recibir
  // ni un asiento.
  @IsIn(GRUPOS_NIIF)
  grupoNiif!: (typeof GRUPOS_NIIF)[number];

  @IsOptional()
  @IsString()
  @Length(3, 3)
  monedaFuncional?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  mesCierreFiscal?: number;

  @IsOptional()
  @IsIn(METODOS_VALORACION)
  metodoValoracionInventario?: (typeof METODOS_VALORACION)[number];

  @IsDateString()
  fechaInicioOperaciones!: string;
}

export class EditarEmpresaDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  razonSocial?: string;

  @IsOptional()
  @IsString()
  nombreComercial?: string;

  /** Reemplaza la lista completa: lo que no venga, se quita. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SECTORES, { each: true })
  sectores?: Array<(typeof SECTORES)[number]>;
}

export class CrearSedeDto {
  @IsString()
  @Length(1, 20)
  codigo!: string;

  @IsString()
  @Length(2, 120)
  nombre!: string;

  @IsString()
  @Length(3, 200)
  direccion!: string;

  @Matches(/^[0-9]{5}$/, { message: 'Codigo DANE de municipio: 5 digitos' })
  municipioCodigo!: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;
}

export class EditarSedeDto {
  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsString()
  direccion?: string;

  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;
}
