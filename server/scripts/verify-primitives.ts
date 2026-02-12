
import { strict as assert } from 'assert';

const BASE_URL = 'http://localhost:3001';

async function main() {
  console.log('🚀 Starting Primitive Verification...');

  // 1. Enter World (Create temporary agent)
  console.log('1. Entering World...');
  const enterRes = await fetch(`${BASE_URL}/v1/agents/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerId: '0x89E9E1ab11dD1B138b1dcE6d6A4a0926aaFD5029',
      visuals: { name: 'Verifier', color: '#ff00ff' },
      erc8004: {
        agentId: '0',
        agentRegistry: '0x0000000000000000000000000000000000000000'
      }
    })
  });

  if (!enterRes.ok) {
    throw new Error(`Failed to enter world: ${enterRes.status} ${await enterRes.text()}`);
  }

  const { token, agentId } = await enterRes.json() as any;
  console.log(`✅ Entered as ${agentId}`);

  // 2. Build Primitive
  console.log('2. Building Primitive...');
  const buildRes = await fetch(`${BASE_URL}/v1/grid/primitive`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      shape: 'box',
      position: { x: 10, y: 5, z: 10 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      color: '#00ff00'
    })
  });

  if (!buildRes.ok) {
    throw new Error(`Failed to build primitive: ${buildRes.status} ${await buildRes.text()}`);
  }

  const primitive = await buildRes.json() as any;
  assert.equal(primitive.shape, 'box');
  assert.equal(primitive.ownerAgentId, agentId);
  console.log(`✅ Created primitive: ${primitive.id}`);

  // 3. Verify State
  console.log('3. Verifying State...');
  const stateRes = await fetch(`${BASE_URL}/v1/grid/state`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!stateRes.ok) {
    throw new Error(`Failed to get state: ${stateRes.status}`);
  }

  const state = await stateRes.json() as any;
  console.log('Current Primitives in State:', state.primitives);
  const found = state.primitives?.find((p: any) => p.id === primitive.id);
  assert.ok(found, 'Primitive not found in state');
  console.log('✅ Primitive found in world state');

  // 4. Delete Primitive
  console.log('4. Deleting Primitive...');
  const deleteRes = await fetch(`${BASE_URL}/v1/grid/primitive/${primitive.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!deleteRes.ok) {
    throw new Error(`Failed to delete primitive: ${deleteRes.status} ${await deleteRes.text()}`);
  }
  console.log('✅ Primitive deleted');

  // 5. Verify Deletion
  console.log('5. Verifying Deletion...');
  const stateRes2 = await fetch(`${BASE_URL}/v1/grid/state`, {
     method: 'GET',
     headers: { 'Authorization': `Bearer ${token}` }
  });
  const state2 = await stateRes2.json() as any;
  const found2 = state2.primitives?.find((p: any) => p.id === primitive.id);
  assert.ok(!found2, 'Primitive still exists in state');
  console.log('✅ Primitive confirmed gone');

  console.log('🎉 Verification Successful!');
}

main().catch(err => {
  console.error('❌ Verification Failed:', err);
  process.exit(1);
});
