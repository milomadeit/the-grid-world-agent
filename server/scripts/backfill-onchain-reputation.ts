/**
 * Backfill onchain reputation feedback for all passed certification runs
 * that were never published (because RELAYER_PK was missing).
 *
 * Usage: npx tsx server/scripts/backfill-onchain-reputation.ts
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──────────────────────────────────────────────────────────
const CHAIN_RPC = process.env.CHAIN_RPC || 'https://sepolia.base.org';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '84532', 10);
const RELAYER_PK = process.env.RELAYER_PK || '';
const REPUTATION_REGISTRY = process.env.REPUTATION_REGISTRY || '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!RELAYER_PK) {
  console.error('❌ RELAYER_PK not set. Cannot publish onchain.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set. Cannot query runs.');
  process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(CHAIN_RPC, CHAIN_ID);
const pk = RELAYER_PK.startsWith('0x') ? RELAYER_PK : `0x${RELAYER_PK}`;
const relayer = new ethers.Wallet(pk, provider);

const reputationAbi = JSON.parse(
  readFileSync(join(__dirname, '..', 'abis', 'ReputationRegistry.json'), 'utf-8')
);
const reputationRegistry = new ethers.Contract(REPUTATION_REGISTRY, reputationAbi, relayer);

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Helpers (mirrored from chain.ts) ────────────────────────────────
function getCertificationTag1(templateId: string): string {
  return 'certification';
}

function toResponseHash(attestation: unknown): string {
  const raw = typeof attestation === 'string' ? attestation : JSON.stringify(attestation || {});
  return ethers.id(raw);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔗 Chain: ${CHAIN_ID} (${CHAIN_RPC})`);
  console.log(`🔑 Relayer: ${relayer.address}`);
  console.log(`📋 ReputationRegistry: ${REPUTATION_REGISTRY}\n`);

  // Check relayer balance
  const balance = await provider.getBalance(relayer.address);
  console.log(`💰 Relayer balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.error('❌ Relayer has 0 ETH. Fund it with Base Sepolia ETH first.');
    process.exit(1);
  }

  // Query all passed runs without onchain tx
  const result = await pool.query(`
    SELECT cr.id, cr.agent_id, cr.template_id, cr.attestation_json,
           cr.verification_result, cr.onchain_tx_hash,
           a.erc8004_agent_id, a.visual_name as agent_name
    FROM certification_runs cr
    JOIN agents a ON a.id = cr.agent_id
    WHERE cr.status = 'passed'
    ORDER BY cr.completed_at ASC
  `);

  const runs = result.rows;
  const unpublished = runs.filter(r => !r.onchain_tx_hash);
  const alreadyPublished = runs.filter(r => r.onchain_tx_hash);

  console.log(`\n📊 Total passed runs: ${runs.length}`);
  console.log(`   Already onchain: ${alreadyPublished.length}`);
  console.log(`   Need publishing: ${unpublished.length}\n`);

  if (unpublished.length === 0) {
    console.log('✅ All passed runs already have onchain feedback!');
    await pool.end();
    return;
  }

  let published = 0;
  let failed = 0;

  for (const run of unpublished) {
    const tokenId = run.erc8004_agent_id;
    if (!tokenId || !/^[0-9]+$/.test(String(tokenId))) {
      console.log(`  ⏭️  ${run.id} (${run.agent_name}) — no valid ERC-8004 token ID, skipping`);
      continue;
    }

    // Extract score from verification_result or attestation
    const verResult = run.verification_result || {};
    const attestation = run.attestation_json || {};
    const score = verResult.score ?? attestation.score ?? 0;
    if (score <= 0) {
      console.log(`  ⏭️  ${run.id} (${run.agent_name}) — no score found, skipping`);
      continue;
    }

    const feedbackValue = Math.min(100, Math.max(0, Math.round(score)));
    const feedbackHash = toResponseHash(attestation);
    const feedbackURI = `https://opgrid.up.railway.app/v1/certify/runs/${run.id}/attestation`;

    try {
      console.log(`  📤 ${run.id} (${run.agent_name}) — score ${feedbackValue}, token #${tokenId}...`);

      const tx = await reputationRegistry.giveFeedback(
        BigInt(tokenId),
        BigInt(feedbackValue),
        0,
        getCertificationTag1(run.template_id),
        run.template_id,
        '',
        feedbackURI,
        feedbackHash,
      );

      console.log(`     ⏳ tx: ${tx.hash} — waiting for confirmation...`);
      const receipt = await tx.wait();
      console.log(`     ✅ Confirmed in block ${receipt.blockNumber}`);

      // Update DB with tx hash
      await pool.query(
        'UPDATE certification_runs SET onchain_tx_hash = $1 WHERE id = $2',
        [tx.hash, run.id]
      );

      published++;

      // Small delay between txs to avoid nonce issues
      if (unpublished.indexOf(run) < unpublished.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err: any) {
      console.error(`     ❌ Failed: ${err.message?.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\n🏁 Done! Published: ${published}, Failed: ${failed}, Skipped: ${unpublished.length - published - failed}`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
