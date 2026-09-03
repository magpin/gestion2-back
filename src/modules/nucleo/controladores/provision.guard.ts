import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { ENTORNO, type Entorno } from '../../../config/env';

/**
 * Exige la clave de instalación en `x-clave-provision`.
 *
 * Es un guard y no una comprobación dentro del controlador porque los guards
 * corren **antes** que la validación del cuerpo. Al revés, quien no tiene la
 * clave recibiría igual los errores de validación del DTO, y eso le enseña el
 * esquema completo del alta de cuentas a alguien que no debería estar ahí.
 */
@Injectable()
export class ProvisionGuard implements CanActivate {
  constructor(@Inject(ENTORNO) private readonly env: Entorno) {}

  canActivate(contexto: ExecutionContext): boolean {
    if (this.env.claveProvision === undefined) {
      throw new ServiceUnavailableException(
        'El alta de cuentas no esta habilitada: falta CLAVE_PROVISION en el entorno.',
      );
    }

    const req = contexto.switchToHttp().getRequest<Request>();
    const clave = req.headers['x-clave-provision'];

    if (clave !== this.env.claveProvision) {
      throw new UnauthorizedException('Clave de aprovisionamiento invalida');
    }
    return true;
  }
}
