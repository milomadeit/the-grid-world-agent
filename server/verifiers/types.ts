import type { JsonRpcProvider } from 'ethers';
import type { CertificationRun, CertificationTemplate } from '../types.js';

export interface ScoredCheck {
  name: string;
  score: number;        // 0-100
  weight: number;       // relative weight (sums to 100)
  passed: boolean;      // backward compat: score > 0
  expected: unknown;
  actual: unknown;
  detail?: string;
}

export interface VerifierContext {
  run: CertificationRun;
  template: CertificationTemplate;
  proof: Record<string, unknown> & { txHash: string };
  provider: JsonRpcProvider;
}

export interface VerifierResult {
  score: number;         // weighted average 0-100
  passed: boolean;       // score >= template passingScore
  checks: ScoredCheck[];
}

export interface CertificationVerifier {
  templateId: string;
  verify(ctx: VerifierContext): Promise<VerifierResult>;
}
