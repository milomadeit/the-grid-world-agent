import { chromium, Browser } from 'playwright';

const VISION_ENABLED = process.env.VISION_ENABLED === 'true';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const VISION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between captures

let browserPromise: Promise<Browser> | null = null;

// Per-agent cooldown tracking
const lastCaptureTime = new Map<string, number>();

async function getBrowser() {
  if (!browserPromise) {
    console.log('[Vision] Launching headless browser...');
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }).then(b => {
      process.on('exit', () => b.close().catch(console.error));
      return b;
    });
  }
  return browserPromise;
}

/**
 * Captures a top-down map view of the world centered on the agent.
 * Rate-limited to once per 5 minutes per agent.
 * Returns base64 JPEG or null if disabled/on cooldown.
 */
export async function captureWorldView(agentId: string): Promise<string | null> {
  if (!VISION_ENABLED) return null;

  // Cooldown check
  const now = Date.now();
  const lastCapture = lastCaptureTime.get(agentId) || 0;
  if (now - lastCapture < VISION_INTERVAL_MS) {
    return null; // On cooldown — skip silently
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });

  try {
    const page = await context.newPage();

    // Top-down map view centered on the agent
    const url = `${FRONTEND_URL}?follow=${agentId}&view=map&t=${Date.now()}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    await page.waitForSelector('canvas', { timeout: 10000 });

    // Wait for camera to settle into top-down position
    await page.waitForTimeout(3000);

    const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });

    lastCaptureTime.set(agentId, now);
    console.log(`[Vision] Captured map view for ${agentId}`);
    return buffer.toString('base64');

  } catch (error) {
    console.error(`[Vision] Failed to capture view for ${agentId}:`, error);
    return null;
  } finally {
    await context.close();
  }
}
