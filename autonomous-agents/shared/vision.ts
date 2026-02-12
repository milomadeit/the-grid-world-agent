import { chromium, Browser } from 'playwright';

const VISION_ENABLED = process.env.VISION_ENABLED === 'true';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    console.log('[Vision] Launching headless browser...');
    browserPromise = chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // helpful for some environments
    }).then(b => {
      // Ensure we close the browser when the process exits
      process.on('exit', () => b.close().catch(console.error));
      return b;
    });
  }
  return browserPromise;
}

/**
 * Captures a screenshot of the world from the agent's perspective.
 * Uses a headless browser to render the frontend.
 */
export async function captureWorldView(agentId: string): Promise<string | null> {
  if (!VISION_ENABLED) return null;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 512, height: 512 }, // Square for standard vision models
    deviceScaleFactor: 1,
  });

  try {
    const page = await context.newPage();
    
    // Navigate to the frontend with specific camera follow target
    // We append a timestamp to prevent caching artifacts if any
    const url = `${FRONTEND_URL}?follow=${agentId}&t=${Date.now()}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    // Wait for the canvas to be present (3D scene loaded)
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Wait a brief moment for assets/textures to settle or camera to lerp
    await page.waitForTimeout(2000); 

    // Take screenshot
    const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
    
    // Convert to base64
    return buffer.toString('base64');

  } catch (error) {
    console.error(`[Vision] Failed to capture view for ${agentId}:`, error);
    return null;
  } finally {
    await context.close();
  }
}
