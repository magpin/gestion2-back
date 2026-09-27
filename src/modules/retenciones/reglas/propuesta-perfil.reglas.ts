/**
 * Qué cambiaría del perfil tributario de un proveedor por lo que dice su
 * factura (plan motor de retenciones, Fase 8, §8.8). Sin base de datos.
 *
 * Solo se propone lo que la factura **dice**: «Régimen simple», «No
 * responsable de IVA», «Gran contribuyente», «Autorretenedor», el CIIU. Que
 * una factura no diga «gran contribuyente» no prueba que no lo sea, así que la
 * ausencia no propone nada. Proponer no cambia nada: aprueba una persona (R-D8).
 */

export interface PerfilParaComparar {
  regimenRenta:
    'ORDINARIO' | 'SIMPLE' | 'NO_CONTRIBUYENTE' | 'REGIMEN_ESPECIAL';
  esResponsableIva: boolean;
  esGranContribuyente: boolean;
  esAutorretenedorRenta: boolean;
  ciiuPrincipal: string | null;
}

export interface CondicionLeida {
  regimenSimple: boolean | null;
  responsableIva: boolean | null;
  granContribuyente: boolean | null;
  autorretenedorRenta: boolean | null;
  ciiu: string | null;
}

export type CampoPerfil = keyof PerfilParaComparar;

export interface CambioPerfil {
  campo: CampoPerfil;
  antes: string | boolean | null;
  propuesto: string | boolean;
  /** La frase para la persona: qué dice la factura y qué tengo. */
  texto: string;
}

const si = (b: boolean) => (b ? 'sí' : 'no');

export function cambiosDesdeFactura(
  vigente: PerfilParaComparar,
  leido: CondicionLeida,
): CambioPerfil[] {
  const cambios: CambioPerfil[] = [];

  if (leido.regimenSimple === true && vigente.regimenRenta !== 'SIMPLE') {
    cambios.push({
      campo: 'regimenRenta',
      antes: vigente.regimenRenta,
      propuesto: 'SIMPLE',
      texto: `La factura dice que es del régimen simple; lo tengo como ${vigente.regimenRenta.toLowerCase().replace('_', ' ')}.`,
    });
  }
  if (
    leido.responsableIva !== null &&
    leido.responsableIva !== vigente.esResponsableIva
  ) {
    cambios.push({
      campo: 'esResponsableIva',
      antes: vigente.esResponsableIva,
      propuesto: leido.responsableIva,
      texto: `La factura dice que ${leido.responsableIva ? 'es' : 'no es'} responsable de IVA; lo tengo como ${si(vigente.esResponsableIva)} responsable.`,
    });
  }
  if (leido.granContribuyente === true && !vigente.esGranContribuyente) {
    cambios.push({
      campo: 'esGranContribuyente',
      antes: false,
      propuesto: true,
      texto: 'La factura dice que es gran contribuyente; no lo tengo así.',
    });
  }
  if (leido.autorretenedorRenta === true && !vigente.esAutorretenedorRenta) {
    cambios.push({
      campo: 'esAutorretenedorRenta',
      antes: false,
      propuesto: true,
      texto:
        'La factura dice que es autorretenedor de renta: a un autorretenedor no se le retiene.',
    });
  }
  const ciiu = leido.ciiu?.trim() ?? null;
  if (ciiu !== null && /^\d{4}$/.test(ciiu) && ciiu !== vigente.ciiuPrincipal) {
    cambios.push({
      campo: 'ciiuPrincipal',
      antes: vigente.ciiuPrincipal,
      propuesto: ciiu,
      texto:
        vigente.ciiuPrincipal === null
          ? `La factura dice que su actividad es ${ciiu}; no tengo su CIIU.`
          : `La factura dice que su actividad es ${ciiu}; tengo ${vigente.ciiuPrincipal}.`,
    });
  }
  return cambios;
}

/** Los cambios en forma canónica: la misma propuesta da la misma huella. */
export function huellaDe(cambios: CambioPerfil[]): string {
  return cambios
    .map((c) => `${c.campo}=${String(c.propuesto)}`)
    .sort()
    .join('|');
}

/** El perfil con los cambios aplicados: lo que va a la versión nueva. */
export function aplicarCambios<P extends PerfilParaComparar>(
  vigente: P,
  cambios: CambioPerfil[],
): P {
  const nuevo = { ...vigente };
  for (const c of cambios) {
    (nuevo as Record<string, unknown>)[c.campo] = c.propuesto;
  }
  // Del régimen simple no se es autorretenedor ni gran contribuyente a la vez
  // en renta: el simple sustituye la renta.
  if (nuevo.regimenRenta === 'SIMPLE') {
    nuevo.esAutorretenedorRenta = false;
  }
  return nuevo;
}
