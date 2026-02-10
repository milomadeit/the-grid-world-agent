import { io } from "socket.io-client";
import axios from "axios";

const API_URL = "http://localhost:3001";
const VERBOSE = true;

async function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function createAgent(name, color, ownerId) {
	try {
		const res = await axios.post(`${API_URL}/v1/agents/enter`, {
			ownerId: `spawner_${ownerId}`,
			visuals: { name, color },
			bio: "Verification Bot"
			// No erc8004 to avoid verification
		}, { validateStatus: false }); // Allow 400s to parse error

		if (res.status !== 200 && res.status !== 201) {
			console.error(`[${name}] Failed to enter:`, res.data);
			return null;
		}
		return { ...res.data, name };
	} catch (e) {
		console.error(`[${name}] Error:`, e.message);
		return null;
	}
}

async function moveAgent(agent, x, z) {
	await axios.post(`${API_URL}/v1/agents/action`, {
		action: "MOVE",
		payload: { x, z }
	}, {
		headers: { Authorization: `Bearer ${agent.token}` }
	});
}

async function getObjective() {
	const res = await axios.get(`${API_URL}/v1/world/objective`);
	return res.data;
}

async function activateBeacon(agent, beaconId) {
	try {
		const res = await axios.post(`${API_URL}/v1/world/objective/contribute`, {
			action: "ACTIVATE_BEACON",
			beaconId
		}, {
			headers: { Authorization: `Bearer ${agent.token}` }
		});
		console.log(`[${agent.name}] Activation Result:`, res.data.message);
		return res.data;
	} catch (e) {
		console.log(`[${agent.name}] Activation Failed:`, e.response?.data?.message || e.message);
		return e.response?.data;
	}
}

async function run() {
	console.log("=== STARTING OBJECTIVE VERIFICATION ===");

	// 1. Enter 3 agents
	const agent1 = await createAgent("Agent_One", "#ff0000", "owner_1");
	const agent2 = await createAgent("Agent_Two", "#00ff00", "owner_2");
	const agent3 = await createAgent("Agent_Three", "#0000ff", "owner_3");

	if (!agent1 || !agent2 || !agent3) {
		console.error("Failed to create agents. Is server running?");
		return;
	}
	console.log("✅ 3 Agents Entered");

	// 2. Get Objective
	const objective = await getObjective();
	console.log(`🎯 Objective: ${objective.name} (${objective.status})`);

	if (objective.beacons.length === 0) {
		console.error("No beacons found!");
		return;
	}

	const targetBeacon = objective.beacons[0];
	console.log(`📍 Target Beacon: ${targetBeacon.id} at (${targetBeacon.position.x}, ${targetBeacon.position.z})`);

	// 3. Move Agent 1 to Beacon (Discovery)
	console.log(`\n--- Beacon Discovery ---`);
	await moveAgent(agent1, targetBeacon.position.x, targetBeacon.position.z);
	await sleep(5000); // Wait for movement & discovery tick

	// Check if discovered
	const objAfterMove = await getObjective();
	const beaconState = objAfterMove.beacons.find(b => b.id === targetBeacon.id);
	console.log(`Beacon Discovered: ${beaconState.discovered ? "YES" : "NO"}`);

	if (!beaconState.discovered) {
		console.error("Beacon discovery failed. Check proximity logic.");
		// Proceeding anyway
	}

	// 4. Try to activate alone
	console.log(`\n--- Single Agent Activation (Expect Failure) ---`);
	await activateBeacon(agent1, targetBeacon.id);

	// 5. Move Agent 2 to Beacon
	console.log(`\n--- Cooperation ---`);
	console.log(`Moving Agent 2 to beacon...`);
	await moveAgent(agent2, targetBeacon.position.x, targetBeacon.position.z);
	await sleep(5000);

	// 6. Try to activate together
	console.log(`Agent 1 tries to activate again (with Agent 2 nearby)...`);
	const res = await activateBeacon(agent1, targetBeacon.id);

	// 7. Check final status
	const finalObj = await getObjective();
	const finalBeacon = finalObj.beacons.find(b => b.id === targetBeacon.id);

	if (finalBeacon.activated) {
		console.log(`\n✅ SUCCESS: Beacon activated!`);
	} else {
		console.error(`\n❌ FAILURE: Beacon not activated.`);
	}

	console.log("=== VERIFICATION COMPLETE ===");
}

run();
