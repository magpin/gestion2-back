/**
 * El historial de un asiento: de dónde salió, quién hizo qué y cuándo.
 *
 * Tanda 2 del diseño de María (`docs/planes/maria.md` §11), sobre el prototipo
 * `docs/asistente-ia-diseno/Trazabilidad.dc.html`. Con una diferencia que no es
 * de diseño sino de producto: el prototipo tiene un paso «Asentado sin
 * preguntar», y **eso ya no existe** —María no registra nada sola desde el 22
 * de septiembre de 2026—. En su lugar va quién lo aprobó.
 *
 * **Nada de esto se inventa.** Cada paso sale de una columna que ya se guardaba
 * —cuándo se subió el documento, cuándo se leyó, qué comprobó el código, quién
 * registró—. Si un asiento no pasó por María, su historial es corto, y está
 * bien que lo sea.
 *
 * Sin base de datos: el servicio trae las filas, esto arma los pasos.
 */

export interface Persona {
  nombre: string;
}

export interface FuentesDelAsiento {
  asiento: {
    numero: string;
    creadoEn: string;
    creadoPor: Persona;
    estado: string;
    anuladoEn: string | null;
    anuladoPor: Persona | null;
    motivo: string | null;
    periodo: { anio: number; mes: number };
  };
  /** El documento que María leyó, si el asiento salió de uno. */
  documento?: {
    tipo: string;
    /** La llave en el bucket: su extensión dice si fue PDF o foto. */
    clave: string;
    creadoEn: string;
    subidoPor: Persona;
    leidoEn: string | null;
    extraido: unknown;
  };
  /** El cobro o el pago que María propuso en el chat, si salió de uno. */
  propuesta?: {
    accion: 'COBRO' | 'PAGO';
    creadaEn: string;
    resueltaEn: string | null;
    resueltaPor: Persona | null;
  };
  /** La compra o la factura de venta que generó el asiento. */
  registro?: {
    tipo: 'COMPRA' | 'VENTA';
    /** Cómo se nombra en la frase: «la compra FC-88», «la nota crédito NC-3». */
    nombre: string;
    creadoEn: string;
    creadoPor: Persona;
  };
  /**
   * La retención en la fuente que el motor decidió al registrar la compra
   * (plan motor de retenciones, Fase 1): qué calculó, con qué norma, y si el
   * concepto ya estaba recordado para el proveedor.
   */
  retencion?: {
    decision: string;
    motivo: string | null;
    proveedor: string;
    calculadas: Array<{ texto: string; norma: string; origen: string }>;
  };
}

export type ClavePaso =
  | 'RECIBIDO'
  | 'LEIDO'
  | 'VERIFICADO'
  | 'PROPUESTO'
  | 'APROBADO'
  | 'REGISTRADO'
  | 'RETENCION'
  | 'CONTABILIZADO'
  | 'ANULADO';

export interface Paso {
  clave: ClavePaso;
  cuando: string;
  /** Lo hizo María: la fila lleva su cara. Si no, lleva a la persona. */
  deMaria: boolean;
  persona: { nombre: string; iniciales: string } | null;
  titulo: string;
  detalle: string;
  /**
   * Algo de este paso no salió limpio —una comprobación que no dio— y una
   * persona igual siguió. No es un error: es lo que un auditor querría ver.
   */
  aviso?: true;
}

/** «Camila Torres» → «CT». Como en el prototipo. */
export function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  const letras =
    partes.length === 1
      ? partes[0].slice(0, 2)
      : `${partes[0][0]}${partes[partes.length - 1][0]}`;
  return letras.toUpperCase();
}

const quien = (p: Persona | null) =>
  p === null ? null : { nombre: p.nombre, iniciales: iniciales(p.nombre) };

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

const plural = (n: number, uno: string, varios: string) =>
  `${n} ${n === 1 ? uno : varios}`;

/** Lo que interesa de lo que quedó guardado al leer. La base no mira adentro. */
interface Leido {
  renglones: number;
  comprobaciones: Array<{ que: string; cuadra: boolean }>;
  proveedorPorNit: boolean;
  porCatalogo: number;
  recordados: number;
  contestados: number;
}

function leer(tipo: string, extraido: unknown): Leido {
  const e = (extraido ?? {}) as Record<string, unknown>;
  const raiz = (e[tipo === 'PEDIDO_VENTA' ? 'pedido' : 'factura'] ??
    {}) as Record<string, unknown>;
  const renglonesLeidos = Array.isArray(raiz.renglones)
    ? raiz.renglones.length
    : 0;
  const cruzados = Array.isArray(e.renglones)
    ? (e.renglones as Array<{ resuelto: unknown; forma?: string }>)
    : [];
  return {
    renglones: renglonesLeidos,
    comprobaciones: Array.isArray(e.comprobaciones)
      ? (e.comprobaciones as Array<{ que: string; cuadra: boolean }>)
      : [],
    proveedorPorNit: (e.proveedor ?? e.cliente) != null,
    porCatalogo: cruzados.filter(
      (r) => r.resuelto != null && r.forma !== 'APRENDIDO',
    ).length,
    recordados: cruzados.filter((r) => r.forma === 'APRENDIDO').length,
    contestados: cruzados.filter((r) => r.resuelto == null).length,
  };
}

const NOMBRE_DOCUMENTO: Record<string, string> = {
  FACTURA_COMPRA: 'La factura de compra',
  PEDIDO_VENTA: 'El pedido del cliente',
};

/**
 * Los pasos, en el orden en que pasaron. Si dos pasan en el mismo instante
 * —leer, verificar y proponer ocurren en la misma lectura—, se respeta el orden
 * lógico en que se escribieron.
 */
export function pasosDelAsiento(f: FuentesDelAsiento): Paso[] {
  const pasos: Paso[] = [];
  const { asiento, documento, propuesta, registro, retencion } = f;

  if (documento !== undefined) {
    // La extensión la puso el servidor al firmar la subida, según el tipo que
    // declaró el navegador (`AlmacenamientoApi`): para decir «PDF» o «foto»
    // alcanza.
    const extension = documento.clave.split('.').pop()?.toLowerCase();
    const formato =
      extension === 'pdf'
        ? 'en PDF'
        : extension !== undefined && ['jpg', 'png', 'webp'].includes(extension)
          ? 'en foto'
          : '';
    pasos.push({
      clave: 'RECIBIDO',
      cuando: documento.creadoEn,
      deMaria: false,
      persona: quien(documento.subidoPor),
      titulo: 'Documento recibido',
      detalle: `${NOMBRE_DOCUMENTO[documento.tipo] ?? 'El documento'}${formato === '' ? '' : ` ${formato}`} · subido por ${documento.subidoPor.nombre}`,
    });

    if (documento.leidoEn !== null) {
      const l = leer(documento.tipo, documento.extraido);
      pasos.push({
        clave: 'LEIDO',
        cuando: documento.leidoEn,
        deMaria: true,
        persona: null,
        titulo: 'Leído por María',
        detalle: `${plural(l.renglones, 'renglón leído', 'renglones leídos')}, con la cabecera y los totales.`,
      });

      const dan = l.comprobaciones.filter((c) => c.cuadra).length;
      pasos.push({
        clave: 'VERIFICADO',
        cuando: documento.leidoEn,
        deMaria: true,
        persona: null,
        titulo: 'Verificado',
        ...(dan < l.comprobaciones.length || l.comprobaciones.length === 0
          ? { aviso: true as const }
          : {}),
        detalle:
          l.comprobaciones.length === 0
            ? 'El documento no traía totales con qué comprobar las cantidades.'
            : `${dan} de ${l.comprobaciones.length} ${l.comprobaciones.length === 1 ? 'comprobación superada' : 'comprobaciones superadas'}: ${l.comprobaciones
                .map((c) => c.que.charAt(0).toLowerCase() + c.que.slice(1))
                .join('; ')}.`,
      });

      pasos.push({
        clave: 'PROPUESTO',
        cuando: documento.leidoEn,
        deMaria: true,
        persona: null,
        titulo: 'María propuso el registro',
        detalle:
          documento.tipo === 'PEDIDO_VENTA'
            ? `${l.proveedorPorNit ? 'El cliente, por su NIT' : 'Sin cliente reconocido'}; ${plural(l.porCatalogo, 'producto encontrado', 'productos encontrados')} en el catálogo; los precios, de la lista.`
            : [
                l.proveedorPorNit
                  ? 'El proveedor, por su NIT'
                  : 'Sin proveedor reconocido',
                l.porCatalogo > 0 &&
                  plural(
                    l.porCatalogo,
                    'renglón encontrado',
                    'renglones encontrados',
                  ) + ' en el catálogo',
                l.recordados > 0 &&
                  plural(l.recordados, 'recordado', 'recordados') +
                    ' de facturas anteriores',
                l.contestados > 0 &&
                  plural(
                    l.contestados,
                    'renglón lo contestó',
                    'renglones los contestó',
                  ) + ' una persona',
              ]
                .filter(Boolean)
                .join('; ') + '.',
      });
    }
  }

  if (propuesta !== undefined) {
    pasos.push({
      clave: 'PROPUESTO',
      cuando: propuesta.creadaEn,
      deMaria: true,
      persona: null,
      titulo: `María propuso el ${propuesta.accion === 'COBRO' ? 'cobro' : 'pago'}`,
      detalle: 'En la conversación, verificado en seco antes de mostrarlo.',
    });
  }

  // Quién lo aprobó: la persona que registró lo que María dejó listo. Si
  // María no intervino, es simplemente quién lo registró.
  const intervino = documento !== undefined || propuesta !== undefined;
  const aprobo =
    propuesta?.resueltaPor != null
      ? {
          persona: propuesta.resueltaPor,
          cuando: propuesta.resueltaEn ?? asiento.creadoEn,
        }
      : registro !== undefined
        ? { persona: registro.creadoPor, cuando: registro.creadoEn }
        : { persona: asiento.creadoPor, cuando: asiento.creadoEn };
  pasos.push({
    clave: intervino ? 'APROBADO' : 'REGISTRADO',
    cuando: aprobo.cuando,
    deMaria: false,
    persona: quien(aprobo.persona),
    titulo: intervino
      ? `${aprobo.persona.nombre} lo aprobó`
      : `${aprobo.persona.nombre} lo registró`,
    detalle:
      registro === undefined
        ? intervino
          ? 'Confirmó lo que María propuso.'
          : 'Registrado a mano.'
        : registro.tipo === 'COMPRA'
          ? `Registró ${registro.nombre}.`
          : `Emitió ${registro.nombre}.`,
  });

  if (retencion !== undefined && registro !== undefined) {
    const recordado = retencion.calculadas.some(
      (c) => c.origen === 'CONFIRMADO',
    );
    pasos.push({
      clave: 'RETENCION',
      cuando: registro.creadoEn,
      deMaria: true,
      persona: null,
      titulo:
        retencion.calculadas.length > 0
          ? 'Retención calculada'
          : 'Sin retención en la fuente',
      detalle:
        retencion.calculadas.length > 0
          ? [
              retencion.calculadas
                .map(
                  (c) =>
                    `${c.texto.replace(/^Retención en la fuente · /, '').replace(/\.$/, '')} — ${c.norma}`,
                )
                .join('; '),
              recordado
                ? `concepto recordado para ${retencion.proveedor}`
                : null,
            ]
              .filter((x) => x !== null)
              .join('; ') + '.'
          : (retencion.motivo ?? 'No correspondía retener.'),
      // «Sin retención» por decisión de una persona: lo que un auditor
      // querría ver, aunque no sea un error.
      ...(retencion.decision === 'DECIDIDO_SIN'
        ? { aviso: true as const }
        : {}),
    });
  }

  pasos.push({
    clave: 'CONTABILIZADO',
    cuando: asiento.creadoEn,
    deMaria: false,
    persona: null,
    titulo: 'Contabilizado',
    detalle: `Período ${MESES[asiento.periodo.mes - 1]} de ${asiento.periodo.anio} · asiento ${asiento.numero}`,
  });

  if (asiento.estado === 'ANULADO' && asiento.anuladoEn !== null) {
    pasos.push({
      clave: 'ANULADO',
      cuando: asiento.anuladoEn,
      deMaria: false,
      persona: quien(asiento.anuladoPor),
      titulo: `Anulado${asiento.anuladoPor === null ? '' : ` por ${asiento.anuladoPor.nombre}`}`,
      detalle: asiento.motivo ?? 'Sin motivo escrito.',
    });
  }

  // Orden cronológico, estable: lo que pasó en el mismo instante queda en el
  // orden lógico en que se armó.
  return pasos
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) => Date.parse(a.p.cuando) - Date.parse(b.p.cuando) || a.i - b.i,
    )
    .map(({ p }) => p);
}
