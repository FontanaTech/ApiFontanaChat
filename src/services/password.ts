import { hash, verify, Algorithm } from '@node-rs/argon2';

/** Argon2id con parámetros OWASP (19 MiB, t=2, p=1). */
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(hashStr: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}

/** Hash ficticio para igualar tiempos cuando el email no existe. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword('dummy-password-for-timing-equalization'));
