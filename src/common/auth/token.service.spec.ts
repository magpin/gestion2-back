import { JwtService } from '@nestjs/jwt';

import type { Entorno } from '../../config/env';
import { TokenService } from './token.service';

const entorno = {
  jwt: {
    secreto: 'secreto-de-pruebas-de-al-menos-32-caracteres',
    expiraEn: '8h',
  },
} as Entorno;

describe('TokenService', () => {
  const tokens = new TokenService(new JwtService({}), entorno);

  it('el token de sesion no trae empresa', () => {
    const ctx = tokens.verificar(tokens.firmarSesion('u-1', 't-1'));
    expect(ctx.usuarioId).toBe('u-1');
    expect(ctx.tenantId).toBe('t-1');
    expect(ctx.empresaId).toBeUndefined();
    expect(ctx.roles).toEqual([]);
  });

  it('el token de sesion lleva los roles de ambito cuenta', () => {
    // Es lo que permite crear la primera empresa cuando todavia no hay ninguna.
    const ctx = tokens.verificar(
      tokens.firmarSesion('u-1', 't-1', ['ADMIN_TENANT']),
    );
    expect(ctx.roles).toEqual(['ADMIN_TENANT']);
    expect(ctx.empresaId).toBeUndefined();
  });

  it('el token de trabajo trae empresa y roles', () => {
    const token = tokens.firmarEmpresa({
      usuarioId: 'u-1',
      tenantId: 't-1',
      empresaId: 'e-1',
      roles: ['DIRECTOR', 'CONTADOR'],
    });
    const ctx = tokens.verificar(token);
    expect(ctx.empresaId).toBe('e-1');
    expect(ctx.roles).toEqual(['DIRECTOR', 'CONTADOR']);
  });

  it('rechaza un token firmado con otro secreto', () => {
    const ajeno = new TokenService(new JwtService({}), {
      jwt: {
        secreto: 'otro-secreto-distinto-de-32-caracteres-o-mas',
        expiraEn: '8h',
      },
    } as Entorno);
    const token = ajeno.firmarSesion('u-1', 't-1');
    expect(() => tokens.verificar(token)).toThrow();
  });

  it('rechaza un token alterado', () => {
    const token = tokens.firmarSesion('u-1', 't-1');
    const [cabecera, , firma] = token.split('.');
    const cuerpoFalso = Buffer.from(
      JSON.stringify({ sub: 'u-2', ten: 't-1', rol: ['DIRECTOR'] }),
    ).toString('base64url');
    expect(() =>
      tokens.verificar([cabecera, cuerpoFalso, firma].join('.')),
    ).toThrow();
  });
});
