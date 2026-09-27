/**
 * Las reglas que deciden si una empresa está lista para operar.
 *
 * Están separadas del acceso a datos a propósito: son la parte que hay que poder
 * probar exhaustivamente sin levantar una base. El servicio recoge los hechos, y
 * este archivo decide qué significan.
 *
 * El orden de los pasos no es estético. Refleja dependencias reales del negocio:
 * el plan de cuentas se deriva de la situación legal y de los impuestos, y no se
 * puede emitir sin una resolución de la DIAN.
 *
 * Acá solo está lo que hay que resolver ANTES de poder operar. Invitar usuarios y
 * cargar clientes son trabajo del día a día: se hacen desde su propia pantalla,
 * cuantas veces haga falta, y no tienen por qué mirarse como un paso que queda
 * pendiente para siempre.
 */

import { SECCIONES_POR_SECTOR } from './secciones-ciiu';

export type ClavePaso =
  | 'EMPRESA'
  | 'SEDES'
  | 'SITUACION_LEGAL'
  | 'IMPUESTOS'
  | 'PLAN_CUENTAS'
  | 'RESOLUCIONES';

/**
 * `PENDIENTE` y `FALTA` no son lo mismo, y la diferencia le importa a quien
 * configura: `PENDIENTE` es que nunca lo tocó, `FALTA` es que lo empezó y le
 * quedaron datos por llenar. El segundo caso se atiende primero.
 */
export type EstadoPaso = 'LISTO' | 'FALTA' | 'PENDIENTE' | 'BLOQUEADO';

/** Un dato concreto que falta, con el nombre del campo para que la UI lo enfoque. */
export interface Faltante {
  campo: string;
  etiqueta: string;
  /** Una línea de contexto, cuando la etiqueta sola no alcanza para actuar. */
  detalle?: string;
}

export interface Paso {
  clave: ClavePaso;
  nombre: string;
  orden: number;
  /** Si es obligatorio, la empresa no está lista para operar sin él. */
  obligatorio: boolean;
  estado: EstadoPaso;
  /** Una línea para el resumen lateral. Nunca una explicación. */
  resumen: string;
  /** Lo que impide dar el paso por terminado. */
  faltantes: Faltante[];
  /** Lo que conviene pero no bloquea. */
  opcionales: Faltante[];
  /** Qué paso hay que resolver antes de poder entrar a este. */
  bloqueadoPor?: ClavePaso;
}

export interface EstadoConfiguracion {
  pasos: Paso[];
  completados: number;
  totalObligatorios: number;
  porcentaje: number;
  /** Todos los pasos obligatorios listos: la empresa puede operar. */
  completa: boolean;
  /** El paso al que hay que llevar al usuario. Null si no queda nada. */
  siguiente: ClavePaso | null;
  /**
   * Con qué modo se está configurando. Quien eligió IA se queda en IA hasta
   * terminar: los pasos manuales lo sacaban del modo.
   */
  modo: 'IA' | 'MANUAL' | null;
  /**
   * Si ya se mostró la bienvenida de María al terminar (0072). Una vez por
   * empresa: quien entre después va directo al tablero.
   */
  bienvenidaVista: boolean;
}

/** Lo que el servicio lee de la base. Sin interpretar. */
export interface HechosConfiguracion {
  empresa: {
    razonSocial: string;
    tipoPersona: 'JURIDICA' | 'NATURAL';
    /** Con qué modo se eligió configurarla (0068). `null`: no se eligió. */
    modoConfiguracion?: 'IA' | 'MANUAL' | null;
    /** Cuándo se mostró la bienvenida (0072). `null`: todavía no. */
    bienvenidaVistaEn?: Date | string | null;
    /** Puede estar vacio: al dar de alta no se exige marcar ninguno. */
    sectores: string[];
    /** Secciones CIIU de las actividades vigentes. Respaldan a los sectores. */
    seccionesActividades: string[];
  };
  configuracionContable: { grupoNiif: string; monedaFuncional: string } | null;
  sedes: {
    activas: number;
    tienePrincipal: boolean;
    municipioPrincipal: string | null;
  };
  regimenesVigentes: string[];
  representanteVigente: string | null;
  actividadPrincipal: {
    codigoCiiu: string;
    tarifaIcaPorMil: number | null;
  } | null;
  matriculaVigente: boolean;
  /** El paso «Impuestos» (0077). */
  impuestos: {
    /** Alguien miró el resumen y dijo «Todo correcto». */
    confirmado: boolean;
    /** Municipios con sede activa sin respuesta de ICA. */
    municipiosSinIca: string[];
  };
  resolucionFacturaVenta: {
    numeroResolucion: string;
    vigente: boolean;
    agotada: boolean;
    numerosRestantes: number;
  } | null;
  credencialesDianCargadas: boolean;
  /** Cuentas activas del plan de la empresa, y cuántas reciben asientos. */
  plan: { cuentasActivas: number; auxiliares: number };
}

const f = (campo: string, etiqueta: string): Faltante => ({ campo, etiqueta });

const NOMBRE_SECTOR: Record<string, string> = {
  COMERCIO: 'Comercio',
  SERVICIOS: 'Servicios',
  MANUFACTURA: 'Manufactura',
};

/** `LISTO` si no falta nada; `PENDIENTE` si no se empezó; `FALTA` si quedó a medias. */
function resolver(faltantes: Faltante[], seEmpezo: boolean): EstadoPaso {
  if (faltantes.length === 0) return 'LISTO';
  return seEmpezo ? 'FALTA' : 'PENDIENTE';
}

// ---------------------------------------------------------------------------
// Un evaluador por paso
// ---------------------------------------------------------------------------

function evaluarEmpresa(h: HechosConfiguracion): Paso {
  // La configuración contable nace junto con la empresa, en la misma transacción.
  // Si falta, la empresa quedó a medio crear y el módulo de contabilidad no podrá
  // asentar nada: necesita el grupo NIIF antes de permitir un solo movimiento.
  const faltantes =
    h.configuracionContable === null
      ? [f('grupoNiif', 'Configuración contable')]
      : [];

  return {
    clave: 'EMPRESA',
    nombre: 'Empresa',
    orden: 1,
    obligatorio: true,
    estado: resolver(faltantes, true),
    resumen:
      h.configuracionContable === null
        ? h.empresa.razonSocial
        : [
            h.empresa.sectores.length > 0
              ? h.empresa.sectores.join(' · ')
              : null,
            h.configuracionContable.grupoNiif.replace('_', ' '),
            h.configuracionContable.monedaFuncional,
          ]
            .filter((x) => x !== null)
            .join(' · '),
    faltantes,
    opcionales: [],
  };
}

function evaluarSedes(h: HechosConfiguracion): Paso {
  const faltantes: Faltante[] = [];

  if (h.sedes.activas === 0) {
    faltantes.push(f('sede', 'Al menos una sede'));
  } else if (!h.sedes.tienePrincipal) {
    // El municipio de la sede principal define la tarifa de ICA y viaja en la
    // factura electrónica. Sin una marcada, no hay de dónde sacarlo.
    faltantes.push(f('esPrincipal', 'Marcar una sede como principal'));
  }

  return {
    clave: 'SEDES',
    nombre: 'Sedes',
    orden: 2,
    obligatorio: true,
    estado: resolver(faltantes, h.sedes.activas > 0),
    resumen:
      h.sedes.activas === 0
        ? 'Sin registrar'
        : `${h.sedes.activas} activa${h.sedes.activas === 1 ? '' : 's'}${h.sedes.municipioPrincipal ? ` · ${h.sedes.municipioPrincipal}` : ''}`,
    faltantes,
    opcionales: [],
  };
}

function evaluarSituacionLegal(h: HechosConfiguracion): Paso {
  const faltantes: Faltante[] = [];
  const opcionales: Faltante[] = [];

  // Persona natural se representa a sí misma: exigirle un representante legal
  // sería inventar un requisito que la ley no le pone.
  if (h.empresa.tipoPersona === 'JURIDICA' && h.representanteVigente === null) {
    faltantes.push(f('representante', 'Representante legal'));
  }

  // Lo tributario (casilla 53 y el ICA de cada municipio) es del paso
  // «Impuestos». Acá queda quién es la empresa: representante, actividad y
  // matrícula.
  if (h.actividadPrincipal === null) {
    faltantes.push(f('codigoCiiu', 'Actividad económica principal'));
  }

  // La matrícula mercantil no la tiene toda persona natural, y su ausencia no
  // impide facturar. Se avisa, no se exige.
  if (!h.matriculaVigente) {
    opcionales.push(f('matricula', 'Matrícula mercantil'));
  }

  // Un sector marcado que ninguna actividad del RUT respalda.
  //
  // No es un error: el sector suma cuentas al catálogo y nunca esconde las que
  // el RUT respalda, así que marcar de más no rompe nada. Pero sí es una señal
  // de que el RUT quedó corto frente a lo que la empresa realmente hace, y eso
  // conviene saberlo antes de que lo pregunte la DIAN.
  const declaradas = new Set(h.empresa.seccionesActividades);
  for (const sector of h.empresa.sectores) {
    const respaldado = (SECCIONES_POR_SECTOR[sector] ?? []).some((s) =>
      declaradas.has(s),
    );
    if (!respaldado) {
      opcionales.push({
        campo: 'sectores',
        etiqueta: `${NOMBRE_SECTOR[sector] ?? sector} sin actividad que lo respalde`,
        detalle:
          h.empresa.seccionesActividades.length === 0
            ? 'Todavía no registraste ninguna actividad económica en el RUT.'
            : 'Ninguna de tus actividades del RUT es de ese tipo. Puede faltar registrarla, o sobrar el sector.',
      });
    }
  }

  const seEmpezo =
    h.representanteVigente !== null || h.actividadPrincipal !== null;

  const partes: string[] = [];
  if (h.actividadPrincipal !== null)
    partes.push(`CIIU ${h.actividadPrincipal.codigoCiiu}`);

  return {
    clave: 'SITUACION_LEGAL',
    nombre: 'Situación legal',
    orden: 3,
    obligatorio: true,
    estado: resolver(faltantes, seEmpezo),
    resumen: partes.length === 0 ? 'Sin registrar' : partes.join(' · '),
    faltantes,
    opcionales,
  };
}

/**
 * Todo lo tributario, en lenguaje de persona (plan motor de retenciones,
 * Fase 0, §0.7). Está listo cuando se sabe si la empresa cobra IVA, cada
 * municipio con sede tiene su respuesta de ICA y alguien confirmó el resumen.
 */
function evaluarImpuestos(h: HechosConfiguracion): Paso {
  const faltantes: Faltante[] = [];
  const iva =
    h.regimenesVigentes.includes('RESPONSABLE_IVA') ||
    h.regimenesVigentes.includes('NO_RESPONSABLE_IVA');

  // Sin esto no se sabe si la venta lleva IVA: es el dato del que cuelga toda
  // la liquidación.
  if (!iva) {
    faltantes.push({
      campo: 'iva',
      etiqueta: 'Si tu empresa cobra IVA',
      detalle:
        'De ahí sale si la venta lleva IVA y qué cuentas necesita el plan.',
    });
  }
  for (const m of h.impuestos.municipiosSinIca) {
    faltantes.push({
      campo: 'ica',
      etiqueta: `Te falta contarme el ICA de ${m}`,
      detalle:
        'El ICA es municipal: se contesta por cada municipio donde tenés sede.',
    });
  }
  if (faltantes.length === 0 && !h.impuestos.confirmado) {
    faltantes.push({
      campo: 'confirmar',
      etiqueta: 'Revisar lo que esto significa para vos',
      detalle: 'Mirá el resumen y confirmalo con «Todo correcto».',
    });
  }

  const partes: string[] = [];
  if (h.regimenesVigentes.includes('RESPONSABLE_IVA')) partes.push('Cobra IVA');
  else if (h.regimenesVigentes.includes('NO_RESPONSABLE_IVA'))
    partes.push('No cobra IVA');
  if (
    h.regimenesVigentes.includes('AGENTE_RETENEDOR_RENTA') ||
    h.regimenesVigentes.includes('GRAN_CONTRIBUYENTE')
  )
    partes.push('Agente de retención');

  return {
    clave: 'IMPUESTOS',
    nombre: 'Impuestos',
    orden: 4,
    obligatorio: true,
    estado: resolver(faltantes, iva || h.impuestos.confirmado),
    resumen: partes.length === 0 ? 'Sin contestar' : partes.join(' · '),
    faltantes,
    opcionales: [],
  };
}

/**
 * Sin plan de cuentas no se puede asentar nada, y sin asientos no hay
 * contabilidad: por eso es obligatorio y no un paso opcional más.
 *
 * Está bloqueado por la situación legal y por los impuestos porque el plan se
 * deriva de ellos. La sugerencia lee la actividad CIIU para saber cuál es la
 * cuenta de ingresos, y los impuestos para saber si proponer IVA y las cuentas
 * de retención. Armarlo antes obliga a rehacerlo.
 */
function evaluarPlanCuentas(
  h: HechosConfiguracion,
  legalLista: boolean,
  impuestosListos: boolean,
): Paso {
  const comun = {
    clave: 'PLAN_CUENTAS' as const,
    nombre: 'Plan de cuentas',
    orden: 5,
    obligatorio: true,
  };

  if (!legalLista || !impuestosListos) {
    return {
      ...comun,
      estado: 'BLOQUEADO',
      resumen: legalLista ? 'Requiere impuestos' : 'Requiere situación legal',
      faltantes: [],
      opcionales: [],
      bloqueadoPor: legalLista ? 'IMPUESTOS' : 'SITUACION_LEGAL',
    };
  }

  const faltantes: Faltante[] = [];
  if (h.plan.cuentasActivas === 0) {
    faltantes.push(f('cuentas', 'Ninguna cuenta registrada'));
  } else if (h.plan.auxiliares === 0) {
    // Todas las cuentas son de agrupación: suman a sus hijas pero no reciben
    // movimiento. Un plan así no deja asentar ni una factura.
    faltantes.push(f('esAuxiliar', 'Ninguna cuenta recibe movimiento'));
  }

  return {
    ...comun,
    estado: resolver(faltantes, h.plan.cuentasActivas > 0),
    resumen:
      h.plan.cuentasActivas === 0
        ? 'Sin registrar'
        : `${h.plan.cuentasActivas} cuenta${h.plan.cuentasActivas === 1 ? '' : 's'} · ${h.plan.auxiliares} con movimiento`,
    faltantes,
    opcionales: [],
  };
}

function evaluarResoluciones(h: HechosConfiguracion): Paso {
  const faltantes: Faltante[] = [];
  const opcionales: Faltante[] = [];
  const r = h.resolucionFacturaVenta;

  if (r === null) {
    faltantes.push(f('resolucion', 'Resolución de factura de venta'));
  } else if (!r.vigente) {
    faltantes.push(f('fechaVigenciaHasta', 'La resolución está vencida'));
  } else if (r.agotada) {
    faltantes.push(f('rangoHasta', 'La resolución agotó su rango'));
  }

  // Las credenciales hacen falta para transmitirle a la DIAN, que es del módulo
  // `dian`. Registrar la resolución ya permite numerar, así que no bloquea.
  if (!h.credencialesDianCargadas) {
    opcionales.push(
      f('credenciales', 'Credenciales de facturación electrónica'),
    );
  }

  return {
    clave: 'RESOLUCIONES',
    nombre: 'Resoluciones',
    orden: 6,
    obligatorio: true,
    estado: resolver(faltantes, r !== null),
    resumen:
      r === null
        ? 'Sin registrar'
        : `${r.numeroResolucion} · ${r.numerosRestantes} números`,
    faltantes,
    opcionales,
  };
}

// ---------------------------------------------------------------------------

export function calcularEstado(h: HechosConfiguracion): EstadoConfiguracion {
  const legal = evaluarSituacionLegal(h);
  const impuestos = evaluarImpuestos(h);

  const pasos: Paso[] = [
    evaluarEmpresa(h),
    evaluarSedes(h),
    legal,
    impuestos,
    evaluarPlanCuentas(
      h,
      legal.estado === 'LISTO',
      impuestos.estado === 'LISTO',
    ),
    evaluarResoluciones(h),
  ];

  const obligatorios = pasos.filter((p) => p.obligatorio);
  const completados = obligatorios.filter((p) => p.estado === 'LISTO').length;

  // El siguiente es el primero que no está listo y al que se puede entrar. Se
  // prefiere lo empezado a medias sobre lo que nunca se tocó: terminar algo
  // abierto cuesta menos que empezar de cero.
  const candidatos = pasos.filter(
    (p) => p.estado !== 'LISTO' && p.estado !== 'BLOQUEADO',
  );
  const aMedias = candidatos.find((p) => p.estado === 'FALTA');
  const siguiente =
    aMedias ?? candidatos.find((p) => p.obligatorio) ?? candidatos[0];

  return {
    pasos,
    completados,
    totalObligatorios: obligatorios.length,
    porcentaje: Math.round((completados / obligatorios.length) * 100),
    completa: completados === obligatorios.length,
    siguiente: siguiente?.clave ?? null,
    modo: h.empresa.modoConfiguracion ?? null,
    bienvenidaVista: (h.empresa.bienvenidaVistaEn ?? null) !== null,
  };
}
