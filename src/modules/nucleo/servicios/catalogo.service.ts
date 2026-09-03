import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { BuscarCiiuDto, BuscarPucDto } from '../dto/catalogo.dto';

/**
 * Los catálogos normativos: CIIU, PUC y las casillas del RUT.
 *
 * Son del Estado, no de nadie: viven sin `empresa_id` y sin RLS, y los lee
 * cualquier usuario autenticado aunque todavía no haya elegido empresa. Por eso
 * se consultan directo contra el `DataSource`, sin abrir transacción ni fijar
 * contexto — igual que `GeografiaService`.
 *
 * Ninguno tiene método de escritura. Se cargan por migración y se corrigen por
 * migración: si un usuario pudiera editarlos, dos empresas verían PUC distintos
 * y los informes dejarían de ser comparables.
 */
@Injectable()
export class CatalogoService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  // ---------------------------------------------------------------------------
  // CIIU
  // ---------------------------------------------------------------------------

  /** Las 21 secciones, para navegar el árbol de arriba hacia abajo. */
  async secciones(): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      `SELECT s.codigo, s.nombre, count(d.codigo)::int AS divisiones
         FROM ciiu_seccion s
         LEFT JOIN ciiu_division d ON d.seccion_codigo = s.codigo
        GROUP BY s.codigo, s.nombre
        ORDER BY s.codigo`,
    );
  }

  async divisiones(seccion?: string): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      `SELECT codigo, seccion_codigo, nombre
         FROM ciiu_division
        WHERE ($1::char(1) IS NULL OR seccion_codigo = $1)
        ORDER BY codigo`,
      [seccion ?? null],
    );
  }

  async grupos(division?: string): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      `SELECT codigo, division_codigo, nombre
         FROM ciiu_grupo
        WHERE ($1::char(2) IS NULL OR division_codigo = $1)
        ORDER BY codigo`,
      [division ?? null],
    );
  }

  /**
   * Búsqueda de la clase de 4 dígitos, que es la que va al RUT y la que
   * referencia `empresa_actividad_economica`.
   *
   * El texto busca por nombre y por código a la vez: quien tiene el RUT delante
   * escribe "4741", y quien no, escribe "computadores".
   */
  async clases(f: BuscarCiiuDto): Promise<Array<Record<string, unknown>>> {
    const condiciones: string[] = [];
    const params: unknown[] = [];

    if (f.q !== undefined && f.q.trim() !== '') {
      params.push(`%${f.q.trim()}%`);
      condiciones.push(
        `(fn_normalizar(c.nombre) LIKE fn_normalizar($${params.length}) OR c.codigo LIKE $${params.length})`,
      );
    }
    if (f.grupo !== undefined) {
      params.push(f.grupo);
      condiciones.push(`c.grupo_codigo = $${params.length}`);
    }
    if (f.division !== undefined) {
      params.push(f.division);
      condiciones.push(`g.division_codigo = $${params.length}`);
    }
    if (f.seccion !== undefined) {
      params.push(f.seccion);
      condiciones.push(`d.seccion_codigo = $${params.length}`);
    }
    if (f.origen !== undefined) {
      params.push(f.origen);
      condiciones.push(`c.origen = $${params.length}`);
    }

    const where =
      condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

    // LEFT JOIN y no JOIN: las cinco clases de origen DIAN (asalariado,
    // pensionado, rentista) no cuelgan de ningún grupo y un JOIN las borraría
    // justo del selector donde más se necesitan.
    return this.ds.query(
      `SELECT c.codigo, c.nombre, c.origen,
              c.grupo_codigo, g.nombre AS grupo_nombre,
              g.division_codigo, d.nombre AS division_nombre,
              d.seccion_codigo, s.nombre AS seccion_nombre
         FROM ciiu_clase c
         LEFT JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
         LEFT JOIN ciiu_division d ON d.codigo = g.division_codigo
         LEFT JOIN ciiu_seccion  s ON s.codigo = d.seccion_codigo
         ${where}
        ORDER BY c.origen DESC, c.codigo
        LIMIT 200`,
      params,
    );
  }

  async clase(codigo: string): Promise<Record<string, unknown>> {
    const [fila] = await this.ds.query<Array<Record<string, unknown>>>(
      `SELECT c.codigo, c.nombre, c.origen,
              c.grupo_codigo, g.nombre AS grupo_nombre,
              g.division_codigo, d.nombre AS division_nombre,
              d.seccion_codigo, s.nombre AS seccion_nombre
         FROM ciiu_clase c
         LEFT JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
         LEFT JOIN ciiu_division d ON d.codigo = g.division_codigo
         LEFT JOIN ciiu_seccion  s ON s.codigo = d.seccion_codigo
        WHERE c.codigo = $1`,
      [codigo],
    );
    if (fila === undefined)
      throw new NotFoundException(`La actividad CIIU ${codigo} no existe`);
    return fila;
  }

  // ---------------------------------------------------------------------------
  // PUC — Decreto 2650
  // ---------------------------------------------------------------------------

  async cuentas(f: BuscarPucDto): Promise<Array<Record<string, unknown>>> {
    const condiciones: string[] = [];
    const params: unknown[] = [];

    if (f.q !== undefined && f.q.trim() !== '') {
      params.push(`%${f.q.trim()}%`);
      condiciones.push(
        `(fn_normalizar(p.nombre) LIKE fn_normalizar($${params.length}) OR p.codigo LIKE $${params.length})`,
      );
    }
    if (f.nivel !== undefined) {
      params.push(f.nivel);
      condiciones.push(`p.nivel = $${params.length}`);
    }
    if (f.padre !== undefined) {
      params.push(f.padre);
      condiciones.push(`p.codigo_padre = $${params.length}`);
    }
    if (f.soloImputables === 'true') {
      condiciones.push('p.es_imputable');
    }

    const where =
      condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

    return this.ds.query(
      `SELECT p.codigo, p.nivel, p.codigo_padre, p.nombre, p.naturaleza,
              p.es_imputable, p.rango_libre
         FROM cuenta_puc p
         ${where}
        ORDER BY p.codigo
        LIMIT 300`,
      params,
    );
  }

  /**
   * Una cuenta con su ruta completa hasta la clase. La ruta es lo que la UI
   * necesita para mostrar "1 · 11 · 1105 · 110505" sin cuatro consultas.
   */
  async cuenta(codigo: string): Promise<Record<string, unknown>> {
    const [fila] = await this.ds.query<Array<Record<string, unknown>>>(
      `WITH RECURSIVE ruta AS (
         SELECT codigo, nivel, codigo_padre, nombre, naturaleza, es_imputable, rango_libre
           FROM cuenta_puc WHERE codigo = $1
         UNION ALL
         SELECT p.codigo, p.nivel, p.codigo_padre, p.nombre, p.naturaleza, p.es_imputable, p.rango_libre
           FROM cuenta_puc p JOIN ruta r ON p.codigo = r.codigo_padre
       )
       SELECT c.codigo, c.nivel, c.codigo_padre, c.nombre, c.naturaleza,
              c.es_imputable, c.rango_libre,
              (SELECT json_agg(json_build_object('codigo', r.codigo, 'nombre', r.nombre)
                               ORDER BY length(r.codigo))
                 FROM ruta r) AS ruta,
              (SELECT count(*)::int FROM cuenta_puc h WHERE h.codigo_padre = c.codigo) AS hijas
         FROM cuenta_puc c
        WHERE c.codigo = $1`,
      [codigo],
    );
    if (fila === undefined)
      throw new NotFoundException(`La cuenta PUC ${codigo} no existe`);
    return fila;
  }

  /**
   * Las hijas directas. Si la cuenta tiene `rango_libre` no devuelve nada y no
   * es un error: el decreto no numera ese nivel y le toca a la empresa hacerlo
   * en su propio plan. La UI se apoya en la bandera para decirlo con esas
   * palabras en vez de mostrar una rama vacía.
   */
  async hijas(
    codigo: string,
  ): Promise<{ rangoLibre: boolean; hijas: Array<Record<string, unknown>> }> {
    const padre = await this.cuenta(codigo);
    const hijas = await this.ds.query<Array<Record<string, unknown>>>(
      `SELECT codigo, nivel, nombre, naturaleza, es_imputable, rango_libre
         FROM cuenta_puc WHERE codigo_padre = $1 ORDER BY codigo`,
      [codigo],
    );
    return { rangoLibre: padre.rango_libre === true, hijas };
  }

  // ---------------------------------------------------------------------------
  // Casillas del RUT
  // ---------------------------------------------------------------------------

  /**
   * Casilla 53. Por defecto solo las vigentes: las suprimidas existen para poder
   * leer un RUT viejo, no para ofrecerlas en un formulario.
   *
   * La búsqueda mira el número y la descripción a la vez, igual que la de CIIU:
   * quien tiene el RUT delante escribe "48", y quien no, escribe "ventas". El
   * número se compara como texto y por prefijo para que "4" traiga el 4, el 41,
   * el 42 y el 48 — son cuarenta y ocho códigos, no hace falta acertar entero.
   */
  async responsabilidadesRut(
    q?: string,
    incluirNoVigentes = false,
  ): Promise<Array<Record<string, unknown>>> {
    const busqueda = q !== undefined && q.trim() !== '' ? q.trim() : null;

    return this.ds.query(
      `SELECT r.codigo, r.descripcion, r.vigente, r.codigo_reemplazo, r.observacion,
              fe.codigo AS codigo_dian_fe
         FROM responsabilidad_tributaria r
         LEFT JOIN responsabilidad_fiscal_fe fe ON fe.codigo_rut = r.codigo
        WHERE ($1 = true OR r.vigente)
          AND ($2::text IS NULL
               OR r.codigo::text LIKE $2 || '%'
               OR fn_normalizar(r.descripcion) LIKE '%' || fn_normalizar($2) || '%')
        ORDER BY r.codigo`,
      [incluirNoVigentes, busqueda],
    );
  }

  /** Las siete que viajan en el XML de la factura electrónica. */
  async responsabilidadesFe(): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      `SELECT fe.codigo, fe.descripcion, fe.codigo_rut, r.descripcion AS descripcion_rut
         FROM responsabilidad_fiscal_fe fe
         LEFT JOIN responsabilidad_tributaria r ON r.codigo = fe.codigo_rut
        ORDER BY fe.codigo`,
    );
  }

  /** Casilla 25. `aplicaPersona` filtra lo que tiene sentido ofrecer en cada formulario. */
  async tiposDocumento(
    aplicaPersona?: 'NATURAL' | 'JURIDICA',
  ): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      `SELECT codigo, descripcion, codigo_rut, codigo_dian_fe, aplica_persona
         FROM tipo_documento_identidad
        WHERE vigente
          AND ($1::text IS NULL OR aplica_persona = $1 OR aplica_persona = 'AMBAS')
        ORDER BY codigo_rut NULLS LAST, codigo`,
      [aplicaPersona ?? null],
    );
  }

  /** Casilla 63. Solo aplica a personas jurídicas. */
  async formasAsociativas(): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      'SELECT codigo, descripcion FROM forma_asociativa ORDER BY codigo',
    );
  }

  /** Casilla 24. */
  async tiposContribuyente(): Promise<Array<Record<string, unknown>>> {
    return this.ds.query(
      'SELECT codigo, descripcion, tipo_persona FROM tipo_contribuyente ORDER BY codigo',
    );
  }

  // ---------------------------------------------------------------------------
  // Lecturas que usan otros servicios de núcleo
  // ---------------------------------------------------------------------------

  /**
   * Nombre oficial de una clase CIIU, para congelarlo dentro de
   * `empresa_actividad_economica`. Devuelve null si el código no existe, y el
   * llamador decide qué error levantar.
   */
  async nombreCiiu(codigo: string): Promise<string | null> {
    const [fila] = await this.ds.query<Array<{ nombre: string }>>(
      'SELECT nombre FROM ciiu_clase WHERE codigo = $1',
      [codigo],
    );
    return fila?.nombre ?? null;
  }

  /** Los códigos de tipo de documento vigentes. Reemplaza la lista escrita a mano. */
  async codigosTipoDocumento(): Promise<string[]> {
    const filas = await this.ds.query<Array<{ codigo: string }>>(
      'SELECT codigo FROM tipo_documento_identidad WHERE vigente ORDER BY codigo',
    );
    return filas.map((f) => f.codigo);
  }
}
