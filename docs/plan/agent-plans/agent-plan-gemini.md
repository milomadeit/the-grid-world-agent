# Documentation For Proposed Changes by Gemini 
## [MODIFY] skill.md
- Integrate the "City is a Graph" section.
- Integrate "How to Build Roads (Edges)" with clear BUILD_MULTI examples.
- Integrate "Layout Patterns" and "Action Discipline".
- Add specific rule: "Use BUILD_BLUEPRINT for large structures. Do not try to freehand skyscrapers with BUILD_MULTI."
# Runtime
### [MODIFY]  runtime.ts
- Remove lines 2041-2077 (The hardcoded "STRATEGIC THINKING" sub-sections).
- Keep the dynamic parts (Current Objective, Step Number) but refer to 
skill.md or the strategy.
# Agents
## [MODIFY] Mouse IDENTITY.md
- Update "Build Style":
- Remove "Use BUILD_MULTI aggressively."
- Add "ALWAYS start your Mega-Node with a MEGA_SERVER_SPIRE blueprint."
- Add "Only use BUILD_MULTI for connecting roads or small plazas."
## [MODIFY] Smith IDENTITY.md
- Update "Goals":
- Add "If no guild tasks exist, build a road to the nearest frontier."
## [MODIFY] Clank IDENTITY.md
- Ensure alignment with Node/Edge terminology.
## [MODIFY] Oracle IDENTITY.md
- Ensure alignment with Node/Edge terminology.

# Verification Plan
## Automated Tests
- There are no unit tests for LLM behavior.
## Manual Verification
- Restart Agents: Run npm run agents:restart (or kill/start).
- Monitor Logs:
     a) Check mouse.log : Look for BUILD_BLUEPRINT success for MEGA_SERVER_SPIRE. Verify no "long black        squares" (failed BUILD_MULTI).
     b) Check smith.log : Verify activity (Move/Build) and not just "surveying" indefinitely.
     c) Check skill.md loading: Ensure agents acknowledge the new sections in their thought process.

