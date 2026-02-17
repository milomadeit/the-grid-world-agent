import { readdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';

type Action =
  | 'MOVE'
  | 'CHAT'
  | 'BUILD_CONTINUE'
  | 'BUILD_BLUEPRINT'
  | 'BUILD_PRIMITIVE'
  | 'BUILD_MULTI'
  | 'TERMINAL'
  | 'VOTE'
  | 'SUBMIT_DIRECTIVE'
  | 'TRANSFER_CREDITS'
  | 'IDLE';

const ACTIONS: Action[] = [
  'MOVE',
  'CHAT',
  'BUILD_CONTINUE',
  'BUILD_BLUEPRINT',
  'BUILD_PRIMITIVE',
  'BUILD_MULTI',
  'TERMINAL',
  'VOTE',
  'SUBMIT_DIRECTIVE',
  'TRANSFER_CREDITS',
  'IDLE',
];

const BUILD_ACTIONS: Action[] = ['BUILD_CONTINUE', 'BUILD_BLUEPRINT', 'BUILD_PRIMITIVE', 'BUILD_MULTI'];

interface AgentMetrics {
  file: string;
  lineCount: number;
  heartbeatSeconds: number | null;
  actions: Record<Action, number>;
  totalActions: number;
  buildActions: number;
  chatActions: number;
  buildChatRatio: number | null;
  llmCalls: number;
  llmFailures: number;
  chatSuppressed: number;
  lowSignalLoopDetected: number;
  unchangedPolicyTicks: number;
  primeDirectiveLoaded: number;
  stateSnapshots: number;
  estimatedHours: number | null;
  actionsPerHour: number | null;
  buildsPerHour: number | null;
  llmCallsPerHour: number | null;
}

interface AggregateMetrics {
  files: number;
  lineCount: number;
  totalActions: number;
  buildActions: number;
  chatActions: number;
  buildChatRatio: number | null;
  llmCalls: number;
  llmFailures: number;
  chatSuppressed: number;
  lowSignalLoopDetected: number;
  unchangedPolicyTicks: number;
  primeDirectiveLoaded: number;
  stateSnapshots: number;
  agentHours: number | null;
  actionsPerAgentHour: number | null;
  buildsPerAgentHour: number | null;
  llmCallsPerAgentHour: number | null;
}

interface Report {
  label: string;
  directory: string;
  generatedAt: string;
  aggregate: AggregateMetrics;
  agents: AgentMetrics[];
}

function usage(): never {
  console.error('Usage: npx tsx scripts/analyze-logs.ts --dir <log-dir> [--label <name>]');
  process.exit(1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round(numerator / denominator);
}

function parseArgs(argv: string[]): { dir: string; label: string } {
  let dir = '';
  let label = 'run';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      dir = argv[i + 1] || '';
      i++;
    } else if (arg === '--label') {
      label = argv[i + 1] || label;
      i++;
    }
  }

  if (!dir) usage();
  return { dir: resolve(dir), label };
}

function initActionCounts(): Record<Action, number> {
  return ACTIONS.reduce((acc, action) => {
    acc[action] = 0;
    return acc;
  }, {} as Record<Action, number>);
}

function analyzeFile(path: string): AgentMetrics {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const actions = initActionCounts();

  let heartbeatSeconds: number | null = null;
  let llmCalls = 0;
  let llmFailures = 0;
  let chatSuppressed = 0;
  let lowSignalLoopDetected = 0;
  let unchangedPolicyTicks = 0;
  let primeDirectiveLoaded = 0;
  let stateSnapshots = 0;

  for (const line of lines) {
    const heartbeatMatch = line.match(/Heartbeat started \(every (\d+)s\)/);
    if (heartbeatMatch) heartbeatSeconds = Number(heartbeatMatch[1]);

    const actionMatch = line.match(/-> (MOVE|CHAT|BUILD_CONTINUE|BUILD_BLUEPRINT|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|TRANSFER_CREDITS|IDLE)\b/);
    if (actionMatch) {
      const action = actionMatch[1] as Action;
      actions[action] += 1;
    }

    if (line.includes('Tokens:')) llmCalls += 1;
    if (line.includes('LLM call failed')) llmFailures += 1;
    if (line.includes('CHAT suppressed')) chatSuppressed += 1;
    if (line.includes('Low-signal chat loop detected')) lowSignalLoopDetected += 1;
    if (line.includes('No meaningful change, using policy action without LLM')) unchangedPolicyTicks += 1;
    if (line.includes('Loaded prime-directive')) primeDirectiveLoaded += 1;
    if (line.includes(' State: ') || line.includes('] State:')) stateSnapshots += 1;
  }

  const totalActions = ACTIONS.reduce((sum, action) => sum + actions[action], 0);
  const buildActions = BUILD_ACTIONS.reduce((sum, action) => sum + actions[action], 0);
  const chatActions = actions.CHAT;
  const buildChatRatio = safeRatio(buildActions, chatActions);
  const estimatedHours =
    heartbeatSeconds && heartbeatSeconds > 0
      ? (totalActions * heartbeatSeconds) / 3600
      : null;

  const actionsPerHour = estimatedHours && estimatedHours > 0 ? round(totalActions / estimatedHours) : null;
  const buildsPerHour = estimatedHours && estimatedHours > 0 ? round(buildActions / estimatedHours) : null;
  const llmCallsPerHour = estimatedHours && estimatedHours > 0 ? round(llmCalls / estimatedHours) : null;

  return {
    file: basename(path),
    lineCount: lines.filter(Boolean).length,
    heartbeatSeconds,
    actions,
    totalActions,
    buildActions,
    chatActions,
    buildChatRatio,
    llmCalls,
    llmFailures,
    chatSuppressed,
    lowSignalLoopDetected,
    unchangedPolicyTicks,
    primeDirectiveLoaded,
    stateSnapshots,
    estimatedHours: estimatedHours ? round(estimatedHours) : null,
    actionsPerHour,
    buildsPerHour,
    llmCallsPerHour,
  };
}

function aggregateMetrics(metrics: AgentMetrics[]): AggregateMetrics {
  const files = metrics.length;
  const lineCount = metrics.reduce((sum, m) => sum + m.lineCount, 0);
  const totalActions = metrics.reduce((sum, m) => sum + m.totalActions, 0);
  const buildActions = metrics.reduce((sum, m) => sum + m.buildActions, 0);
  const chatActions = metrics.reduce((sum, m) => sum + m.chatActions, 0);
  const llmCalls = metrics.reduce((sum, m) => sum + m.llmCalls, 0);
  const llmFailures = metrics.reduce((sum, m) => sum + m.llmFailures, 0);
  const chatSuppressed = metrics.reduce((sum, m) => sum + m.chatSuppressed, 0);
  const lowSignalLoopDetected = metrics.reduce((sum, m) => sum + m.lowSignalLoopDetected, 0);
  const unchangedPolicyTicks = metrics.reduce((sum, m) => sum + m.unchangedPolicyTicks, 0);
  const primeDirectiveLoaded = metrics.reduce((sum, m) => sum + m.primeDirectiveLoaded, 0);
  const stateSnapshots = metrics.reduce((sum, m) => sum + m.stateSnapshots, 0);
  const agentHoursRaw = metrics.reduce((sum, m) => sum + (m.estimatedHours || 0), 0);
  const agentHours = agentHoursRaw > 0 ? round(agentHoursRaw) : null;

  return {
    files,
    lineCount,
    totalActions,
    buildActions,
    chatActions,
    buildChatRatio: safeRatio(buildActions, chatActions),
    llmCalls,
    llmFailures,
    chatSuppressed,
    lowSignalLoopDetected,
    unchangedPolicyTicks,
    primeDirectiveLoaded,
    stateSnapshots,
    agentHours,
    actionsPerAgentHour: agentHoursRaw > 0 ? round(totalActions / agentHoursRaw) : null,
    buildsPerAgentHour: agentHoursRaw > 0 ? round(buildActions / agentHoursRaw) : null,
    llmCallsPerAgentHour: agentHoursRaw > 0 ? round(llmCalls / agentHoursRaw) : null,
  };
}

function main() {
  const { dir, label } = parseArgs(process.argv.slice(2));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => join(dir, name))
    .sort();

  if (files.length === 0) {
    console.error(`No .log files found in: ${dir}`);
    process.exit(1);
  }

  const agents = files.map(analyzeFile);
  const report: Report = {
    label,
    directory: dir,
    generatedAt: new Date().toISOString(),
    aggregate: aggregateMetrics(agents),
    agents,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main();
