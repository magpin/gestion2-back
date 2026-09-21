import { planear, type Accion } from './confirmacion.reglas';
import type { DatoExtraido } from '../proveedores/extractor.puerto';

const HOY = '2026-09-20';

/** Un dato leído, con lo mínimo para que se entienda la prueba. */
const dato = (
  campo: string,
  valor: unknown,
  confianza: 'ALTA' | 'DUDOSA' = 'ALTA',
): DatoExtraido => ({
  paso: 'EMPRESA',
  campo,
  valor,
  etiqueta: campo,
  fuente: { documento: 'RUT' },
  confianza,
});

const planearCon = (datos: DatoExtraido[], seleccion?: string[]) =>
  planear(datos, { hoy: HOY, seleccion });

const accion = <T extends Accion['tipo']>(
  acciones: Accion[],
  tipo: T,
): Extract<Accion, { tipo: T }> | undefined =>
  acciones.find((a): a is Extract<Accion, { tipo: T }> => a.tipo === tipo);

const motivoDe = (
  sinAplicar: { campo: string; motivo: string }[],
  campo: string,
) => sinAplicar.find((s) => s.campo === campo)?.motivo;

describe('planear', () => {
  it('la razón social sola arma la edición de la empresa', () => {
    const { acciones, sinAplicar } = planearCon([
      dato('razonSocial', 'Tecnodigital SAS'),
    ]);

    expect(sinAplicar).toEqual([]);
    expect(accion(acciones, 'EDITAR_EMPRESA')).toEqual({
      tipo: 'EDITAR_EMPRESA',
      campos: ['razonSocial'],
      dto: { razonSocial: 'Tecnodigital SAS' },
    });
  });

  it('lo dudoso no se aplica: se pregunta', () => {
    const { acciones, sinAplicar } = planearCon([
      dato('razonSocial', 'Tecnodigital SAS', 'DUDOSA'),
    ]);

    expect(acciones).toEqual([]);
    expect(motivoDe(sinAplicar, 'razonSocial')).toContain(
      'La lectura no fue segura',
    );
  });

  it('solo se aplica lo que la persona aprobó', () => {
    const { acciones } = planearCon(
      [
        dato('razonSocial', 'Tecnodigital SAS'),
        dato('nombreComercial', 'Tecno'),
      ],
      ['razonSocial'],
    );

    expect(accion(acciones, 'EDITAR_EMPRESA')?.dto).toEqual({
      razonSocial: 'Tecnodigital SAS',
    });
  });

  it('un campo aprobado que no salió del documento se dice, no se ignora', () => {
    const { sinAplicar } = planearCon(
      [dato('razonSocial', 'Tecnodigital SAS')],
      ['razonSocial', 'telefono'],
    );

    expect(motivoDe(sinAplicar, 'telefono')).toBe(
      'No salió de este documento.',
    );
  });

  describe('la sede', () => {
    it('se arma con dirección y municipio, y suma el contacto', () => {
      const { acciones } = planearCon([
        dato('direccion', 'Cra 7 # 71-21'),
        dato('municipioCodigo', '11001'),
        dato('telefono', '3001112233'),
        dato('email', 'hola@tecnodigital.co'),
      ]);

      expect(accion(acciones, 'SEDE_PRINCIPAL')).toEqual({
        tipo: 'SEDE_PRINCIPAL',
        campos: ['direccion', 'municipioCodigo', 'telefono', 'email'],
        dto: {
          direccion: 'Cra 7 # 71-21',
          municipioCodigo: '11001',
          telefono: '3001112233',
          email: 'hola@tecnodigital.co',
        },
      });
    });

    it('sin municipio no hay sede, y el teléfono queda pendiente con ella', () => {
      const { acciones, sinAplicar } = planearCon([
        dato('direccion', 'Cra 7 # 71-21'),
        dato('telefono', '3001112233'),
      ]);

      expect(accion(acciones, 'SEDE_PRINCIPAL')).toBeUndefined();
      expect(motivoDe(sinAplicar, 'direccion')).toContain('Falta la dirección');
      expect(motivoDe(sinAplicar, 'telefono')).toContain('Falta la dirección');
    });

    it('un municipio que no tiene cinco dígitos no pasa', () => {
      const { acciones } = planearCon([
        dato('direccion', 'Cra 7 # 71-21'),
        dato('municipioCodigo', '001'),
      ]);

      expect(accion(acciones, 'SEDE_PRINCIPAL')).toBeUndefined();
    });
  });

  describe('la actividad económica', () => {
    it('limpia el código y le pone la vigencia de hoy', () => {
      const { acciones } = planearCon([dato('codigoCiiu', '47.11')]);

      expect(accion(acciones, 'ACTIVIDAD')?.dto).toEqual({
        codigoCiiu: '4711',
        esPrincipal: true,
        fechaInicio: HOY,
      });
    });

    it('un CIIU corto no se completa a mano', () => {
      const { acciones, sinAplicar } = planearCon([dato('codigoCiiu', '471')]);

      expect(acciones).toEqual([]);
      expect(motivoDe(sinAplicar, 'codigoCiiu')).toContain('cuatro dígitos');
    });
  });

  describe('las responsabilidades del RUT', () => {
    it('toma la lista de la casilla 53, venga como número o como texto', () => {
      const { acciones } = planearCon([
        dato('responsabilidadesRut', ['05', 48, '48']),
      ]);

      expect(accion(acciones, 'RESPONSABILIDADES_RUT')?.dto).toEqual({
        codigos: [5, 48],
        fechaInicio: HOY,
      });
    });

    it('si no se entiende ningún código, queda pendiente', () => {
      const { acciones, sinAplicar } = planearCon([
        dato('responsabilidadesRut', ['ninguna']),
      ]);

      expect(acciones).toEqual([]);
      expect(motivoDe(sinAplicar, 'responsabilidadesRut')).toContain(
        'casilla 53',
      );
    });
  });

  describe('el régimen', () => {
    // No se lee: se deriva de los códigos de la casilla 53 al aplicarlos, en
    // `abrirResponsabilidadRut`. Si alguien vuelve a poner `tipoRegimen` en el
    // catálogo, esto lo avisa antes de que aparezca el renglón falso.
    it('no se planea desde un campo leído, ni aunque llegue uno válido', () => {
      const { acciones, sinAplicar } = planearCon([
        dato('tipoRegimen', 'RESPONSABLE_IVA'),
      ]);

      expect(acciones).toEqual([]);
      expect(sinAplicar).toEqual([]);
    });
  });

  describe('el representante legal', () => {
    it('va con nombre y documento', () => {
      const { acciones } = planearCon([
        dato('representanteNombre', 'Ana Gómez'),
        dato('representanteTipoDocumento', 'CC'),
        dato('representanteNumeroDocumento', '43567890'),
        dato('representanteCargo', 'Gerente'),
      ]);

      expect(accion(acciones, 'REPRESENTANTE')?.dto).toEqual({
        nombreCompleto: 'Ana Gómez',
        tipoDocumento: 'CC',
        numeroDocumento: '43567890',
        cargo: 'Gerente',
        fechaInicio: HOY,
      });
    });

    it('sin número de documento no es medio representante: es una pregunta', () => {
      const { acciones, sinAplicar } = planearCon([
        dato('representanteNombre', 'Ana Gómez'),
        dato('representanteTipoDocumento', 'CC'),
      ]);

      expect(accion(acciones, 'REPRESENTANTE')).toBeUndefined();
      expect(motivoDe(sinAplicar, 'representanteNombre')).toContain(
        'Falta el nombre o el documento',
      );
      expect(sinAplicar).toHaveLength(2);
    });
  });

  describe('la matrícula', () => {
    it('va con número, cámara y fecha', () => {
      const { acciones } = planearCon([
        dato('numeroMatricula', '0001234'),
        dato('camaraComercio', 'Bogotá'),
        dato('fechaMatricula', '2019-03-14'),
        dato('fechaUltimaRenovacion', '2026-03-31'),
      ]);

      expect(accion(acciones, 'MATRICULA')?.dto).toEqual({
        numeroMatricula: '0001234',
        camaraComercio: 'Bogotá',
        fechaMatricula: '2019-03-14',
        fechaUltimaRenovacion: '2026-03-31',
        fechaInicio: HOY,
      });
    });

    it('una fecha que no es AAAA-MM-DD no se interpreta', () => {
      const { acciones, sinAplicar } = planearCon([
        dato('numeroMatricula', '0001234'),
        dato('camaraComercio', 'Bogotá'),
        dato('fechaMatricula', '14 de marzo de 2019'),
      ]);

      expect(accion(acciones, 'MATRICULA')).toBeUndefined();
      expect(motivoDe(sinAplicar, 'fechaMatricula')).toContain(
        'Falta el número',
      );
    });
  });

  describe('la resolución', () => {
    const completa = [
      dato('tipoDocumento', 'FACTURA_VENTA'),
      dato('numeroResolucion', '18764003287665'),
      dato('prefijo', 'FE'),
      dato('rangoDesde', '1'),
      dato('rangoHasta', '5000'),
      dato('fechaResolucion', '2026-01-15'),
      dato('fechaVigenciaDesde', '2026-01-15'),
      dato('fechaVigenciaHasta', '2027-01-15'),
    ];

    it('va entera, con los rangos como números y en producción', () => {
      const { acciones } = planearCon(completa);

      expect(accion(acciones, 'RESOLUCION')?.dto).toEqual({
        tipoDocumento: 'FACTURA_VENTA',
        numeroResolucion: '18764003287665',
        prefijo: 'FE',
        rangoDesde: 1,
        rangoHasta: 5000,
        fechaResolucion: '2026-01-15',
        fechaVigenciaDesde: '2026-01-15',
        fechaVigenciaHasta: '2027-01-15',
        ambiente: 'PRODUCCION',
      });
    });

    it('a medias no va: sin vigencia final no numera nada', () => {
      const { acciones, sinAplicar } = planearCon(
        completa.filter((d) => d.campo !== 'fechaVigenciaHasta'),
      );

      expect(accion(acciones, 'RESOLUCION')).toBeUndefined();
      expect(motivoDe(sinAplicar, 'numeroResolucion')).toContain('incompleta');
      expect(sinAplicar).toHaveLength(7);
    });

    it('un tipo de documento que la DIAN no numera no pasa', () => {
      const { acciones } = planearCon([
        ...completa.filter((d) => d.campo !== 'tipoDocumento'),
        dato('tipoDocumento', 'RECIBO_DE_CAJA'),
      ]);

      expect(accion(acciones, 'RESOLUCION')).toBeUndefined();
    });
  });

  it('un RUT completo arma las cuatro acciones de sus pasos', () => {
    const { acciones, sinAplicar } = planearCon([
      dato('razonSocial', 'Tecnodigital SAS'),
      dato('direccion', 'Cra 7 # 71-21'),
      dato('municipioCodigo', '11001'),
      dato('codigoCiiu', '4711'),
      dato('responsabilidadesRut', [5, 48]),
    ]);

    // Cuatro, y el régimen no es una quinta: sale de los códigos 5 y 48 al
    // aplicarlos, sin campo propio y sin renglón propio.
    expect(acciones.map((a) => a.tipo)).toEqual([
      'EDITAR_EMPRESA',
      'SEDE_PRINCIPAL',
      'ACTIVIDAD',
      'RESPONSABILIDADES_RUT',
    ]);
    expect(sinAplicar).toEqual([]);
  });

  it('sin datos no hay nada que aplicar ni nada que preguntar', () => {
    expect(planearCon([])).toEqual({ acciones: [], sinAplicar: [] });
  });
});
