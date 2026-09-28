import {
  contrarrestoAlAnular,
  reversaProporcional,
  type RetencionParaReversar,
} from './anulacion.reglas';

/**
 * Un `retencion_calculada` de mentira, con la misma lectura que hace
 * `retencionesVivas` en SQL: propias del documento, lo vivo por `anula_a` a
 * cualquier nivel, lo que puso el propio documento y si el origen se anuló.
 * Con esto se corre la historia completa del bug 1 sin base.
 */
interface Fila {
  id: string;
  documento: string;
  anulaA: string | null;
  estado: 'CONFIRMADA' | 'ANULADA';
  base: number;
  valor: number;
}

class Libro {
  filas: Fila[] = [];
  private n = 0;

  poner(f: Omit<Fila, 'id'>): Fila {
    this.n += 1;
    const fila = { ...f, id: `rc-${this.n}` };
    this.filas.push(fila);
    return fila;
  }

  private arbol(raiz: string): Fila[] {
    const r = this.filas.find((f) => f.id === raiz)!;
    return [
      r,
      ...this.filas
        .filter((f) => f.anulaA === raiz)
        .flatMap((h) => this.arbol(h.id)),
    ];
  }

  vivas(documento: string): Array<Fila & RetencionParaReversar> {
    const propias = this.filas.filter(
      (f) =>
        f.documento === documento &&
        !this.filas.some((p) => p.id === f.anulaA && p.documento === documento),
    );
    return propias.map((p) => {
      const arbol = this.arbol(p.id);
      const delDocumento = arbol.filter((a) => a.documento === p.documento);
      let cima = p;
      while (cima.anulaA !== null) {
        cima = this.filas.find((f) => f.id === cima.anulaA)!;
      }
      const origenAnulado =
        cima.id !== p.id &&
        this.arbol(cima.id).some(
          (a) => a.documento === cima.documento && a.estado === 'ANULADA',
        );
      return {
        ...p,
        base: arbol.reduce((s, a) => s + a.base, 0),
        valor: arbol.reduce((s, a) => s + a.valor, 0),
        baseDocumento: delDocumento.reduce((s, a) => s + a.base, 0),
        valorDocumento: delDocumento.reduce((s, a) => s + a.valor, 0),
        origenAnulado,
      };
    });
  }

  /** Lo que hace `MotorRentaService.reversar`. */
  nota(compra: string, nota: string, proporcion: number): void {
    for (const v of this.vivas(compra)) {
      const r = reversaProporcional(v, proporcion);
      if (r === null) continue;
      this.poner({
        documento: nota,
        anulaA: v.id,
        estado: 'ANULADA',
        base: -r.base,
        valor: -r.valor,
      });
    }
  }

  /** Lo que hacen `anularCompra` y `MotorVentaService.anular`. */
  anular(
    documento: string,
    regla: (
      r: RetencionParaReversar,
    ) => { base: number; valor: number } | null = contrarrestoAlAnular,
  ): void {
    for (const v of this.vivas(documento)) {
      const c = regla(v);
      if (c === null) continue;
      this.poner({
        documento,
        anulaA: v.id,
        estado: 'ANULADA',
        base: -c.base,
        valor: -c.valor,
      });
    }
  }

  total(): number {
    return this.filas.reduce((s, f) => s + f.valor, 0);
  }
}

/** La regla de antes del arreglo: devolver siempre lo que la nota quitó. */
const reglaVieja = (r: RetencionParaReversar) =>
  r.valor === 0 ? null : { base: r.base, valor: r.valor };

describe('Anulación de retenciones — bug 1', () => {
  // La compra del e2e: 10 × 100.000, retiene 25.000; la nota devuelve 4 (40 %).
  const armar = (): Libro => {
    const l = new Libro();
    l.poner({
      documento: 'compra',
      anulaA: null,
      estado: 'CONFIRMADA',
      base: 1_000_000,
      valor: 25_000,
    });
    l.nota('compra', 'nota', 0.4);
    return l;
  };

  it('así estaba: anular la compra y después la nota revivía $ 10.000', () => {
    const l = armar();
    l.anular('compra', reglaVieja);
    l.anular('nota', reglaVieja);
    expect(l.total()).toBe(10_000);
  });

  it('anular la compra y después su nota deja la retención en cero', () => {
    const l = armar();
    l.anular('compra');
    expect(l.total()).toBe(0);
    l.anular('nota');
    expect(l.total()).toBe(0);
    // Y la nota anulada no escribió nada: no había nada que devolver.
    expect(l.filas).toHaveLength(3);
  });

  it('en el otro orden (nota primero, compra después) también queda en cero', () => {
    const l = armar();
    l.anular('nota');
    expect(l.total()).toBe(25_000);
    l.anular('compra');
    expect(l.total()).toBe(0);
  });

  it('anular solo la nota devuelve lo que la nota había quitado', () => {
    const l = armar();
    expect(l.total()).toBe(15_000);
    l.anular('nota');
    expect(l.total()).toBe(25_000);
  });

  it('dos notas y la compra anulada, después las notas: sigue en cero', () => {
    const l = armar();
    l.nota('compra', 'nota-2', 0.1);
    expect(l.total()).toBe(12_500);
    l.anular('compra');
    l.anular('nota-2');
    l.anular('nota');
    expect(l.total()).toBe(0);
  });

  it('contrarrestoAlAnular: sin nada vivo, o con el origen anulado, no hay fila', () => {
    const base: RetencionParaReversar = {
      base: -400_000,
      valor: -10_000,
      baseDocumento: -400_000,
      valorDocumento: -10_000,
      origenAnulado: false,
    };
    expect(contrarrestoAlAnular(base)).toEqual({
      base: -400_000,
      valor: -10_000,
    });
    expect(contrarrestoAlAnular({ ...base, origenAnulado: true })).toBeNull();
    expect(contrarrestoAlAnular({ ...base, valor: 0 })).toBeNull();
  });
});

describe('Reversa de una nota crédito — bug 4', () => {
  it('lleva la proporción de la original más su ajuste, en una sola cifra al peso', () => {
    // Retuvo 25.000 y el recálculo ajustó +5.000 (misma base).
    const l = new Libro();
    const o = l.poner({
      documento: 'compra',
      anulaA: null,
      estado: 'CONFIRMADA',
      base: 1_000_000,
      valor: 25_000,
    });
    l.poner({
      documento: 'compra',
      anulaA: o.id,
      estado: 'CONFIRMADA',
      base: 0,
      valor: 5_000,
    });
    l.nota('compra', 'nota', 0.4);
    const reversa = l.filas.filter((f) => f.documento === 'nota');
    expect(reversa).toEqual([
      expect.objectContaining({ valor: -12_000, base: -400_000 }),
    ]);
    expect(l.total()).toBe(18_000);
  });

  it('un ajuste en negativo también baja la reversa (antes se saltaba)', () => {
    const r = reversaProporcional(
      {
        base: 1_000_000,
        valor: 20_000,
        baseDocumento: 1_000_000,
        valorDocumento: 20_000,
        origenAnulado: false,
      },
      0.4,
    );
    expect(r).toEqual({ base: 400_000, valor: 8_000 });
  });

  it('al peso, no en centavos: 12.345 × 50 % = 6.173', () => {
    const r = reversaProporcional(
      {
        base: 493_800,
        valor: 12_345,
        baseDocumento: 493_800,
        valorDocumento: 12_345,
        origenAnulado: false,
      },
      0.5,
    );
    expect(r?.valor).toBe(6_173);
    expect(Number.isInteger(r?.valor)).toBe(true);
  });

  it('nunca reversa más de lo que queda vivo', () => {
    const r = reversaProporcional(
      {
        base: 100_000,
        valor: 2_500,
        baseDocumento: 1_000_000,
        valorDocumento: 25_000,
        origenAnulado: false,
      },
      0.5,
    );
    expect(r).toEqual({ base: 100_000, valor: 2_500 });
    expect(
      reversaProporcional(
        {
          base: 0,
          valor: 0,
          baseDocumento: 1_000_000,
          valorDocumento: 25_000,
          origenAnulado: false,
        },
        0.5,
      ),
    ).toBeNull();
  });
});
