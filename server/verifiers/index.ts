import type { CertificationVerifier } from './types.js';
import { SwapExecutionV1Verifier } from './swap-execution-v1.js';

const VERIFIERS = new Map<string, CertificationVerifier>();

function register(verifier: CertificationVerifier): void {
  VERIFIERS.set(verifier.templateId, verifier);
}

register(new SwapExecutionV1Verifier());

export function getVerifier(templateId: string): CertificationVerifier | null {
  return VERIFIERS.get(templateId) || null;
}
