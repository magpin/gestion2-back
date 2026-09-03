import { randomBytes } from 'node:crypto';

import { CifradoService } from './cifrado.service';
import type { Entorno } from '../../config/env';

const entorno = { claveCifrado: randomBytes(32) } as Entorno;

describe('CifradoService', () => {
  const cifrado = new CifradoService(entorno);

  it('devuelve el mismo texto al descifrar', () => {
    const original = 'PIN-DIAN-12345';
    expect(cifrado.descifrar(cifrado.cifrar(original))).toBe(original);
  });

  it('produce un texto cifrado distinto cada vez', () => {
    // IV aleatorio por llamada: dos cifrados del mismo valor no se parecen, asi
    // que nadie puede deducir que dos empresas comparten el mismo PIN.
    expect(cifrado.cifrar('igual')).not.toBe(cifrado.cifrar('igual'));
  });

  it('rechaza un texto cifrado alterado', () => {
    const guardado = cifrado.cifrar('no me toques');
    const partes = guardado.split(':');
    const alterado = [
      partes[0],
      partes[1],
      partes[2],
      Buffer.from('otra cosa').toString('base64'),
    ].join(':');
    // GCM autentica ademas de cifrar: alterar la base rompe el descifrado en vez
    // de devolver basura silenciosamente.
    expect(() => cifrado.descifrar(alterado)).toThrow();
  });

  it('rechaza un formato desconocido', () => {
    expect(() => cifrado.descifrar('texto plano')).toThrow(
      'Formato de dato cifrado desconocido',
    );
  });

  it('no cifra lo que viene vacio', () => {
    expect(cifrado.cifrarOpcional(undefined)).toBeNull();
    expect(cifrado.cifrarOpcional(null)).toBeNull();
    expect(cifrado.cifrarOpcional('')).toBeNull();
    expect(cifrado.cifrarOpcional('algo')).not.toBeNull();
  });

  it('no descifra con otra clave', () => {
    const otro = new CifradoService({
      claveCifrado: randomBytes(32),
    } as Entorno);
    expect(() => otro.descifrar(cifrado.cifrar('secreto'))).toThrow();
  });
});
