import type { AgentSessionRecord } from "./storage.js";

function asDict(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asList<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeAgentId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function compactSingleLine(value: unknown, limit = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function dedupe(values: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const agentId = normalizeAgentId(value);
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ordered.push(agentId);
  }
  return ordered;
}

function parseAnyInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseAnyFloat(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoToEpoch(value: unknown): number {
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function ageSeconds(value: unknown, nowSeconds: number): number {
  const epoch = isoToEpoch(value);
  if (!epoch) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, nowSeconds - epoch);
}

type GuiAgent = {
  agent_id: string;
  display_name: string;
  tier: string;
  role: string;
  parent_agent_id: string;
  managed_agent_ids: string[];
  accent_color: string;
  active: boolean;
};

type GuiPresence = {
  agent: GuiAgent;
  token: string;
  state: string;
  activity: string;
  location: string;
  actions: string[];
  evidence_source: string;
  evidence_detail: string;
};

function buildAgentToken(displayName: string, agentId: string): string {
  const words = String(displayName).split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] ?? "X"}${words[1][0] ?? "X"}`.toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase().padEnd(2, "X");
  }
  return agentId.slice(0, 2).toUpperCase().padEnd(2, "X");
}

function buildCatalog(raw: Record<string, unknown>) {
  const activeIds = new Set(dedupe(asList(raw.active_agent_ids)));
  const catalog = new Map<string, GuiAgent>();
  for (const entry of asList(raw.agents)) {
    const item = asDict(entry);
    const agentId = normalizeAgentId(item.agent_id);
    if (!agentId) {
      continue;
    }
    catalog.set(agentId, {
      agent_id: agentId,
      display_name: String(item.display_name ?? agentId).trim() || agentId,
      tier: String(item.coordination_tier ?? "support").trim().toLowerCase() || "support",
      role: String(item.role_lane ?? "support").trim().toLowerCase() || "support",
      parent_agent_id: normalizeAgentId(item.parent_agent_id),
      managed_agent_ids: dedupe(asList(item.managed_agent_ids)),
      accent_color: String(item.accent_color ?? "").trim(),
      active: activeIds.has(agentId),
    });
  }
  return catalog;
}

function buildTaskIndex(...payloads: Record<string, unknown>[]) {
  const index = new Map<string, Record<string, unknown>>();
  for (const payload of payloads) {
    for (const taskRaw of asList(payload.tasks)) {
      const task = asDict(taskRaw);
      const taskId = String(task.task_id ?? "").trim();
      if (taskId) {
        index.set(taskId, task);
      }
    }
  }
  return index;
}

function maybeTurn(workboard: Record<string, unknown>) {
  return asDict(workboard.active_turn).turn_id ? asDict(workboard.active_turn) : asDict(workboard.latest_turn);
}

function buildAdapterBlocks(adapter: Record<string, unknown>, nowSeconds: number) {
  const blocked = new Map<string, { state: string; detail: string }>();
  for (const stateRaw of asList(adapter.states)) {
    const state = asDict(stateRaw);
    const agentId = normalizeAgentId(state.agent_id);
    if (!agentId) {
      continue;
    }
    const updatedAt = String(state.updated_at ?? "").trim();
    if (ageSeconds(updatedAt, nowSeconds) > 600) {
      continue;
    }
    const open = Boolean(state.open);
    const lastResult = String(state.last_result ?? "").trim().toLowerCase();
    if (!open && !["failure", "trip-opened"].includes(lastResult)) {
      continue;
    }
    const errorText = compactSingleLine(state.last_error, 160);
    const detail = errorText || compactSingleLine(lastResult || "adapter issue", 160) || "adapter issue";
    blocked.set(agentId, {
      state: /command not found|permission denied/i.test(detail) ? "offline" : "blocked",
      detail,
    });
  }
  return blocked;
}

function buildChatSignals(busTail: Record<string, unknown>, nowSeconds: number) {
  const chat = new Map<string, { state: string; activity: string; detail: string }>();
  for (const eventRaw of asList(busTail.events)) {
    const event = asDict(eventRaw);
    const agentId = normalizeAgentId(event.source_agent);
    if (!agentId) {
      continue;
    }
    const createdAt = String(event.created_at ?? "").trim();
    const age = ageSeconds(createdAt, nowSeconds);
    if (age > 900) {
      continue;
    }
    const content = compactSingleLine(event.content || event.event_type || "recent message", 72);
    chat.set(agentId, {
      state: age <= 240 ? "talking" : "break",
      activity: content || "recent message",
      detail: String(event.event_id ?? createdAt ?? "bus-event"),
    });
  }
  return chat;
}

function buildProviderSignals(raw: Record<string, unknown>) {
  const providerBridge = asDict(raw.provider_bridge);
  const diagnosticsPayload = asDict(providerBridge.diagnostics);
  if (diagnosticsPayload.stale === true) {
    return new Map();
  }
  const diagnostics = asList(diagnosticsPayload.diagnostics);
  const agentIdsByClient: Record<string, string[]> = {
    codex: ["codex"],
    cursor: ["cursor"],
    "gemini-cli": ["gemini"],
    "github-copilot-cli": ["github-copilot"],
    "github-copilot-vscode": ["github-copilot"],
  };
  const signals = new Map<string, { state: string; activity: string; detail: string; location: string; priority: number }>();
  for (const entryRaw of diagnostics) {
    const entry = asDict(entryRaw);
    const clientId = String(entry.client_id ?? "").trim();
    const displayName = String((entry.display_name ?? clientId) || "provider").trim() || "provider";
    const status = String(entry.status ?? "").trim().toLowerCase();
    const detail = compactSingleLine(entry.detail || status || "provider-bridge", 120);
    const mappedAgentIds = agentIdsByClient[clientId] || [];
    if (!mappedAgentIds.length) {
      continue;
    }
    let signal:
      | { state: string; activity: string; detail: string; location: string; priority: number }
      | null = null;
    if (status === "connected") {
      signal = {
        state: "ready",
        activity: `${displayName} bridge connected`,
        detail,
        location: "ops",
        priority: 4,
      };
    } else if (status === "configured") {
      signal = {
        state: "sleeping",
        activity: `${displayName} bridge configured`,
        detail,
        location: "sofa",
        priority: 3,
      };
    } else if (status === "disconnected") {
      signal = {
        state: "blocked",
        activity: `${displayName} bridge disconnected`,
        detail,
        location: "ops",
        priority: 2,
      };
    } else if (status === "unavailable") {
      signal = {
        state: "offline",
        activity: `${displayName} bridge unavailable`,
        detail,
        location: "ops",
        priority: 1,
      };
    }
    if (!signal) {
      continue;
    }
    for (const agentId of mappedAgentIds) {
      const current = signals.get(agentId);
      if (!current || signal.priority >= current.priority) {
        signals.set(agentId, signal);
      }
    }
  }
  return new Map(
    [...signals.entries()].map(([agentId, signal]) => [
      agentId,
      {
        state: signal.state,
        activity: signal.activity,
        detail: signal.detail,
        location: signal.location,
      },
    ])
  );
}

function buildTaskSignals(
  catalog: Map<string, GuiAgent>,
  tmux: Record<string, unknown>,
  taskRunning: Record<string, unknown>,
  taskPending: Record<string, unknown>
) {
  const ownerSignals = new Map<string, { state: string; activity: string; detail: string }>();
  const supervisorSignals = new Map<string, { state: string; activity: string; detail: string }>();
  const taskBatches = [
    ["tmux", asList(asDict(tmux.state).tasks)],
    ["task", [...asList(taskRunning.tasks), ...asList(taskPending.tasks)]],
  ] as const;

  const applySignal = (
    bucket: Map<string, { state: string; activity: string; detail: string }>,
    agentId: string,
    state: string,
    activity: string,
    detail: string
  ) => {
    if (!catalog.has(agentId)) {
      return;
    }
    const existing = bucket.get(agentId);
    if (existing && existing.state === "running") {
      return;
    }
    bucket.set(agentId, { state, activity, detail });
  };

  for (const [source, tasks] of taskBatches) {
    for (const taskRaw of tasks) {
      const task = asDict(taskRaw);
      const status = String(task.status ?? "").trim().toLowerCase();
      const normalizedStatus = status === "pending" ? "queued" : status;
      if (!["running", "queued", "dispatched"].includes(normalizedStatus)) {
        continue;
      }
      const metadata = asDict(task.metadata);
      const payload = asDict(task.payload);
      const owners = dedupe([
        metadata.delegate_agent_id,
        payload.delegate_agent_id,
        metadata.selected_agent,
        payload.selected_agent,
      ]).filter((agentId) => catalog.has(agentId));
      const supervisors = dedupe([
        metadata.lead_agent_id,
        payload.lead_agent_id,
      ]).filter((agentId) => catalog.has(agentId) && !owners.includes(agentId));
      const activity = compactSingleLine(
        task.objective || payload.task_objective || task.title || task.command || "bounded task",
        56
      );
      const detail = String(task.task_id ?? task.title ?? `${source}-task`).trim();
      for (const ownerId of owners) {
        applySignal(ownerSignals, ownerId, normalizedStatus, activity, detail);
      }
      for (const supervisorId of supervisors) {
        applySignal(supervisorSignals, supervisorId, normalizedStatus, `directing: ${activity}`, detail);
      }
    }
  }
  return { ownerSignals, supervisorSignals };
}

function buildSessionSignals(
  catalog: Map<string, GuiAgent>,
  sessionsPayload: Record<string, unknown>,
  taskIndex: Map<string, Record<string, unknown>>,
  nowSeconds: number
) {
  const signals = new Map<string, { state: string; activity: string; detail: string }>();
  for (const sessionRaw of asList(sessionsPayload.sessions)) {
    const session = asDict(sessionRaw) as Record<string, unknown> & Partial<AgentSessionRecord>;
    const agentId = normalizeAgentId(session.agent_id);
    if (!catalog.has(agentId)) {
      continue;
    }
    const status = String(session.status ?? "").trim().toLowerCase();
    if (!["busy", "active", "idle"].includes(status)) {
      continue;
    }
    const updatedAt = String(session.updated_at ?? session.heartbeat_at ?? "").trim();
    if (ageSeconds(updatedAt, nowSeconds) > 900) {
      continue;
    }
    const metadata = asDict(session.metadata);
    const currentTaskId =
      String(metadata.current_task_id ?? "").trim() ||
      String(metadata.last_source_task_id ?? "").trim() ||
      String(metadata.last_claimed_task_id ?? "").trim();
    const task = currentTaskId ? asDict(taskIndex.get(currentTaskId)) : {};
    const detail = String(session.session_id ?? "session").trim() || "session";
    const existing = signals.get(agentId);
    if (status === "busy" || Boolean(currentTaskId)) {
      const activity = compactSingleLine(
        task.objective || asDict(task.payload).task_objective || metadata.last_selected_strategy || metadata.objective || "active session",
        56
      );
      signals.set(agentId, {
        state: "running",
        activity: activity || "active session",
        detail,
      });
      continue;
    }
    if (existing?.state === "running") {
      continue;
    }
    signals.set(agentId, {
      state: "ready",
      activity:
        compactSingleLine(
          metadata.last_selected_strategy ||
            metadata.objective ||
            metadata.current_focus ||
            metadata.last_summary ||
            "session heartbeat clean",
          56
        ) || "session heartbeat clean",
      detail,
    });
  }
  return signals;
}

function partitionRooms(presences: GuiPresence[]) {
  const lounge = presences.filter((presence) =>
    ["cooler", "lounge", "sofa"].includes(presence.location) || ["talking", "break", "sleeping"].includes(presence.state)
  );
  const ops = presences.filter(
    (presence) => !lounge.includes(presence) && ["blocked", "offline"].includes(presence.state)
  );
  const command = presences.filter(
    (presence) =>
      !lounge.includes(presence) &&
      !ops.includes(presence) &&
      (["lead", "director"].includes(presence.agent.tier) || ["planner", "orchestrator", "reliability-critic"].includes(presence.agent.role))
  );
  const build = presences.filter((presence) => !lounge.includes(presence) && !ops.includes(presence) && !command.includes(presence));
  return {
    command,
    lounge,
    build,
    ops,
  };
}

export function buildOfficeGuiSnapshot(raw: Record<string, unknown>, input: { theme: string }) {
  const nowSeconds = Date.now() / 1000;
  const roster = asDict(raw.roster);
  const workboard = asDict(raw.workboard);
  const tmux = asDict(raw.tmux);
  const taskSummary = asDict(raw.task_summary);
  const taskRunning = asDict(raw.task_running);
  const taskPending = asDict(raw.task_pending);
  const agentSessions = asDict(raw.agent_sessions);
  const adapter = asDict(raw.adapter);
  const busTail = asDict(raw.bus_tail);
  const trichatSummary = asDict(raw.trichat_summary);
  const kernel = asDict(raw.kernel);
  const learning = asDict(raw.learning);
  const autopilot = asDict(raw.autopilot);
  const maintain = asDict(raw.autonomy_maintain);
  const runtimeWorkers = asDict(raw.runtime_workers);

  const catalog = buildCatalog(roster);
  const latestTurn = maybeTurn(workboard);
  const selectedAgentId = normalizeAgentId(latestTurn.selected_agent);
  const expectedAgents = new Set(dedupe(asList(latestTurn.expected_agents)));
  const taskIndex = buildTaskIndex(taskRunning, taskPending);
  const { ownerSignals, supervisorSignals } = buildTaskSignals(catalog, tmux, taskRunning, taskPending);
  const sessionSignals = buildSessionSignals(catalog, agentSessions, taskIndex, nowSeconds);
  const blockedSignals = buildAdapterBlocks(adapter, nowSeconds);
  const chatSignals = buildChatSignals(busTail, nowSeconds);
  const providerSignals = buildProviderSignals(raw);
  const turnRecent =
    Boolean(String(latestTurn.turn_id ?? "").trim() || String(latestTurn.updated_at ?? "").trim()) &&
    ageSeconds(latestTurn.updated_at, nowSeconds) <= 300;

  const presences: GuiPresence[] = [];
  for (const agent of [...catalog.values()].sort((left, right) => left.agent_id.localeCompare(right.agent_id))) {
    let state = "idle";
    let location = "desk";
    let activity = "standing by";
    let evidenceSource = "none";
    let evidenceDetail = "no current evidence";

    const blocked = blockedSignals.get(agent.agent_id);
    const owner = ownerSignals.get(agent.agent_id);
    const supervisor = supervisorSignals.get(agent.agent_id);
    const session = sessionSignals.get(agent.agent_id);
    const chat = chatSignals.get(agent.agent_id);
    const provider = providerSignals.get(agent.agent_id);

    if (owner?.state === "running") {
      state = "working";
      activity = owner.activity;
      evidenceSource = "task";
      evidenceDetail = owner.detail;
    } else if (supervisor?.state === "running") {
      state = "supervising";
      activity = supervisor.activity;
      evidenceSource = "task";
      evidenceDetail = supervisor.detail;
    } else if (session?.state === "running") {
      state = ["lead", "director"].includes(agent.tier) || agent.role === "orchestrator" ? "supervising" : "working";
      activity = session.activity;
      evidenceSource = "session";
      evidenceDetail = session.detail;
    } else if (turnRecent && agent.agent_id === selectedAgentId) {
      state = ["lead", "director"].includes(agent.tier) ? "supervising" : "working";
      activity = compactSingleLine(latestTurn.selected_strategy || latestTurn.user_prompt || "active turn", 56);
      evidenceSource = "turn";
      evidenceDetail = String(latestTurn.turn_id ?? "active-turn");
    } else if (turnRecent && expectedAgents.has(agent.agent_id)) {
      state = "idle";
      activity = "waiting on the next turn";
      evidenceSource = "turn";
      evidenceDetail = String(latestTurn.turn_id ?? "active-turn");
    } else if (session?.state === "ready") {
      state = "ready";
      activity = session.activity;
      evidenceSource = "session";
      evidenceDetail = session.detail;
    } else if (provider && ["ready", "sleeping"].includes(provider.state)) {
      state = provider.state;
      location = provider.location;
      activity = provider.activity;
      evidenceSource = "provider_bridge";
      evidenceDetail = provider.detail;
    } else if (blocked) {
      state = blocked.state;
      activity = blocked.detail;
      evidenceSource = "adapter";
      evidenceDetail = blocked.detail;
    } else if (provider) {
      state = provider.state;
      location = provider.location;
      activity = provider.activity;
      evidenceSource = "provider_bridge";
      evidenceDetail = provider.detail;
    } else if (chat) {
      state = chat.state;
      location = chat.state === "talking" ? "cooler" : "lounge";
      activity = chat.activity;
      evidenceSource = "bus";
      evidenceDetail = chat.detail;
    } else if (owner && ["queued", "dispatched"].includes(owner.state)) {
      state = "idle";
      activity = compactSingleLine(`queued: ${owner.activity}`, 56);
      evidenceSource = "task";
      evidenceDetail = owner.detail;
    } else if (agent.active) {
      state = "ready";
      location = "desk";
      activity = "armed for the next bounded task";
      evidenceSource = "roster";
      evidenceDetail = "active-agent-pool";
    } else {
      state = "offline";
      location = "ops";
      activity = "not in the current working set";
      evidenceSource = "roster";
      evidenceDetail = "inactive";
    }

    const actions = dedupe([
      location === "desk" ? "desk" : location === "cooler" ? "chat" : location === "lounge" ? "coffee" : location === "sofa" ? "nap" : "ops",
      state === "working" ? "code" : state === "supervising" ? "brief" : state === "talking" ? "chat" : state === "break" ? "coffee" : state === "sleeping" ? "sleep" : state === "blocked" ? "blocked" : state === "offline" ? "offline" : "ready",
    ]);

    presences.push({
      agent,
      token: buildAgentToken(agent.display_name, agent.agent_id),
      state,
      activity,
      location,
      actions,
      evidence_source: evidenceSource,
      evidence_detail: evidenceDetail,
    });
  }

  const rooms = partitionRooms(presences);
  const counts = presences.reduce<Record<string, number>>((acc, presence) => {
    acc[presence.state] = (acc[presence.state] ?? 0) + 1;
    return acc;
  }, {});

  const kernelOverview = asDict(kernel.overview);
  const kernelWorkerFabric = asDict(kernel.worker_fabric);
  const kernelModelRouter = asDict(kernel.model_router);
  const kernelRuntimeWorkers = asDict(kernel.runtime_workers);
  const kernelMaintain = asDict(kernel.autonomy_maintain);
  const kernelReaction = asDict(kernel.reaction_engine);
  const kernelObservability = asDict(kernel.observability);
  const kernelToolCatalog = asDict(kernel.tool_catalog);
  const kernelPermissionProfiles = asDict(kernel.permission_profiles);
  const kernelBudgetLedger = asDict(kernel.budget_ledger);
  const kernelWarmCache = asDict(kernel.warm_cache);
  const kernelFeatureFlags = asDict(kernel.feature_flags);
  const kernelDesktopControl = asDict(kernel.desktop_control);
  const kernelPatientZero = asDict(kernel.patient_zero);
  const kernelPrivilegedAccess = asDict(kernel.privileged_access);
  const defaultHostId = String(kernelWorkerFabric.default_host_id ?? "local").trim() || "local";
  const localHost = asDict(
    asList(kernelWorkerFabric.hosts).find((entry) => String(asDict(entry).host_id ?? "").trim() === defaultHostId)
  );
  const defaultBackendId = String(kernelModelRouter.default_backend_id ?? "").trim();
  const routerBackend = asDict(
    asList(kernelModelRouter.backends).find((entry) => String(asDict(entry).backend_id ?? "").trim() === defaultBackendId) ??
      asList(kernelModelRouter.backends)[0]
  );
  const runtimeSummary = asDict(runtimeWorkers.summary);
  const latestDecision = asDict(workboard.latest_decision);
  const taskCounts = asDict(taskSummary.counts);
  const tmuxDashboard = asDict(tmux.dashboard);
  const maintainState = asDict(maintain.state);
  const maintainRuntime = asDict(maintain.runtime);
  const maintainDue = asDict(maintain.due);
  const maintainSelfDrive = asDict(maintain.self_drive);
  const providerBridge = asDict(raw.provider_bridge);
  const providerBridgeDiagnostics = asDict(providerBridge.diagnostics);
  const providerEntries = asList(providerBridgeDiagnostics.diagnostics);
  const rawDesktopControl = asDict(raw.desktop_control);
  const desktopControlSummary = asDict(kernelDesktopControl.summary || rawDesktopControl.summary);
  const rawPatientZero = asDict(raw.patient_zero);
  const rawPrivilegedAccess = asDict(raw.privileged_access);
  const patientZeroSummary = asDict(kernelPatientZero.summary || rawPatientZero.summary);
  const patientZeroReport = asDict(rawPatientZero.report);
  const patientZeroAutonomyControl = asDict(rawPatientZero.autonomy_control);
  const patientZeroToolkit = asDict(patientZeroAutonomyControl.toolkit);
  const privilegedAccessSummary = asDict(kernelPrivilegedAccess.summary || rawPrivilegedAccess.summary || rawPrivilegedAccess);
  const threadId = String(raw.thread_id ?? "ring-leader-main").trim() || "ring-leader-main";
  const latestAutopilotSession = asList(agentSessions.sessions).find((entry) => {
    const session = asDict(entry);
    const metadata = asDict(session.metadata);
    return String(session.client_kind ?? "").trim() === "trichat-autopilot" && String(metadata.thread_id ?? "").trim() === threadId;
  });
  const autopilotSessionMetadata = asDict(asDict(latestAutopilotSession).metadata);
  const autopilotState = asDict(autopilot.state);
  const lastTick = asDict(autopilotState.last_tick);
  const currentTaskId =
    String(autopilotSessionMetadata.current_task_id ?? "").trim() ||
    String(autopilotSessionMetadata.last_source_task_id ?? "").trim() ||
    String(autopilotSessionMetadata.last_claimed_task_id ?? "").trim() ||
    String(autopilotSessionMetadata.last_execution_task_id ?? "").trim();
  const currentTask = asDict(taskIndex.get(currentTaskId));
  const autopilotConfig = asDict(autopilotState.config);
  const autopilotPool = asDict(autopilotState.effective_agent_pool);
  const autopilotExecution = asDict(lastTick.execution);
  const executionTaskIds = dedupe([
    ...asList(autopilotExecution.task_ids),
    ...asList(autopilotSessionMetadata.last_execution_task_ids),
  ]);
  const hasLiveExecutionContext =
    Boolean(currentTaskId) ||
    Boolean(autopilotState.running) ||
    Boolean(autopilotState.local_running) ||
    Boolean(autopilotState.in_tick) ||
    executionTaskIds.length > 0 ||
    parseAnyInt(tmuxDashboard.queue_depth) > 0 ||
    parseAnyInt(runtimeSummary.active_count) > 0;
  const autopilotCouncilAgentIds = dedupe([
    autopilotPool.lead_agent_id,
    ...asList(autopilotPool.council_agent_ids),
  ]);
  const autopilotSpecialistAgentIds = dedupe(asList(autopilotPool.specialist_agent_ids));
  const patientZeroAutonomousControlEnabled =
    Boolean(patientZeroSummary.autonomy_enabled) &&
    Boolean(maintainSelfDrive.enabled) &&
    Boolean(autopilotConfig.execute_enabled);
  const patientZeroFullControlAuthority =
    Boolean(patientZeroSummary.enabled) &&
    Boolean(desktopControlSummary.observe_ready) &&
    Boolean(desktopControlSummary.act_ready) &&
    Boolean(desktopControlSummary.listen_ready) &&
    Boolean(patientZeroSummary.browser_ready) &&
    Boolean(privilegedAccessSummary.root_execution_ready) &&
    patientZeroAutonomousControlEnabled;
  const currentObjective = hasLiveExecutionContext
    ? compactSingleLine(
        currentTask.objective ||
          asDict(currentTask.payload).task_objective ||
          String(autopilotConfig.objective ?? "") ||
          String(autopilotSessionMetadata.last_source_task_objective ?? ""),
        220
      )
    : "";
  const currentDecisionSummary = hasLiveExecutionContext
    ? String(latestDecision.decision_summary ?? latestTurn.decision_summary ?? "")
    : "";
  const currentSelectedStrategy = hasLiveExecutionContext
    ? String(latestDecision.selected_strategy ?? latestTurn.selected_strategy ?? "")
    : "";
  const currentSelectedAgent = hasLiveExecutionContext
    ? String(latestDecision.selected_agent ?? latestTurn.selected_agent ?? "")
    : "";
  const currentSpawnPath = hasLiveExecutionContext
    ? compactSingleLine(
        dedupe([
          autopilotSessionMetadata.lead_agent_id || latestTurn.lead_agent_id || "ring-leader",
          latestDecision.selected_agent || latestTurn.selected_agent,
          asDict(latestDecision.selected_delegation_brief).delegate_agent_id ||
            asDict(latestTurn.selected_delegation_brief).delegate_agent_id,
        ]).join(" -> "),
        120
      )
    : "";
  const currentDelegationBrief =
    hasLiveExecutionContext && asDict(latestDecision.selected_delegation_brief).delegate_agent_id
      ? asDict(latestDecision.selected_delegation_brief)
      : hasLiveExecutionContext
        ? asDict(latestTurn.selected_delegation_brief)
        : {};

  return {
    thread_id: threadId,
    fetched_at: parseAnyFloat(raw.generated_at ? new Date(String(raw.generated_at)).getTime() / 1000 : Date.now() / 1000, Date.now() / 1000),
    fetched_at_iso: new Date().toISOString(),
    theme: input.theme,
    errors: asList(raw.errors).map((entry) => String(entry)),
    counts,
    agents: presences.map((presence) => ({
      agent: presence.agent,
      token: presence.token,
      state: presence.state,
      activity: presence.activity,
      location: presence.location,
      actions: presence.actions,
      evidence_source: presence.evidence_source,
      evidence_detail: presence.evidence_detail,
    })),
    rooms: Object.fromEntries(
      Object.entries(rooms).map(([roomName, roomPresences]) => [roomName, roomPresences.map((presence) => presence.agent.agent_id)])
    ),
    summary: {
      tasks: {
        pending: parseAnyInt(taskCounts.pending),
        running: parseAnyInt(taskCounts.running),
        failed: parseAnyInt(taskCounts.failed),
        completed: parseAnyInt(taskCounts.completed),
      },
      tmux: {
        enabled: Boolean(asDict(tmux.state).enabled),
        worker_count: parseAnyInt(asDict(tmux.state).worker_count),
        queue_depth: parseAnyInt(tmuxDashboard.queue_depth),
        queue_age_seconds: parseAnyFloat(tmuxDashboard.queue_age_seconds),
        failure_count: parseAnyInt(tmuxDashboard.failure_count),
      },
      kernel: {
        state: String(kernel.state ?? "n/a"),
        active_sessions: parseAnyInt(kernelOverview.active_session_count),
        healthy: parseAnyInt(asDict(kernel.adaptive_session_counts).healthy),
        degraded: parseAnyInt(asDict(kernel.adaptive_session_counts).degraded),
        attention: asList(kernel.attention).slice(0, 6),
      },
      local_host: {
        host_id: defaultHostId,
        cpu_utilization: parseAnyFloat(asDict(localHost.telemetry).cpu_utilization ?? localHost.cpu_utilization),
        ram_available_gb: parseAnyFloat(asDict(localHost.telemetry).ram_available_gb ?? localHost.ram_available_gb),
        ram_total_gb: parseAnyFloat(asDict(localHost.telemetry).ram_total_gb ?? localHost.ram_total_gb),
        swap_used_gb: parseAnyFloat(asDict(localHost.telemetry).swap_used_gb ?? localHost.swap_used_gb),
        thermal_pressure: String(asDict(localHost.telemetry).thermal_pressure ?? localHost.thermal_pressure ?? "n/a"),
        worker_count: parseAnyInt(localHost.worker_count),
        recommended_worker_count: parseAnyInt(localHost.recommended_worker_count),
        max_local_model_concurrency: parseAnyInt(localHost.max_local_model_concurrency),
      },
      router: {
        backend_count: parseAnyInt(kernelModelRouter.backend_count),
        enabled_backend_count: parseAnyInt(kernelModelRouter.enabled_backend_count),
        default_backend_id: String(kernelModelRouter.default_backend_id ?? "n/a"),
        strategy: String(kernelModelRouter.strategy ?? "n/a"),
        routing_outlook: asList(kernelModelRouter.routing_outlook).slice(0, 6),
        live_backend: {
          backend_id: String(routerBackend.backend_id ?? "n/a"),
          probe_healthy: routerBackend.probe_healthy,
          probe_model_known: routerBackend.probe_model_known,
          probe_model_loaded: routerBackend.probe_model_loaded,
          latency_ms_p50: parseAnyFloat(routerBackend.latency_ms_p50),
          throughput_tps: parseAnyFloat(routerBackend.throughput_tps),
          probe_resident_model_count: parseAnyInt(routerBackend.probe_resident_model_count),
          probe_resident_vram_gb: parseAnyFloat(routerBackend.probe_resident_vram_gb),
        },
      },
      runtime_workers: {
        session_count: parseAnyInt(kernelRuntimeWorkers.session_count || runtimeSummary.session_count),
        active_count: parseAnyInt(kernelRuntimeWorkers.active_count || runtimeSummary.active_count),
        failed_count: parseAnyInt(asDict(kernelRuntimeWorkers.counts).failed || asDict(runtimeSummary.counts).failed),
        latest_session: asDict(runtimeSummary.latest_session),
      },
      learning: {
        active_entry_count: parseAnyInt(learning.active_entry_count),
        agents_with_active_entries: parseAnyInt(learning.agents_with_active_entries),
        prefer_count: parseAnyInt(learning.prefer_count),
        avoid_count: parseAnyInt(learning.avoid_count),
        top_agents: asList(learning.top_agents).slice(0, 8),
      },
      reaction_engine: {
        enabled: Boolean(kernelReaction.enabled),
        runtime_running: Boolean(asDict(kernelReaction.runtime).running),
        stale: Boolean(kernelReaction.stale),
        channels: asList(kernelReaction.channels).slice(0, 4),
        last_sent_count: parseAnyInt(kernelReaction.last_sent_count),
      },
      observability: {
        document_count: parseAnyInt(kernelObservability.document_count),
        recent_error_count: parseAnyInt(kernelObservability.recent_error_count),
        recent_critical_count: parseAnyInt(kernelObservability.recent_critical_count),
        source_kind_counts: asList(kernelObservability.source_kind_counts).slice(0, 4),
        service_counts: asList(kernelObservability.service_counts).slice(0, 4),
      },
      provider_bridge: {
        generated_at: String(providerBridgeDiagnostics.generated_at ?? ""),
        cached: Boolean(providerBridgeDiagnostics.cached),
        connected_count: providerEntries.filter((entry) => String(asDict(entry).status ?? "").trim().toLowerCase() === "connected").length,
        configured_count: providerEntries.filter((entry) => String(asDict(entry).status ?? "").trim().toLowerCase() === "configured").length,
        disconnected_count: providerEntries.filter((entry) => String(asDict(entry).status ?? "").trim().toLowerCase() === "disconnected").length,
        unavailable_count: providerEntries.filter((entry) => String(asDict(entry).status ?? "").trim().toLowerCase() === "unavailable").length,
      },
      desktop_control: {
        enabled: Boolean(desktopControlSummary.enabled),
        stale: Boolean(desktopControlSummary.stale),
        observe_ready: Boolean(desktopControlSummary.observe_ready),
        act_ready: Boolean(desktopControlSummary.act_ready),
        listen_ready: Boolean(desktopControlSummary.listen_ready),
        last_frontmost_app: String(desktopControlSummary.last_frontmost_app ?? ""),
      },
      patient_zero: {
        enabled: Boolean(patientZeroSummary.enabled),
        posture: String(patientZeroSummary.posture ?? "standby"),
        severity: String(patientZeroSummary.severity ?? "controlled"),
        permission_profile: String(patientZeroSummary.permission_profile ?? "high_risk"),
        browser_app: String(patientZeroSummary.browser_app ?? "Safari"),
        browser_ready: Boolean(patientZeroSummary.browser_ready),
        root_shell_enabled: Boolean(patientZeroSummary.root_shell_enabled),
        root_shell_reason: String(patientZeroSummary.root_shell_reason ?? ""),
        autonomy_enabled: Boolean(patientZeroSummary.autonomy_enabled),
        autonomous_control_enabled: patientZeroAutonomousControlEnabled,
        full_control_authority: patientZeroFullControlAuthority,
        toolkit: {
          bridge_agents: asList(patientZeroToolkit.bridge_agents),
          local_agents: asList(patientZeroToolkit.local_agents),
          terminal_commands: asList(patientZeroToolkit.terminal_commands),
          bridge_toolkit_ready: Boolean(patientZeroToolkit.bridge_toolkit_ready),
          local_agent_spawn_ready: Boolean(patientZeroToolkit.local_agent_spawn_ready),
          terminal_toolkit_ready: Boolean(patientZeroToolkit.terminal_toolkit_ready),
          imprint_ready: Boolean(patientZeroToolkit.imprint_ready),
          github_cli_ready: Boolean(patientZeroToolkit.github_cli_ready),
        },
        armed_at: String(patientZeroSummary.armed_at ?? ""),
        armed_by: String(patientZeroSummary.armed_by ?? ""),
        last_operator_note: String(patientZeroSummary.last_operator_note ?? ""),
        report: {
          stance: String(patientZeroReport.stance ?? ""),
          priority_pull: String(patientZeroReport.priority_pull ?? ""),
          concern: String(patientZeroReport.concern ?? ""),
          desire: String(patientZeroReport.desire ?? ""),
          activity_summary: asList(patientZeroReport.activity_summary).map((entry) => String(entry)),
          scope_notice: String(patientZeroReport.scope_notice ?? ""),
        },
      },
      privileged_access: {
        root_execution_ready: Boolean(privilegedAccessSummary.root_execution_ready),
        credential_verified: Boolean(privilegedAccessSummary.credential_verified),
        account: String(privilegedAccessSummary.account ?? "mcagent"),
        target_user: String(privilegedAccessSummary.target_user ?? "root"),
        patient_zero_armed: Boolean(privilegedAccessSummary.patient_zero_armed),
        secret_present: Boolean(privilegedAccessSummary.secret_present),
        helper_ready: Boolean(privilegedAccessSummary.helper_ready),
        secret_path: String(privilegedAccessSummary.secret_path ?? ""),
        blockers: asList(privilegedAccessSummary.blockers).map((entry) => String(entry)),
        last_verified_at: String(privilegedAccessSummary.last_verified_at ?? ""),
        last_verification_ok:
          typeof privilegedAccessSummary.last_verification_ok === "boolean"
            ? privilegedAccessSummary.last_verification_ok
            : null,
        last_verification_error: String(privilegedAccessSummary.last_verification_error ?? ""),
        last_executed_at: String(privilegedAccessSummary.last_executed_at ?? ""),
        last_actor: String(privilegedAccessSummary.last_actor ?? ""),
        last_command: String(privilegedAccessSummary.last_command ?? ""),
        last_exit_code:
          privilegedAccessSummary.last_exit_code == null ? null : parseAnyInt(privilegedAccessSummary.last_exit_code),
        last_error: String(privilegedAccessSummary.last_error ?? ""),
      },
      maintain: {
        enabled: Boolean(maintainState.enabled),
        running: Boolean(maintainRuntime.running),
        stale: Boolean(maintainDue.stale),
        eval_due: Boolean(maintainDue.eval),
        last_eval_score: kernelMaintain.last_eval_score,
        self_drive_enabled: Boolean(maintainSelfDrive.enabled),
        self_drive_last_run_at: String(maintainSelfDrive.last_run_at ?? ""),
        self_drive_last_goal_id: String(maintainSelfDrive.last_goal_id ?? ""),
        subsystems: asDict(maintain.subsystems),
      },
      autopilot: {
        running: Boolean(autopilotState.running),
        local_running: Boolean(autopilotState.local_running),
        in_tick: Boolean(autopilotState.in_tick),
        execute_enabled: Boolean(autopilotConfig.execute_enabled),
        execute_backend: String(autopilotConfig.execute_backend ?? "n/a"),
        lead_agent_id: String(autopilotConfig.lead_agent_id ?? autopilotPool.lead_agent_id ?? "ring-leader"),
        objective: compactSingleLine(String(autopilotConfig.objective ?? ""), 180),
        last_execution_mode: String(autopilotExecution.mode ?? autopilotSessionMetadata.last_execution_mode ?? "none"),
        last_tick_ok:
          typeof autopilotState.last_tick === "object" && autopilotState.last_tick !== null
            ? Boolean(lastTick.ok)
            : null,
        last_tick_reason: compactSingleLine(String(lastTick.reason ?? autopilotSessionMetadata.last_tick_reason ?? ""), 160),
        success_agents: parseAnyInt(lastTick.success_agents),
        council_agent_ids: autopilotCouncilAgentIds,
        council_agent_count: autopilotCouncilAgentIds.length,
        specialist_agent_ids: autopilotSpecialistAgentIds,
        specialist_agent_count: autopilotSpecialistAgentIds.length,
      },
      swarm: {
        active_profile_count: parseAnyInt(asDict(kernel.swarm).active_profile_count),
        checkpoint_artifact_count: parseAnyInt(asDict(kernel.swarm).checkpoint_artifact_count),
        active_profiles: asList(asDict(kernel.swarm).active_profiles).slice(0, 4),
      },
      workflow_exports: {
        bundle_count: parseAnyInt(asDict(kernel.workflow_exports).bundle_count),
        metrics_count: parseAnyInt(asDict(kernel.workflow_exports).metrics_count),
        argo_contract_count: parseAnyInt(asDict(kernel.workflow_exports).argo_contract_count),
      },
      control_plane: {
        tool_catalog_count: parseAnyInt(kernelToolCatalog.total_count),
        permission_default_profile: String(kernelPermissionProfiles.default_profile ?? "n/a"),
        projected_cost_usd: parseAnyFloat(kernelBudgetLedger.projected_cost_usd),
        actual_cost_usd: parseAnyFloat(kernelBudgetLedger.actual_cost_usd),
        warm_cache_enabled: Boolean(asDict(kernelWarmCache.state).enabled || kernelWarmCache.enabled),
        warm_cache_stale: Boolean(kernelWarmCache.stale),
        disabled_feature_flags: parseAnyInt(kernelFeatureFlags.disabled_count),
        patient_zero_enabled: Boolean(patientZeroSummary.enabled),
        patient_zero_autonomous_control_enabled: patientZeroAutonomousControlEnabled,
        patient_zero_full_control_authority: patientZeroFullControlAuthority,
        privileged_root_ready: Boolean(privilegedAccessSummary.root_execution_ready),
      },
    },
    current: {
      decision_summary: currentDecisionSummary,
      selected_strategy: currentSelectedStrategy,
      selected_agent: currentSelectedAgent,
      current_task_id: currentTaskId,
      current_objective: currentObjective,
      spawn_path: currentSpawnPath,
      delegation_brief: currentDelegationBrief,
      execution_task_ids: executionTaskIds,
      execution_mode: String(autopilotExecution.mode ?? autopilotSessionMetadata.last_execution_mode ?? "none"),
      execute_enabled: Boolean(autopilotConfig.execute_enabled),
      council_agent_ids: autopilotCouncilAgentIds,
      specialist_agent_ids: autopilotSpecialistAgentIds,
      confidence_method: asDict(lastTick.confidence_method || autopilotSessionMetadata.last_confidence_method),
      learning_signal: asDict(lastTick.learning_signal || autopilotSessionMetadata.last_learning_signal),
      last_tick: lastTick,
    },
    events: asList(busTail.events).slice(0, 20),
    runtime_sessions: asList(runtimeWorkers.sessions).slice(0, 20),
    provider_bridge: {
      generated_at: String(providerBridgeDiagnostics.generated_at ?? ""),
      cached: Boolean(providerBridgeDiagnostics.cached),
      diagnostics: providerEntries.map((entry) => asDict(entry)),
    },
  };
}
