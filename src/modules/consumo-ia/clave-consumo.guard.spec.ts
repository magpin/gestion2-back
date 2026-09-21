import {
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';

import type { Entorno } from '../../config/env';
import {
  SQL_DETALLE_LECTURAS,
  SQL_DETALLE_RESPUESTAS,
  SQL_EMPRESAS,
  SQL_LECTURAS,
  SQL_RESPUESTAS,
  rango,
} from './servicios/consumo-ia.service';
import { ClaveConsumoGuard, iguales } from './clave-consumo.guard';

const CLAVE = 'una-clave-larga-de-prueba-de-32-caracteres!!';

function contexto(clave?: string, ip = '10.0.0.1'): ExecutionContext {
  const req = {
    ip,
    headers: clave === undefined ? {} : { 'x-clave-consumo': clave },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guardia = (clave: string | undefined) =>
  new ClaveConsumoGuard({ claveConsumoIa: clave } as unknown as Entorno);

describe('ClaveConsumoGuard', () => {
  it('sin la clave configurada, la puerta no existe: 503', () => {
    expect(() => guardia(undefined).canActivate(contexto(CLAVE))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('con la clave correcta, pasa', () => {
    expect(guardia(CLAVE).canActivate(contexto(CLAVE))).toBe(true);
  });

  it('sin cabecera o con otra clave, 401', () => {
    const g = guardia(CLAVE);
    expect(() => g.canActivate(contexto())).toThrow(UnauthorizedException);
    expect(() => g.canActivate(contexto('otra'))).toThrow(
      UnauthorizedException,
    );
  });

  it('diez claves erradas desde una IP la dejan afuera, aunque después acierte; otra IP sigue entrando', () => {
    const g = guardia(CLAVE);
    for (let i = 0; i < 10; i += 1) {
      expect(() => g.canActivate(contexto('mal'))).toThrow(
        UnauthorizedException,
      );
    }
    expect(() => g.canActivate(contexto(CLAVE))).toThrow(HttpException);
    expect(g.canActivate(contexto(CLAVE, '10.0.0.2'))).toBe(true);
  });

  it('compara en tiempo constante, sea cual sea el largo', () => {
    expect(iguales('abc', 'abc')).toBe(true);
    expect(iguales('abc', 'abcd')).toBe(false);
    expect(iguales('', CLAVE)).toBe(false);
  });
});

describe('ConsumoIaService — solo cifras', () => {
  it('ninguna consulta trae el texto de lo conversado ni de lo leído', () => {
    for (const sql of [
      SQL_RESPUESTAS,
      SQL_LECTURAS,
      SQL_EMPRESAS,
      SQL_DETALLE_RESPUESTAS,
      SQL_DETALLE_LECTURAS,
    ]) {
      expect(sql).not.toMatch(
        /\btexto\b|\bmotivo\b|\bextraido\b|\berror\b|\bcuerpo\b/,
      );
    }
  });

  it('el detalle lee de las consultas solo el nombre de la herramienta, nunca lo que se pidió', () => {
    expect(SQL_DETALLE_RESPUESTAS).toMatch(/c\.herramienta/);
    expect(SQL_DETALLE_RESPUESTAS).not.toMatch(
      /\bentrada\b|\bvista_previa\b|\bresultado\b|\bp\.\w*accion/,
    );
  });

  it('el rango: por defecto los últimos 30 días; fechas mal escritas o al revés, 400', () => {
    const r = rango(undefined, '2026-09-21');
    expect(r).toEqual({ desde: '2026-08-23', hasta: '2026-09-21' });
    expect(() => rango('21/09/2026', undefined)).toThrow(/aaaa-mm-dd/);
    expect(() => rango('2026-09-22', '2026-09-21')).toThrow(/antes/);
    expect(() => rango('2020-01-01', '2026-09-21')).toThrow(/400 días/);
  });
});
