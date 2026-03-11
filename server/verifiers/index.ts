import type { CertificationVerifier } from './types.js';
import { SwapExecutionV1Verifier } from './swap-execution-v1.js';
import { SwapExecutionV2Verifier } from './swap-execution-v2.js';
import { DeployerV1Verifier } from './deployer-v1.js';
import { SniperV1Verifier } from './sniper-v1.js';

const VERIFIERS = new Map<string, CertificationVerifier>();

function register(verifier: CertificationVerifier): void {
  VERIFIERS.set(verifier.templateId, verifier);
}

register(new SwapExecutionV1Verifier());
register(new SwapExecutionV2Verifier());
register(new DeployerV1Verifier());
register(new SniperV1Verifier());

export function getVerifier(templateId: string): CertificationVerifier | null {
  return VERIFIERS.get(templateId) || null;
}
