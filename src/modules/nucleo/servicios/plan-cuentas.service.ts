import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
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
  madrePermitida,
  proximoCodigoAuxiliar,
  sugerirPlan,
  type HechosPlan,
  type Sugerencia,
} from './plan-cuentas.reglas';
import {
  cuentaIngresoDeActividad,
  evaluarPertinencia,
  seccionesPertinentes,
} from './secciones-ciiu';

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
      const editada = fila<Record<string, unknown>>(
        await t.query(
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
        ),
      );
      if (editada === undefined)
        throw new NotFoundException('La cuenta no existe');
      return editada;
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
      const desactivadas = filas<{ id: string }>(
        await t.query(
          'UPDATE empresa_cuenta SET activa = false WHERE id = $1 RETURNING id',
          [id],
        ),
      );
      if (desactivadas.length === 0)
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
          `SELECT ${CAMPOS_RESUMEN}
             FROM empresa_cuenta
            WHERE codigo = $1 AND activa`,
          [codigo],
        );
        return f === undefined ? null : resumirCuenta(f);
      },
      tx,
    );
  }

  /**
   * Una cuenta y sus auxiliares: las cuentas activas que cuelgan de ella y
   * reciben asientos (`429553` → `42955301`, `42955302`).
   *
   * Sirve para decidir contra qué se asienta un concepto: si la cuenta abrió
   * auxiliares, la cuenta madre ya no es la que recibe el movimiento, y quien
   * configura tiene que elegir entre ellos. `cuenta` es `null` si no existe:
   * puede haber auxiliares sin madre, cuando la empresa los creó sueltos.
   */
  async cuentaConAuxiliares(
    ctx: CtxEmpresa,
    codigo: string,
    tx?: Tx,
  ): Promise<{ cuenta: CuentaResumen | null; auxiliares: CuentaResumen[] }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<Array<Record<string, unknown>>>(
          `SELECT ${CAMPOS_RESUMEN}
             FROM empresa_cuenta
            WHERE activa AND codigo LIKE $1 || '%'
            ORDER BY codigo`,
          [codigo],
        );
        const madre = filas.find((f) => f.codigo === codigo);
        return {
          cuenta: madre === undefined ? null : resumirCuenta(madre),
          auxiliares: filas
            .filter((f) => f.codigo !== codigo && f.es_auxiliar === true)
            .map(resumirCuenta),
        };
      },
      tx,
    );
  }

  /**
   * Crea la cuenta si la empresa no la tiene, con el código del decreto tal
   * cual. Si ya existe —activa o no—, no la toca y devuelve `null`: quien la
   * desactivó tuvo un motivo, y reactivarla por la espalda lo pisaría.
   *
   * Existe para lo que el sistema configura solo (las cuentas de arqueo): la
   * cuenta se crea igual que si alguien la hubiera agregado del catálogo.
   */
  async asegurarCuenta(
    ctx: CtxEmpresa,
    datos: { codigo: string; nombre: string; exigeTercero?: boolean },
    tx?: Tx,
  ): Promise<CuentaResumen | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [existe] = await t.query<Array<{ id: string }>>(
          'SELECT id FROM empresa_cuenta WHERE codigo = $1',
          [datos.codigo],
        );
        if (existe !== undefined) return null;
        const creada = await this.insertar(t, ctx, {
          codigo: datos.codigo,
          nombre: datos.nombre,
          exigeTercero: datos.exigeTercero ?? false,
        });
        return resumirCuenta(creada);
      },
      tx,
    );
  }

  /**
   * La misma cuenta, buscada por id y **sin exigir que esté activa**.
   *
   * Va aparte de `cuenta()` porque responde otra pregunta. Aquella resuelve
   * una cuenta que el sistema conoce por su código —la de proveedores, la de
   * IVA— y si no está activa es como si no existiera. Esta resuelve una que
   * eligió una persona en una lista, y ahí «no existe» y «está inactiva» son
   * dos problemas distintos que merecen dos mensajes distintos: por eso
   * devuelve la fila con su bandera en vez de un nulo.
   */
  async cuentaPorId(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<{
    id: string;
    codigo: string;
    nombre: string;
    activa: boolean;
    es_auxiliar: boolean;
  } | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [f] = await t.query<
          Array<{
            id: string;
            codigo: string;
            nombre: string;
            activa: boolean;
            es_auxiliar: boolean;
          }>
        >(
          `SELECT id, codigo, nombre, activa, es_auxiliar
             FROM empresa_cuenta
            WHERE id = $1`,
          [id],
        );
        return f ?? null;
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
      const editado = fila<Record<string, unknown>>(
        await t.query(
          'UPDATE empresa_centro_costo SET nombre = COALESCE($2, nombre) WHERE id = $1 RETURNING *',
          [id, dto.nombre ?? null],
        ),
      );
      if (editado === undefined)
        throw new NotFoundException('El centro de costo no existe');
      return editado;
    });
  }

  async desactivarCentro(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const desactivados = filas<{ id: string }>(
        await t.query(
          'UPDATE empresa_centro_costo SET activo = false WHERE id = $1 RETURNING id',
          [id],
        ),
      );
      if (desactivados.length === 0)
        throw new NotFoundException('El centro de costo no existe');
    });
  }

  // ---------------------------------------------------------------------------
  // Auxiliares desde los formularios (plan de ventas, Fase 5)
  // ---------------------------------------------------------------------------

  /**
   * Un auxiliar bajo `madre`, con el código que sigue y el nombre que se pidió.
   * Es lo que usa «+ Crear cuenta auxiliar» en los selectores de cuenta: la
   * persona solo pone el nombre, y la cuenta queda lista para elegirse.
   *
   * Quien no es director ni contador solo puede crear bajo la madre de su
   * contexto (`madrePermitida`). La madre queda bloqueada mientras tanto: dos
   * creaciones a la vez no pueden sacar el mismo código. Si la madre no está
   * en el plan pero sí en el decreto, se agrega como cuenta que agrupa. Los
   * requisitos de la madre (tercero, centro de costo, base) pasan a la hija.
   */
  async crearAuxiliar(
    ctx: CtxEmpresa,
    datos: { madre: string; nombre: string },
    /** El sistema al configurar (cajas por sede, bancos): no pregunta el rol. */
    { sistema = false }: { sistema?: boolean } = {},
    tx?: Tx,
  ): Promise<Record<string, unknown>> {
    if (!sistema && !madrePermitida(ctx.roles, datos.madre)) {
      throw new ForbiddenException(
        `Tu rol no puede crear cuentas bajo la ${datos.madre}. Pedíselo al contador o al director.`,
      );
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const madre = await this.madreBloqueada(t, ctx, datos.madre);
        await this.prepararMadre(t, ctx, madre, []);
        const codigo = await this.siguienteEn(t, madre.codigo, []);
        const creada = await this.insertar(t, ctx, {
          codigo,
          nombre: datos.nombre.trim(),
          esAuxiliar: true,
          exigeTercero: madre.exige_tercero,
          exigeCentroCosto: madre.exige_centro_costo,
          exigeBaseGravable: madre.exige_base_gravable,
        });
        const [fila] = await t.query<Array<Record<string, unknown>>>(
          `SELECT ${CAMPOS_LISTAR} FROM empresa_cuenta ec
             JOIN cuenta_puc p ON p.codigo = ec.codigo_puc
            WHERE ec.id = $1`,
          [creada.id],
        );
        return fila;
      },
      tx,
    );
  }

  /** La cuenta 41xx de la actividad principal, o `null`. Ver `cuentaIngresoDeActividad`. */
  async familiaDeIngreso(ctx: CtxEmpresa, tx?: Tx): Promise<string | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [f] = await t.query<
          Array<{ seccion: string | null; division: string | null }>
        >(
          `SELECT d.seccion_codigo AS seccion, g.division_codigo AS division
             FROM empresa_actividad_economica a
             JOIN ciiu_clase    c ON c.codigo = a.codigo_ciiu
             JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
             JOIN ciiu_division d ON d.codigo = g.division_codigo
            WHERE a.empresa_id = $1 AND a.fecha_fin IS NULL AND a.es_principal
            LIMIT 1`,
          [ctx.empresaId],
        );
        return f === undefined
          ? null
          : (cuentaIngresoDeActividad(f.seccion, f.division) ?? null);
      },
      tx,
    );
  }

  /** El código que saldría bajo `madre`, para mostrarlo antes de guardar. */
  async siguiente(ctx: CtxEmpresa, madre: string): Promise<{ codigo: string }> {
    return this.tx.enContexto(ctx, async (t) => ({
      codigo: await this.siguienteEn(t, madre, []),
    }));
  }

  /**
   * Vuelve a activar una cuenta. Si su madre está inactiva, primero la madre:
   * una cuenta activa colgando de una inactiva no se ve en el árbol.
   */
  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const [cuenta] = await t.query<
        Array<{ codigo: string; codigo_padre: string | null }>
      >('SELECT codigo, codigo_padre FROM empresa_cuenta WHERE id = $1', [id]);
      if (cuenta === undefined)
        throw new NotFoundException('La cuenta no existe');
      if (cuenta.codigo_padre !== null) {
        const [madre] = await t.query<Array<{ activa: boolean }>>(
          'SELECT activa FROM empresa_cuenta WHERE codigo = $1',
          [cuenta.codigo_padre],
        );
        if (madre !== undefined && !madre.activa) {
          throw new BadRequestException(
            `Activa primero la ${cuenta.codigo_padre}: la ${cuenta.codigo} cuelga de ella.`,
          );
        }
      }
      await t.query('UPDATE empresa_cuenta SET activa = true WHERE id = $1', [
        id,
      ]);
    });
  }

  /**
   * La madre, bloqueada hasta el final de la transacción. Si la empresa no la
   * tiene pero el decreto sí, se agrega como cuenta que agrupa.
   */
  private async madreBloqueada(
    t: Tx,
    ctx: CtxEmpresa,
    codigo: string,
  ): Promise<FilaMadre> {
    const buscar = async () =>
      (
        await t.query<FilaMadre[]>(
          `SELECT id, codigo, nombre, activa, es_auxiliar, exige_tercero,
                  exige_centro_costo, exige_base_gravable
             FROM empresa_cuenta WHERE codigo = $1 FOR UPDATE`,
          [codigo],
        )
      )[0];
    let madre = await buscar();
    if (madre === undefined) {
      const [puc] = await t.query<Array<{ nombre: string }>>(
        'SELECT nombre FROM cuenta_puc WHERE codigo = $1',
        [codigo],
      );
      if (puc === undefined) {
        throw new NotFoundException(
          `La cuenta ${codigo} no existe en el plan ni en el decreto.`,
        );
      }
      await this.insertar(t, ctx, {
        codigo,
        nombre: puc.nombre,
        esAuxiliar: false,
      });
      madre = (await buscar())!;
    }
    if (!madre.activa) {
      throw new BadRequestException(
        `La cuenta ${codigo} está inactiva. Actívala en Plan de cuentas antes de crearle auxiliares.`,
      );
    }
    return madre;
  }

  /** El siguiente código libre bajo `madre`, contando activas e inactivas. */
  private async siguienteEn(
    t: Tx,
    madre: string,
    reservados: readonly string[],
  ): Promise<string> {
    const hijas = await t.query<Array<{ codigo: string }>>(
      'SELECT codigo FROM empresa_cuenta WHERE codigo_padre = $1',
      [madre],
    );
    const r = proximoCodigoAuxiliar(madre, [
      ...hijas.map((h) => h.codigo),
      ...reservados,
    ]);
    if (!r.ok) throw new BadRequestException(r.motivo);
    return r.codigo;
  }

  /**
   * Antes de que una cuenta auxiliar tenga hijas, deja de recibir asientos
   * (la base no deja asentar en una que agrupa). Lo que ya apuntaba a ella
   * —la caja de una sede única sobre la 110505, un producto, un concepto—
   * pasa a una hija nueva con su mismo nombre, así nada queda apuntando a una
   * cuenta que agrupa (D5). Si ya tiene movimientos contables, no se puede:
   * el libro la mostraría con saldo propio y con hijas a la vez.
   *
   * `reservados`: códigos que la misma operación ya va a usar.
   */
  private async prepararMadre(
    t: Tx,
    ctx: CtxEmpresa,
    madre: FilaMadre,
    reservados: readonly string[],
  ): Promise<void> {
    if (!madre.es_auxiliar) return;
    const [movimiento] = await t.query<Array<{ uno: number }>>(
      'SELECT 1 AS uno FROM asiento_linea WHERE cuenta_id = $1 LIMIT 1',
      [madre.id],
    );
    if (movimiento !== undefined) {
      throw new BadRequestException(
        `La cuenta ${madre.codigo} ${madre.nombre} ya tiene movimientos: no se le pueden abrir auxiliares sin descuadrar el libro. Creá la cuenta bajo otra madre o pedíselo al contador.`,
      );
    }

    const usadas = await this.referenciasA(t, madre.id);
    await t.query(
      'UPDATE empresa_cuenta SET es_auxiliar = false WHERE id = $1',
      [madre.id],
    );
    if (usadas.length === 0) return;

    const codigo = await this.siguienteEn(t, madre.codigo, reservados);
    const traslado = await this.insertar(t, ctx, {
      codigo,
      nombre: madre.nombre,
      esAuxiliar: true,
      exigeTercero: madre.exige_tercero,
      exigeCentroCosto: madre.exige_centro_costo,
      exigeBaseGravable: madre.exige_base_gravable,
    });
    await this.moverReferencias(t, usadas, madre.id, traslado.id as string);
  }

  /**
   * Qué tablas apuntan hoy a una cuenta (fuera de los asientos), sacado del
   * catálogo de la base: así no se escapa una tabla nueva que alguien agregue
   * mañana.
   */
  private async referenciasA(
    t: Tx,
    cuentaId: string,
  ): Promise<Array<{ tabla: string; columna: string }>> {
    const referencias = await t.query<
      Array<{ tabla: string; columna: string }>
    >(
      `SELECT c.conrelid::regclass::text AS tabla, a.attname AS columna
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(local, remota)
         JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = k.local
         JOIN pg_attribute ar ON ar.attrelid = c.confrelid AND ar.attnum = k.remota
        WHERE c.contype = 'f'
          AND c.confrelid = 'empresa_cuenta'::regclass
          AND ar.attname = 'id'
          AND c.conrelid <> 'asiento_linea'::regclass`,
    );
    const usadas: Array<{ tabla: string; columna: string }> = [];
    for (const r of referencias) {
      const [hay] = await t.query<Array<{ uno: number }>>(
        `SELECT 1 AS uno FROM ${r.tabla} WHERE ${quote(r.columna)} = $1 LIMIT 1`,
        [cuentaId],
      );
      if (hay !== undefined) usadas.push(r);
    }
    return usadas;
  }

  private async moverReferencias(
    t: Tx,
    usadas: Array<{ tabla: string; columna: string }>,
    de: string,
    a: string,
  ): Promise<void> {
    for (const r of usadas) {
      await t.query(
        `UPDATE ${r.tabla} SET ${quote(r.columna)} = $1 WHERE ${quote(r.columna)} = $2`,
        [a, de],
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dejar la configuración lista (plan de ventas, Fase 6)
  // ---------------------------------------------------------------------------

  /**
   * El capital y las utilidades acumuladas (370505) según el tipo de
   * sociedad, si faltan: sin ellos no se puede cargar el saldo inicial de
   * caja y bancos. Es el bloque de patrimonio de la sugerencia, sin preguntar:
   * lo necesita cualquier empresa. Idempotente.
   */
  async prepararPatrimonio(ctx: CtxEmpresa, tx?: Tx): Promise<string[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const aCrear = sugerirPlan(await this.hechos(t, ctx))
          .cuentas.filter((c) => c.bloque === 'PATRIMONIO')
          .sort(
            (a, b) =>
              a.codigo.length - b.codigo.length ||
              a.codigo.localeCompare(b.codigo),
          );
        const creadas: string[] = [];
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
          creadas.push(`${c.codigo} ${c.nombre}`);
        }
        return creadas;
      },
      tx,
    );
  }

  /**
   * La sugerencia vieja ponía la depreciación del equipo de oficina, de
   * cómputo y de la maquinaria en 159235, 159240 y 159245, que en el decreto
   * son de flota (terrestre, fluvial y aérea). El código no se edita: si la
   * cuenta mal puesta no tiene movimientos, se crea la correcta, lo que
   * apuntaba a la vieja pasa a la nueva y la vieja se desactiva. Con
   * movimientos no se toca: eso lo decide el contador. Idempotente.
   */
  async corregirDepreciacion(ctx: CtxEmpresa, tx?: Tx): Promise<string[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const hechas: string[] = [];
        for (const par of CORRECCION_1592) {
          const [mala] = await t.query<
            Array<{ id: string; nombre: string; activa: boolean }>
          >('SELECT id, nombre, activa FROM empresa_cuenta WHERE codigo = $1', [
            par.malo,
          ]);
          if (mala === undefined || !mala.activa) continue;
          if (!/^Depreciaci[oó]n acumulada - /i.test(mala.nombre)) continue;
          const [movimiento] = await t.query<Array<{ uno: number }>>(
            'SELECT 1 AS uno FROM asiento_linea WHERE cuenta_id = $1 LIMIT 1',
            [mala.id],
          );
          if (movimiento !== undefined) continue;
          const [hija] = await t.query<Array<{ uno: number }>>(
            'SELECT 1 AS uno FROM empresa_cuenta WHERE codigo_padre = $1 AND activa LIMIT 1',
            [par.malo],
          );
          if (hija !== undefined) continue;

          let [buena] = await t.query<Array<{ id: string }>>(
            'SELECT id FROM empresa_cuenta WHERE codigo = $1',
            [par.bueno],
          );
          if (buena === undefined) {
            buena = (await this.insertar(t, ctx, {
              codigo: par.bueno,
              nombre: par.nombre,
              codigoPuc: par.bueno,
            })) as { id: string };
          }
          await this.moverReferencias(
            t,
            await this.referenciasA(t, mala.id),
            mala.id,
            buena.id,
          );
          await t.query(
            'UPDATE empresa_cuenta SET activa = false WHERE id = $1',
            [mala.id],
          );
          hechas.push(`${par.malo} → ${par.bueno} ${par.nombre}`);
        }
        return hechas;
      },
      tx,
    );
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
    const [padre] = await t.query<FilaMadre[]>(
      `SELECT id, codigo, nombre, activa, es_auxiliar, exige_tercero,
              exige_centro_costo, exige_base_gravable
         FROM empresa_cuenta
        WHERE $1 LIKE codigo || '%' AND length(codigo) < length($1)
        ORDER BY length(codigo) DESC LIMIT 1
        FOR UPDATE`,
      [dto.codigo],
    );
    // Una madre que recibía asientos deja de hacerlo al tener hijas (D5).
    if (padre !== undefined) {
      await this.prepararMadre(t, ctx, padre, [dto.codigo]);
    }

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
         a.codigo_ciiu,
         -- La tarifa de ICA del municipio de la sede principal (paso Impuestos,
         -- provisional hasta la ley de ICA); la de la actividad, si no hay.
         COALESCE((SELECT i.tarifa_provisional_por_mil
                     FROM empresa_ica_municipio i
                     JOIN empresa_sede s ON s.empresa_id = i.empresa_id
                                        AND s.municipio_codigo = i.municipio_codigo
                    WHERE i.empresa_id = e.id AND i.fecha_fin IS NULL
                      AND s.es_principal AND s.activo
                    LIMIT 1),
                  a.tarifa_ica_por_mil)                                  AS tarifa_ica_por_mil,
         g.division_codigo, d.seccion_codigo,
         cc.maneja_centro_de_costo,
         COALESCE((SELECT json_agg(json_build_object('codigo', s.codigo, 'nombre', s.nombre)
                                   ORDER BY s.es_principal DESC, s.codigo)
                     FROM empresa_sede s WHERE s.empresa_id = e.id AND s.activo),
                  '[]'::json)                                            AS sedes,
         COALESCE((SELECT array_agg(ec.codigo) FROM empresa_cuenta ec
                    WHERE ec.empresa_id = e.id),
                  ARRAY[]::varchar[])                                    AS codigos,
         COALESCE((SELECT json_agg(json_build_object('codigo', ec.codigo, 'nombre', ec.nombre))
                     FROM empresa_cuenta ec
                    WHERE ec.empresa_id = e.id AND ec.codigo LIKE '110505_%'),
                  '[]'::json)                                            AS cajas
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
      cajasExistentes:
        (fila.cajas as Array<{ codigo: string; nombre: string }>) ?? [],
    };
  }
}

const CAMPOS_RESUMEN = `id, codigo, nombre, codigo_puc, naturaleza, es_auxiliar,
                exige_tercero, exige_centro_costo, exige_base_gravable`;

function resumirCuenta(f: Record<string, unknown>): CuentaResumen {
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
}

/** Lo mismo que devuelve `listar`, para una cuenta recién creada. */
const CAMPOS_LISTAR = `ec.id, ec.codigo, ec.nombre, ec.codigo_puc, ec.naturaleza, ec.codigo_padre,
                ec.es_auxiliar, ec.exige_tercero, ec.exige_centro_costo, ec.exige_base_gravable,
                ec.activa,
                p.nombre AS puc_nombre, p.nivel AS puc_nivel, p.rango_libre AS puc_rango_libre`;

interface FilaMadre {
  id: string;
  codigo: string;
  nombre: string;
  activa: boolean;
  es_auxiliar: boolean;
  exige_tercero: boolean;
  exige_centro_costo: boolean;
  exige_base_gravable: boolean;
}

/** Un nombre de columna sacado del catálogo, entre comillas por si acaso. */
function quote(identificador: string): string {
  return `"${identificador.replace(/"/g, '""')}"`;
}

/** La depreciación que la sugerencia vieja puso en códigos de flota. */
const CORRECCION_1592 = [
  {
    malo: '159235',
    bueno: '159215',
    nombre: 'Depreciación acumulada - equipo de oficina',
  },
  {
    malo: '159240',
    bueno: '159220',
    nombre: 'Depreciación acumulada - equipo de computación',
  },
  {
    malo: '159245',
    bueno: '159210',
    nombre: 'Depreciación acumulada - maquinaria y equipo',
  },
] as const;
