import { UnauthorizedException } from '@nestjs/common';

import type { TokenService } from '../../../common/auth/token.service';
import type { PasswordService } from '../../../common/cripto/password.service';
import type { TxService } from '../../../common/db/tx.service';
import { AutenticacionService } from './autenticacion.service';

/** Devuelve respuestas fijas según lo que pida el SQL. */
function txFalso(respuestas: Array<{ contiene: string; filas: unknown[] }>) {
  const query = jest.fn(async (sql: string) => {
    const encontrada = respuestas.find((r) => sql.includes(r.contiene));
    return encontrada?.filas ?? [];
  });
  const tx = { query };
  return {
    query,
    servicio: {
      sinContexto: (fn: (t: unknown) => unknown) => fn(tx),
      enContexto: (_ctx: unknown, fn: (t: unknown) => unknown) => fn(tx),
    } as unknown as TxService,
  };
}

const tokens = {
  firmarSesion: jest.fn(() => 'token-de-sesion'),
  firmarEmpresa: jest.fn(() => 'token-de-empresa'),
  firmarPlataforma: jest.fn(() => 'token-de-plataforma'),
} as unknown as TokenService;

const adminActivo = {
  id: 'adm-1',
  email: 'admin@gestion.co',
  nombre_completo: 'Admin',
  hash_password: 'hash-admin',
  activo: true,
};

const usuarioActivo = {
  id: 'u-1',
  tenant_id: 't-1',
  hash_password: 'hash',
  activo: true,
  tenant_estado: 'ACTIVO',
};

describe('AutenticacionService.login', () => {
  beforeEach(() => jest.clearAllMocks());

  it('autentica y devuelve las empresas accesibles', async () => {
    const { servicio: tx } = txFalso([
      { contiene: 'fn_usuario_para_login', filas: [usuarioActivo] },
      {
        contiene: 'usuario_empresa_rol',
        filas: [
          {
            id: 'e-1',
            razon_social: 'ACME',
            nit: '900123456',
            dv: '7',
            roles: ['DIRECTOR'],
          },
        ],
      },
      {
        contiene: 'usuario_rol_tenant',
        filas: [{ rol_codigo: 'ADMIN_TENANT' }],
      },
      {
        contiene: 'nombre_completo, email',
        filas: [{ id: 'u-1', nombre_completo: 'Ana', email: 'a@b.co' }],
      },
    ]);
    const passwords = {
      verificar: jest.fn(async () => true),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    const resultado = await auth.login('a@b.co', 'clave-correcta');

    expect(resultado.ambito).toBe('CLIENTE');
    if (resultado.ambito !== 'CLIENTE')
      throw new Error('se esperaba una sesion de cliente');
    expect(resultado.token).toBe('token-de-sesion');
    expect(resultado.empresas).toHaveLength(1);
    expect(resultado.empresas[0].razonSocial).toBe('ACME');
  });

  // El login es uno solo para clientes y para quien administra el producto. Lo
  // que sigue cubre esa bifurcacion, que es donde estaria el agujero si se
  // rompiera: un token de plataforma emitido a un cliente, o al reves.

  it('el mismo endpoint devuelve una sesion de plataforma si el correo es de un administrador', async () => {
    const { servicio: tx } = txFalso([
      { contiene: 'plataforma_admin', filas: [adminActivo] },
    ]);
    const passwords = {
      verificar: jest.fn(async () => true),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    const resultado = await auth.login('admin@gestion.co', 'clave-correcta');

    expect(resultado.ambito).toBe('PLATAFORMA');
    if (resultado.ambito !== 'PLATAFORMA')
      throw new Error('se esperaba una sesion de plataforma');
    expect(resultado.token).toBe('token-de-plataforma');
    expect(resultado.admin.adminId).toBe('adm-1');
  });

  it('no cae al almacen de clientes cuando la clave del administrador esta mal', async () => {
    // Si cayera, un correo registrado en las dos tablas podria tantear ambas.
    const { servicio: tx, query } = txFalso([
      { contiene: 'plataforma_admin', filas: [adminActivo] },
      { contiene: 'fn_usuario_para_login', filas: [usuarioActivo] },
    ]);
    const passwords = {
      verificar: jest.fn(async () => false),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(auth.login('admin@gestion.co', 'mala')).rejects.toThrow(
      'Correo o contrasena incorrectos',
    );
    const consultas = query.mock.calls.map(([sql]) => sql);
    expect(consultas.some((s) => s.includes('fn_usuario_para_login'))).toBe(
      false,
    );
  });

  it('un administrador desactivado no entra aunque la clave sea correcta', async () => {
    const { servicio: tx } = txFalso([
      {
        contiene: 'plataforma_admin',
        filas: [{ ...adminActivo, activo: false }],
      },
    ]);
    const passwords = {
      verificar: jest.fn(async () => true),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(
      auth.login('admin@gestion.co', 'clave-correcta'),
    ).rejects.toThrow('Correo o contrasena incorrectos');
  });

  it('rechaza con el mismo mensaje si el correo no existe', async () => {
    const { servicio: tx } = txFalso([
      { contiene: 'fn_usuario_para_login', filas: [] },
    ]);
    const passwords = {
      verificar: jest.fn(async () => false),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(auth.login('nadie@b.co', 'x')).rejects.toThrow(
      'Correo o contrasena incorrectos',
    );
  });

  it('verifica un hash de descarte cuando el correo no existe', async () => {
    // Sin esa verificacion, el tiempo de respuesta delata que el correo no esta
    // registrado y regala la lista de usuarios.
    const { servicio: tx } = txFalso([
      { contiene: 'fn_usuario_para_login', filas: [] },
    ]);
    const verificar = jest.fn(async () => false);
    const auth = new AutenticacionService(tx, tokens, {
      verificar,
    } as unknown as PasswordService);

    await expect(auth.login('nadie@b.co', 'x')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verificar).toHaveBeenCalled();
  });

  it('rechaza con el mismo mensaje si la clave esta mal', async () => {
    const { servicio: tx } = txFalso([
      { contiene: 'fn_usuario_para_login', filas: [usuarioActivo] },
    ]);
    const passwords = {
      verificar: jest.fn(async () => false),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(auth.login('a@b.co', 'mala')).rejects.toThrow(
      'Correo o contrasena incorrectos',
    );
  });

  it('rechaza a un usuario desactivado', async () => {
    const { servicio: tx } = txFalso([
      {
        contiene: 'fn_usuario_para_login',
        filas: [{ ...usuarioActivo, activo: false }],
      },
    ]);
    const passwords = {
      verificar: jest.fn(async () => true),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(auth.login('a@b.co', 'clave-correcta')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si la cuenta esta cancelada', async () => {
    const { servicio: tx } = txFalso([
      {
        contiene: 'fn_usuario_para_login',
        filas: [{ ...usuarioActivo, tenant_estado: 'CANCELADO' }],
      },
    ]);
    const passwords = {
      verificar: jest.fn(async () => true),
    } as unknown as PasswordService;
    const auth = new AutenticacionService(tx, tokens, passwords);

    await expect(auth.login('a@b.co', 'clave-correcta')).rejects.toThrow(
      'La cuenta esta cancelada',
    );
  });
});

describe('AutenticacionService.elegirEmpresa', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rechaza una empresa a la que el usuario no tiene acceso', async () => {
    const { servicio: tx } = txFalso([
      { contiene: 'usuario_empresa_rol', filas: [] },
    ]);
    const auth = new AutenticacionService(tx, tokens, {} as PasswordService);

    await expect(
      auth.elegirEmpresa(
        { tenantId: 't-1', usuarioId: 'u-1', roles: [] },
        'e-ajena',
      ),
    ).rejects.toThrow('Sin acceso a esa empresa');
  });

  it('suma los roles de cuenta a los de la empresa', async () => {
    const { servicio: tx } = txFalso([
      {
        contiene: 'usuario_empresa_rol',
        filas: [
          {
            id: 'e-1',
            razon_social: 'ACME',
            nit: '900123456',
            dv: '7',
            roles: ['VENTAS'],
          },
        ],
      },
      {
        contiene: 'usuario_rol_tenant',
        filas: [{ rol_codigo: 'ADMIN_TENANT' }],
      },
    ]);
    const auth = new AutenticacionService(tx, tokens, {} as PasswordService);

    const { roles } = await auth.elegirEmpresa(
      { tenantId: 't-1', usuarioId: 'u-1', roles: [] },
      'e-1',
    );

    expect(roles.sort()).toEqual(['ADMIN_TENANT', 'VENTAS']);
  });
});
