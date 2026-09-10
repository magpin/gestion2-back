import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';

/** Códigos de error de Postgres que sabemos traducir a algo que el cliente entienda. */
const CODIGOS = {
  VIOLACION_UNICO: '23505',
  VIOLACION_FK: '23503',
  VIOLACION_CHECK: '23514',
  VIOLACION_NOT_NULL: '23502',
  PRIVILEGIO_INSUFICIENTE: '42501',
} as const;

/**
 * Traduce los errores del motor a respuestas HTTP.
 *
 * Buena parte de las reglas del sistema las sostiene Postgres —índices únicos
 * parciales, CHECKs, FK compuestas, RLS—. Sin este filtro, romper una de esas
 * reglas devuelve un 500 y un volcado con el nombre de las tablas. Con él, el
 * cliente recibe un 409 o un 400 explicando qué regla se violó.
 */
@Catch(QueryFailedError)
export class ErrorPostgresFilter implements ExceptionFilter {
  private readonly log = new Logger('Postgres');

  catch(error: QueryFailedError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const driver = error.driverError as {
      code?: string;
      constraint?: string;
      detail?: string;
      message?: string;
    };
    const codigo = driver?.code;
    const restriccion = driver?.constraint ?? '';
    const texto = driver?.message ?? error.message;

    const { estado, mensaje } = this.traducir(codigo, restriccion, texto);

    if (estado === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.log.error(
        `${codigo ?? 'sin codigo'} ${restriccion}: ${error.message}`,
      );
    }

    res.status(estado).json({
      estado,
      error: mensaje,
      // La restriccion se devuelve para que el frontend pueda marcar el campo
      // exacto. No expone datos, solo el nombre de la regla.
      restriccion: restriccion === '' ? undefined : restriccion,
    });
  }

  private traducir(
    codigo: string | undefined,
    restriccion: string,
    texto: string,
  ): { estado: number; mensaje: string } {
    switch (codigo) {
      case CODIGOS.VIOLACION_UNICO:
        return {
          estado: HttpStatus.CONFLICT,
          mensaje: this.mensajeUnico(restriccion),
        };

      case CODIGOS.VIOLACION_FK:
        return {
          estado: HttpStatus.BAD_REQUEST,
          mensaje:
            'Referencia a un registro que no existe o pertenece a otra cuenta.',
        };

      case CODIGOS.VIOLACION_CHECK:
        return {
          estado: HttpStatus.BAD_REQUEST,
          mensaje: this.mensajeCheck(restriccion),
        };

      case CODIGOS.VIOLACION_NOT_NULL:
        return {
          estado: HttpStatus.BAD_REQUEST,
          mensaje: 'Falta un dato obligatorio.',
        };

      case CODIGOS.PRIVILEGIO_INSUFICIENTE:
        // Postgres usa el mismo codigo para dos cosas muy distintas, y confundirlas
        // manda al cliente un mensaje que no tiene nada que ver con lo que paso.
        if (texto.includes('row-level security')) {
          // La fila cae fuera del tenant o de la empresa en sesion. Casi siempre
          // es un bug de contexto, no un intento de intrusion.
          return {
            estado: HttpStatus.FORBIDDEN,
            mensaje: 'El registro no pertenece a la empresa en sesion.',
          };
        }
        // Falta el privilegio: pasa cuando la API intenta un DELETE. No es un
        // error del cliente, es el motor recordando que aca nada se borra.
        return {
          estado: HttpStatus.FORBIDDEN,
          mensaje:
            'Esa operacion no esta permitida: los registros se anulan, no se eliminan.',
        };

      default:
        return {
          estado: HttpStatus.INTERNAL_SERVER_ERROR,
          mensaje: 'Error al acceder a los datos.',
        };
    }
  }

  private mensajeUnico(restriccion: string): string {
    const conocidos: Record<string, string> = {
      uq_empresa_tenant_nit: 'Ya existe una empresa con ese NIT en la cuenta.',
      usuario_email_key: 'Ese correo ya esta registrado.',
      uq_tercero_documento:
        'Ya existe un tercero con ese documento en la empresa.',
      uq_sede_empresa_codigo: 'Ya existe una sede con ese codigo.',
      ux_sede_principal:
        'Ya hay una sede principal activa. Cambiar la actual antes de marcar otra.',
      ux_regimen_vigente:
        'Esa condicion tributaria ya esta vigente. Cerrarla antes de abrir otra.',
      ux_representante_vigente:
        'Ya hay un representante vigente de ese tipo. Cerrarlo primero.',
      ux_matricula_vigente:
        'Ya hay una matricula mercantil vigente. Cerrarla primero.',
      ux_actividad_principal_vigente:
        'Ya hay una actividad economica principal vigente.',
      ux_actividad_ciiu_vigente: 'Esa actividad economica ya esta vigente.',
      ux_resolucion_activa:
        'Ya hay una resolucion activa para ese tipo de documento y ambiente.',
      uq_resolucion_numero: 'Esa resolucion ya esta registrada.',
      uq_producto_codigo: 'Ya existe un producto con ese codigo.',
      ux_caja_principal_por_sede:
        'Ya hay una caja principal activa en esa sede.',
      ux_arqueo_abierto:
        'Ya hay un arqueo abierto para esta caja. Cerralo antes de abrir uno nuevo.',
    };
    return conocidos[restriccion] ?? 'Ese registro ya existe.';
  }

  private mensajeCheck(restriccion: string): string {
    const conocidos: Record<string, string> = {
      ck_empresa_dv: 'El digito de verificacion no corresponde al NIT.',
      ck_tercero_dv: 'El digito de verificacion no corresponde al NIT.',
      ck_tercero_rol: 'Un tercero tiene que ser cliente, proveedor o ambos.',
      ck_tercero_nombre:
        'Persona juridica exige razon social; persona natural exige primer nombre y primer apellido.',
      ck_resolucion_consecutivo:
        'El consecutivo quedaria fuera del rango autorizado por la DIAN.',
      ck_resolucion_rango: 'El rango de numeracion esta invertido.',
      ck_resolucion_vigencia:
        'Las fechas de vigencia de la resolucion estan invertidas.',
      ck_regimen_vigencia:
        'La fecha de fin no puede ser anterior a la de inicio.',
      ck_actividad_vigencia:
        'La fecha de fin no puede ser anterior a la de inicio.',
      ck_representante_vigencia:
        'La fecha de fin no puede ser anterior a la de inicio.',
      ck_matricula_vigencia:
        'La fecha de fin no puede ser anterior a la de inicio.',
      ck_precio_vigencia:
        'La fecha de fin no puede ser anterior a la de inicio.',
      ck_caja_sede:
        'Una caja principal necesita una sede; el fondo de caja menor no.',
    };
    return (
      conocidos[restriccion] ?? 'Los datos violan una regla de validacion.'
    );
  }
}

/** Deja pasar las excepciones HTTP que la propia aplicación lanza. */
export function esHttp(error: unknown): error is HttpException {
  return error instanceof HttpException;
}
