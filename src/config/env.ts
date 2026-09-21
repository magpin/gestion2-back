/**
 * Validación del entorno. Se ejecuta al arrancar: si falta algo, la aplicación no
 * levanta. Es preferible un arranque fallido y ruidoso a un servidor en pie
 * firmando tokens con un secreto vacío.
 */

export interface Entorno {
  nodeEnv: 'development' | 'test' | 'production';
  puerto: number;
  prefijoApi: string;

  /** Conexión de la API. Debe ser `gestion_app`: sujeta a RLS y sin DELETE. */
  db: {
    host: string;
    puerto: number;
    usuario: string;
    password: string;
    nombre: string;
    /**
     * Si la conexión va cifrada. Un Postgres local no lo necesita; uno
     * administrado —Neon, RDS, Supabase— lo exige y rechaza la conexión sin
     * él. Se enciende con `DB_SSL=true`.
     */
    ssl: boolean;
  };

  /**
   * Conexión de aprovisionamiento (`gestion_provision`, con BYPASSRLS). Solo la
   * usa el alta de tenants. Si no está configurada, ese endpoint responde 503.
   */
  dbProvision?: {
    usuario: string;
    password: string;
  };

  jwt: {
    secreto: string;
    expiraEn: string;
  };

  /** Clave AES-256-GCM para las columnas `_enc`. 32 bytes en base64. */
  claveCifrado: Buffer;

  /** Cabecera que autoriza el alta de tenants. */
  claveProvision?: string;

  /**
   * Cabecera que abre el tablero de consumo de la IA (`/consumo-ia`). Sin
   * ella, el tablero responde 503. De 32 caracteres o más: es la única puerta
   * a cifras de todas las empresas.
   */
  claveConsumoIa?: string;
}

function requerido(nombre: string): string {
  const valor = process.env[nombre];
  if (valor === undefined || valor.trim() === '') {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

function opcional(nombre: string): string | undefined {
  const valor = process.env[nombre];
  return valor === undefined || valor.trim() === '' ? undefined : valor;
}

export function leerEntorno(): Entorno {
  const nodeEnv = (opcional('NODE_ENV') ?? 'development') as Entorno['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV invalido: ${nodeEnv}`);
  }

  const secreto = requerido('JWT_SECRET');
  if (nodeEnv === 'production' && secreto.length < 32) {
    throw new Error('JWT_SECRET debe tener 32 caracteres o mas en produccion');
  }

  const claveCifradoB64 = requerido('CLAVE_CIFRADO');
  const claveCifrado = Buffer.from(claveCifradoB64, 'base64');
  if (claveCifrado.length !== 32) {
    throw new Error(
      "CLAVE_CIFRADO debe ser 32 bytes en base64. Generar con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  // En produccion la API NO puede conectarse como superusuario: un superusuario
  // se salta RLS aunque las tablas tengan FORCE, y el aislamiento entre clientes
  // dejaria de existir.
  const usuarioApp = opcional('DB_APP_USERNAME');
  if (nodeEnv === 'production' && usuarioApp === undefined) {
    throw new Error(
      'DB_APP_USERNAME es obligatorio en produccion: la API debe conectarse como gestion_app',
    );
  }

  const provisionUsuario = opcional('DB_PROVISION_USERNAME');
  const provisionPassword = opcional('DB_PROVISION_PASSWORD');

  return {
    nodeEnv,
    puerto: Number(opcional('PORT') ?? 3001),
    prefijoApi: opcional('API_PREFIX') ?? 'api/v1',
    db: {
      host: opcional('DB_HOST') ?? 'localhost',
      puerto: Number(opcional('DB_PORT') ?? 5432),
      usuario: usuarioApp ?? requerido('DB_USERNAME'),
      password: opcional('DB_APP_PASSWORD') ?? opcional('DB_PASSWORD') ?? '',
      nombre: requerido('DB_NAME'),
      // Se deduce del host cuando no se dice: los proveedores administrados
      // tienen dominios reconocibles, y olvidarse de la variable no debería
      // significar "intentá sin cifrar contra un servidor que lo exige".
      ssl:
        opcional('DB_SSL') === 'true' ||
        (opcional('DB_SSL') === undefined &&
          /neon\.tech|amazonaws\.com|supabase\.co|azure\.com/.test(
            opcional('DB_HOST') ?? '',
          )),
    },
    dbProvision:
      provisionUsuario !== undefined && provisionPassword !== undefined
        ? { usuario: provisionUsuario, password: provisionPassword }
        : undefined,
    jwt: {
      secreto,
      expiraEn: opcional('JWT_EXPIRES_IN') ?? '8h',
    },
    claveCifrado,
    claveProvision: opcional('CLAVE_PROVISION'),
    claveConsumoIa: claveConsumoIa(),
  };
}

/** La clave del tablero de consumo: opcional, pero si está, larga. */
function claveConsumoIa(): string | undefined {
  const clave = opcional('CLAVE_CONSUMO_IA');
  if (clave !== undefined && clave.length < 32) {
    throw new Error('CLAVE_CONSUMO_IA debe tener 32 caracteres o mas');
  }
  return clave;
}

export const ENTORNO = Symbol('ENTORNO');
