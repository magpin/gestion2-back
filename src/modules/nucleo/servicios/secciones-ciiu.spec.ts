import { evaluarPertinencia, seccionesPertinentes } from './secciones-ciiu';

const secciones = (...s: string[]) => new Set(s);
const pertinente = (codigo: string, cj: Set<string>) =>
  evaluarPertinencia(codigo, cj).pertinente;

describe('seccionesPertinentes · las dos fuentes suman', () => {
  it('junta las secciones de las actividades con las de los sectores', () => {
    // Comercio por el RUT, manufactura porque la empresa la marcó a mano.
    const r = seccionesPertinentes(['G'], ['MANUFACTURA']);
    expect([...r].sort()).toEqual(['C', 'G']);
  });

  it('un sector marcado nunca quita lo que respalda el RUT', () => {
    // El sector dice solo comercio; el RUT declara ademas servicios. Con
    // interseccion se perderia 'S', y esa cuenta existe en el RUT.
    const r = seccionesPertinentes(['G', 'S'], ['COMERCIO']);
    expect(r.has('S')).toBe(true);
  });

  it('SERVICIOS cubre de la H a la U', () => {
    const r = seccionesPertinentes([], ['SERVICIOS']);
    expect(r.has('P')).toBe(true); // educación
    expect(r.has('Q')).toBe(true); // salud
    expect(r.has('C')).toBe(false); // manufactura no
  });

  it('ignora actividades sin sección', () => {
    // Las cinco clases de origen DIAN (asalariado, pensionado) no tienen sección.
    expect(seccionesPertinentes([null, 'G'], []).size).toBe(1);
  });
});

describe('evaluarPertinencia · ingresos y costos', () => {
  const comercio = secciones('G');

  it('el comercio ve su cuenta de ingresos y su costo', () => {
    expect(pertinente('4135', comercio)).toBe(true);
    expect(pertinente('413520', comercio)).toBe(true);
    expect(pertinente('6135', comercio)).toBe(true);
  });

  it('y no ve las de otras actividades', () => {
    expect(pertinente('4160', comercio)).toBe(false); // enseñanza
    expect(pertinente('6160', comercio)).toBe(false);
    expect(pertinente('4105', comercio)).toBe(false); // agricultura
  });

  it('las devoluciones en ventas le sirven a cualquiera que venda', () => {
    expect(pertinente('4175', comercio)).toBe(true);
    expect(pertinente('417505', comercio)).toBe(true);
  });

  it('los ingresos no operacionales y las compras no dependen de la actividad', () => {
    expect(pertinente('4210', comercio)).toBe(true); // financieros
    expect(pertinente('6205', comercio)).toBe(true); // compras de mercancías
  });

  it('la pesca tiene cuenta propia aunque comparta seccion con la agricultura', () => {
    expect(pertinente('4110', secciones('A'))).toBe(true);
    expect(pertinente('4110', comercio)).toBe(false);
  });

  it('dos actividades ven las dos cuentas de ingreso', () => {
    const dos = seccionesPertinentes(['G', 'P'], []);
    expect(pertinente('4135', dos)).toBe(true);
    expect(pertinente('4160', dos)).toBe(true);
  });
});

describe('evaluarPertinencia · costos de produccion e inventarios', () => {
  it('quien no produce no ve la clase 7', () => {
    expect(pertinente('71', secciones('G'))).toBe(false);
    expect(pertinente('7105', secciones('G'))).toBe(false);
  });

  it('la construccion si la ve, aunque no sea una fabrica', () => {
    expect(pertinente('71', secciones('F'))).toBe(true);
  });

  it('el comercio ve mercancias, no materias primas', () => {
    expect(pertinente('1435', secciones('G'))).toBe(true);
    expect(pertinente('1405', secciones('G'))).toBe(false);
  });

  it('la manufactura ve materias primas, no mercancias', () => {
    expect(pertinente('1405', secciones('C'))).toBe(true);
    expect(pertinente('1435', secciones('C'))).toBe(false);
  });

  it('repuestos, envases y provisiones le sirven a cualquiera', () => {
    for (const c of ['1455', '1460', '1465', '1499']) {
      expect(pertinente(c, secciones('G'))).toBe(true);
    }
  });
});

describe('evaluarPertinencia · lo que nunca se filtra', () => {
  const comercio = secciones('G');

  it('caja, cartera, impuestos, patrimonio y gastos son iguales para todos', () => {
    for (const c of [
      '110505',
      '130505',
      '2408',
      '3105',
      '5105',
      '8105',
      '9105',
    ]) {
      expect(pertinente(c, comercio)).toBe(true);
    }
  });

  it('sin actividad ni sectores, todo es pertinente', () => {
    // Mostrar de menos es peor que mostrar de mas: la empresa nueva todavia no
    // declaro nada y esconderle cuentas la deja sin poder elegir.
    const ninguna = secciones();
    expect(pertinente('4160', ninguna)).toBe(true);
    expect(pertinente('7105', ninguna)).toBe(true);
    expect(pertinente('1405', ninguna)).toBe(true);
  });

  it('lo no pertinente explica por que, sin repetir la actividad de la empresa', () => {
    // La actividad viaja una sola vez arriba de la lista: repetirla en cada una
    // de las cuatrocientas filas la vuelve ilegible con quince secciones.
    const r = evaluarPertinencia('4160', secciones('G'));
    expect(r.pertinente).toBe(false);
    expect(r.motivo).toBe('Es de otra actividad económica.');
  });
});
