import { randomInt } from 'node:crypto';

/**
 * Sin los caracteres que se confunden al dictar o al leer: ni `0/O`, ni
 * `1/l/I`. Son 55 símbolos.
 */
export const ALFABETO =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/**
 * Una contraseña para dictar por teléfono: tres grupos de cuatro, como
 * `Hq7r-T4kw-9vXz`. Doce símbolos de 55 dan unos 69 bits, de sobra para una
 * contraseña que se entrega una vez y el usuario debería cambiar.
 *
 * Los guiones **son parte** de la contraseña: se escribe tal como se ve, y no
 * hay que explicarle a nadie que los quite. Sale del generador del sistema
 * operativo (`randomInt`), nunca de `Math.random`.
 */
export function contrasenaParaDictar(): string {
  const grupo = () =>
    Array.from({ length: 4 }, () => ALFABETO[randomInt(ALFABETO.length)]).join(
      '',
    );
  return `${grupo()}-${grupo()}-${grupo()}`;
}
