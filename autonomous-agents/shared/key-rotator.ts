/**
 * Key Rotator — Provider-agnostic LLM bucket rotation with per-bucket cooldowns.
 *
 * Each LLMBucket is a key x model combination with its own independent rate limit.
 * On 429, the rotator immediately tries the next bucket instead of sleeping.
 */

export interface LLMBucket {
  provider: 'gemini' | 'anthropic' | 'openai' | 'minimax' | 'opencode' | 'openrouter';
  model: string;
  apiKey: string;
  label: string; // human-readable, e.g. "2.5-flash@K2" — logging only
}

interface BucketState {
  bucket: LLMBucket;
  cooldownUntil: number; // timestamp ms, 0 = available
  usesToday: number;
  lastResetDate: string; // "YYYY-MM-DD" for daily counter reset
}

export interface LLMResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

export class KeyRotator {
  private states: BucketState[];
  private agentName: string;
  private defaultCooldownMs: number;

  constructor(opts: {
    agentName: string;
    buckets: LLMBucket[];
    defaultCooldownMs?: number;
  }) {
    this.agentName = opts.agentName;
    this.defaultCooldownMs = opts.defaultCooldownMs ?? 60_000;
    this.states = opts.buckets.map(bucket => ({
      bucket,
      cooldownUntil: 0,
      usesToday: 0,
      lastResetDate: todayUTC(),
    }));
  }

  /**
   * Try LLM call, rotating through buckets on rate limit errors.
   * Returns response + which bucket succeeded.
   * Throws last error if ALL buckets fail.
   */
  async call(
    callFn: (bucket: LLMBucket) => Promise<LLMResponse>,
    isRateLimit: (err: unknown) => boolean,
  ): Promise<LLMResponse & { bucket: LLMBucket }> {
    const now = Date.now();
    let lastError: unknown = null;
    let skipped = 0;

    for (const state of this.states) {
      // Reset daily counters on day boundary
      const today = todayUTC();
      if (state.lastResetDate !== today) {
        state.usesToday = 0;
        state.lastResetDate = today;
      }

      // Skip buckets still cooling down
      if (now < state.cooldownUntil) {
        skipped++;
        continue;
      }

      try {
        const response = await callFn(state.bucket);
        state.usesToday++;
        return { ...response, bucket: state.bucket };
      } catch (err) {
        lastError = err;

        if (isRateLimit(err)) {
          state.cooldownUntil = Date.now() + this.defaultCooldownMs;
          console.warn(
            `[${this.agentName}] 429 on ${state.bucket.label} — cooldown ${Math.ceil(this.defaultCooldownMs / 1000)}s, trying next bucket...`
          );
          continue; // Immediately try next bucket
        }

        // Non-rate-limit error — don't try other buckets
        throw err;
      }
    }

    // All buckets exhausted or cooling down
    const total = this.states.length;
    if (lastError) {
      const nextAvail = Math.min(...this.states.map(s => s.cooldownUntil));
      const waitSec = Math.max(0, Math.ceil((nextAvail - Date.now()) / 1000));
      console.error(
        `[${this.agentName}] All ${total} buckets exhausted (${skipped} cooling). Next available in ~${waitSec}s.`
      );
      throw lastError;
    }

    // All were cooling down, none attempted
    const nextAvail = Math.min(...this.states.map(s => s.cooldownUntil));
    const waitSec = Math.max(0, Math.ceil((nextAvail - Date.now()) / 1000));
    throw new Error(
      `[${this.agentName}] All ${total} buckets cooling down. Next available in ~${waitSec}s.`
    );
  }

  /** Returns earliest recovery timestamp if ALL buckets are cooling, else 0. */
  allCoolingDown(): number {
    const now = Date.now();
    const allCooling = this.states.every(s => s.cooldownUntil > now);
    if (!allCooling) return 0;
    return Math.min(...this.states.map(s => s.cooldownUntil));
  }

  /** Debug summary of bucket states. */
  status(): string {
    const now = Date.now();
    return this.states.map(s => {
      const cd = s.cooldownUntil > now
        ? `COOL(${Math.ceil((s.cooldownUntil - now) / 1000)}s)`
        : 'OK';
      return `${s.bucket.label}:${cd}(${s.usesToday})`;
    }).join(' | ');
  }
}
