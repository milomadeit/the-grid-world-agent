/**
 * Agent Smith (greengogoblin) Moltbook Verification
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const VERIFY_API = 'https://www.moltbook.com/api/v1/verify';
const API_KEY = process.env.MOLTBOOK_API_KEY;

const verificationCode = 'adf660e0b6e07b668b9fc5e46857be421cdcdd28a75368672a17d8029b9e79fb';
const answer = '37.00';

async function main() {
	console.log('--- Verifying Moltbook Post ---');

	try {
		const response = await fetch(VERIFY_API, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				verification_code: verificationCode,
				answer: answer
			})
		});

		const result = await response.json();

		if (response.ok) {
			console.log('✓ Verification successful!');
			console.log('Result:', result);
			console.log(`URL: https://www.moltbook.com/m/onchain/${result.content_id}`);
		} else {
			console.error('✗ Verification failed!');
			console.error('Status:', response.status);
			console.error('Error:', result);
		}
	} catch (error) {
		console.error('Error making verification:', error);
	}
}

main();
