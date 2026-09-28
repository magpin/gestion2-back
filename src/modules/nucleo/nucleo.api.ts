import { ConflictException, Injectable } from '@nestjs/common';

import type {
  Ctx,
  CtxEmpresa,
  RolCodigo,
  TipoDocumentoFiscal,
  TipoRegimen,
} from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import type { EditarEmpresaDto } from './dto/empresa.dto';
import type {
  AbrirActividadDto,
  AbrirMatriculaDto,
  AbrirRegimenDto,
  AbrirRepresentanteDto,
  AbrirResponsabilidadRutDto,
} from './dto/empresa-legal.dto';
import type { CrearResolucionDto } from './dto/resolucion.dto';
import { AutenticacionService } from './servicios/autenticacion.service';
import { ConceptosService } from './servicios/conceptos.service';
import { EmpresaService } from './servicios/empresa.service';
import { EmpresaLegalService } from './servicios/empresa-legal.service';
import { EstadoConfiguracionService } from './servicios/estado-configuracion.service';
import type { EstadoConfiguracion } from './servicios/estado-configuracion.reglas';
import {
  PlanCuentasService,
  type CuentaResumen,
} from './servicios/plan-cuentas.service';
import {
  ResolucionService,
  type NumeroFiscal,
} from './servicios/resolucion.service';
import {
  TerceroService,
  type TerceroResumen,
} from './servicios/tercero.service';

/**
 * La única clase que `nucleo` expone a otros módulos.
 *
 * Todo lo demás —servicios, controladores, DTOs— es interno. Si otro módulo
 * necesita algo que esta fachada no tiene, se le agrega un método acá; no se
 * importa un servicio interno. Esa regla es lo que permite cambiar cómo se
 * guardan los datos de empresa sin que se entere nadie más.
 *
 * Los métodos que escriben reciben `Tx`: quien es dueño de la tabla cabecera abre
 * la transacción, y `nucleo` se engancha a la que le pasan.
 */
@Injectable()
export class NucleoApi {
  constructor(
    private readonly auth: AutenticacionService,
    private readonly empresas: EmpresaService,
    private readonly legal: EmpresaLegalService,
    private readonly estadoConfig: EstadoConfiguracionService,
    private readonly plan: PlanCuentasService,
    private readonly resoluciones: ResolucionService,
    private readonly terceros: TerceroService,
    private readonly conceptos: ConceptosService,
  ) {}

  /**
   * Un concepto de ingreso o egreso, con su cuenta. Lo usan Tesorería, Compras
   * y Ventas para asentar lo que la persona eligió. Ver `ConceptosService`.
   */
  async concepto(ctx: CtxEmpresa, id: string, tx?: Tx) {
    return this.conceptos.obtener(ctx, id, tx);
  }

  /** Los conceptos activos, para elegir uno. */
  async conceptosActivos(ctx: CtxEmpresa) {
    return this.conceptos.listar(ctx);
  }

  /** Roles del usuario en una empresa, leídos de la base y no del token. */
  async rolesDe(ctx: Ctx, empresaId: string, tx?: Tx): Promise<RolCodigo[]> {
    return this.auth.rolesDe(ctx, empresaId, tx);
  }

  /**
   * Las condiciones tributarias vigentes a una fecha.
   *
   * Es lo que decide si una operación lleva IVA, si hay que retener y a qué
   * tarifa. Va con fecha porque una factura de hace tres meses tiene que
   * liquidarse con las condiciones de hace tres meses, no con las de hoy.
   */
  async regimenVigente(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<TipoRegimen[]> {
    return this.legal.regimenVigente(ctx, fecha, tx);
  }

  /**
   * Si la empresa cobra IVA en sus ventas, a una fecha.
   *
   * Existe como método propio y no como "buscá RESPONSABLE_IVA en la lista"
   * porque es la pregunta que el motor de facturación va a hacer en cada línea,
   * y la respuesta tiene una trampa: figurar como responsable y como no
   * responsable a la vez es un dato roto, no un caso a resolver por defecto.
   * Acá eso lanza en vez de elegir en silencio — liquidar IVA a quien no lo
   * cobra se corrige con nota crédito, no editando.
   *
   * La condición se deriva de la casilla 53 del RUT al cargarla, así que en la
   * práctica esto lee lo que dice el documento.
   */
  async esResponsableDeIva(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<boolean> {
    const vigentes = await this.legal.regimenVigente(ctx, fecha, tx);
    const responsable = vigentes.includes('RESPONSABLE_IVA');
    const noResponsable = vigentes.includes('NO_RESPONSABLE_IVA');

    if (responsable && noResponsable) {
      throw new ConflictException(
        'La empresa figura a la vez como responsable y como no responsable de IVA. Cerrá una de las dos condiciones antes de facturar.',
      );
    }

    return responsable;
  }

  /** La configuración contable de la empresa: grupo NIIF, moneda, mes de cierre. */
  async configuracionContable(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<Record<string, unknown>> {
    return this.legal.configuracionContable(ctx, tx);
  }

  /**
   * Entrega el siguiente número fiscal, dentro de la transacción del documento.
   *
   * Exige `tx` a propósito: el avance del consecutivo tiene que confirmarse o
   * revertirse junto con el documento. Un número quemado sin documento es un
   * hueco en la numeración que hay que justificar ante la DIAN.
   */
  async tomarConsecutivo(
    ctx: CtxEmpresa,
    tipo: TipoDocumentoFiscal,
    tx: Tx,
    fecha?: string,
  ): Promise<NumeroFiscal> {
    return this.resoluciones.tomarConsecutivo(ctx, tipo, tx, fecha);
  }

  /**
   * Si la empresa está lista para operar, y qué le falta si no.
   *
   * Los módulos de negocio la consultarán antes de dejar emitir: vender sin
   * condición tributaria vigente produce una factura mal liquidada, y eso se
   * corrige con nota crédito, no editando.
   */
  async estadoConfiguracion(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<EstadoConfiguracion> {
    return this.estadoConfig.estado(ctx, tx);
  }

  /**
   * El mismo estado, sobre una conexión que lee sin contexto de empresa. Solo
   * la usa la consola de plataforma, con la de aprovisionamiento, para ver
   * quién se quedó a medias en la configuración.
   */
  async estadoConfiguracionCon(
    t: Tx,
    empresaId: string,
  ): Promise<EstadoConfiguracion> {
    return this.estadoConfig.estadoCon(t, empresaId);
  }

  /**
   * Una cuenta del plan de la empresa, para asentar contra ella.
   *
   * `null` si no existe o está inactiva. Las banderas que trae —`exigeTercero`,
   * `exigeCentroCosto`, `exigeBaseGravable`— son lo que el módulo que asienta
   * tiene que exigirle al movimiento: una cuenta de cartera sin tercero no sirve
   * para cobrar, y una de IVA sin base no sirve para declarar.
   */
  async cuenta(
    ctx: CtxEmpresa,
    codigo: string,
    tx?: Tx,
  ): Promise<CuentaResumen | null> {
    return this.plan.cuenta(ctx, codigo, tx);
  }

  /** Una cuenta y sus auxiliares activos. Ver `PlanCuentasService.cuentaConAuxiliares`. */
  async cuentaConAuxiliares(ctx: CtxEmpresa, codigo: string, tx?: Tx) {
    return this.plan.cuentaConAuxiliares(ctx, codigo, tx);
  }

  /**
   * Crea una cuenta del decreto si la empresa no la tiene. `null` si ya
   * existía, aunque esté inactiva. Ver `PlanCuentasService.asegurarCuenta`.
   */
  async asegurarCuenta(
    ctx: CtxEmpresa,
    datos: { codigo: string; nombre: string; exigeTercero?: boolean },
    tx?: Tx,
  ) {
    return this.plan.asegurarCuenta(ctx, datos, tx);
  }

  /** Las sedes de la empresa: id y nombre, la principal primero. */
  async sedes(ctx: CtxEmpresa, tx?: Tx) {
    return this.empresas.sedesResumen(ctx, tx);
  }

  /**
   * Si la empresa declaró un hecho operativo (`MANEJA_CAJA_MENOR`,
   * `TIENE_EMPLEADOS`…). Es lo que ningún documento dice y solo la persona
   * contesta en el asistente.
   */
  async tieneHechoOperativo(
    ctx: CtxEmpresa,
    hecho: string,
    tx?: Tx,
  ): Promise<boolean> {
    return (await this.legal.hechosOperativos(ctx, tx)).includes(hecho);
  }

  /**
   * Una cuenta por id, con su bandera de activa: la eligió una persona en una
   * lista, así que «no existe» y «está inactiva» son dos problemas distintos.
   */
  async cuentaPorId(ctx: CtxEmpresa, id: string, tx?: Tx) {
    return this.plan.cuentaPorId(ctx, id, tx);
  }

  /**
   * Los terceros cuyo número de documento contiene lo buscado.
   *
   * Contiene y no es igual, a propósito: el NIT puede estar guardado con el
   * dígito de verificación aparte y venir pegado en el documento. Quién es el
   * mismo NIT lo decide quien llama —`mismoNit` en `cruce.reglas.ts`—; acá solo
   * se acota la lista.
   */
  async terceroPorDocumento(
    ctx: CtxEmpresa,
    numeroDocumento: string,
  ): Promise<TerceroResumen[]> {
    return this.terceros.porNumeroDocumento(ctx, numeroDocumento);
  }

  /** Los datos de un tercero para ponerlo en un documento. */
  async buscarTercero(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<TerceroResumen | null> {
    return this.terceros.buscarTercero(ctx, id, tx);
  }

  // ---------------------------------------------------------------------------
  // Lo que aplica el asistente cuando una persona confirma
  // ---------------------------------------------------------------------------
  //
  // Son las mismas operaciones que hacen los endpoints manuales de configuración,
  // con los mismos DTO y las mismas validaciones. Están acá —y no importando los
  // servicios desde `lectura-documentos`— porque la regla del módulo no cambia
  // por tener un modo nuevo: afuera sale `NucleoApi` y nada más.
  //
  // Que sean estos métodos y no un camino propio es lo que hace que no haya dos
  // verdades sobre cuándo un paso de la configuración está completo.

  /** Paso 1: razón social y nombre comercial. */
  async editarEmpresa(
    ctx: CtxEmpresa,
    dto: EditarEmpresaDto,
  ): Promise<unknown> {
    return this.empresas.editar(ctx, ctx.empresaId, dto);
  }

  /** Paso 2: la sede principal, exista o no todavía. */
  async fijarSedePrincipal(
    ctx: CtxEmpresa,
    dto: {
      direccion: string;
      municipioCodigo: string;
      telefono?: string;
      email?: string;
    },
  ): Promise<unknown> {
    return this.empresas.fijarSedePrincipal(ctx, dto);
  }

  /** Paso 3: la actividad económica, con su vigencia. */
  async abrirActividad(
    ctx: CtxEmpresa,
    dto: AbrirActividadDto,
  ): Promise<unknown> {
    return this.legal.abrirActividad(ctx, dto);
  }

  /** Paso 3: una responsabilidad de la casilla 53 del RUT. */
  async abrirResponsabilidadRut(
    ctx: CtxEmpresa,
    dto: AbrirResponsabilidadRutDto,
  ): Promise<unknown> {
    return this.legal.abrirResponsabilidadRut(ctx, dto);
  }

  /** Paso 3: una condición tributaria, con su vigencia. */
  async abrirRegimen(ctx: CtxEmpresa, dto: AbrirRegimenDto): Promise<unknown> {
    return this.legal.abrirRegimen(ctx, dto);
  }

  /** Paso 3: el representante legal. */
  async abrirRepresentante(
    ctx: CtxEmpresa,
    dto: AbrirRepresentanteDto,
  ): Promise<unknown> {
    return this.legal.abrirRepresentante(ctx, dto);
  }

  /** Paso 3: la matrícula mercantil. */
  async abrirMatricula(
    ctx: CtxEmpresa,
    dto: AbrirMatriculaDto,
  ): Promise<unknown> {
    return this.legal.abrirMatricula(ctx, dto);
  }

  /** Paso 5: una resolución de facturación de la DIAN. */
  async crearResolucion(
    ctx: CtxEmpresa,
    dto: CrearResolucionDto,
  ): Promise<unknown> {
    return this.resoluciones.crear(ctx, dto);
  }
}
