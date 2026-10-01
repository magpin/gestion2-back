// Lo que comparten los scripts que hablan con la API como un usuario: pedir y
// entrar a una empresa.
// `API_BASE` apunta a otro entorno —QA, por ejemplo—; sin ella, la API local.
const BASE =
  process.env.API_BASE ||
  `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;

async function pedir(metodo, ruta, { token, cuerpo } = {}) {
  // Una importación son miles de llamadas: un corte de red suelto no puede
  // tumbarla entera. Se reintenta hasta tres veces, con una pausa creciente.
  let res;
  for (let intento = 1; ; intento += 1) {
    try {
      res = await fetch(BASE + ruta, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
      break;
    } catch (e) {
      if (intento >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * intento));
    }
  }
  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  return { estado: res.status, datos };
}

async function entrar(email, password, empresa) {
  const login = await pedir('POST', '/auth/login', { cuerpo: { email, password } });
  if (login.estado !== 201 && login.estado !== 200) throw new Error(`Login falló (${login.estado}): ${JSON.stringify(login.datos)}`);
  if (login.datos.ambito !== 'CLIENTE') throw new Error('Ese correo administra la plataforma, no una cuenta de cliente.');
  const destino = login.datos.empresas.find((e) => e.id === empresa || e.nit === empresa);
  if (!destino) {
    throw new Error(`El usuario no tiene acceso a la empresa "${empresa}". Tiene: ${login.datos.empresas.map((e) => `${e.razonSocial} (${e.nit})`).join(', ')}`);
  }
  const eleccion = await pedir('POST', '/auth/empresa', { token: login.datos.token, cuerpo: { empresaId: destino.id } });
  if (eleccion.estado !== 201 && eleccion.estado !== 200) throw new Error(`Elegir empresa falló (${eleccion.estado}): ${JSON.stringify(eleccion.datos)}`);
  return { token: eleccion.datos.token, empresa: destino };
}

module.exports = { BASE, pedir, entrar };
