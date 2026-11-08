import { generateSecret, generateURI, verify } from 'otplib';

// TOTP per RFC 6238 with the defaults every authenticator app understands
// (SHA-1, 6 digits, 30 s). One step of clock drift either way is accepted.
// The caller stores the matched time step and passes it back as
// `afterTimeStep`, so a code can never be used twice.

export const newTotpSecret = (): string => generateSecret();

export const totpUri = (secret: string, username: string, issuer: string): string =>
  generateURI({ issuer, label: username, secret });

export async function verifyTotp(
  secret: string,
  token: string,
  lastStep: number | null,
  nowMs: number,
): Promise<number | null> {
  const result = await verify({
    secret,
    token,
    epoch: Math.floor(nowMs / 1000),
    epochTolerance: 30,
    ...(lastStep !== null ? { afterTimeStep: lastStep } : {}),
  });
  return result.valid && 'timeStep' in result ? result.timeStep : null;
}
