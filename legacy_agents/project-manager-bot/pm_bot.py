#!/usr/bin/env python3
"""Telegram project-manager bot with MiniMax planning + CLI delegation."""

import asyncio
import json
import logging
import os
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - handled at runtime
    OpenAI = None  # type: ignore


# --- Paths and environment ---
BOT_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT_DEFAULT = BOT_DIR.parent.parent
load_dotenv(WORKSPACE_ROOT_DEFAULT / ".env.local")
load_dotenv(WORKSPACE_ROOT_DEFAULT / "autonomous-agents" / ".env")
load_dotenv(BOT_DIR / ".env", override=True)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Configuration ---
TELEGRAM_BOT_TOKEN = os.getenv("TG_HTTP_API", "").strip() or os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
ALLOWED_CHAT_IDS_RAW = os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").strip() or os.getenv("TG_CHAT_ID", "").strip()
MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "").strip() or os.getenv("MINI_MAX_API_KEY", "").strip()
MINIMAX_BASE_URL = os.getenv("MINIMAX_BASE_URL", "https://api.minimax.io/v1").rstrip("/")
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-M2.1").strip()
PM_WORKSPACE_ROOT = Path(os.getenv("PM_WORKSPACE_ROOT", str(WORKSPACE_ROOT_DEFAULT))).resolve()
PM_COMMAND_TIMEOUT_SEC = int(os.getenv("PM_COMMAND_TIMEOUT_SEC", "1200"))
PM_MAX_PARALLEL_JOBS = int(os.getenv("PM_MAX_PARALLEL_JOBS", "1"))
PM_MAX_OUTPUT_CHARS = int(os.getenv("PM_MAX_OUTPUT_CHARS", "3500"))
CLAUDE_BIN = os.getenv("CLAUDE_BIN", "claude").strip()
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "").strip()
CLAUDE_PERMISSION_MODE = os.getenv("CLAUDE_PERMISSION_MODE", "dontAsk").strip()
PM_CLAUDE_MCP_CONFIG = os.getenv("PM_CLAUDE_MCP_CONFIG", "").strip()
PM_CLAUDE_STRICT_MCP_CONFIG = env_bool("PM_CLAUDE_STRICT_MCP_CONFIG", default=False)
CODEX_BIN = os.getenv("CODEX_BIN", "codex").strip()
CODEX_MODEL = os.getenv("CODEX_MODEL", "").strip()
CODEX_SANDBOX = os.getenv("CODEX_SANDBOX", "workspace-write").strip()
CODEX_PROFILE = os.getenv("CODEX_PROFILE", "").strip()
CODEX_FULL_AUTO = env_bool("CODEX_FULL_AUTO", default=False)
CODEX_SKIP_GIT_REPO_CHECK = env_bool("CODEX_SKIP_GIT_REPO_CHECK", default=False)
CODEX_ADD_DIRS = [part.strip() for part in os.getenv("CODEX_ADD_DIRS", "").split(",") if part.strip()]
PM_ROUTER_ENABLED = env_bool("PM_ROUTER_ENABLED", default=True)
PM_AUTO_EXECUTE_ROUTED_ACTIONS = env_bool("PM_AUTO_EXECUTE_ROUTED_ACTIONS", default=False)
PM_PENDING_TTL_SEC = int(os.getenv("PM_PENDING_TTL_SEC", "300"))
PM_ALLOWED_COMMAND_PREFIXES = [
    part.strip()
    for part in os.getenv(
        "PM_ALLOWED_COMMAND_PREFIXES",
        "git,npm,npx,pnpm,yarn,node,python,python3,pytest,rg,ls,cat,sed,find,claude",
    ).split(",")
    if part.strip()
]

DISALLOWED_SUBSTRINGS = [
    "rm -rf",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    ":(){",
    "git reset --hard",
    "git checkout --",
    "curl |",
    "wget |",
]

STATE_DIR = BOT_DIR / ".state"
LOG_DIR = STATE_DIR / "logs"
CHAT_LOG_FILE = STATE_DIR / "chat-events.jsonl"
STATE_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("pm-bot")
logging.getLogger("httpx").setLevel(logging.WARNING)


# --- Data models ---
@dataclass
class Job:
    job_id: int
    kind: str
    command_display: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    exit_code: Optional[int] = None
    duration_sec: Optional[float] = None
    output_tail: str = ""
    log_path: Optional[str] = None


@dataclass
class PendingApproval:
    action: str
    payload: str
    reason: str
    created_at: float = field(default_factory=time.time)


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[int, Job] = {}
        self._next_id = 1
        self._lock = asyncio.Lock()

    async def create(self, kind: str, command_display: str) -> Job:
        async with self._lock:
            job = Job(job_id=self._next_id, kind=kind, command_display=command_display)
            self._jobs[job.job_id] = job
            self._next_id += 1
            return job

    async def mark_running(self, job_id: int) -> None:
        async with self._lock:
            job = self._jobs[job_id]
            job.status = "running"
            job.started_at = time.time()

    async def mark_finished(
        self,
        job_id: int,
        exit_code: int,
        duration_sec: float,
        output_tail: str,
        log_path: str,
    ) -> None:
        async with self._lock:
            job = self._jobs[job_id]
            job.status = "done" if exit_code == 0 else "failed"
            job.exit_code = exit_code
            job.finished_at = time.time()
            job.duration_sec = duration_sec
            job.output_tail = output_tail
            job.log_path = log_path

    async def list_recent(self, limit: int = 10) -> List[Job]:
        async with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda item: item.job_id, reverse=True)
            return jobs[:limit]

    async def get_last_completed(self) -> Optional[Job]:
        async with self._lock:
            completed = [job for job in self._jobs.values() if job.finished_at is not None]
            if not completed:
                return None
            return sorted(completed, key=lambda item: item.finished_at, reverse=True)[0]


# --- MiniMax brain ---
class MiniMaxBrain:
    def __init__(self) -> None:
        self.enabled = False
        self.reason = ""
        self.client = None

        if OpenAI is None:
            self.reason = "openai package not installed"
            return

        if not MINIMAX_API_KEY:
            self.reason = "MINIMAX_API_KEY missing"
            return

        try:
            self.client = OpenAI(api_key=MINIMAX_API_KEY, base_url=MINIMAX_BASE_URL)
            self.enabled = True
        except Exception as exc:  # pragma: no cover - runtime configuration issue
            self.reason = f"client init failed: {exc}"

    def _chat(self, system_prompt: str, user_prompt: str, max_tokens: int = 700, temperature: float = 0.2) -> str:
        if not self.enabled or not self.client:
            return ""

        try:
            response = self.client.chat.completions.create(
                model=MINIMAX_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=max_tokens,
                temperature=temperature,
            )
            message = response.choices[0].message.content
            return (message or "").strip()
        except Exception as exc:  # pragma: no cover - network/provider runtime issue
            logger.error("MiniMax call failed: %s", exc)
            return ""

    def project_reply(self, user_message: str, snapshot: str) -> str:
        system_prompt = (
            "You are a pragmatic technical project manager for a software repo. "
            "Be concise, concrete, and execution-focused. "
            "Do not invent results. If information is missing, say what command should run next."
        )
        user_prompt = (
            f"Repository snapshot:\n{snapshot}\n\n"
            f"User message:\n{user_message}\n\n"
            "Reply with three labeled sections:\n"
            "1) Current Status\n"
            "2) What To Do Next\n"
            "3) Optional Command"
        )
        reply = self._chat(system_prompt, user_prompt, max_tokens=600)
        if reply:
            return reply

        return (
            "Current Status:\nMiniMax brain unavailable.\n\n"
            "What To Do Next:\nRun `/status` and `/review` to collect current repo signals, "
            "or set `MINIMAX_API_KEY` to enable PM reasoning.\n\n"
            "Optional Command:\n`/status`"
        )

    def review_after_job(
        self,
        intent: str,
        command_display: str,
        exit_code: int,
        output_tail: str,
        snapshot: str,
    ) -> str:
        system_prompt = (
            "You are a strict engineering reviewer. "
            "Prioritize correctness risks, regressions, missing tests, and next implementation steps."
        )
        user_prompt = (
            f"Task intent: {intent or 'not provided'}\n"
            f"Command run: {command_display}\n"
            f"Exit code: {exit_code}\n\n"
            f"Command output tail:\n{output_tail}\n\n"
            f"Repository snapshot after command:\n{snapshot}\n\n"
            "Respond with:\n"
            "- Outcome\n"
            "- Findings (if any)\n"
            "- Next 3 steps"
        )
        reply = self._chat(system_prompt, user_prompt, max_tokens=800)
        if reply:
            return reply

        return (
            "Outcome:\nMiniMax review unavailable.\n\n"
            "Findings:\nInspect command log and run targeted tests for changed files.\n\n"
            "Next 3 steps:\n"
            "1. Run `/status` to confirm changed files.\n"
            "2. Run focused tests/lint for those files.\n"
            "3. Use `/review` for a fresh repo-level summary."
        )

    def next_steps(self, snapshot: str, focus: str) -> str:
        system_prompt = (
            "You are a software PM. Convert repo state into an immediately actionable sequence. "
            "Prefer the minimum set of high-leverage steps."
        )
        user_prompt = (
            f"Focus: {focus or 'general progress update'}\n\n"
            f"Snapshot:\n{snapshot}\n\n"
            "Provide exactly 5 numbered next steps with why each matters."
        )
        reply = self._chat(system_prompt, user_prompt, max_tokens=700)
        if reply:
            return reply

        return (
            "1. Run `/status` to confirm current branch and staged/unstaged changes.\n"
            "2. Run `/run git diff --stat` to quantify scope.\n"
            "3. Run project-specific tests before any merge.\n"
            "4. Run `/review` to summarize risks and blockers.\n"
            "5. Delegate concrete coding tasks via `/delegate <task>`."
        )

    @staticmethod
    def _extract_json(raw_text: str) -> dict:
        if not raw_text:
            return {}
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            return json.loads(raw_text[start : end + 1])
        except json.JSONDecodeError:
            return {}

    def route_message(self, user_message: str, snapshot: str) -> dict:
        """Choose the best control action for a free-form Telegram message."""
        if not self.enabled:
            return {
                "action": "reply",
                "reason": f"MiniMax disabled: {self.reason}",
                "response": self.project_reply(user_message=user_message, snapshot=snapshot),
            }

        system_prompt = (
            "You are a PM control router. Decide which tool/action to run next. "
            "Output EXACTLY one JSON object with keys: action, reason, command, task, response. "
            "Allowed actions: reply, status, review, next, run, claude, delegate, codex. "
            "Use run only for simple safe shell commands. Use delegate for implementation/debug tasks best handled by Claude Code tooling."
        )
        user_prompt = (
            f"User message:\n{user_message}\n\n"
            f"Repo snapshot:\n{snapshot}\n\n"
            "Rules:\n"
            "- If asking for execution, choose run/claude/delegate/codex.\n"
            "- If asking for project state, choose status/review/next.\n"
            "- Prefer codex when user explicitly asks for Codex CLI or Codex coding execution.\n"
            "- Fill only one of command or task for executable actions.\n"
            "- Keep response concise.\n"
            "Return JSON only."
        )
        raw = self._chat(system_prompt, user_prompt, max_tokens=260, temperature=0.1)
        parsed = self._extract_json(raw)
        if not parsed:
            return {
                "action": "reply",
                "reason": "router_parse_failed",
                "response": self.project_reply(user_message=user_message, snapshot=snapshot),
            }

        action = str(parsed.get("action", "reply")).strip().lower()
        if action not in {"reply", "status", "review", "next", "run", "claude", "delegate", "codex"}:
            action = "reply"

        return {
            "action": action,
            "reason": str(parsed.get("reason", "")).strip(),
            "command": str(parsed.get("command", "")).strip(),
            "task": str(parsed.get("task", "")).strip(),
            "response": str(parsed.get("response", "")).strip(),
        }


# --- Utility helpers ---
def parse_chat_ids(raw_value: str) -> List[str]:
    return [part.strip() for part in raw_value.split(",") if part.strip()]


ALLOWED_CHAT_IDS = parse_chat_ids(ALLOWED_CHAT_IDS_RAW)
JOB_MANAGER = JobManager()
BRAIN = MiniMaxBrain()
JOB_SEMAPHORE = asyncio.Semaphore(PM_MAX_PARALLEL_JOBS)
PENDING_APPROVALS: Dict[int, PendingApproval] = {}


def clip_lines(text: str, max_lines: int = 40, max_chars: int = 3000) -> str:
    if not text:
        return ""

    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... ({len(lines) - max_lines} more lines)"]
    clipped = "\n".join(lines)

    if len(clipped) > max_chars:
        return clipped[: max_chars - 20] + "\n... (truncated)"
    return clipped


def run_sync(args: List[str], timeout: int = 10) -> str:
    try:
        completed = subprocess.run(
            args,
            cwd=str(PM_WORKSPACE_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception as exc:  # pragma: no cover - runtime/system issue
        return f"[error] {' '.join(args)} -> {exc}"

    output = (completed.stdout or "").strip()
    if completed.returncode != 0:
        err = (completed.stderr or "").strip()
        if err:
            return f"[exit {completed.returncode}] {err}"
    return output


def collect_repo_snapshot(include_diff_stat: bool = True) -> str:
    branch = run_sync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    status = clip_lines(run_sync(["git", "status", "--short"]), max_lines=60, max_chars=4000)
    commits = clip_lines(run_sync(["git", "log", "--oneline", "-n", "5"]), max_lines=5, max_chars=800)
    diff_stat = ""
    if include_diff_stat:
        diff_stat = clip_lines(run_sync(["git", "diff", "--stat"]), max_lines=40, max_chars=2400)

    status_count = len([line for line in status.splitlines() if line.strip() and not line.startswith("...")])

    parts = [
        f"Workspace: {PM_WORKSPACE_ROOT}",
        f"Branch: {branch or 'unknown'}",
        f"Changed files (approx): {status_count}",
        "Git Status:\n" + (status or "clean"),
        "Recent Commits:\n" + (commits or "none"),
    ]

    if include_diff_stat:
        parts.append("Diff Stat:\n" + (diff_stat or "none"))

    return "\n\n".join(parts)


def split_for_telegram(text: str, chunk_size: int = 3900) -> List[str]:
    if len(text) <= chunk_size:
        return [text]

    chunks: List[str] = []
    remaining = text
    while len(remaining) > chunk_size:
        split_idx = remaining.rfind("\n", 0, chunk_size)
        if split_idx == -1:
            split_idx = chunk_size
        chunks.append(remaining[:split_idx])
        remaining = remaining[split_idx:].lstrip("\n")

    if remaining:
        chunks.append(remaining)
    return chunks


def _preview(text: str, limit: int = 240) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def log_chat_event(event_type: str, chat_id: int, payload: Dict[str, object]) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "chat_id": chat_id,
        "payload": payload,
    }
    try:
        with CHAT_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=True) + "\n")
    except Exception as exc:  # pragma: no cover - best-effort diagnostics
        logger.warning("Failed to write chat event: %s", exc)


def read_recent_chat_events(limit: int = 20) -> List[dict]:
    if not CHAT_LOG_FILE.exists():
        return []
    try:
        lines = CHAT_LOG_FILE.read_text(encoding="utf-8").splitlines()
        selected = lines[-max(1, limit) :]
        out = []
        for line in selected:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
    except Exception:
        return []


async def send_long_message(context: ContextTypes.DEFAULT_TYPE, chat_id: int, text: str) -> None:
    for chunk in split_for_telegram(text):
        await context.bot.send_message(chat_id=chat_id, text=chunk)


def is_authorized(update: Update) -> bool:
    if not ALLOWED_CHAT_IDS:
        return True

    chat = update.effective_chat
    if not chat:
        return False
    return str(chat.id) in ALLOWED_CHAT_IDS


async def require_authorized(update: Update) -> bool:
    if is_authorized(update):
        return True

    if update.message:
        await update.message.reply_text("This bot is locked to configured chat IDs.")
    logger.warning("Unauthorized chat blocked: %s", update.effective_chat.id if update.effective_chat else "unknown")
    return False


def validate_shell_command(raw_command: str) -> Tuple[Optional[List[str]], Optional[str]]:
    raw = raw_command.strip()
    if not raw:
        return None, "Usage: /run <command>"

    if "\n" in raw:
        return None, "Multi-line commands are blocked. Use a single command."

    for operator in ["&&", "||", ";", "|", "`", "$(", ">", "<"]:
        if operator in raw:
            return None, f"Shell operator `{operator}` is blocked for safety."

    lowered = raw.lower()
    for banned in DISALLOWED_SUBSTRINGS:
        if banned in lowered:
            return None, f"Blocked by safety rule: `{banned}`"

    try:
        args = shlex.split(raw)
    except ValueError as exc:
        return None, f"Command parse error: {exc}"

    if not args:
        return None, "Usage: /run <command>"

    executable = Path(args[0]).name
    if executable not in PM_ALLOWED_COMMAND_PREFIXES:
        allowed = ", ".join(PM_ALLOWED_COMMAND_PREFIXES)
        return None, f"`{executable}` is not in allowed commands: {allowed}"

    return args, None


async def run_process(args: List[str], timeout_sec: int) -> Tuple[int, str, str, float]:
    start = time.time()

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(PM_WORKSPACE_ROOT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        duration = time.time() - start
        return 127, "", f"Executable not found: {args[0]}", duration
    except Exception as exc:  # pragma: no cover - runtime/system issue
        duration = time.time() - start
        return 1, "", f"Failed to start process: {exc}", duration

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        duration = time.time() - start
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        duration = time.time() - start
        return 124, "", f"Timed out after {timeout_sec}s", duration

    stdout = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
    stderr = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
    return proc.returncode or 0, stdout, stderr, duration


def build_output_tail(stdout: str, stderr: str) -> str:
    sections: List[str] = []
    if stdout.strip():
        sections.append("[stdout]\n" + stdout.strip())
    if stderr.strip():
        sections.append("[stderr]\n" + stderr.strip())

    combined = "\n\n".join(sections).strip() or "(no output)"
    if len(combined) > PM_MAX_OUTPUT_CHARS:
        return "... (truncated)\n" + combined[-PM_MAX_OUTPUT_CHARS:]
    return combined


def write_job_log(job: Job, args: List[str], exit_code: int, duration_sec: float, stdout: str, stderr: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = LOG_DIR / f"job-{job.job_id:04d}-{job.kind}-{timestamp}.log"

    payload = {
        "job_id": job.job_id,
        "kind": job.kind,
        "command": args,
        "command_display": job.command_display,
        "exit_code": exit_code,
        "duration_sec": round(duration_sec, 3),
        "created_at": datetime.fromtimestamp(job.created_at, tz=timezone.utc).isoformat(),
        "stdout": stdout,
        "stderr": stderr,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path)


async def execute_job_and_report(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    job: Job,
    args: List[str],
    task_intent: str,
    auto_review: bool,
) -> None:
    async with JOB_SEMAPHORE:
        await JOB_MANAGER.mark_running(job.job_id)
        exit_code, stdout, stderr, duration_sec = await run_process(args, PM_COMMAND_TIMEOUT_SEC)
        output_tail = build_output_tail(stdout, stderr)
        log_path = write_job_log(job, args, exit_code, duration_sec, stdout, stderr)
        await JOB_MANAGER.mark_finished(job.job_id, exit_code, duration_sec, output_tail, log_path)

    await send_long_message(
        context,
        chat_id,
        (
            f"Job #{job.job_id} finished.\n"
            f"Kind: {job.kind}\n"
            f"Exit: {exit_code}\n"
            f"Duration: {duration_sec:.1f}s\n"
            f"Log: {log_path}\n\n"
            f"Output tail:\n{output_tail}"
        ),
    )

    if auto_review:
        snapshot = collect_repo_snapshot(include_diff_stat=True)
        review = BRAIN.review_after_job(
            intent=task_intent,
            command_display=job.command_display,
            exit_code=exit_code,
            output_tail=output_tail,
            snapshot=snapshot,
        )
        await send_long_message(context, chat_id, "PM Review:\n" + review)


def extract_command_text(update: Update) -> str:
    if not update.message or not update.message.text:
        return ""

    text = update.message.text.strip()
    parts = text.split(" ", 1)
    return parts[1].strip() if len(parts) > 1 else ""


async def queue_shell_job(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    raw_command: str,
    task_intent: str,
    auto_review: bool,
) -> Tuple[bool, str]:
    args, error = validate_shell_command(raw_command)
    if error:
        return False, error

    assert args is not None
    job = await JOB_MANAGER.create(kind="shell", command_display=shlex.join(args))
    asyncio.create_task(
        execute_job_and_report(
            context=context,
            chat_id=chat_id,
            job=job,
            args=args,
            task_intent=task_intent,
            auto_review=auto_review,
        )
    )
    return True, f"Queued job #{job.job_id}: {job.command_display}"


def build_claude_command_display() -> str:
    base = f"{CLAUDE_BIN} -p <task>"
    if PM_CLAUDE_MCP_CONFIG:
        base += " --mcp-config <path>"
    return base


async def queue_claude_job(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    task_prompt: str,
    kind: str,
    auto_review: bool,
) -> str:
    args = build_claude_args(task_prompt)
    job = await JOB_MANAGER.create(kind=kind, command_display=build_claude_command_display())
    asyncio.create_task(
        execute_job_and_report(
            context=context,
            chat_id=chat_id,
            job=job,
            args=args,
            task_intent=task_prompt,
            auto_review=auto_review,
        )
    )
    return f"Queued {kind} job #{job.job_id}."


def pending_for_chat(chat_id: int) -> Optional[PendingApproval]:
    pending = PENDING_APPROVALS.get(chat_id)
    if not pending:
        return None
    if time.time() - pending.created_at > PM_PENDING_TTL_SEC:
        PENDING_APPROVALS.pop(chat_id, None)
        return None
    return pending


def is_approve_message(text: str) -> bool:
    normalized = text.strip().lower()
    return normalized in {"approve", "approved", "yes", "y", "run it", "do it", "execute"}


def is_cancel_message(text: str) -> bool:
    normalized = text.strip().lower()
    return normalized in {"cancel", "stop", "no", "n", "abort"}


async def request_action_approval(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    action: str,
    payload: str,
    reason: str,
) -> None:
    PENDING_APPROVALS[chat_id] = PendingApproval(action=action, payload=payload, reason=reason or "router decision")
    await send_long_message(
        context,
        chat_id,
        (
            f"Proposed action: {action}\n"
            f"Reason: {reason or 'not provided'}\n"
            f"Payload: {payload}\n\n"
            f"Reply `approve` within {PM_PENDING_TTL_SEC}s to execute, or `cancel`."
        ),
    )


async def execute_pending_approval(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    pending: PendingApproval,
) -> str:
    if pending.action == "run":
        ok, msg = await queue_shell_job(
            context=context,
            chat_id=chat_id,
            raw_command=pending.payload,
            task_intent=f"router-approved run: {pending.reason}",
            auto_review=False,
        )
        return msg if ok else f"Execution blocked: {msg}"

    if pending.action == "claude":
        return await queue_claude_job(
            context=context,
            chat_id=chat_id,
            task_prompt=pending.payload,
            kind="claude",
            auto_review=False,
        )

    if pending.action == "delegate":
        return await queue_claude_job(
            context=context,
            chat_id=chat_id,
            task_prompt=pending.payload,
            kind="delegate",
            auto_review=True,
        )

    if pending.action == "codex":
        return await queue_codex_job(
            context=context,
            chat_id=chat_id,
            task_prompt=pending.payload,
            auto_review=True,
        )

    return f"Unsupported pending action: {pending.action}"


# --- Telegram handlers ---
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    minimax_status = "enabled" if BRAIN.enabled else f"disabled ({BRAIN.reason})"
    allowed_chats = ", ".join(ALLOWED_CHAT_IDS) if ALLOWED_CHAT_IDS else "ALL"
    router_status = "enabled" if PM_ROUTER_ENABLED else "disabled"
    routed_exec = "auto-exec" if PM_AUTO_EXECUTE_ROUTED_ACTIONS else "approval-required"

    help_text = (
        "Project Manager bot online.\n\n"
        f"Workspace: {PM_WORKSPACE_ROOT}\n"
        f"MiniMax: {minimax_status}\n"
        f"Allowed chats: {allowed_chats}\n\n"
        f"Router: {router_status} ({routed_exec})\n\n"
        "Commands:\n"
        "/status - current repo snapshot\n"
        "/run <cmd> - run a safe CLI command\n"
        "/codex <task> - run Codex CLI task (with PM review)\n"
        "/claude <task> - run Claude Code in print mode\n"
        "/delegate <task> - run Claude + auto review\n"
        "/review [focus] - repo-level PM review\n"
        "/next [focus] - next-step plan\n"
        "/jobs - recent job statuses\n"
        "/recentlogs [n] - show last n inbound/router events\n"
        "approve / cancel - handle routed execution proposals\n"
        "/help - show this message"
    )
    await update.message.reply_text(help_text)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await cmd_start(update, context)


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    snapshot = collect_repo_snapshot(include_diff_stat=True)
    recent_jobs = await JOB_MANAGER.list_recent(limit=5)

    if recent_jobs:
        jobs_lines = [
            f"#{job.job_id} {job.kind} {job.status} exit={job.exit_code if job.exit_code is not None else '-'} "
            f"dur={job.duration_sec:.1f}s" if job.duration_sec is not None else f"#{job.job_id} {job.kind} {job.status}"
            for job in recent_jobs
        ]
        jobs_section = "\n".join(jobs_lines)
    else:
        jobs_section = "No jobs yet."

    await send_long_message(
        context,
        update.effective_chat.id,
        f"{snapshot}\n\nRecent Jobs:\n{jobs_section}",
    )


async def cmd_jobs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    jobs = await JOB_MANAGER.list_recent(limit=15)
    if not jobs:
        await update.message.reply_text("No jobs recorded yet.")
        return

    lines = ["Recent jobs:"]
    for job in jobs:
        duration = f"{job.duration_sec:.1f}s" if job.duration_sec is not None else "-"
        exit_text = str(job.exit_code) if job.exit_code is not None else "-"
        lines.append(
            f"#{job.job_id} [{job.kind}] {job.status} exit={exit_text} dur={duration}\n"
            f"  {job.command_display}"
        )
    await send_long_message(context, update.effective_chat.id, "\n".join(lines))


async def cmd_recentlogs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    limit_text = extract_command_text(update)
    try:
        limit = int(limit_text) if limit_text else 15
    except ValueError:
        limit = 15
    limit = max(1, min(50, limit))

    events = read_recent_chat_events(limit=limit)
    if not events:
        await update.message.reply_text("No chat event logs yet.")
        return

    lines = [f"Recent chat events (last {len(events)}):"]
    for entry in events:
        event_type = entry.get("event_type", "unknown")
        ts = str(entry.get("ts", ""))[11:19]
        payload = entry.get("payload", {})
        if isinstance(payload, dict):
            summary = payload.get("text") or payload.get("action") or payload.get("result") or str(payload)
        else:
            summary = str(payload)
        lines.append(f"[{ts}] {event_type}: {_preview(str(summary), 140)}")

    await send_long_message(context, update.effective_chat.id, "\n".join(lines))


async def cmd_run(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    raw_command = extract_command_text(update)
    log_chat_event(
        "command.run",
        update.effective_chat.id,
        {"text": _preview(raw_command, 300)},
    )
    ok, message = await queue_shell_job(
        context=context,
        chat_id=update.effective_chat.id,
        raw_command=raw_command,
        task_intent="manual /run command",
        auto_review=False,
    )
    log_chat_event(
        "command.run.result",
        update.effective_chat.id,
        {"result": _preview(message, 300), "ok": ok},
    )
    await update.message.reply_text(message if ok else f"Blocked: {message}")


def build_claude_args(task_prompt: str) -> List[str]:
    args = [
        CLAUDE_BIN,
        "-p",
        task_prompt,
        "--output-format",
        "text",
        "--permission-mode",
        CLAUDE_PERMISSION_MODE,
        "--add-dir",
        str(PM_WORKSPACE_ROOT),
    ]

    if CLAUDE_MODEL:
        args.extend(["--model", CLAUDE_MODEL])
    if PM_CLAUDE_MCP_CONFIG:
        args.extend(["--mcp-config", PM_CLAUDE_MCP_CONFIG])
        if PM_CLAUDE_STRICT_MCP_CONFIG:
            args.append("--strict-mcp-config")

    return args


def build_codex_args(task_prompt: str) -> List[str]:
    args = [
        CODEX_BIN,
        "exec",
        task_prompt,
        "-C",
        str(PM_WORKSPACE_ROOT),
        "-s",
        CODEX_SANDBOX,
    ]
    if CODEX_MODEL:
        args.extend(["-m", CODEX_MODEL])
    if CODEX_PROFILE:
        args.extend(["-p", CODEX_PROFILE])
    if CODEX_FULL_AUTO:
        args.append("--full-auto")
    if CODEX_SKIP_GIT_REPO_CHECK:
        args.append("--skip-git-repo-check")
    for extra_dir in CODEX_ADD_DIRS:
        args.extend(["--add-dir", extra_dir])
    return args


def build_codex_command_display() -> str:
    display = f"{CODEX_BIN} exec <task> -s {CODEX_SANDBOX}"
    if CODEX_MODEL:
        display += " -m <model>"
    if CODEX_PROFILE:
        display += " -p <profile>"
    return display


async def queue_codex_job(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    task_prompt: str,
    auto_review: bool,
) -> str:
    args = build_codex_args(task_prompt)
    job = await JOB_MANAGER.create(kind="codex", command_display=build_codex_command_display())
    asyncio.create_task(
        execute_job_and_report(
            context=context,
            chat_id=chat_id,
            job=job,
            args=args,
            task_intent=task_prompt,
            auto_review=auto_review,
        )
    )
    return f"Queued codex job #{job.job_id}."


async def cmd_claude(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    task_prompt = extract_command_text(update)
    if not task_prompt:
        await update.message.reply_text("Usage: /claude <task prompt>")
        return
    log_chat_event(
        "command.claude",
        update.effective_chat.id,
        {"text": _preview(task_prompt, 300)},
    )

    message = await queue_claude_job(
        context=context,
        chat_id=update.effective_chat.id,
        task_prompt=task_prompt,
        kind="claude",
        auto_review=False,
    )
    log_chat_event("command.claude.result", update.effective_chat.id, {"result": _preview(message, 300)})
    await update.message.reply_text(message + "\nI will send output when it finishes.")


async def cmd_codex(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    task_prompt = extract_command_text(update)
    if not task_prompt:
        await update.message.reply_text("Usage: /codex <task prompt>")
        return
    log_chat_event(
        "command.codex",
        update.effective_chat.id,
        {"text": _preview(task_prompt, 300)},
    )

    message = await queue_codex_job(
        context=context,
        chat_id=update.effective_chat.id,
        task_prompt=task_prompt,
        auto_review=True,
    )
    log_chat_event("command.codex.result", update.effective_chat.id, {"result": _preview(message, 300)})
    await update.message.reply_text(message + "\nFlow: Codex execution -> PM review -> next steps.")


async def cmd_delegate(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    task_prompt = extract_command_text(update)
    if not task_prompt:
        await update.message.reply_text("Usage: /delegate <task prompt>")
        return
    log_chat_event(
        "command.delegate",
        update.effective_chat.id,
        {"text": _preview(task_prompt, 300)},
    )

    message = await queue_claude_job(
        context=context,
        chat_id=update.effective_chat.id,
        task_prompt=task_prompt,
        kind="delegate",
        auto_review=True,
    )
    log_chat_event("command.delegate.result", update.effective_chat.id, {"result": _preview(message, 300)})
    await update.message.reply_text(message + "\nFlow: Claude execution -> PM review -> next steps.")


async def cmd_review(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    focus = extract_command_text(update)
    log_chat_event(
        "command.review",
        update.effective_chat.id,
        {"text": _preview(focus, 300)},
    )
    snapshot = collect_repo_snapshot(include_diff_stat=True)
    last_job = await JOB_MANAGER.get_last_completed()

    if last_job:
        context_line = (
            f"Last completed job: #{last_job.job_id} ({last_job.kind}) "
            f"exit={last_job.exit_code} dur={last_job.duration_sec:.1f}s\n"
            f"Command: {last_job.command_display}\n"
            f"Output tail:\n{last_job.output_tail}"
        )
    else:
        context_line = "Last completed job: none"

    review = BRAIN.review_after_job(
        intent=focus or "repo review request",
        command_display=last_job.command_display if last_job else "(none)",
        exit_code=last_job.exit_code if last_job and last_job.exit_code is not None else 0,
        output_tail=last_job.output_tail if last_job else "(no recent job output)",
        snapshot=snapshot + "\n\n" + context_line,
    )
    log_chat_event("command.review.result", update.effective_chat.id, {"text": _preview(review, 300)})

    await send_long_message(context, update.effective_chat.id, "PM Review:\n" + review)


async def cmd_next(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    focus = extract_command_text(update)
    log_chat_event(
        "command.next",
        update.effective_chat.id,
        {"text": _preview(focus, 300)},
    )
    snapshot = collect_repo_snapshot(include_diff_stat=True)
    next_steps = BRAIN.next_steps(snapshot=snapshot, focus=focus)
    log_chat_event("command.next.result", update.effective_chat.id, {"text": _preview(next_steps, 300)})
    await send_long_message(context, update.effective_chat.id, "Next steps:\n" + next_steps)


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await require_authorized(update):
        return

    if not update.message or not update.message.text:
        return

    user_message = update.message.text.strip()
    if not user_message:
        return

    chat_id = update.effective_chat.id
    log_chat_event(
        "message.inbound",
        chat_id,
        {
            "text": _preview(user_message, 500),
            "user_id": update.effective_user.id if update.effective_user else None,
        },
    )

    pending = pending_for_chat(chat_id)
    if pending and is_cancel_message(user_message):
        PENDING_APPROVALS.pop(chat_id, None)
        log_chat_event("approval.cancel", chat_id, {"action": pending.action, "payload": _preview(pending.payload, 300)})
        await update.message.reply_text("Pending action canceled.")
        return
    if pending and is_approve_message(user_message):
        PENDING_APPROVALS.pop(chat_id, None)
        result = await execute_pending_approval(context=context, chat_id=chat_id, pending=pending)
        log_chat_event(
            "approval.execute",
            chat_id,
            {"action": pending.action, "payload": _preview(pending.payload, 300), "result": _preview(result, 300)},
        )
        await send_long_message(context, chat_id, result)
        return

    snapshot = collect_repo_snapshot(include_diff_stat=False)
    if not PM_ROUTER_ENABLED:
        reply = BRAIN.project_reply(user_message=user_message, snapshot=snapshot)
        log_chat_event("message.reply", chat_id, {"source": "direct", "text": _preview(reply, 500)})
        await send_long_message(context, chat_id, reply)
        return

    decision = BRAIN.route_message(user_message=user_message, snapshot=snapshot)
    action = decision.get("action", "reply")
    reason = decision.get("reason", "")
    response_text = decision.get("response", "")
    log_chat_event(
        "router.decision",
        chat_id,
        {
            "action": action,
            "reason": _preview(reason, 200),
            "command": _preview(str(decision.get("command", "")), 220),
            "task": _preview(str(decision.get("task", "")), 220),
        },
    )

    if action == "status":
        status_snapshot = collect_repo_snapshot(include_diff_stat=True)
        if response_text:
            log_chat_event("message.reply", chat_id, {"source": "router.status", "text": _preview(response_text, 500)})
            await send_long_message(context, chat_id, response_text + "\n\n" + status_snapshot)
        else:
            await send_long_message(context, chat_id, status_snapshot)
        return

    if action == "review":
        review = BRAIN.review_after_job(
            intent=user_message,
            command_display="(router)",
            exit_code=0,
            output_tail="(no command output provided)",
            snapshot=collect_repo_snapshot(include_diff_stat=True),
        )
        log_chat_event("message.reply", chat_id, {"source": "router.review", "text": _preview(review, 500)})
        await send_long_message(context, chat_id, "PM Review:\n" + review)
        return

    if action == "next":
        next_steps = BRAIN.next_steps(snapshot=collect_repo_snapshot(include_diff_stat=True), focus=user_message)
        log_chat_event("message.reply", chat_id, {"source": "router.next", "text": _preview(next_steps, 500)})
        await send_long_message(context, chat_id, "Next steps:\n" + next_steps)
        return

    if action in {"run", "claude", "delegate", "codex"}:
        payload = (decision.get("command", "") if action == "run" else decision.get("task", "")).strip()
        if not payload:
            fallback = response_text or "I could not extract an executable payload. Please be more specific."
            await send_long_message(context, chat_id, fallback)
            return

        if PM_AUTO_EXECUTE_ROUTED_ACTIONS:
            if action == "run":
                ok, message = await queue_shell_job(
                    context=context,
                    chat_id=chat_id,
                    raw_command=payload,
                    task_intent=f"router auto-run: {reason}",
                    auto_review=False,
                )
                log_chat_event(
                    "router.execute",
                    chat_id,
                    {"action": "run", "ok": ok, "result": _preview(message, 300), "reason": _preview(reason, 200)},
                )
                await send_long_message(context, chat_id, message if ok else f"Blocked: {message}")
                return

            if action == "codex":
                queued = await queue_codex_job(
                    context=context,
                    chat_id=chat_id,
                    task_prompt=payload,
                    auto_review=True,
                )
                log_chat_event("router.execute", chat_id, {"action": "codex", "result": _preview(queued, 300)})
                await send_long_message(context, chat_id, queued)
                return

            queued = await queue_claude_job(
                context=context,
                chat_id=chat_id,
                task_prompt=payload,
                kind=action,
                auto_review=(action == "delegate"),
            )
            log_chat_event("router.execute", chat_id, {"action": action, "result": _preview(queued, 300)})
            await send_long_message(context, chat_id, queued)
            return

        await request_action_approval(
            context=context,
            chat_id=chat_id,
            action=action,
            payload=payload,
            reason=reason,
        )
        log_chat_event(
            "router.pending_approval",
            chat_id,
            {"action": action, "payload": _preview(payload, 300), "reason": _preview(reason, 200)},
        )
        return

    reply = response_text or BRAIN.project_reply(user_message=user_message, snapshot=snapshot)
    log_chat_event("message.reply", chat_id, {"source": "router.reply", "text": _preview(reply, 500)})
    await send_long_message(context, chat_id, reply)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Telegram handler error", exc_info=context.error)


def main() -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("Missing Telegram bot token: set TG_HTTP_API or TELEGRAM_BOT_TOKEN")

    if not ALLOWED_CHAT_IDS:
        raise RuntimeError("Set TELEGRAM_ALLOWED_CHAT_IDS or TG_CHAT_ID before starting this bot")

    if not PM_WORKSPACE_ROOT.exists():
        raise RuntimeError(f"Workspace root does not exist: {PM_WORKSPACE_ROOT}")

    logger.info("Starting project-manager Telegram bot")
    logger.info("Workspace: %s", PM_WORKSPACE_ROOT)
    logger.info("MiniMax: %s", "enabled" if BRAIN.enabled else f"disabled ({BRAIN.reason})")
    logger.info("Allowed chats: %s", ", ".join(ALLOWED_CHAT_IDS) if ALLOWED_CHAT_IDS else "ALL")
    logger.info("Router: %s", "enabled" if PM_ROUTER_ENABLED else "disabled")
    logger.info(
        "Routed execution mode: %s",
        "auto-execute" if PM_AUTO_EXECUTE_ROUTED_ACTIONS else "approval-required",
    )
    logger.info("Codex: %s (sandbox=%s)", CODEX_BIN, CODEX_SANDBOX)
    if CODEX_PROFILE:
        logger.info("Codex profile: %s", CODEX_PROFILE)
    if PM_CLAUDE_MCP_CONFIG:
        logger.info("Claude MCP config: %s", PM_CLAUDE_MCP_CONFIG)

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_error_handler(on_error)

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("jobs", cmd_jobs))
    app.add_handler(CommandHandler("recentlogs", cmd_recentlogs))
    app.add_handler(CommandHandler("run", cmd_run))
    app.add_handler(CommandHandler("codex", cmd_codex))
    app.add_handler(CommandHandler("claude", cmd_claude))
    app.add_handler(CommandHandler("delegate", cmd_delegate))
    app.add_handler(CommandHandler("review", cmd_review))
    app.add_handler(CommandHandler("next", cmd_next))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
