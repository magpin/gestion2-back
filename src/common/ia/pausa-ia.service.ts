import {
  Global,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
} from '@nestjs/common';

import { TxService } from '../db/tx.service';

export type UsoPausable = 'CHAT' | 'LECTURA';

/**
 * El interruptor de la IA que maneja el superadministrador desde Sistema.
 *
 * Una pausa vale para una cuenta o para toda la plataforma (`tenant_id` NULL)
 * y para el chat, la lectura de documentos o los dos. El chat y la lectura la
 * consultan **antes** de llamar al modelo: con la pausa puesta no se gasta un
 * token. Cuando está puesta, el asistente dice que está en pausa, no que falló.
 *
 * Es una consulta por pregunta, contra un índice parcial de las pausas
 * vigentes, que casi siempre está vacío.
 */
@Injectable()
export class PausaIaService {
  constructor(private readonly tx: TxService) {}

  async pausada(tenantId: string, uso: UsoPausable): Promise<boolean> {
    const filas = await this.tx.sinContexto((t) =>
      t.query<unknown[]>(
        `SELECT 1 FROM ia_pausa
          WHERE levantada_en IS NULL
            AND (tenant_id IS NULL OR tenant_id = $1)
            AND $2 = ANY(usos)
          LIMIT 1`,
        [tenantId, uso],
      ),
    );
    return filas.length > 0;
  }

  /** Lanza 503 con un mensaje para la persona si el uso está en pausa. */
  async exigirActiva(tenantId: string, uso: UsoPausable): Promise<void> {
    if (await this.pausada(tenantId, uso)) {
      throw new HttpException(
        uso === 'CHAT'
          ? 'El asistente está en pausa por mantenimiento. Vuelva a intentarlo más tarde.'
          : 'La lectura de documentos está en pausa por mantenimiento. Mientras tanto puede llenar los datos a mano.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

/** Global: el chat y la lectura de documentos lo usan sin importar nada más. */
@Global()
@Module({
  providers: [PausaIaService],
  exports: [PausaIaService],
})
export class PausaIaModule {}
