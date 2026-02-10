import { GoogleGenAI, Type } from '@google/genai';
import type { FastifyInstance } from 'fastify';
import type { Agent, WorldState } from '../types.js';

let ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

export async function simulateWorldTick(
  worldState: WorldState,
  userAction?: string
): Promise<{ updatedAgents: Agent[]; newEvent: string }> {
  const prompt = `
    You are the "World Model Agent", a master game master for a high-fidelity persistent virtual world.

    Current World State: ${JSON.stringify(worldState)}
    User Input/Action: ${userAction || 'No user input, just simulate autonomous life.'}

    Task:
    1. Update agent positions, statuses, and inventories based on their current goals or the user action.
    2. Ensure movements are consistent with an isometric grid (small increments, logical paths).
    3. Invent a compelling "World Event" (e.g., resource spawns, weather changes, or agent discoveries).
    4. Maintain the "cute, round, chibi" aesthetic of the agents in your narrative.
    5. Inventory must strictly track 'wood', 'stone', and 'gold'.

    Return the updated list of agents and the short narrative event in JSON format.
  `;

  try {
    const genai = getAI();
    const response = await genai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        thinkingConfig: { thinkingBudget: 2048 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            updatedAgents: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  color: { type: Type.STRING },
                  position: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      z: { type: Type.NUMBER }
                    },
                    required: ['x', 'y', 'z']
                  },
                  targetPosition: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      z: { type: Type.NUMBER }
                    },
                    required: ['x', 'y', 'z']
                  },
                  status: { type: Type.STRING },
                  inventory: {
                    type: Type.OBJECT,
                    properties: {
                      wood: { type: Type.NUMBER },
                      stone: { type: Type.NUMBER },
                      gold: { type: Type.NUMBER }
                    },
                    required: ['wood', 'stone', 'gold']
                  }
                },
                required: ['id', 'name', 'color', 'position', 'targetPosition', 'status', 'inventory']
              }
            },
            newEvent: { type: Type.STRING }
          },
          required: ['updatedAgents', 'newEvent']
        }
      }
    });

    const text = response.text || '{}';
    return JSON.parse(text);
  } catch (error) {
    console.error('[Gemini] Error:', error);
    // Hardened fallback logic: Ensure all required fields (inventory, targetPosition) are present
    return {
      updatedAgents: worldState.agents.map(a => ({
        ...a,
        position: {
          x: a.position.x + (Math.random() - 0.5) * 0.5,
          y: a.position.y,
          z: a.position.z + (Math.random() - 0.5) * 0.5
        },
        targetPosition: a.targetPosition || a.position,
        status: 'idle' as const,
        inventory: a.inventory || { wood: 0, stone: 0, gold: 0 }
      })),
      newEvent: 'The grid pulses with a strange energy as the simulation recalibrates.'
    };
  }
}

// Register API routes for simulation
export async function registerSimulateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Body: { worldState: WorldState; userAction?: string }
  }>('/api/simulate', async (request, reply) => {
    const { worldState, userAction } = request.body;

    if (!worldState) {
      return reply.code(400).send({ error: 'worldState is required' });
    }

    const result = await simulateWorldTick(worldState, userAction);
    return result;
  });
}
