import { QueryFailedError } from 'typeorm';

import { ErrorPostgresFilter } from './error-postgres.filter';

/** Corre el filtro con un error del driver y devuelve lo que respondió. */
function responder(driver: {
  code: string;
  constraint?: string;
  message: string;
}) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  };
  const error = new QueryFailedError(
    'INSERT ...',
    [],
    new Error(driver.message),
  );
  (error as unknown as { driverError: unknown }).driverError = driver;
  new ErrorPostgresFilter().catch(error, host as never);
  const [cuerpo] = res.json.mock.calls[0] as [
    { estado: number; error: string },
  ];
  return cuerpo;
}

describe('ErrorPostgresFilter', () => {
  it('un trigger con check_violation llega como 400 con su propio mensaje', () => {
    const cuerpo = responder({
      code: '23514',
      message: 'Una reversa no se reversa: se registra el movimiento de nuevo.',
    });
    expect(cuerpo).toEqual({
      estado: 400,
      error: 'Una reversa no se reversa: se registra el movimiento de nuevo.',
      restriccion: undefined,
    });
  });

  it('un CHECK con nombre conocido usa el mensaje escrito para él', () => {
    const cuerpo = responder({
      code: '23514',
      constraint: 'ck_caja_mov_reversa',
      message: 'new row violates check constraint "ck_caja_mov_reversa"',
    });
    expect(cuerpo.estado).toBe(400);
    expect(cuerpo.error).toMatch(/motivo/);
  });

  it('un CHECK con nombre desconocido no expone el texto del motor', () => {
    const cuerpo = responder({
      code: '23514',
      constraint: 'ck_algo_nuevo',
      message: 'new row for relation "x" violates check constraint',
    });
    expect(cuerpo.error).toBe('Los datos violan una regla de validacion.');
  });

  it('el corte repetido es un 409 que se entiende', () => {
    const cuerpo = responder({
      code: '23505',
      constraint: 'uq_banco_corte_dia',
      message: 'duplicate key',
    });
    expect(cuerpo.estado).toBe(409);
    expect(cuerpo.error).toMatch(/ya se cortó/);
  });
});
