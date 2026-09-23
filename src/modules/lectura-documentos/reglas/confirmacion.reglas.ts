import type { TipoDocumentoFiscal, TipoRegimen } from '../../../common/ctx';
import type { DatoExtraido } from '../proveedores/extractor.puerto';

/**
 * De datos leídos a llamadas al asistente manual. Sin base de datos y sin red.
 *
 * Este archivo es la traducción, y es donde se ve por qué el módulo no escribe en
 * la base: lo que sale de acá son los DTO que ya reciben los endpoints
 * manuales —`EditarEmpresaDto`, `AbrirActividadDto`, `CrearResolucionDto`—. Si el
 * modo IA tuviera un camino propio habría dos verdades sobre cuándo un paso está
 * completo, y la que manda tiene que seguir siendo el backend.
 *
 * Dos cosas que no se negocian:
 *
 * 1. **Lo `DUDOSA` no se aplica solo.** Se pregunta: acá se convierte en un
 *    renglón de «esto quedó sin aplicar, y por esto». Si después la persona lo
 *    elige explícitamente —vio el valor y dijo «está bien»—, se aplica: ya no
 *    es una lectura dudosa, es un dato que ella confirmó.
 * 2. **Un grupo incompleto no se aplica a medias.** Un representante legal sin
 *    número de documento no es medio representante: es una pregunta.
 */

/** Los tipos de documento que la DIAN numera por resolución. */
const TIPOS_FISCALES: readonly TipoDocumentoFiscal[] = [
  'FACTURA_VENTA',
  'FACTURA_CONTINGENCIA',
  'NOTA_CREDITO',
  'NOTA_DEBITO',
  'DOCUMENTO_SOPORTE',
  'NOTA_AJUSTE_DOC_SOPORTE',
  'NOMINA_ELECTRONICA',
  'POS',
];

/**
 * El tipo de documento de la resolución, venga como código o como lo imprime la
 * DIAN. El modelo a veces devuelve el texto —«FACTURA ELECTRÓNICA DE VENTA»— y
 * eso dejaba la resolución entera sin aplicar, porque va completa o no va.
 */
export function tipoFiscalDe(
  valor: string | undefined,
): TipoDocumentoFiscal | undefined {
  if (valor === undefined) return undefined;
  const t = valor.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  if ((TIPOS_FISCALES as readonly string[]).includes(t))
    return t as TipoDocumentoFiscal;
  if (t.includes('CONTINGENCIA')) return 'FACTURA_CONTINGENCIA';
  if (t.includes('AJUSTE')) return 'NOTA_AJUSTE_DOC_SOPORTE';
  if (t.includes('NOTA') && t.includes('CREDITO')) return 'NOTA_CREDITO';
  if (t.includes('NOTA') && t.includes('DEBITO')) return 'NOTA_DEBITO';
  if (t.includes('SOPORTE')) return 'DOCUMENTO_SOPORTE';
  if (t.includes('NOMINA')) return 'NOMINA_ELECTRONICA';
  if (/\bPOS\b|TIQUETE/.test(t)) return 'POS';
  if (t.includes('FACTURA')) return 'FACTURA_VENTA';
  return undefined;
}

/**
 * El tipo de documento de identidad como lo espera el catálogo, venga como
 * venga. La Cámara imprime «C.C.» y el catálogo dice «CC»: por el punto se
 * rechazaba el representante entero.
 */
export function tipoIdentidadDe(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  const t = valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (t === '') return undefined;
  if (t === 'CC' || t.startsWith('CEDULADECIUDADANIA')) return 'CC';
  if (t === 'CE' || t.startsWith('CEDULADEEXTRANJERIA')) return 'CE';
  if (t === 'TI' || t.startsWith('TARJETADEIDENTIDAD')) return 'TI';
  if (t === 'PA' || t.startsWith('PASAPORTE')) return 'PA';
  if (t.startsWith('NIT')) return 'NIT';
  return t;
}

export type Accion =
  | {
      tipo: 'EDITAR_EMPRESA';
      campos: string[];
      dto: { razonSocial?: string; nombreComercial?: string };
    }
  | {
      tipo: 'SEDE_PRINCIPAL';
      campos: string[];
      dto: {
        direccion: string;
        municipioCodigo: string;
        telefono?: string;
        email?: string;
      };
    }
  | {
      tipo: 'ACTIVIDAD';
      campos: string[];
      dto: { codigoCiiu: string; esPrincipal: true; fechaInicio: string };
    }
  | {
      tipo: 'RESPONSABILIDADES_RUT';
      campos: string[];
      dto: { codigos: number[]; fechaInicio: string };
    }
  | {
      tipo: 'REPRESENTANTE';
      campos: string[];
      dto: {
        nombreCompleto: string;
        tipoDocumento: string;
        numeroDocumento: string;
        cargo?: string;
        fechaInicio: string;
      };
    }
  | {
      tipo: 'MATRICULA';
      campos: string[];
      dto: {
        numeroMatricula: string;
        camaraComercio: string;
        fechaMatricula: string;
        fechaUltimaRenovacion?: string;
        fechaInicio: string;
      };
    }
  | {
      tipo: 'RESOLUCION';
      campos: string[];
      dto: {
        tipoDocumento: TipoDocumentoFiscal;
        numeroResolucion: string;
        prefijo?: string;
        rangoDesde: number;
        rangoHasta: number;
        fechaResolucion: string;
        fechaVigenciaDesde: string;
        fechaVigenciaHasta: string;
        ambiente: 'PRODUCCION';
      };
    };

/** Un dato que no se aplicó, con la razón en palabras que sirvan a la persona. */
export interface SinAplicar {
  campo: string;
  etiqueta: string;
  motivo: string;
}

const DUDOSO = 'La lectura no fue segura: hay que confirmarlo.';

/**
 * Qué se va a llamar y qué queda pendiente.
 *
 * `seleccion` son los campos que la persona aprobó; sin ella se toma todo lo
 * aplicable. Un campo pedido que no se pueda aplicar vuelve en `sinAplicar` con
 * el motivo: la pantalla lo muestra como pregunta, no como error.
 */
export function planear(
  datos: DatoExtraido[],
  opciones: { hoy: string; seleccion?: string[] },
): { acciones: Accion[]; sinAplicar: SinAplicar[] } {
  const { hoy, seleccion } = opciones;
  const sinAplicar: SinAplicar[] = [];
  const valores = new Map<string, DatoExtraido>();

  for (const dato of datos) {
    if (seleccion !== undefined && !seleccion.includes(dato.campo)) continue;

    // Lo dudoso no se aplica solo. Pero si la persona lo eligió explícitamente
    // —vio el valor y dijo «está bien»—, ya no es dudoso: lo confirmó ella.
    if (dato.confianza !== 'ALTA' && seleccion === undefined) {
      sinAplicar.push(renglon(dato, DUDOSO));
      continue;
    }
    valores.set(dato.campo, dato);
  }

  // Un campo aprobado que no está entre lo leído: la pantalla lo pidió por algo,
  // así que se dice, no se ignora.
  for (const campo of seleccion ?? []) {
    if (!valores.has(campo) && !sinAplicar.some((s) => s.campo === campo)) {
      sinAplicar.push({
        campo,
        etiqueta: campo,
        motivo: 'No salió de este documento.',
      });
    }
  }

  const acciones: Accion[] = [];
  const tomar = (campo: string) => valores.get(campo);

  // ── Paso 1: la empresa ────────────────────────────────────────────────────
  const razonSocial = texto(tomar('razonSocial'));
  const nombreComercial = texto(tomar('nombreComercial'));
  if (razonSocial !== undefined || nombreComercial !== undefined) {
    acciones.push({
      tipo: 'EDITAR_EMPRESA',
      campos: presentes(valores, ['razonSocial', 'nombreComercial']),
      dto: {
        ...(razonSocial !== undefined && { razonSocial }),
        ...(nombreComercial !== undefined && { nombreComercial }),
      },
    });
  }

  // ── Paso 2: la sede principal ─────────────────────────────────────────────
  // Sin dirección y municipio no hay sede que registrar: el resto son datos de
  // contacto de una sede que no existe.
  const direccion = texto(tomar('direccion'));
  const municipio = codigoDe(tomar('municipioCodigo'), 5);
  const camposSede = presentes(valores, [
    'direccion',
    'municipioCodigo',
    'telefono',
    'email',
  ]);
  if (direccion !== undefined && municipio !== undefined) {
    acciones.push({
      tipo: 'SEDE_PRINCIPAL',
      campos: camposSede,
      dto: {
        direccion,
        municipioCodigo: municipio,
        ...(texto(tomar('telefono')) !== undefined && {
          telefono: texto(tomar('telefono')),
        }),
        ...(texto(tomar('email')) !== undefined && {
          email: texto(tomar('email')),
        }),
      },
    });
  }
  // Una dirección sin municipio —la Cámara la trae así— no se reporta como
  // pendiente: la sede sale del RUT, y si falta, el paso de sedes lo pregunta.
  // Decir «falta» sobre algo que ya quedó guardado era lo que confundía.

  // ── Paso 3: la situación legal ────────────────────────────────────────────
  const ciiu = codigoDe(tomar('codigoCiiu'), 4);
  if (ciiu !== undefined) {
    acciones.push({
      tipo: 'ACTIVIDAD',
      campos: ['codigoCiiu'],
      dto: { codigoCiiu: ciiu, esPrincipal: true, fechaInicio: hoy },
    });
  } else if (valores.has('codigoCiiu')) {
    sinAplicar.push(
      renglon(
        valores.get('codigoCiiu')!,
        'El código CIIU no tiene cuatro dígitos.',
      ),
    );
  }

  const responsabilidades = tomar('responsabilidadesRut');
  if (responsabilidades !== undefined) {
    const codigos = codigosNumericos(responsabilidades.valor);
    if (codigos.length > 0) {
      acciones.push({
        tipo: 'RESPONSABILIDADES_RUT',
        campos: ['responsabilidadesRut'],
        dto: { codigos, fechaInicio: hoy },
      });
    } else {
      sinAplicar.push(
        renglon(
          responsabilidades,
          'Los códigos de la casilla 53 no se entienden.',
        ),
      );
    }
  }

  // El régimen no se planea acá: lo abre `abrirResponsabilidadRut` al aplicar
  // los códigos de la casilla 53, derivándolo de cada uno. Ver el comentario de
  // `tipoRegimen` en `documento.reglas.ts`.

  const camposRepresentante = presentes(valores, [
    'representanteNombre',
    'representanteTipoDocumento',
    'representanteNumeroDocumento',
    'representanteCargo',
  ]);
  const nombreRep = texto(tomar('representanteNombre'));
  const tipoDocRep = tipoIdentidadDe(
    texto(tomar('representanteTipoDocumento')),
  );
  const numeroDocRep = texto(tomar('representanteNumeroDocumento'));
  if (
    nombreRep !== undefined &&
    tipoDocRep !== undefined &&
    numeroDocRep !== undefined
  ) {
    acciones.push({
      tipo: 'REPRESENTANTE',
      campos: camposRepresentante,
      dto: {
        nombreCompleto: nombreRep,
        tipoDocumento: tipoDocRep,
        numeroDocumento: numeroDocRep,
        ...(texto(tomar('representanteCargo')) !== undefined && {
          cargo: texto(tomar('representanteCargo')),
        }),
        fechaInicio: hoy,
      },
    });
  } else {
    faltoElGrupo(
      valores,
      camposRepresentante,
      sinAplicar,
      'Falta el nombre o el documento del representante legal.',
    );
  }

  const camposMatricula = presentes(valores, [
    'numeroMatricula',
    'camaraComercio',
    'fechaMatricula',
    'fechaUltimaRenovacion',
  ]);
  const numeroMatricula = texto(tomar('numeroMatricula'));
  const camaraComercio = texto(tomar('camaraComercio'));
  const fechaMatricula = fecha(tomar('fechaMatricula'));
  if (
    numeroMatricula !== undefined &&
    camaraComercio !== undefined &&
    fechaMatricula !== undefined
  ) {
    acciones.push({
      tipo: 'MATRICULA',
      campos: camposMatricula,
      dto: {
        numeroMatricula,
        camaraComercio,
        fechaMatricula,
        ...(fecha(tomar('fechaUltimaRenovacion')) !== undefined && {
          fechaUltimaRenovacion: fecha(tomar('fechaUltimaRenovacion')),
        }),
        fechaInicio: hoy,
      },
    });
  } else {
    faltoElGrupo(
      valores,
      camposMatricula,
      sinAplicar,
      'Falta el número, la cámara o la fecha de la matrícula.',
    );
  }

  // ── Paso 5: la resolución ─────────────────────────────────────────────────
  // Va entera o no va: una resolución a medias no numera nada, y el rango es lo
  // que después decide si se puede facturar.
  const camposResolucion = presentes(valores, [
    'tipoDocumento',
    'numeroResolucion',
    'prefijo',
    'rangoDesde',
    'rangoHasta',
    'fechaResolucion',
    'fechaVigenciaDesde',
    'fechaVigenciaHasta',
  ]);
  const tipoFiscal = tipoFiscalDe(texto(tomar('tipoDocumento')));
  const numeroResolucion = texto(tomar('numeroResolucion'));
  const rangoDesde = entero(tomar('rangoDesde'));
  const rangoHasta = entero(tomar('rangoHasta'));
  const fechaResolucion = fecha(tomar('fechaResolucion'));
  const desde = fecha(tomar('fechaVigenciaDesde'));
  const hasta = fecha(tomar('fechaVigenciaHasta'));
  if (
    tipoFiscal !== undefined &&
    (TIPOS_FISCALES as string[]).includes(tipoFiscal) &&
    numeroResolucion !== undefined &&
    rangoDesde !== undefined &&
    rangoHasta !== undefined &&
    fechaResolucion !== undefined &&
    desde !== undefined &&
    hasta !== undefined
  ) {
    acciones.push({
      tipo: 'RESOLUCION',
      campos: camposResolucion,
      dto: {
        tipoDocumento: tipoFiscal,
        numeroResolucion,
        ...(texto(tomar('prefijo')) !== undefined && {
          prefijo: texto(tomar('prefijo')),
        }),
        rangoDesde,
        rangoHasta,
        fechaResolucion,
        fechaVigenciaDesde: desde,
        fechaVigenciaHasta: hasta,
        // Una resolución que la DIAN emitió es de producción. La de habilitación
        // se registra a mano, cuando se está probando la facturación.
        ambiente: 'PRODUCCION',
      },
    });
  } else {
    faltoElGrupo(
      valores,
      camposResolucion,
      sinAplicar,
      'La resolución quedó incompleta: va con número, rango y vigencia, o no va.',
    );
  }

  return { acciones, sinAplicar };
}

/** Los campos de esa lista que de verdad llegaron, en el orden de la lista. */
function presentes(
  valores: Map<string, DatoExtraido>,
  campos: string[],
): string[] {
  return campos.filter((campo) => valores.has(campo));
}

/** Un grupo que no se puede armar deja a todos sus campos sin aplicar. */
function faltoElGrupo(
  valores: Map<string, DatoExtraido>,
  campos: string[],
  sinAplicar: SinAplicar[],
  motivo: string,
): void {
  for (const campo of campos) {
    const dato = valores.get(campo);
    if (dato !== undefined) sinAplicar.push(renglon(dato, motivo));
  }
}

function renglon(dato: DatoExtraido, motivo: string): SinAplicar {
  return { campo: dato.campo, etiqueta: dato.etiqueta, motivo };
}

function texto(dato: DatoExtraido | undefined): string | undefined {
  if (dato === undefined) return undefined;
  if (typeof dato.valor === 'string') {
    const limpio = dato.valor.trim();
    return limpio === '' ? undefined : limpio;
  }
  if (typeof dato.valor === 'number') return String(dato.valor);
  return undefined;
}

/** Un código de largo fijo, sin puntos ni espacios: CIIU, municipio DANE. */
function codigoDe(
  dato: DatoExtraido | undefined,
  digitos: number,
): string | undefined {
  const crudo = texto(dato);
  if (crudo === undefined) return undefined;
  const limpio = crudo.replace(/[^0-9]/g, '');
  return limpio.length === digitos ? limpio : undefined;
}

function entero(dato: DatoExtraido | undefined): number | undefined {
  const crudo = texto(dato);
  if (crudo === undefined) return undefined;
  const limpio = crudo.replace(/[^0-9]/g, '');
  if (limpio === '') return undefined;
  const numero = Number(limpio);
  return Number.isSafeInteger(numero) ? numero : undefined;
}

function fecha(dato: DatoExtraido | undefined): string | undefined {
  const crudo = texto(dato);
  return crudo !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(crudo)
    ? crudo
    : undefined;
}

/** Los códigos de la casilla 53: vienen como lista, o como uno solo. */
function codigosNumericos(valor: unknown): number[] {
  const lista = Array.isArray(valor) ? valor : [valor];
  const codigos: number[] = [];
  for (const item of lista) {
    const crudo =
      typeof item === 'number'
        ? String(item)
        : typeof item === 'string'
          ? item.replace(/[^0-9]/g, '')
          : '';
    if (crudo === '') continue;
    const numero = Number(crudo);
    if (Number.isSafeInteger(numero) && numero > 0) codigos.push(numero);
  }
  return [...new Set(codigos)];
}
