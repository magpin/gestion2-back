import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { BuscarPucDto } from '../dto/catalogo.dto';
import type {
  AplicarSugerenciaDto,
  CrearCentroCostoDto,
  CrearCuentaEmpresaDto,
  EditarCentroCostoDto,
  EditarCuentaEmpresaDto,
  ListarCuentasEmpresaDto,
} from '../dto/plan-cuentas.dto';
import {
  sugerirPlan,
  type HechosPlan,
  type Sugerencia,
} from './plan-cuentas.reglas';
import { evaluarPertinencia, seccionesPertinentes } from './secciones-ciiu';

/**
 * Lo que otro módulo necesita saber de una cuenta para asentar contra ella.
 * Es menos de lo que guarda la tabla: nadie fuera de núcleo necesita el árbol
 * ni las banderas de administración.
 */
export interface CuentaResumen {
  id: string;
  codigo: string;
  nombre: string;
  codigoPuc: string;
  naturaleza: 'DEBITO' | 'CREDITO';
  esAuxiliar: boolean;
  exigeTercero: boolean;
  exigeCentroCosto: boolean;
  exigeBaseGravable: boolean;
}

/**
 * El plan de cuentas de una empresa y sus centros de costo.
 *
 * `cuenta_puc` es el Decreto 2650 y no lo edita nadie. Esto es lo que ESTA
 * empresa decidió usar: lo que escogió del catálogo más los auxiliares que el
 * decreto no alcanza —el banco con nombre propio, la caja de cada sede—.
 *
 * Nada se borra. Una cuenta con movimiento no se puede quitar sin descuadrar el
 * libro, así que se desactiva y deja de ofrecerse al digitar.
 */
@Injectable()
export class PlanCuentasService {
  constructor(private readonly tx: TxService) {}

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  async listar(
    ctx: CtxEmpresa,
    f: ListarCuentasEmpresaDto,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      if (f.incluirInactivas !== 'true') condiciones.push('ec.activa');
      if (f.soloAuxiliares === 'true') condiciones.push('ec.es_auxiliar');
      if (f.q !== undefined && f.q.trim() !== '') {
        params.push(`%${f.q.trim()}%`);
        condiciones.push(
          `(fn_normalizar(ec.nombre) LIKE fn_normalizar($${params.length}) OR ec.codigo LIKE $${params.length})`,
        );
      }
      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      return t.query(
        `SELECT ec.id, ec.codigo, ec.nombre, ec.codigo_puc, ec.naturaleza, ec.codigo_padre,
                ec.es_auxiliar, ec.exige_tercero, ec.exige_centro_costo, ec.exige_base_gravable,
                ec.activa,
                p.nombre AS puc_nombre, p.nivel AS puc_nivel, p.rango_libre AS puc_rango_libre
           FROM empresa_cuenta ec
           JOIN cuenta_puc p ON p.codigo = ec.codigo_puc
           ${where}
          ORDER BY ec.codigo`,
        params,
      );
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `SELECT ec.*, p.nombre AS puc_nombre, p.nivel AS puc_nivel
           FROM empresa_cuenta ec
           JOIN cuenta_puc p ON p.codigo = ec.codigo_puc
          WHERE ec.id = $1`,
        [id],
      );
      if (fila === undefined)
        throw new NotFoundException('La cuenta no existe');
      return fila;
    });
  }

  // ---------------------------------------------------------------------------
  // Escritura
  // ---------------------------------------------------------------------------

  async crear(
    ctx: CtxEmpresa,
    dto: CrearCuentaEmpresaDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, (t) => this.insertar(t, ctx, dto));
  }

  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarCuentaEmpresaDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `UPDATE empresa_cuenta SET
           nombre              = COALESCE($2, nombre),
           naturaleza          = COALESCE($3, naturaleza),
           es_auxiliar         = COALESCE($4, es_auxiliar),
           exige_tercero       = COALESCE($5, exige_tercero),
           exige_centro_costo  = COALESCE($6, exige_centro_costo),
           exige_base_gravable = COALESCE($7, exige_base_gravable)
         WHERE id = $1
         RETURNING *`,
        [
          id,
          dto.nombre ?? null,
          dto.naturaleza ?? null,
          dto.esAuxiliar ?? null,
          dto.exigeTercero ?? null,
          dto.exigeCentroCosto ?? null,
          dto.exigeBaseGravable ?? null,
        ],
      );
      if (fila === undefined)
        throw new NotFoundException('La cuenta no existe');
      return fila;
    });
  }

  /**
   * Desactiva. No borra: si la cuenta tiene movimiento, quitarla dejaría el libro
   * sin la contrapartida de asientos ya emitidos.
   */
  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const hijas = await t.query<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM empresa_cuenta h
          WHERE h.codigo_padre = (SELECT codigo FROM empresa_cuenta WHERE id = $1) AND h.activa`,
        [id],
      );
      if (Number(hijas[0]?.n ?? '0') > 0) {
        throw new BadRequestException(
          'La cuenta tiene auxiliares activos. Desactivalos primero: si no, quedarian colgando de una cuenta inactiva.',
        );
      }
      const filas = await t.query<Array<unknown>>(
        'UPDATE empresa_cuenta SET activa = false WHERE id = $1 RETURNING id',
        [id],
      );
      if (filas.length === 0)
        throw new NotFoundException('La cuenta no existe');
    });
  }

  /**
   * Una cuenta por su código, con lo que hace falta para validar un movimiento
   * contra ella. Es lo que `NucleoApi` expone al resto del sistema.
   *
   * Devuelve null si no existe o está inactiva: asentar contra una cuenta dada
   * de baja deja un saldo que ningún informe vuelve a mostrar.
   */
  async cuenta(
    ctx: CtxEmpresa,
    codigo: string,
    tx?: Tx,
  ): Promise<CuentaResumen | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [f] = await t.query<Array<Record<string, unknown>>>(
          `SELECT id, codigo, nombre, codigo_puc, naturaleza, es_auxiliar,
                  exige_tercero, exige_centro_costo, exige_base_gravable
             FROM empresa_cuenta
            WHERE codigo = $1 AND activa`,
          [codigo],
        );
        if (f === undefined) return null;
        return {
          id: f.id as string,
          codigo: f.codigo as string,
          nombre: f.nombre as string,
          codigoPuc: f.codigo_puc as string,
          naturaleza: f.naturaleza as 'DEBITO' | 'CREDITO',
          esAuxiliar: f.es_auxiliar === true,
          exigeTercero: f.exige_tercero === true,
          exigeCentroCosto: f.exige_centro_costo === true,
          exigeBaseGravable: f.exige_base_gravable === true,
        };
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // El catálogo del decreto, visto desde esta empresa
  // ---------------------------------------------------------------------------

  /**
   * Las cuentas del Decreto 2650 marcadas según le sirvan o no a esta empresa.
   *
   * NO filtra: marca. Devuelve todo y cada cuenta dice si es pertinente y por qué
   * no lo es. Esconder una cuenta que alguien necesitaba es peor que mostrar de
   * más — termina asentando en la equivocada porque la correcta "no aparecía".
   * La UI pliega lo no pertinente y deja el catálogo completo a un clic.
   *
   * Vive acá y no en `CatalogoService` porque necesita saber a qué se dedica la
   * empresa, y ese servicio lee los catálogos compartidos sin contexto.
   */
  async catalogo(
    ctx: CtxEmpresa,
    f: BuscarPucDto,
  ): Promise<{
    secciones: Array<{ codigo: string; nombre: string }>;
    cuentas: Array<Record<string, unknown>>;
  }> {
    return this.tx.enContexto(ctx, async (t) => {
      const [empresa] = await t.query<Array<Record<string, unknown>>>(
        `SELECT
           COALESCE((SELECT array_agg(DISTINCT d.seccion_codigo)
                       FROM empresa_actividad_economica a
                       JOIN ciiu_clase    c ON c.codigo = a.codigo_ciiu
                       JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
                       JOIN ciiu_division d ON d.codigo = g.division_codigo
                      WHERE a.empresa_id = e.id AND a.fecha_fin IS NULL),
                    ARRAY[]::text[])                                  AS secciones_actividad,
           COALESCE((SELECT array_agg(s.sector ORDER BY s.sector)
                       FROM empresa_sector s WHERE s.empresa_id = e.id),
                    ARRAY[]::text[])                                  AS sectores
         FROM empresa e WHERE e.id = $1`,
        [ctx.empresaId],
      );

      const secciones = seccionesPertinentes(
        (empresa.secciones_actividad as string[]) ?? [],
        (empresa.sectores as string[]) ?? [],
      );

      // Viajan una sola vez, arriba: la UI las muestra como encabezado en vez de
      // repetirlas en cada una de las cuatrocientas filas.
      const nombres = await t.query<Array<{ codigo: string; nombre: string }>>(
        'SELECT codigo, nombre FROM ciiu_seccion WHERE codigo = ANY($1) ORDER BY codigo',
        [[...secciones]],
      );

      const params: unknown[] = [];
      const condiciones: string[] = [];
      if (f.q !== undefined && f.q.trim() !== '') {
        params.push(`%${f.q.trim()}%`);
        condiciones.push(
          `(fn_normalizar(p.nombre) LIKE fn_normalizar($${params.length}) OR p.codigo LIKE $${params.length})`,
        );
      }
      // Los mismos filtros de navegación que `/catalogos/puc`. Sin ellos, el
      // LIMIT sobre 2 492 cuentas ordenadas por código no deja pasar de la clase 1.
      if (f.nivel !== undefined) {
        params.push(f.nivel);
        condiciones.push(`p.nivel = $${params.length}`);
      }
      if (f.padre !== undefined) {
        params.push(f.padre);
        condiciones.push(`p.codigo_padre = $${params.length}`);
      }
      if (f.soloImputables === 'true') condiciones.push('p.es_imputable');
      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const cuentas = await t.query<Array<Record<string, unknown>>>(
        `SELECT p.codigo, p.nivel, p.codigo_padre, p.nombre, p.naturaleza,
                p.es_imputable, p.rango_libre,
                EXISTS (SELECT 1 FROM empresa_cuenta ec WHERE ec.codigo_puc = p.codigo) AS ya_en_el_plan
           FROM cuenta_puc p
           ${where}
          ORDER BY p.codigo
          LIMIT 400`,
        params,
      );

      return {
        secciones: nombres,
        cuentas: cuentas.map((c) => ({
          ...c,
          ...evaluarPertinencia(c.codigo as string, secciones),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Sugerencia derivada de lo que la empresa declaró
  // ---------------------------------------------------------------------------

  /**
   * No siembra nada: propone y explica. Aplicar es un acto aparte y explícito
   * (`aplicar`), con los códigos que el usuario confirmó.
   */
  async sugerencia(ctx: CtxEmpresa, tx?: Tx): Promise<Sugerencia> {
    return this.tx.enContexto(
      ctx,
      async (t) => sugerirPlan(await this.hechos(t, ctx)),
      tx,
    );
  }

  async aplicar(
    ctx: CtxEmpresa,
    dto: AplicarSugerenciaDto,
  ): Promise<{ creadas: number }> {
    return this.tx.enContexto(ctx, async (t) => {
      const propuestas = sugerirPlan(await this.hechos(t, ctx));
      const pedidos = new Set(dto.codigos);
      const aCrear = propuestas.cuentas.filter((c) => pedidos.has(c.codigo));

      const desconocidos = [...pedidos].filter(
        (c) => !propuestas.cuentas.some((s) => s.codigo === c),
      );
      if (desconocidos.length > 0) {
        throw new BadRequestException(
          `Estos codigos no estan en la sugerencia vigente: ${desconocidos.join(', ')}. Volve a pedirla: los hechos de la empresa pudieron cambiar.`,
        );
      }

      // Las de agrupación primero: una auxiliar puede colgar de ellas.
      aCrear.sort(
        (a, b) =>
          a.codigo.length - b.codigo.length || a.codigo.localeCompare(b.codigo),
      );

      for (const c of aCrear) {
        await this.insertar(t, ctx, {
          codigo: c.codigo,
          nombre: c.nombre,
          codigoPuc: c.codigoPuc,
          esAuxiliar: c.esAuxiliar,
          exigeTercero: c.exigeTercero,
          exigeCentroCosto: c.exigeCentroCosto,
          exigeBaseGravable: c.exigeBaseGravable,
        });
      }

      return { creadas: aCrear.length };
    });
  }

  // ---------------------------------------------------------------------------
  // Centros de costo
  // ---------------------------------------------------------------------------

  async centros(ctx: CtxEmpresa): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query('SELECT * FROM empresa_centro_costo ORDER BY codigo'),
    );
  }

  async crearCentro(
    ctx: CtxEmpresa,
    dto: CrearCentroCostoDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_centro_costo (empresa_id, codigo, nombre)
         VALUES ($1, $2, $3) RETURNING *`,
        [ctx.empresaId, dto.codigo, dto.nombre],
      );
      return fila;
    });
  }

  async editarCentro(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarCentroCostoDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        'UPDATE empresa_centro_costo SET nombre = COALESCE($2, nombre) WHERE id = $1 RETURNING *',
        [id, dto.nombre ?? null],
      );
      if (fila === undefined)
        throw new NotFoundException('El centro de costo no existe');
      return fila;
    });
  }

  async desactivarCentro(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const filas = await t.query<Array<unknown>>(
        'UPDATE empresa_centro_costo SET activo = false WHERE id = $1 RETURNING id',
        [id],
      );
      if (filas.length === 0)
        throw new NotFoundException('El centro de costo no existe');
    });
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private async insertar(
    t: Tx,
    ctx: CtxEmpresa,
    dto: CrearCuentaEmpresaDto,
  ): Promise<Record<string, unknown>> {
    const codigoPuc = dto.codigoPuc ?? (await this.anclaPuc(t, dto.codigo));
    if (codigoPuc === null) {
      throw new BadRequestException(
        `El codigo ${dto.codigo} no cae bajo ninguna cuenta del Decreto 2650. Revisa los primeros digitos.`,
      );
    }

    // El padre es la cuenta propia mas larga que sea prefijo de esta. Si no hay
    // ninguna, la cuenta cuelga directo del catalogo y `codigo_padre` va en NULL.
    const [padre] = await t.query<Array<{ codigo: string }>>(
      `SELECT codigo FROM empresa_cuenta
        WHERE $1 LIKE codigo || '%' AND length(codigo) < length($1)
        ORDER BY length(codigo) DESC LIMIT 1`,
      [dto.codigo],
    );

    const [fila] = await t.query<Array<Record<string, unknown>>>(
      `INSERT INTO empresa_cuenta
         (empresa_id, codigo, nombre, codigo_puc, naturaleza, codigo_padre,
          es_auxiliar, exige_tercero, exige_centro_costo, exige_base_gravable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        ctx.empresaId,
        dto.codigo,
        dto.nombre,
        codigoPuc,
        dto.naturaleza ?? null, // NULL: el trigger la hereda de cuenta_puc
        padre?.codigo ?? null,
        dto.esAuxiliar ?? true,
        dto.exigeTercero ?? false,
        dto.exigeCentroCosto ?? false,
        dto.exigeBaseGravable ?? false,
      ],
    );
    return fila;
  }

  /** El prefijo más largo del código que exista en el catálogo. */
  private async anclaPuc(t: Tx, codigo: string): Promise<string | null> {
    const [fila] = await t.query<Array<{ codigo: string }>>(
      `SELECT codigo FROM cuenta_puc
        WHERE $1 LIKE codigo || '%'
        ORDER BY length(codigo) DESC LIMIT 1`,
      [codigo],
    );
    return fila?.codigo ?? null;
  }

  private async hechos(t: Tx, ctx: CtxEmpresa): Promise<HechosPlan> {
    const [fila] = await t.query<Array<Record<string, unknown>>>(
      `SELECT
         e.tipo_persona, e.forma_asociativa_codigo,
         COALESCE((SELECT array_agg(rt.tipo_regimen ORDER BY rt.tipo_regimen)
                     FROM empresa_regimen_tributario rt
                    WHERE rt.empresa_id = e.id AND rt.fecha_fin IS NULL),
                  ARRAY[]::text[])                                       AS regimenes,
         -- Casilla 53 vigente, resuelta contra el codigo que la reemplazo: un RUT
         -- viejo trae el 11 (regimen comun) donde hoy la DIAN escribe el 48, y el
         -- mapeo de reglas solo conoce los vigentes.
         COALESCE((SELECT array_agg(DISTINCT COALESCE(c.codigo_reemplazo, r.codigo))
                     FROM empresa_responsabilidad_rut r
                     JOIN responsabilidad_tributaria c ON c.codigo = r.codigo
                    WHERE r.empresa_id = e.id AND r.fecha_fin IS NULL),
                  ARRAY[]::smallint[])                                   AS responsabilidades,
         COALESCE((SELECT array_agg(s.sector ORDER BY s.sector)
                     FROM empresa_sector s WHERE s.empresa_id = e.id),
                  ARRAY[]::text[])                                       AS sectores,
         COALESCE((SELECT array_agg(ho.hecho ORDER BY ho.hecho)
                     FROM empresa_hecho_operativo ho WHERE ho.empresa_id = e.id),
                  ARRAY[]::text[])                                       AS hechos_operativos,
         a.codigo_ciiu, a.tarifa_ica_por_mil,
         g.division_codigo, d.seccion_codigo,
         cc.maneja_centro_de_costo,
         COALESCE((SELECT json_agg(json_build_object('codigo', s.codigo, 'nombre', s.nombre)
                                   ORDER BY s.codigo)
                     FROM empresa_sede s WHERE s.empresa_id = e.id AND s.activo),
                  '[]'::json)                                            AS sedes,
         COALESCE((SELECT array_agg(ec.codigo) FROM empresa_cuenta ec
                    WHERE ec.empresa_id = e.id),
                  ARRAY[]::varchar[])                                    AS codigos
       FROM empresa e
       LEFT JOIN empresa_configuracion_contable cc ON cc.empresa_id = e.id
       LEFT JOIN empresa_actividad_economica a
              ON a.empresa_id = e.id AND a.fecha_fin IS NULL AND a.es_principal
       LEFT JOIN ciiu_clase    c ON c.codigo = a.codigo_ciiu
       LEFT JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
       LEFT JOIN ciiu_division d ON d.codigo = g.division_codigo
       WHERE e.id = $1`,
      [ctx.empresaId],
    );

    return {
      tipoPersona: fila.tipo_persona as 'JURIDICA' | 'NATURAL',
      formaAsociativa: (fila.forma_asociativa_codigo as string | null) ?? null,
      sectores: (fila.sectores as string[]) ?? [],
      regimenesVigentes: (fila.regimenes as string[]) ?? [],
      // smallint llega como número; el driver lo entrega ya convertido.
      responsabilidadesRut: (fila.responsabilidades as number[]) ?? [],
      hechosOperativos: (fila.hechos_operativos as string[]) ?? [],
      actividadPrincipal:
        fila.codigo_ciiu === null || fila.codigo_ciiu === undefined
          ? null
          : {
              codigoCiiu: fila.codigo_ciiu as string,
              seccionCiiu: (fila.seccion_codigo as string | null) ?? null,
              divisionCiiu: (fila.division_codigo as string | null) ?? null,
              tarifaIcaPorMil:
                fila.tarifa_ica_por_mil === null
                  ? null
                  : Number(fila.tarifa_ica_por_mil),
            },
      manejaCentroCosto: fila.maneja_centro_de_costo === true,
      sedes: (fila.sedes as Array<{ codigo: string; nombre: string }>) ?? [],
      codigosExistentes: (fila.codigos as string[]) ?? [],
    };
  }
}
