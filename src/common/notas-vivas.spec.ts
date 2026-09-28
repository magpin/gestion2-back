import { mensajeNotasVivas } from './notas-vivas';

describe('mensajeNotasVivas', () => {
  it('nombra la única nota viva', () => {
    expect(
      mensajeNotasVivas('factura', [{ tipo: 'NOTA_CREDITO', numero: 'NC-5' }]),
    ).toBe('Esta factura tiene la nota crédito NC-5 viva: anulala primero.');
  });

  it('nombra todas cuando son varias, crédito y débito', () => {
    expect(
      mensajeNotasVivas('compra', [
        { tipo: 'NOTA_CREDITO', numero: 'NC-5' },
        { tipo: 'NOTA_CREDITO', numero: 'NC-6' },
        { tipo: 'NOTA_DEBITO', numero: 'ND-1' },
      ]),
    ).toBe(
      'Esta compra tiene vivas la nota crédito NC-5, la nota crédito NC-6 y la nota débito ND-1: anulalas primero.',
    );
  });
});
