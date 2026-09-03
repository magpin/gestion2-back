// Recorre el nucleo completo por HTTP, como lo hara el frontend.
//
// No reemplaza a los tests unitarios: prueba lo que ellos no pueden —que los
// guards, el filtro de errores, RLS y las politicas de la base funcionen juntos
// contra un servidor de verdad.
require('dotenv').config();
const crypto = require('crypto');

const BASE = `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;
const marca = Date.now();

let pasadas = 0;
let fallidas = 0;

function revisar(condicion, descripcion, detalle = '') {
  if (condicion) {
    pasadas += 1;
    console.log(`  OK    ${descripcion}`);
  } else {
    fallidas += 1;
    console.log(`  FALLA ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
  }
}

async function pedir(metodo, ruta, { token, cuerpo, cabeceras } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  return { estado: res.status, datos };
}

(async () => {
  console.log(`\n=== Nucleo · prueba de punta a punta contra ${BASE} ===\n`);

  // -------------------------------------------------------------------------
  console.log('1 · Salud y aislamiento');
  const salud = await pedir('GET', '/salud');
  revisar(salud.estado === 200 && salud.datos?.estado === 'ok', 'la API responde y la base conecta');
  revisar(
    salud.datos?.base?.aislamientoActivo === true,
    `la API corre con un rol sujeto a RLS (usuario: ${salud.datos?.base?.usuario})`,
  );

  // -------------------------------------------------------------------------
  console.log('\n2 · Alta de cuenta');
  const correo = `ana.torres+${marca}@prueba.co`;
  // Generada, no escrita: una contrasena literal en el repositorio termina
  // copiada a un entorno real.
  const password = crypto.randomBytes(18).toString('base64url');

  const sinClave = await pedir('POST', '/tenants', {
    cuerpo: { nombre: 'X', slug: `x-${marca}`, email: correo, nombreAdministrador: 'X', password },
  });
  revisar(sinClave.estado === 401, 'sin la clave de aprovisionamiento el alta se rechaza', `dio ${sinClave.estado}`);

  const alta = await pedir('POST', '/tenants', {
    cabeceras: { 'x-clave-provision': process.env.CLAVE_PROVISION },
    cuerpo: {
      nombre: 'Contadores Asociados',
      slug: `contadores-${marca}`,
      plan: 'CONTADOR',
      maxEmpresas: 15,
      maxUsuarios: 10,
      email: correo,
      nombreAdministrador: 'Ana Torres',
      password,
    },
  });
  revisar(alta.estado === 201, 'se crea la cuenta y su primer administrador', JSON.stringify(alta.datos));

  // -------------------------------------------------------------------------
  console.log('\n3 · Entrar');
  const malo = await pedir('POST', '/auth/login', { cuerpo: { email: correo, password: 'incorrecta' } });
  revisar(malo.estado === 401, 'una clave incorrecta se rechaza');

  const inexistente = await pedir('POST', '/auth/login', {
    cuerpo: { email: `nadie+${marca}@prueba.co`, password },
  });
  revisar(
    inexistente.datos?.message === malo.datos?.message,
    'el mensaje es el mismo si el correo no existe (no delata usuarios)',
  );

  const login = await pedir('POST', '/auth/login', { cuerpo: { email: correo, password } });
  revisar(login.estado === 200 && !!login.datos?.token, 'entra y recibe token de sesion');
  revisar(Array.isArray(login.datos?.empresas) && login.datos.empresas.length === 0, 'todavia no tiene empresas');
  const tokenSesion = login.datos?.token;

  const yo = await pedir('GET', '/auth/yo', { token: tokenSesion });
  revisar(yo.datos?.roles?.includes('ADMIN_TENANT'), 'el primer usuario es ADMIN_TENANT');
  revisar(yo.datos?.empresaId === null, 'el token de sesion no trae empresa');

  const sinToken = await pedir('GET', '/empresas');
  revisar(sinToken.estado === 401, 'sin token no se entra a nada');

  // -------------------------------------------------------------------------
  console.log('\n4 · Crear la empresa');
  const empresa = await pedir('POST', '/empresas', {
    token: tokenSesion,
    cuerpo: {
      tipoPersona: 'JURIDICA',
      razonSocial: 'ACME Repuestos S.A.S.',
      nombreComercial: 'ACME Repuestos',
      nit: '900123456',
      dv: '8',
      sectorEconomico: 'COMERCIO',
      grupoNiif: 'GRUPO_2',
      fechaInicioOperaciones: '2019-03-01',
    },
  });
  revisar(empresa.estado === 201, 'crea la empresa con su configuracion contable', JSON.stringify(empresa.datos));
  const empresaId = empresa.datos?.id;

  const dvMalo = await pedir('POST', '/empresas', {
    token: tokenSesion,
    cuerpo: {
      tipoPersona: 'JURIDICA',
      razonSocial: 'DV errado',
      nit: '901884220',
      dv: '1',
      sectorEconomico: 'COMERCIO',
      grupoNiif: 'GRUPO_2',
      fechaInicioOperaciones: '2020-01-01',
    },
  });
  revisar(dvMalo.estado === 400, 'un NIT con DV errado no entra', JSON.stringify(dvMalo.datos));

  // -------------------------------------------------------------------------
  console.log('\n5 · Elegir empresa');
  const elegir = await pedir('POST', '/auth/empresa', { token: tokenSesion, cuerpo: { empresaId } });
  revisar(elegir.estado === 200 && !!elegir.datos?.token, 'cambia el token de sesion por uno de trabajo');
  revisar(
    elegir.datos?.roles?.includes('DIRECTOR') && elegir.datos?.roles?.includes('ADMIN_TENANT'),
    'suma el rol de cuenta al de la empresa',
    JSON.stringify(elegir.datos?.roles),
  );
  const token = elegir.datos?.token;

  const conSesion = await pedir('GET', '/terceros', { token: tokenSesion });
  revisar(conSesion.estado === 403, 'con el token de sesion no se puede operar una contabilidad');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('5b · Estado de configuracion, recien creada');
  const buscar = (e, clave) => e.datos?.pasos?.find((p) => p.clave === clave);
  const est0 = await pedir('GET', '/empresas/actual/estado-configuracion', { token });
  revisar(est0.estado === 200 && est0.datos?.pasos?.length === 6, 'devuelve los seis pasos');
  revisar(buscar(est0, 'EMPRESA')?.estado === 'LISTO', 'empresa nace lista: se creo con su configuracion contable');
  revisar(buscar(est0, 'SEDES')?.estado === 'PENDIENTE', 'sedes pendiente');
  revisar(
    buscar(est0, 'TERCEROS')?.estado === 'BLOQUEADO' &&
      buscar(est0, 'TERCEROS')?.bloqueadoPor === 'SITUACION_LEGAL',
    'terceros bloqueado hasta que la situacion legal este lista',
  );
  revisar(est0.datos?.completa === false && est0.datos?.porcentaje === 25, 'va en 25 %', String(est0.datos?.porcentaje));
  revisar(est0.datos?.siguiente === 'SEDES', 'el siguiente paso es sedes', String(est0.datos?.siguiente));

  console.log('\n6 · Situacion legal');
  const regimen = await pedir('POST', '/empresa-legal/regimenes', {
    token,
    cuerpo: { tipoRegimen: 'RESPONSABLE_IVA', codigoResponsabilidadDian: 'O-48', fechaInicio: '2021-07-01' },
  });
  revisar(regimen.estado === 201, 'abre la condicion tributaria');

  const vigenteHoy = await pedir('GET', '/empresa-legal/regimenes/vigente?fecha=2026-08-25', { token });
  revisar(vigenteHoy.datos?.includes('RESPONSABLE_IVA'), 'hoy la empresa es responsable de IVA');

  const vigenteAntes = await pedir('GET', '/empresa-legal/regimenes/vigente?fecha=2020-01-01', { token });
  revisar(
    Array.isArray(vigenteAntes.datos) && vigenteAntes.datos.length === 0,
    'en 2020 no lo era: la condicion se responde con la fecha, no con el hoy',
  );

  const rep = await pedir('POST', '/empresa-legal/representantes', {
    token,
    cuerpo: {
      nombreCompleto: 'Luisa Pena Gomez',
      tipoDocumento: 'CC',
      numeroDocumento: '43118077',
      cargo: 'Gerente general',
      fechaInicio: '2024-05-15',
    },
  });
  revisar(rep.estado === 201, 'registra el representante legal');

  // Abrir otro cierra el anterior: dos no pueden regir el mismo dia.
  await pedir('POST', '/empresa-legal/representantes', {
    token,
    cuerpo: {
      nombreCompleto: 'Jorge Salas',
      tipoDocumento: 'CC',
      numeroDocumento: '71884209',
      fechaInicio: '2026-01-15',
    },
  });
  const reps = await pedir('GET', '/empresa-legal/representantes?vigentes=false', { token });
  const vigentes = (reps.datos || []).filter((r) => r.fecha_fin === null);
  revisar(vigentes.length === 1, 'abrir un representante cierra al anterior', `vigentes: ${vigentes.length}`);

  // -------------------------------------------------------------------------
  console.log('\n7 · Sede');
  const municipios = await pedir('GET', '/municipios?q=medellin', { token });
  revisar(municipios.datos?.[0]?.codigo === '05001', 'el catalogo DANE responde y busca sin tildes');

  const sede = await pedir('POST', '/empresas/actual/sedes', {
    token,
    cuerpo: {
      codigo: '001',
      nombre: 'Principal',
      direccion: 'Cra. 43A #18-95',
      municipioCodigo: '05001',
      esPrincipal: true,
    },
  });
  revisar(sede.estado === 201, 'crea la sede principal', JSON.stringify(sede.datos));

  // -------------------------------------------------------------------------
  console.log('\n8 · Resolucion DIAN');
  const resolucion = await pedir('POST', '/resoluciones', {
    token,
    cuerpo: {
      tipoDocumento: 'FACTURA_VENTA',
      numeroResolucion: '18764000001234',
      prefijo: 'SETP',
      rangoDesde: 1,
      rangoHasta: 5000,
      fechaResolucion: '2026-01-15',
      fechaVigenciaDesde: '2026-01-15',
      fechaVigenciaHasta: '2026-11-30',
      ambiente: 'PRODUCCION',
      claveTecnica: 'clave-tecnica-secreta',
    },
  });
  revisar(resolucion.estado === 201, 'registra la resolucion', JSON.stringify(resolucion.datos));
  revisar(
    resolucion.datos?.clave_tecnica_enc === undefined && resolucion.datos?.tieneClaveTecnica === true,
    'la clave tecnica no sale por la API, solo su presencia',
  );
  revisar(
    Number(resolucion.datos?.consecutivo_actual) === 0,
    'el consecutivo arranca en rangoDesde - 1: aun no se emitio nada',
  );

  const disp = await pedir('GET', '/resoluciones/disponibilidad', { token });
  revisar(Number(disp.datos?.[0]?.numeros_restantes) === 5000, 'informa 5.000 numeros disponibles');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('8b · Estado de configuracion, a medio camino');
  const est1 = await pedir('GET', '/empresas/actual/estado-configuracion', { token });
  const legal = buscar(est1, 'SITUACION_LEGAL');
  revisar(legal?.estado === 'FALTA', 'situacion legal quedo a medias, no pendiente', String(legal?.estado));
  revisar(
    legal?.faltantes?.some((x) => x.campo === 'codigoCiiu'),
    'nombra el campo exacto que falta: la actividad economica',
    JSON.stringify(legal?.faltantes),
  );
  revisar(buscar(est1, 'RESOLUCIONES')?.estado === 'LISTO', 'resoluciones quedo lista');
  revisar(
    buscar(est1, 'RESOLUCIONES')?.opcionales?.some((x) => x.campo === 'credenciales'),
    'las credenciales DIAN avisan sin bloquear',
  );
  revisar(est1.datos?.siguiente === 'SITUACION_LEGAL', 'manda a terminar lo que quedo a medias');

  console.log('\n9 · Terceros');
  const tercero = await pedir('POST', '/terceros', {
    token,
    cuerpo: {
      tipoPersona: 'NATURAL',
      tipoDocumento: 'CC',
      numeroDocumento: '71884209',
      primerNombre: 'Jose',
      segundoNombre: 'Emilio',
      primerApellido: 'Vargas',
      segundoApellido: 'Ruiz',
      municipioCodigo: '05001',
      esCliente: true,
      responsabilidadesDian: ['R-99-PN'],
    },
  });
  revisar(tercero.estado === 201, 'crea un tercero', JSON.stringify(tercero.datos));

  const niCliente = await pedir('POST', '/terceros', {
    token,
    cuerpo: {
      tipoPersona: 'JURIDICA',
      tipoDocumento: 'NIT',
      numeroDocumento: '830045912',
      dv: '7',
      razonSocial: 'Ni cliente ni proveedor',
    },
  });
  revisar(niCliente.estado === 400, 'un tercero que no es cliente ni proveedor se rechaza');

  const busqueda = await pedir('GET', '/terceros?q=jose', { token });
  revisar(busqueda.datos?.total === 1, 'la busqueda por nombre lo encuentra');
  revisar(busqueda.datos?.datos?.[0]?.nombre === 'Jose Emilio Vargas Ruiz', 'arma el nombre completo');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('9b · Estado de configuracion, completa');
  await pedir('POST', '/empresa-legal/actividades', {
    token,
    cuerpo: {
      codigoCiiu: '4530',
      descripcion: 'Comercio de partes y piezas',
      esPrincipal: true,
      tarifaIcaPorMil: 4.14,
      municipioCodigo: '05001',
      fechaInicio: '2019-03-01',
    },
  });
  const est2 = await pedir('GET', '/empresas/actual/estado-configuracion', { token });
  revisar(buscar(est2, 'SITUACION_LEGAL')?.estado === 'LISTO', 'con la actividad y su tarifa de ICA queda lista');
  revisar(est2.datos?.completa === true && est2.datos?.porcentaje === 100, 'la empresa ya puede operar');
  revisar(buscar(est2, 'TERCEROS')?.estado === 'LISTO', 'terceros se desbloqueo y tiene uno registrado');
  revisar(est2.datos?.siguiente === 'USUARIOS', 'ya solo sugiere lo opcional', String(est2.datos?.siguiente));

  console.log('\n10 · Aislamiento entre cuentas');
  const otroCorreo = `otro+${marca}@prueba.co`;
  await pedir('POST', '/tenants', {
    cabeceras: { 'x-clave-provision': process.env.CLAVE_PROVISION },
    cuerpo: {
      nombre: 'Otra cuenta',
      slug: `otra-${marca}`,
      email: otroCorreo,
      nombreAdministrador: 'Otro',
      password,
    },
  });
  const otroLogin = await pedir('POST', '/auth/login', { cuerpo: { email: otroCorreo, password } });
  const otrasEmpresas = await pedir('GET', '/empresas', { token: otroLogin.datos?.token });
  revisar(
    Array.isArray(otrasEmpresas.datos) && otrasEmpresas.datos.length === 0,
    'otra cuenta no ve la empresa de la primera',
    JSON.stringify(otrasEmpresas.datos),
  );

  const robar = await pedir('POST', '/auth/empresa', {
    token: otroLogin.datos?.token,
    cuerpo: { empresaId },
  });
  revisar(robar.estado === 401, 'no puede elegir una empresa ajena');

  // -------------------------------------------------------------------------
  console.log(`\n=== ${pasadas} pasadas · ${fallidas} fallidas ===\n`);

  console.log('  Las cuentas creadas quedan marcadas como de prueba.');
  console.log('  Borrarlas con: node scripts/limpiar-pruebas.js --confirmar');
  process.exit(fallidas === 0 ? 0 : 1);
})();
