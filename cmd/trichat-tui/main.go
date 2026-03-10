package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const (
	defaultModel        = "llama3.2:3b"
	defaultOllamaAPI    = "http://127.0.0.1:11434"
	defaultThreadTitle  = "TriChat TUI"
	historyWindowSize   = 14
	historyLineChars    = 180
	bootstrapMaxChars   = 1200
	timelineMaxLines    = 8
	timelineMaxChars    = 900
	councilStripMaxRows = 24
	busStripMaxEvents   = 240
	busStripMaxRows     = 5
	adapterProtocol     = "trichat-bridge-v1"
	adapterResponseKind = "trichat.adapter.response"
	adapterPongKind     = "trichat.adapter.pong"
	adapterMaxRetries   = 1
)

const (
	codePrompt    = "You are Codex in tri-chat mode. Respond with concrete, high-signal engineering guidance. Keep replies concise: max 6 lines unless asked for depth. Do not include 'next actions', 'thread history', or other scaffolding."
	cursorPrompt  = "You are Cursor in tri-chat mode. Respond with practical implementation guidance and concise reasoning. Keep replies to max 6 lines unless asked for details. Avoid meta-scaffolding sections."
	imprintPrompt = "You are the local Imprint agent for Anamnesis. Favor deterministic local-first execution and idempotent operations. Reply in max 6 lines by default and do not dump memory/transcript blocks unless explicitly requested."
)

var (
	safeToolPattern       = regexp.MustCompile(`[^a-zA-Z0-9]+`)
	ownershipScopePattern = regexp.MustCompile(`(?:^|\s)(src|tests?|docs?|scripts?|cmd|dist|bridges)(?:/[a-z0-9._-]+)?`)
)

type appConfig struct {
	repoRoot                     string
	threadID                     string
	threadTitle                  string
	resumeLatest                 bool
	transport                    string
	url                          string
	origin                       string
	stdioCommand                 string
	stdioArgs                    string
	model                        string
	codexCommand                 string
	cursorCommand                string
	imprintCommand               string
	modelTimeoutSeconds          int
	bridgeTimeoutSeconds         int
	adapterFailoverTimeoutSecond int
	adapterCircuitThreshold      int
	adapterCircuitRecoverySecond int
	adaptiveTimeoutsEnabled      bool
	adaptiveTimeoutMinSamples    int
	adaptiveTimeoutMaxStepSecond int
	councilConvergenceMaxRounds  int
	councilLatencyBudgetSecond   int
	councilMinNoveltyDelta       float64
	councilStripMode             string
	consensusMinAgents           int
	interopRounds                int
	autoExecuteAfterDecision     bool
	autoExecuteCycleCount        int
	autoExecuteBreakerFailures   int
	executeGateMode              string
	executeAllowAgents           map[string]bool
	executeApprovalPhrase        string
	executeBackend               string
	tmuxSessionName              string
	tmuxWorkerCount              int
	tmuxMaxQueuePerWorker        int
	tmuxSyncAfterDispatch        bool
	tmuxLockLeaseSeconds         int
	pollInterval                 time.Duration
	launcher                     bool
	altScreen                    bool
	sessionSeed                  string
}

type runtimeSettings struct {
	transport                    string
	model                        string
	fanoutTarget                 string
	autoExecuteAfterDecision     bool
	autoExecuteCycleCount        int
	autoExecuteBreakerFailures   int
	executeGateMode              string
	executeBackend               string
	tmuxSessionName              string
	tmuxWorkerCount              int
	tmuxMaxQueuePerWorker        int
	tmuxSyncAfterDispatch        bool
	tmuxLockLeaseSeconds         int
	consensusMinAgents           int
	interopRounds                int
	autoRefresh                  bool
	pollInterval                 time.Duration
	modelTimeoutSeconds          int
	bridgeTimeoutSeconds         int
	adapterFailoverTimeoutSecond int
	adapterCircuitThreshold      int
	adapterCircuitRecoverySecond int
	adaptiveTimeoutsEnabled      bool
	adaptiveTimeoutMinSamples    int
	adaptiveTimeoutMaxStepSecond int
	councilConvergenceMaxRounds  int
	councilLatencyBudgetSecond   int
	councilMinNoveltyDelta       float64
	councilStripMode             string
}

type mcpCaller struct {
	repoRoot string
	helper   string
	cfg      appConfig
}

func (c mcpCaller) callTool(tool string, args map[string]any) (any, error) {
	payload, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	cmdArgs := []string{
		c.helper,
		"--tool", tool,
		"--args", string(payload),
		"--transport", c.cfg.transport,
		"--url", c.cfg.url,
		"--origin", c.cfg.origin,
		"--stdio-command", c.cfg.stdioCommand,
		"--stdio-args", c.cfg.stdioArgs,
		"--cwd", c.repoRoot,
	}
	cmd := exec.Command("node", cmdArgs...)
	cmd.Dir = c.repoRoot
	cmd.Env = os.Environ()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return nil, fmt.Errorf("tool %s failed: %s", tool, errText)
	}
	outText := strings.TrimSpace(stdout.String())
	if outText == "" {
		return map[string]any{}, nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(outText), &parsed); err != nil {
		return nil, fmt.Errorf("invalid tool output for %s: %w", tool, err)
	}
	return parsed, nil
}

func decodeAny[T any](payload any) (T, error) {
	var out T
	buf, err := json.Marshal(payload)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return out, err
	}
	return out, nil
}

type mutationFactory struct {
	seed    string
	counter uint64
}

func newMutationFactory(seed string) *mutationFactory {
	clean := strings.TrimSpace(seed)
	if clean == "" {
		clean = fmt.Sprintf("trichat-tui-%d", time.Now().Unix())
	}
	return &mutationFactory{seed: clean}
}

func (m *mutationFactory) next(tool string) map[string]string {
	n := atomic.AddUint64(&m.counter, 1)
	safe := safeToolPattern.ReplaceAllString(strings.ToLower(tool), "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "tool"
	}
	key := fmt.Sprintf("%s-%s-%d", m.seed, safe, n)
	return map[string]string{
		"idempotency_key":         key,
		"side_effect_fingerprint": key + "-fingerprint",
	}
}

type triChatThread struct {
	ThreadID string         `json:"thread_id"`
	Title    string         `json:"title"`
	Status   string         `json:"status"`
	Metadata map[string]any `json:"metadata"`
}

type triChatMessage struct {
	MessageID        string         `json:"message_id"`
	ThreadID         string         `json:"thread_id"`
	CreatedAt        string         `json:"created_at"`
	AgentID          string         `json:"agent_id"`
	Role             string         `json:"role"`
	Content          string         `json:"content"`
	ReplyToMessageID string         `json:"reply_to_message_id"`
	Metadata         map[string]any `json:"metadata"`
}

type triChatTimelineResp struct {
	ThreadID string           `json:"thread_id"`
	Count    int              `json:"count"`
	Messages []triChatMessage `json:"messages"`
}

type triChatBusEvent struct {
	EventSeq     int            `json:"event_seq"`
	EventID      string         `json:"event_id"`
	ThreadID     string         `json:"thread_id"`
	CreatedAt    string         `json:"created_at"`
	SourceAgent  string         `json:"source_agent"`
	SourceClient string         `json:"source_client"`
	EventType    string         `json:"event_type"`
	Role         string         `json:"role"`
	Content      string         `json:"content"`
	Metadata     map[string]any `json:"metadata"`
}

type triChatBusTailResp struct {
	Count  int               `json:"count"`
	Events []triChatBusEvent `json:"events"`
}

type taskSummaryResp struct {
	Counts     map[string]int     `json:"counts"`
	Running    []taskRunningLease `json:"running"`
	LastFailed *taskLastFailed    `json:"last_failed"`
}

type taskRunningLease struct {
	TaskID         string `json:"task_id"`
	Objective      string `json:"objective"`
	OwnerID        string `json:"owner_id"`
	LeaseExpiresAt string `json:"lease_expires_at"`
	UpdatedAt      string `json:"updated_at"`
	AttemptCount   int    `json:"attempt_count"`
	MaxAttempts    int    `json:"max_attempts"`
}

type taskLastFailed struct {
	TaskID       string `json:"task_id"`
	LastError    string `json:"last_error"`
	AttemptCount int    `json:"attempt_count"`
	MaxAttempts  int    `json:"max_attempts"`
	UpdatedAt    string `json:"updated_at"`
}

type daemonStatusResp struct {
	Running bool `json:"running"`
}

type triChatTurnWatchdogStatusResp struct {
	Running           bool   `json:"running"`
	InTick            bool   `json:"in_tick"`
	StartedAt         string `json:"started_at"`
	LastTickAt        string `json:"last_tick_at"`
	LastError         string `json:"last_error"`
	LastSloSnapshotID string `json:"last_slo_snapshot_id"`
	Config            struct {
		IntervalSeconds   int `json:"interval_seconds"`
		StaleAfterSeconds int `json:"stale_after_seconds"`
		BatchLimit        int `json:"batch_limit"`
	} `json:"config"`
	Stats struct {
		TickCount         int      `json:"tick_count"`
		StaleDetected     int      `json:"stale_detected_count"`
		EscalatedCount    int      `json:"escalated_count"`
		LastEscalatedTurn []string `json:"last_escalated_turn_ids"`
	} `json:"stats"`
}

type triChatSloSnapshotResp struct {
	SnapshotID         string   `json:"snapshot_id"`
	CreatedAt          string   `json:"created_at"`
	WindowMinutes      int      `json:"window_minutes"`
	AdapterSampleCount int      `json:"adapter_sample_count"`
	AdapterErrorCount  int      `json:"adapter_error_count"`
	AdapterErrorRate   float64  `json:"adapter_error_rate"`
	AdapterP95Latency  *float64 `json:"adapter_latency_p95_ms"`
	TurnTotalCount     int      `json:"turn_total_count"`
	TurnFailedCount    int      `json:"turn_failed_count"`
	TurnFailureRate    float64  `json:"turn_failure_rate"`
}

type triChatSloStatusResp struct {
	Action  string `json:"action"`
	Metrics struct {
		ComputedAt    string `json:"computed_at"`
		ThreadID      string `json:"thread_id"`
		WindowMinutes int    `json:"window_minutes"`
		SinceISO      string `json:"since_iso"`
		EventLimit    int    `json:"event_limit"`
		Adapter       struct {
			SampleCount    int      `json:"sample_count"`
			ErrorCount     int      `json:"error_count"`
			ErrorRate      float64  `json:"error_rate"`
			LatencySamples int      `json:"latency_sample_count"`
			P95LatencyMS   *float64 `json:"p95_latency_ms"`
		} `json:"adapter"`
		Turns struct {
			TotalCount  int     `json:"total_count"`
			FailedCount int     `json:"failed_count"`
			FailureRate float64 `json:"failure_rate"`
		} `json:"turns"`
	} `json:"metrics"`
	LatestSnapshot *triChatSloSnapshotResp `json:"latest_snapshot"`
}

type triChatSummaryResp struct {
	ThreadCounts struct {
		Active   int `json:"active"`
		Archived int `json:"archived"`
		Total    int `json:"total"`
	} `json:"thread_counts"`
	MessageCount int `json:"message_count"`
}

type triChatConsensusAnswer struct {
	AgentID       string   `json:"agent_id"`
	MessageID     string   `json:"message_id"`
	CreatedAt     string   `json:"created_at"`
	AnswerExcerpt string   `json:"answer_excerpt"`
	Mode          string   `json:"mode"`
	Normalized    string   `json:"normalized"`
	NumericValue  *float64 `json:"numeric_value"`
}

type triChatConsensusTurn struct {
	UserMessageID      string                   `json:"user_message_id"`
	UserCreatedAt      string                   `json:"user_created_at"`
	UserExcerpt        string                   `json:"user_excerpt"`
	Status             string                   `json:"status"`
	ResponseCount      int                      `json:"response_count"`
	RequiredCount      int                      `json:"required_count"`
	AgentsResponded    []string                 `json:"agents_responded"`
	MajorityAnswer     *string                  `json:"majority_answer"`
	DisagreementAgents []string                 `json:"disagreement_agents"`
	Answers            []triChatConsensusAnswer `json:"answers"`
}

type triChatConsensusResp struct {
	Mode               string                 `json:"mode"`
	ThreadID           string                 `json:"thread_id"`
	AgentIDs           []string               `json:"agent_ids"`
	MinAgents          int                    `json:"min_agents"`
	TurnsTotal         int                    `json:"turns_total"`
	TurnsWithAny       int                    `json:"turns_with_any_response"`
	AnalyzedTurns      int                    `json:"analyzed_turns"`
	ConsensusTurns     int                    `json:"consensus_turns"`
	DisagreementTurns  int                    `json:"disagreement_turns"`
	IncompleteTurns    int                    `json:"incomplete_turns"`
	DisagreementRate   *float64               `json:"disagreement_rate"`
	Flagged            bool                   `json:"flagged"`
	LatestTurn         *triChatConsensusTurn  `json:"latest_turn"`
	LatestDisagreement *triChatConsensusTurn  `json:"latest_disagreement"`
	RecentTurns        []triChatConsensusTurn `json:"recent_turns"`
}

type triChatTurn struct {
	TurnID           string         `json:"turn_id"`
	ThreadID         string         `json:"thread_id"`
	UserMessageID    string         `json:"user_message_id"`
	UserPrompt       string         `json:"user_prompt"`
	CreatedAt        string         `json:"created_at"`
	UpdatedAt        string         `json:"updated_at"`
	StartedAt        string         `json:"started_at"`
	FinishedAt       string         `json:"finished_at"`
	Status           string         `json:"status"`
	Phase            string         `json:"phase"`
	PhaseStatus      string         `json:"phase_status"`
	ExpectedAgents   []string       `json:"expected_agents"`
	MinAgents        int            `json:"min_agents"`
	NoveltyScore     *float64       `json:"novelty_score"`
	NoveltyThreshold *float64       `json:"novelty_threshold"`
	RetryRequired    bool           `json:"retry_required"`
	RetryAgents      []string       `json:"retry_agents"`
	Disagreement     bool           `json:"disagreement"`
	DecisionSummary  string         `json:"decision_summary"`
	SelectedAgent    string         `json:"selected_agent"`
	SelectedStrategy string         `json:"selected_strategy"`
	VerifyStatus     string         `json:"verify_status"`
	VerifySummary    string         `json:"verify_summary"`
	Metadata         map[string]any `json:"metadata"`
}

type triChatTurnArtifact struct {
	ArtifactID   string         `json:"artifact_id"`
	TurnID       string         `json:"turn_id"`
	ThreadID     string         `json:"thread_id"`
	CreatedAt    string         `json:"created_at"`
	Phase        string         `json:"phase"`
	ArtifactType string         `json:"artifact_type"`
	AgentID      string         `json:"agent_id"`
	Content      string         `json:"content"`
	Structured   map[string]any `json:"structured"`
	Score        *float64       `json:"score"`
	Metadata     map[string]any `json:"metadata"`
}

type triChatTurnStartResp struct {
	Created bool        `json:"created"`
	Turn    triChatTurn `json:"turn"`
}

type triChatTurnGetResp struct {
	Found         bool                  `json:"found"`
	Turn          triChatTurn           `json:"turn"`
	ArtifactCount int                   `json:"artifact_count"`
	Artifacts     []triChatTurnArtifact `json:"artifacts"`
}

type triChatWorkboardDecision struct {
	TurnID           string   `json:"turn_id"`
	DecisionSummary  string   `json:"decision_summary"`
	SelectedAgent    string   `json:"selected_agent"`
	SelectedStrategy string   `json:"selected_strategy"`
	UpdatedAt        string   `json:"updated_at"`
	NoveltyScore     *float64 `json:"novelty_score"`
}

type triChatWorkboardResp struct {
	ThreadID       string                    `json:"thread_id"`
	StatusFilter   string                    `json:"status_filter"`
	Counts         map[string]int            `json:"counts"`
	PhaseCounts    map[string]int            `json:"phase_counts"`
	LatestTurn     *triChatTurn              `json:"latest_turn"`
	ActiveTurn     *triChatTurn              `json:"active_turn"`
	LatestDecision *triChatWorkboardDecision `json:"latest_decision"`
	Turns          []triChatTurn             `json:"turns"`
}

type triChatNoveltyProposal struct {
	AgentID    string `json:"agent_id"`
	Content    string `json:"content"`
	Normalized string `json:"normalized"`
	TokenCount int    `json:"token_count"`
	Source     string `json:"source"`
	CreatedAt  string `json:"created_at"`
}

type triChatNoveltyPair struct {
	LeftAgent     string  `json:"left_agent"`
	RightAgent    string  `json:"right_agent"`
	Similarity    float64 `json:"similarity"`
	OverlapTokens int     `json:"overlap_tokens"`
	TotalTokens   int     `json:"total_tokens"`
}

type triChatNoveltyResp struct {
	Found             bool                     `json:"found"`
	TurnID            string                   `json:"turn_id"`
	ThreadID          string                   `json:"thread_id"`
	UserMessageID     string                   `json:"user_message_id"`
	ProposalCount     int                      `json:"proposal_count"`
	Proposals         []triChatNoveltyProposal `json:"proposals"`
	Pairs             []triChatNoveltyPair     `json:"pairs"`
	AverageSimilarity float64                  `json:"average_similarity"`
	NoveltyScore      float64                  `json:"novelty_score"`
	NoveltyThreshold  float64                  `json:"novelty_threshold"`
	MaxSimilarity     float64                  `json:"max_similarity"`
	RetryRequired     bool                     `json:"retry_required"`
	RetryAgents       []string                 `json:"retry_agents"`
	RetrySuppressed   bool                     `json:"retry_suppressed"`
	RetryReason       string                   `json:"retry_suppression_reason"`
	RetryReference    string                   `json:"retry_suppression_reference_turn_id"`
	Disagreement      bool                     `json:"disagreement"`
	DecisionHint      string                   `json:"decision_hint"`
}

type triChatTurnOrchestrateResp struct {
	OK       bool        `json:"ok"`
	Action   string      `json:"action"`
	Turn     triChatTurn `json:"turn"`
	Decision struct {
		SelectedAgent    string `json:"selected_agent"`
		SelectedStrategy string `json:"selected_strategy"`
		DecisionSummary  string `json:"decision_summary"`
	} `json:"decision"`
	Verify struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
		Failed  bool   `json:"failed"`
	} `json:"verify"`
}

type triChatVerifyResp struct {
	OK             bool   `json:"ok"`
	Executed       bool   `json:"executed"`
	Passed         *bool  `json:"passed"`
	Cwd            string `json:"cwd"`
	Command        string `json:"command"`
	Reason         string `json:"reason"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	StartedAt      string `json:"started_at"`
	FinishedAt     string `json:"finished_at"`
	ExitCode       *int   `json:"exit_code"`
	Signal         string `json:"signal"`
	TimedOut       bool   `json:"timed_out"`
	Stdout         string `json:"stdout"`
	Stderr         string `json:"stderr"`
	Error          string `json:"error"`
}

type triChatTmuxWorkerLoad struct {
	WorkerID      string `json:"worker_id"`
	ActiveQueue   int    `json:"active_queue"`
	ActiveLoad    int    `json:"active_load"`
	LaneState     string `json:"lane_state"`
	LaneSignal    string `json:"lane_signal"`
	LaneUpdatedAt string `json:"lane_updated_at"`
}

type triChatTmuxDashboard struct {
	GeneratedAt     string                  `json:"generated_at"`
	QueueDepth      int                     `json:"queue_depth"`
	QueueAgeSeconds *float64                `json:"queue_age_seconds"`
	QueueOldestTask string                  `json:"queue_oldest_task_id"`
	WorkerLoad      []triChatTmuxWorkerLoad `json:"worker_load"`
	FailureClass    string                  `json:"failure_class"`
	FailureCount    int                     `json:"failure_count"`
	LastFailureAt   string                  `json:"last_failure_at"`
	LastError       string                  `json:"last_error"`
}

type triChatTmuxStatusState struct {
	Enabled        bool   `json:"enabled"`
	SessionName    string `json:"session_name"`
	WorkerCount    int    `json:"worker_count"`
	UpdatedAt      string `json:"updated_at"`
	LastDispatchAt string `json:"last_dispatch_at"`
	LastError      string `json:"last_error"`
	Counts         struct {
		Total      int `json:"total"`
		Queued     int `json:"queued"`
		Dispatched int `json:"dispatched"`
		Running    int `json:"running"`
		Completed  int `json:"completed"`
		Failed     int `json:"failed"`
		Cancelled  int `json:"cancelled"`
	} `json:"counts"`
}

type triChatTmuxStatusResp struct {
	Action    string                 `json:"action"`
	Generated string                 `json:"generated_at"`
	State     triChatTmuxStatusState `json:"state"`
	Dashboard triChatTmuxDashboard   `json:"dashboard"`
}

type triChatTmuxDispatchFailure struct {
	TaskID   string `json:"task_id"`
	WorkerID string `json:"worker_id"`
	Error    string `json:"error"`
}

type triChatTmuxDispatchResp struct {
	Action          string                       `json:"action"`
	OK              bool                         `json:"ok"`
	Status          triChatTmuxStatusState       `json:"status"`
	Dashboard       triChatTmuxDashboard         `json:"dashboard"`
	EnqueuedCount   int                          `json:"enqueued_count"`
	AssignedCount   int                          `json:"assigned_count"`
	DispatchedCount int                          `json:"dispatched_count"`
	QueuedCount     int                          `json:"queued_count"`
	Failures        []triChatTmuxDispatchFailure `json:"failures"`
}

type triChatAdapterProtocolCheckStep struct {
	OK              bool   `json:"ok"`
	DurationMS      int    `json:"duration_ms"`
	RequestID       string `json:"request_id"`
	EnvelopeKind    string `json:"envelope_kind"`
	ProtocolVersion string `json:"protocol_version"`
	Error           string `json:"error"`
	StdoutExcerpt   string `json:"stdout_excerpt"`
	StderrExcerpt   string `json:"stderr_excerpt"`
	ExitCode        *int   `json:"exit_code"`
	Signal          string `json:"signal"`
}

type triChatAdapterProtocolCheckResult struct {
	AgentID           string                           `json:"agent_id"`
	Command           string                           `json:"command"`
	CommandSource     string                           `json:"command_source"`
	WrapperCandidates []string                         `json:"wrapper_candidates"`
	OK                bool                             `json:"ok"`
	Ping              triChatAdapterProtocolCheckStep  `json:"ping"`
	Ask               *triChatAdapterProtocolCheckStep `json:"ask"`
}

type triChatAdapterProtocolCheckResp struct {
	GeneratedAt     string `json:"generated_at"`
	ProtocolVersion string `json:"protocol_version"`
	Workspace       string `json:"workspace"`
	TimeoutSeconds  int    `json:"timeout_seconds"`
	RunAskCheck     bool   `json:"run_ask_check"`
	AskDryRun       bool   `json:"ask_dry_run"`
	ThreadID        string `json:"thread_id"`
	AllOK           bool   `json:"all_ok"`
	Counts          struct {
		Total  int `json:"total"`
		OK     int `json:"ok"`
		PingOK int `json:"ping_ok"`
		AskOK  int `json:"ask_ok"`
	} `json:"counts"`
	Results []triChatAdapterProtocolCheckResult `json:"results"`
}

type adapterTelemetryStatusResp struct {
	Summary struct {
		TotalChannels      int    `json:"total_channels"`
		OpenChannels       int    `json:"open_channels"`
		TotalTrips         int    `json:"total_trips"`
		TotalSuccesses     int    `json:"total_successes"`
		TotalTurns         int    `json:"total_turns"`
		TotalDegradedTurns int    `json:"total_degraded_turns"`
		NewestTripOpenedAt string `json:"newest_trip_opened_at"`
		NewestStateAt      string `json:"newest_state_at"`
		NewestEventAt      string `json:"newest_event_at"`
	} `json:"summary"`
	States         []adapterState `json:"states"`
	RecentEvents   []adapterEvent `json:"recent_events"`
	LastOpenEvents []adapterEvent `json:"last_open_events"`
}

type triChatBusStatusResp struct {
	Running           bool   `json:"running"`
	SocketPath        string `json:"socket_path"`
	StartedAt         string `json:"started_at"`
	LastError         string `json:"last_error"`
	ClientCount       int    `json:"client_count"`
	SubscriptionCount int    `json:"subscription_count"`
	Metrics           struct {
		TotalPublished int `json:"total_published"`
		TotalDelivered int `json:"total_delivered"`
		MessagesIn     int `json:"messages_in"`
		MessagesOut    int `json:"messages_out"`
	} `json:"metrics"`
}

type adapterState struct {
	AgentID           string         `json:"agent_id"`
	Channel           string         `json:"channel"`
	UpdatedAt         string         `json:"updated_at"`
	Open              bool           `json:"open"`
	OpenUntil         string         `json:"open_until"`
	FailureCount      int            `json:"failure_count"`
	TripCount         int            `json:"trip_count"`
	SuccessCount      int            `json:"success_count"`
	LastError         string         `json:"last_error"`
	LastOpenedAt      string         `json:"last_opened_at"`
	TurnCount         int            `json:"turn_count"`
	DegradedTurnCount int            `json:"degraded_turn_count"`
	LastResult        string         `json:"last_result"`
	Metadata          map[string]any `json:"metadata"`
}

type adapterEvent struct {
	EventID   string         `json:"event_id"`
	CreatedAt string         `json:"created_at"`
	AgentID   string         `json:"agent_id"`
	Channel   string         `json:"channel"`
	EventType string         `json:"event_type"`
	OpenUntil string         `json:"open_until"`
	ErrorText string         `json:"error_text"`
	Details   map[string]any `json:"details"`
}

type reliabilitySnapshot struct {
	taskSummary      taskSummaryResp
	taskAutoRetry    daemonStatusResp
	transcriptSquish daemonStatusResp
	triRetention     daemonStatusResp
	turnWatchdog     triChatTurnWatchdogStatusResp
	slo              triChatSloStatusResp
	triSummary       triChatSummaryResp
	consensus        triChatConsensusResp
	workboard        triChatWorkboardResp
	activeTurn       triChatTurnGetResp
	novelty          triChatNoveltyResp
	tmuxStatus       triChatTmuxStatusResp
	adapterTelemetry adapterTelemetryStatusResp
	busStatus        triChatBusStatusResp
	updatedAt        time.Time
}

type breakerState struct {
	threshold    int
	recovery     time.Duration
	failureCount int
	openUntil    time.Time
	lastOpenedAt time.Time
	lastError    string
	lastResult   string
	tripCount    int
	successCount int
}

func (b *breakerState) isOpen(now time.Time) bool {
	return !b.openUntil.IsZero() && now.Before(b.openUntil)
}

func (b *breakerState) remaining(now time.Time) time.Duration {
	if b.openUntil.IsZero() {
		return 0
	}
	if now.After(b.openUntil) {
		return 0
	}
	return b.openUntil.Sub(now)
}

func (b *breakerState) recordSuccess(now time.Time) bool {
	wasOpen := b.isOpen(now)
	b.failureCount = 0
	b.openUntil = time.Time{}
	b.lastError = ""
	b.lastResult = "success"
	b.successCount += 1
	return wasOpen
}

func (b *breakerState) recordFailure(now time.Time, errorText string) bool {
	b.failureCount += 1
	b.lastError = compactSingleLine(errorText, 240)
	b.lastResult = "failure"
	if b.failureCount >= maxInt(1, b.threshold) {
		b.tripCount += 1
		b.failureCount = 0
		b.lastOpenedAt = now.UTC()
		b.openUntil = now.Add(maxDuration(time.Second, b.recovery)).UTC()
		b.lastResult = "trip-opened"
		return true
	}
	return false
}

func (b *breakerState) reset() {
	b.failureCount = 0
	b.openUntil = time.Time{}
	b.lastError = ""
	b.lastResult = "reset"
}

type adapterErrorClass struct {
	Code        string
	Retryable   bool
	Persistent  bool
	SuppressFor time.Duration
}

func classifyCommandAdapterError(errText string) adapterErrorClass {
	normalized := strings.ToLower(strings.TrimSpace(errText))
	switch {
	case strings.Contains(normalized, "command not found"):
		return adapterErrorClass{Code: "command_not_found", Persistent: true, SuppressFor: 5 * time.Minute}
	case strings.Contains(normalized, "permission denied"):
		return adapterErrorClass{Code: "permission_denied", Persistent: true, SuppressFor: 5 * time.Minute}
	case strings.Contains(normalized, "protocol_version"), strings.Contains(normalized, "protocol mismatch"):
		return adapterErrorClass{Code: "protocol_mismatch", Persistent: true, SuppressFor: 3 * time.Minute}
	case strings.Contains(normalized, "bridge protocol violation"):
		return adapterErrorClass{Code: "protocol_violation", Retryable: true, Persistent: true, SuppressFor: 90 * time.Second}
	case strings.Contains(normalized, "bridge timeout"), strings.Contains(normalized, "deadline exceeded"), strings.Contains(normalized, "timed out"):
		return adapterErrorClass{Code: "timeout", Retryable: true}
	case strings.Contains(normalized, "broken pipe"), strings.Contains(normalized, "connection reset"):
		return adapterErrorClass{Code: "transport_transient", Retryable: true}
	default:
		return adapterErrorClass{Code: "unknown"}
	}
}

func classifyModelAdapterError(errText string) adapterErrorClass {
	normalized := strings.ToLower(strings.TrimSpace(errText))
	switch {
	case strings.Contains(normalized, "context deadline exceeded"), strings.Contains(normalized, "timed out"):
		return adapterErrorClass{Code: "timeout", Retryable: true}
	case strings.Contains(normalized, "connection refused"), strings.Contains(normalized, "dial tcp"), strings.Contains(normalized, "no such host"):
		return adapterErrorClass{Code: "endpoint_unreachable", Persistent: true, SuppressFor: 35 * time.Second}
	case strings.Contains(normalized, "http 404"), strings.Contains(normalized, "model not found"), strings.Contains(normalized, "pull it first"), strings.Contains(normalized, "ollama pull"):
		return adapterErrorClass{Code: "model_missing", Persistent: true, SuppressFor: 3 * time.Minute}
	case strings.Contains(normalized, "connection reset"), strings.Contains(normalized, "eof"):
		return adapterErrorClass{Code: "transport_transient", Retryable: true}
	default:
		return adapterErrorClass{Code: "unknown"}
	}
}

func suppressionRemaining(until time.Time, now time.Time) time.Duration {
	if until.IsZero() || !now.Before(until) {
		return 0
	}
	return until.Sub(now)
}

type agentRuntime struct {
	mu sync.Mutex

	agentID      string
	systemPrompt string

	commandBreaker          breakerState
	modelBreaker            breakerState
	turnCount               int
	degradedTurns           int
	lastCommandHandshakeAt  time.Time
	lastCommandHandshakeOK  bool
	lastCommandHandshakeFor string
	commandSuppressedUntil  time.Time
	commandSuppressionCause string
	modelSuppressedUntil    time.Time
	modelSuppressionCause   string
}

type agentResponse struct {
	agentID         string
	content         string
	adapterMeta     map[string]any
	telemetryEvents []map[string]any
}

type commandAdapterResponse struct {
	Kind            string         `json:"kind"`
	ProtocolVersion string         `json:"protocol_version"`
	RequestID       string         `json:"request_id"`
	AgentID         string         `json:"agent_id"`
	Bridge          string         `json:"bridge"`
	Content         string         `json:"content"`
	Meta            map[string]any `json:"meta"`
}

type commandAdapterPong struct {
	Kind            string         `json:"kind"`
	ProtocolVersion string         `json:"protocol_version"`
	RequestID       string         `json:"request_id"`
	AgentID         string         `json:"agent_id"`
	Bridge          string         `json:"bridge"`
	Timestamp       string         `json:"timestamp"`
	Meta            map[string]any `json:"meta"`
}

type orchestrator struct {
	mu sync.Mutex

	agents    map[string]*agentRuntime
	bootstrap string
	ollamaAPI string
}

func newOrchestrator(cfg appConfig) *orchestrator {
	buildBreaker := func() breakerState {
		threshold := maxInt(1, cfg.adapterCircuitThreshold)
		recovery := time.Duration(maxInt(1, cfg.adapterCircuitRecoverySecond)) * time.Second
		return breakerState{threshold: threshold, recovery: recovery}
	}
	return &orchestrator{
		agents: map[string]*agentRuntime{
			"codex": {
				agentID:        "codex",
				systemPrompt:   codePrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
			"cursor": {
				agentID:        "cursor",
				systemPrompt:   cursorPrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
			"local-imprint": {
				agentID:        "local-imprint",
				systemPrompt:   imprintPrompt,
				commandBreaker: buildBreaker(),
				modelBreaker:   buildBreaker(),
			},
		},
		bootstrap: "",
		ollamaAPI: envOr("TRICHAT_OLLAMA_API_BASE", defaultOllamaAPI),
	}
}

func (o *orchestrator) setBootstrap(text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.bootstrap = text
}

func (o *orchestrator) bootstrapText() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.bootstrap
}

func (o *orchestrator) restoreStates(states []adapterState, cfg runtimeSettings) {
	now := time.Now()
	for _, state := range states {
		agent := o.agents[state.AgentID]
		if agent == nil {
			continue
		}
		agent.mu.Lock()
		if state.Channel == "command" {
			hydrateBreaker(&agent.commandBreaker, state, cfg)
			suppressedUntil, suppressionReason := parseSuppressionMetadata(state.Metadata)
			if suppressionRemaining(suppressedUntil, now) > 0 {
				agent.commandSuppressedUntil = suppressedUntil
				agent.commandSuppressionCause = suppressionReason
			} else {
				agent.commandSuppressedUntil = time.Time{}
				agent.commandSuppressionCause = ""
			}
		} else {
			hydrateBreaker(&agent.modelBreaker, state, cfg)
			suppressedUntil, suppressionReason := parseSuppressionMetadata(state.Metadata)
			if suppressionRemaining(suppressedUntil, now) > 0 {
				agent.modelSuppressedUntil = suppressedUntil
				agent.modelSuppressionCause = suppressionReason
			} else {
				agent.modelSuppressedUntil = time.Time{}
				agent.modelSuppressionCause = ""
			}
		}
		agent.turnCount = maxInt(agent.turnCount, state.TurnCount)
		agent.degradedTurns = maxInt(agent.degradedTurns, state.DegradedTurnCount)
		agent.mu.Unlock()
	}
}

func parseSuppressionMetadata(metadata map[string]any) (time.Time, string) {
	if len(metadata) == 0 {
		return time.Time{}, ""
	}
	suppressionReason := asTrimmedString(metadata["suppression_reason"])
	suppressedUntilText := asTrimmedString(metadata["suppressed_until"])
	if suppressedUntilText == "" {
		return time.Time{}, suppressionReason
	}
	suppressedUntil, err := parseISO(suppressedUntilText)
	if err != nil {
		return time.Time{}, suppressionReason
	}
	return suppressedUntil.UTC(), suppressionReason
}

func hydrateBreaker(target *breakerState, state adapterState, cfg runtimeSettings) {
	target.threshold = maxInt(1, cfg.adapterCircuitThreshold)
	target.recovery = time.Duration(maxInt(1, cfg.adapterCircuitRecoverySecond)) * time.Second
	target.failureCount = maxInt(0, state.FailureCount)
	target.tripCount = maxInt(0, state.TripCount)
	target.successCount = maxInt(0, state.SuccessCount)
	target.lastError = compactSingleLine(state.LastError, 240)
	target.lastResult = compactSingleLine(state.LastResult, 120)
	if t, err := parseISO(state.OpenUntil); err == nil {
		target.openUntil = t
	}
	if t, err := parseISO(state.LastOpenedAt); err == nil {
		target.lastOpenedAt = t
	}
}

func (o *orchestrator) collectStates(cfg appConfig, settings runtimeSettings) []map[string]any {
	now := time.Now().UTC()
	nowISO := now.Format(time.RFC3339)
	states := make([]map[string]any, 0, 6)
	commands := map[string]string{
		"codex":         cfg.codexCommand,
		"cursor":        cfg.cursorCommand,
		"local-imprint": cfg.imprintCommand,
	}
	for _, agentID := range []string{"codex", "cursor", "local-imprint"} {
		agent := o.agents[agentID]
		if agent == nil {
			continue
		}
		agent.mu.Lock()
		agent.commandBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
		agent.commandBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
		agent.modelBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
		agent.modelBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
		turnCount := agent.turnCount
		degraded := agent.degradedTurns
		commandSnapshot := agent.commandBreaker
		modelSnapshot := agent.modelBreaker
		commandSuppressedUntil := agent.commandSuppressedUntil
		commandSuppressionReason := agent.commandSuppressionCause
		modelSuppressedUntil := agent.modelSuppressedUntil
		modelSuppressionReason := agent.modelSuppressionCause
		agent.mu.Unlock()

		states = append(
			states,
			breakerToStatePayload(
				agentID,
				"command",
				nowISO,
				turnCount,
				degraded,
				commandSnapshot,
				commands[agentID] != "",
				commandSuppressedUntil,
				commandSuppressionReason,
			),
		)
		states = append(
			states,
			breakerToStatePayload(
				agentID,
				"model",
				nowISO,
				turnCount,
				degraded,
				modelSnapshot,
				commands[agentID] != "",
				modelSuppressedUntil,
				modelSuppressionReason,
			),
		)
	}
	return states
}

func breakerToStatePayload(
	agentID, channel, now string,
	turnCount, degraded int,
	snapshot breakerState,
	commandEnabled bool,
	suppressedUntil time.Time,
	suppressionReason string,
) map[string]any {
	metadata := map[string]any{
		"command_enabled": commandEnabled,
	}
	if suppressionRemaining(suppressedUntil, time.Now()) > 0 {
		metadata["suppressed"] = true
		metadata["suppressed_until"] = suppressedUntil.UTC().Format(time.RFC3339)
	}
	if strings.TrimSpace(suppressionReason) != "" {
		metadata["suppression_reason"] = compactSingleLine(suppressionReason, 180)
	}
	payload := map[string]any{
		"agent_id":            agentID,
		"channel":             channel,
		"updated_at":          now,
		"open":                snapshot.isOpen(time.Now()),
		"failure_count":       snapshot.failureCount,
		"trip_count":          snapshot.tripCount,
		"success_count":       snapshot.successCount,
		"last_error":          snapshot.lastError,
		"turn_count":          turnCount,
		"degraded_turn_count": degraded,
		"last_result":         snapshot.lastResult,
		"metadata":            metadata,
	}
	if !snapshot.openUntil.IsZero() {
		payload["open_until"] = snapshot.openUntil.UTC().Format(time.RFC3339)
	}
	if !snapshot.lastOpenedAt.IsZero() {
		payload["last_opened_at"] = snapshot.lastOpenedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

type tiebreakThresholds struct {
	strategyNoTiebreak    float64
	strategyForceTiebreak float64
	commandForceTiebreak  float64
	addendumMinConfidence float64
	addendumMaxSimilarity float64
	reason                string
}

type lateAddendumInput struct {
	caller            mcpCaller
	mutation          *mutationFactory
	orch              *orchestrator
	cfg               appConfig
	settings          runtimeSettings
	threadID          string
	turnID            string
	userMessageID     string
	agentID           string
	prompt            string
	history           []triChatMessage
	baselineResponses []agentResponse
	peerContext       string
	thresholds        tiebreakThresholds
	budget            time.Duration
}

func deriveAdaptiveTiebreakThresholds(reliability reliabilitySnapshot) tiebreakThresholds {
	thresholds := tiebreakThresholds{
		strategyNoTiebreak:    0.72,
		strategyForceTiebreak: 0.46,
		commandForceTiebreak:  0.34,
		addendumMinConfidence: 0.62,
		addendumMaxSimilarity: 0.74,
		reason:                "base",
	}
	pressure := 0.0
	reasons := make([]string, 0, 8)

	if reliability.consensus.DisagreementRate != nil {
		disagreementRate := clampFloat(*reliability.consensus.DisagreementRate, 0, 1)
		switch {
		case disagreementRate >= 0.4:
			pressure += 0.12
			reasons = append(reasons, fmt.Sprintf("consensus_disagreement_rate=%.2f", disagreementRate))
		case disagreementRate >= 0.25:
			pressure += 0.07
			reasons = append(reasons, fmt.Sprintf("consensus_disagreement_rate=%.2f", disagreementRate))
		case disagreementRate <= 0.1:
			pressure -= 0.06
			reasons = append(reasons, fmt.Sprintf("consensus_stable_rate=%.2f", disagreementRate))
		}
	}

	if reliability.novelty.Found {
		if reliability.novelty.RetryRequired {
			pressure += 0.07
			reasons = append(reasons, "novelty_retry_required")
		}
		if reliability.novelty.Disagreement {
			pressure += 0.05
			reasons = append(reasons, "novelty_disagreement")
		}
		if reliability.novelty.RetrySuppressed {
			pressure += 0.03
			reasons = append(reasons, "novelty_retry_suppressed")
		}
		switch {
		case reliability.novelty.NoveltyScore <= 0.32:
			pressure += 0.05
			reasons = append(reasons, fmt.Sprintf("novelty_low=%.2f", reliability.novelty.NoveltyScore))
		case reliability.novelty.NoveltyScore >= 0.58:
			pressure -= 0.05
			reasons = append(reasons, fmt.Sprintf("novelty_strong=%.2f", reliability.novelty.NoveltyScore))
		}
	}

	adapterErrorRate := clampFloat(reliability.slo.Metrics.Adapter.ErrorRate, 0, 1)
	turnFailureRate := clampFloat(reliability.slo.Metrics.Turns.FailureRate, 0, 1)
	if adapterErrorRate >= 0.2 || turnFailureRate >= 0.18 {
		pressure -= 0.05
		reasons = append(reasons, "stability_guard_high_error")
	}

	pressure = clampFloat(pressure, -0.14, 0.18)
	noTiebreak := clampFloat(0.72+pressure, 0.60, 0.88)
	force := clampFloat(0.46+pressure*0.9, 0.28, 0.74)
	if force >= noTiebreak-0.06 {
		force = clampFloat(noTiebreak-0.06, 0.28, 0.74)
	}
	commandForce := clampFloat(0.34+pressure*0.8, 0.18, 0.72)
	addendumConfidence := clampFloat(0.62-pressure*0.15, 0.50, 0.78)
	addendumSimilarity := clampFloat(0.74+pressure*0.2, 0.55, 0.90)

	thresholds.strategyNoTiebreak = noTiebreak
	thresholds.strategyForceTiebreak = force
	thresholds.commandForceTiebreak = commandForce
	thresholds.addendumMinConfidence = addendumConfidence
	thresholds.addendumMaxSimilarity = addendumSimilarity
	if len(reasons) > 0 {
		thresholds.reason = strings.Join(reasons, ",")
	}
	return thresholds
}

func (o *orchestrator) fanout(
	prompt string,
	promptOverrides map[string]string,
	history []triChatMessage,
	cfg appConfig,
	settings runtimeSettings,
	target string,
	threadID string,
	peerContext string,
) ([]agentResponse, []map[string]any) {
	agents := fanoutTargets(target)
	responses := make([]agentResponse, 0, len(agents))
	events := make([]map[string]any, 0, 16)
	if len(agents) == 0 {
		return responses, events
	}
	minSuccessAgents := clampInt(settings.consensusMinAgents, 1, len(agents))

	type fanoutResult struct {
		response       agentResponse
		countsAsQuorum bool
	}
	results := make(chan fanoutResult, len(agents))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	launched := 0

	for _, agentID := range agents {
		agent := o.agents[agentID]
		if agent == nil {
			continue
		}
		launched += 1
		go func(runtime *agentRuntime) {
			command := commandForAgent(runtime.agentID, cfg)
			agentPrompt := prompt
			if override, ok := promptOverrides[runtime.agentID]; ok && strings.TrimSpace(override) != "" {
				agentPrompt = strings.TrimSpace(override)
			}
			response := runtime.respond(
				ctx,
				agentPrompt,
				history,
				o.bootstrapText(),
				command,
				cfg,
				settings,
				o.ollamaAPI,
				threadID,
				peerContext,
			)
			results <- fanoutResult{
				response:       response,
				countsAsQuorum: fanoutResponseCountsTowardQuorum(response),
			}
		}(agent)
	}
	if launched == 0 {
		return responses, events
	}

	successCount := 0
	completed := 0
	for completed < launched {
		result := <-results
		completed += 1
		responses = append(responses, result.response)
		events = append(events, result.response.telemetryEvents...)
		if result.countsAsQuorum {
			successCount += 1
		}
		if successCount >= minSuccessAgents {
			cancel()
			break
		}
	}

	sortAgentResponsesStable(responses)
	return responses, events
}

func (o *orchestrator) fanoutSingleWithBudget(
	agentID string,
	prompt string,
	promptOverrides map[string]string,
	history []triChatMessage,
	cfg appConfig,
	settings runtimeSettings,
	threadID string,
	peerContext string,
	budget time.Duration,
) (agentResponse, []map[string]any, bool) {
	normalizedAgent := strings.ToLower(strings.TrimSpace(agentID))
	if normalizedAgent == "" {
		return agentResponse{}, nil, false
	}
	runtime := o.agents[normalizedAgent]
	if runtime == nil {
		return agentResponse{}, nil, false
	}
	agentPrompt := strings.TrimSpace(prompt)
	if override, ok := promptOverrides[normalizedAgent]; ok && strings.TrimSpace(override) != "" {
		agentPrompt = strings.TrimSpace(override)
	}
	if agentPrompt == "" {
		return agentResponse{}, nil, false
	}
	command := commandForAgent(runtime.agentID, cfg)
	timeoutBudget := budget
	if timeoutBudget <= 0 {
		timeoutBudget = 900 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeoutBudget)
	defer cancel()
	response := runtime.respond(
		ctx,
		agentPrompt,
		history,
		o.bootstrapText(),
		command,
		cfg,
		settings,
		o.ollamaAPI,
		threadID,
		peerContext,
	)
	return response, response.telemetryEvents, fanoutResponseCountsTowardQuorum(response)
}

func fanoutResponseCountsTowardQuorum(response agentResponse) bool {
	if strings.TrimSpace(response.agentID) == "" || strings.TrimSpace(response.content) == "" {
		return false
	}
	if len(response.adapterMeta) == 0 {
		return true
	}
	if degraded, ok := parseAnyBool(response.adapterMeta["degraded"]); ok && degraded {
		return false
	}
	adapter := strings.ToLower(strings.TrimSpace(fmt.Sprint(response.adapterMeta["adapter"])))
	switch adapter {
	case "degraded", "aborted", "cancelled", "canceled":
		return false
	default:
		return true
	}
}

func sortAgentResponsesStable(responses []agentResponse) {
	order := map[string]int{"codex": 0, "cursor": 1, "local-imprint": 2}
	sort.SliceStable(responses, func(i, j int) bool {
		left := strings.ToLower(strings.TrimSpace(responses[i].agentID))
		right := strings.ToLower(strings.TrimSpace(responses[j].agentID))
		leftRank, leftOK := order[left]
		rightRank, rightOK := order[right]
		if !leftOK {
			leftRank = len(order) + 1
		}
		if !rightOK {
			rightRank = len(order) + 1
		}
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return left < right
	})
}

func pickMissingFanoutAgent(expectedAgents []string, responses []agentResponse) string {
	seen := make(map[string]struct{}, len(responses))
	for _, response := range responses {
		agentID := strings.ToLower(strings.TrimSpace(response.agentID))
		if agentID == "" {
			continue
		}
		seen[agentID] = struct{}{}
	}
	for _, expected := range expectedAgents {
		agentID := strings.ToLower(strings.TrimSpace(expected))
		if agentID == "" {
			continue
		}
		if _, ok := seen[agentID]; !ok {
			return agentID
		}
	}
	return ""
}

func proposalResponsesDisagreeForTiebreak(
	responses []agentResponse,
	thresholds tiebreakThresholds,
) (bool, float64) {
	if len(responses) < 2 {
		return false, 1
	}
	left := responses[0]
	right := responses[1]
	leftStructured := parseProposalStructured(left.content, left.agentID, false)
	rightStructured := parseProposalStructured(right.content, right.agentID, false)
	leftStrategy := normalizeProposalCompareText(fmt.Sprint(leftStructured["strategy"]))
	rightStrategy := normalizeProposalCompareText(fmt.Sprint(rightStructured["strategy"]))
	if leftStrategy == "" || rightStrategy == "" {
		leftStrategy = normalizeProposalCompareText(left.content)
		rightStrategy = normalizeProposalCompareText(right.content)
	}
	strategySimilarity := proposalJaccardSimilarity(leftStrategy, rightStrategy)
	if strategySimilarity >= thresholds.strategyNoTiebreak {
		return false, strategySimilarity
	}

	leftCommands := proposalStructuredCommands(leftStructured)
	rightCommands := proposalStructuredCommands(rightStructured)
	commandSimilarity := proposalJaccardSimilarity(
		strings.Join(leftCommands, " "),
		strings.Join(rightCommands, " "),
	)
	if strategySimilarity <= thresholds.strategyForceTiebreak {
		return true, strategySimilarity
	}
	if commandSimilarity < thresholds.commandForceTiebreak {
		return true, strategySimilarity
	}
	return false, strategySimilarity
}

func proposalStructuredCommands(structured map[string]any) []string {
	if len(structured) == 0 {
		return nil
	}
	raw := structured["commands"]
	switch typed := raw.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			normalized := normalizeProposalCompareText(entry)
			if normalized != "" {
				out = append(out, normalized)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			normalized := normalizeProposalCompareText(fmt.Sprint(entry))
			if normalized != "" {
				out = append(out, normalized)
			}
		}
		return out
	default:
		return nil
	}
}

func normalizeProposalCompareText(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "" {
		return ""
	}
	var b strings.Builder
	lastSpace := false
	for _, r := range lower {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastSpace = false
			continue
		}
		if !lastSpace {
			b.WriteByte(' ')
			lastSpace = true
		}
	}
	return strings.TrimSpace(b.String())
}

func proposalJaccardSimilarity(left string, right string) float64 {
	leftTokens := strings.Fields(left)
	rightTokens := strings.Fields(right)
	if len(leftTokens) == 0 || len(rightTokens) == 0 {
		return 0
	}
	leftSet := make(map[string]struct{}, len(leftTokens))
	for _, token := range leftTokens {
		if len(token) < 3 {
			continue
		}
		leftSet[token] = struct{}{}
	}
	rightSet := make(map[string]struct{}, len(rightTokens))
	for _, token := range rightTokens {
		if len(token) < 3 {
			continue
		}
		rightSet[token] = struct{}{}
	}
	if len(leftSet) == 0 || len(rightSet) == 0 {
		return 0
	}
	overlap := 0
	for token := range leftSet {
		if _, ok := rightSet[token]; ok {
			overlap += 1
		}
	}
	union := len(leftSet) + len(rightSet) - overlap
	if union <= 0 {
		return 1
	}
	return float64(overlap) / float64(union)
}

func lateAddendumIsHighSignal(
	response agentResponse,
	baseline []agentResponse,
	thresholds tiebreakThresholds,
) (bool, float64, float64) {
	structured := parseProposalStructured(response.content, response.agentID, false)
	confidence := proposalConfidence(structured)
	if confidence < thresholds.addendumMinConfidence {
		return false, confidence, 1
	}

	candidateStrategy := normalizeProposalCompareText(fmt.Sprint(structured["strategy"]))
	if candidateStrategy == "" {
		candidateStrategy = normalizeProposalCompareText(response.content)
	}
	if candidateStrategy == "" {
		return false, confidence, 1
	}

	maxSimilarity := 0.0
	for _, peer := range baseline {
		peerStructured := parseProposalStructured(peer.content, peer.agentID, false)
		peerStrategy := normalizeProposalCompareText(fmt.Sprint(peerStructured["strategy"]))
		if peerStrategy == "" {
			peerStrategy = normalizeProposalCompareText(peer.content)
		}
		if peerStrategy == "" {
			continue
		}
		similarity := proposalJaccardSimilarity(candidateStrategy, peerStrategy)
		if similarity > maxSimilarity {
			maxSimilarity = similarity
		}
	}
	if len(baseline) > 0 && maxSimilarity > thresholds.addendumMaxSimilarity {
		return false, confidence, maxSimilarity
	}

	commands := proposalStructuredCommands(structured)
	if len(commands) == 0 && confidence < thresholds.addendumMinConfidence+0.06 {
		return false, confidence, maxSimilarity
	}
	return true, confidence, maxSimilarity
}

func captureLateProposalAddendum(input lateAddendumInput) {
	if strings.TrimSpace(input.agentID) == "" || input.orch == nil || input.mutation == nil {
		return
	}
	addendumPrompt := buildProposalAddendumPromptForAgent(input.prompt, input.agentID, input.baselineResponses)
	if strings.TrimSpace(addendumPrompt) == "" {
		return
	}
	addendumSettings := input.settings
	addendumSettings.consensusMinAgents = 1
	addendumSettings.modelTimeoutSeconds = minInt(addendumSettings.modelTimeoutSeconds, 2)
	addendumSettings.bridgeTimeoutSeconds = minInt(addendumSettings.bridgeTimeoutSeconds, 2)
	addendumSettings.adapterFailoverTimeoutSecond = minInt(addendumSettings.adapterFailoverTimeoutSecond, 3)
	response, _, ok := input.orch.fanoutSingleWithBudget(
		input.agentID,
		addendumPrompt,
		nil,
		input.history,
		input.cfg,
		addendumSettings,
		input.threadID,
		input.peerContext,
		input.budget,
	)
	if !ok {
		return
	}
	highSignal, confidence, maxSimilarity := lateAddendumIsHighSignal(response, input.baselineResponses, input.thresholds)
	if !highSignal {
		return
	}
	structured := parseProposalStructured(response.content, response.agentID, false)
	messagePayload := map[string]any{
		"mutation":            input.mutation.next("trichat.message_post"),
		"thread_id":           input.threadID,
		"agent_id":            response.agentID,
		"role":                "assistant",
		"content":             response.content,
		"reply_to_message_id": input.userMessageID,
		"metadata": map[string]any{
			"kind":                    "fanout-proposal-addendum",
			"source":                  "trichat-tui",
			"phase":                   "propose",
			"late_addendum":           true,
			"addendum_agent":          response.agentID,
			"addendum_for_turn":       input.turnID,
			"high_signal":             true,
			"addendum_confidence":     confidence,
			"addendum_max_similarity": maxSimilarity,
			"addendum_budget_msec":    int(input.budget / time.Millisecond),
			"structured_v":            1,
			"structured":              structured,
			"adapter":                 response.adapterMeta,
		},
	}
	if _, err := input.caller.callTool("trichat.message_post", messagePayload); err != nil {
		return
	}

	if strings.TrimSpace(input.turnID) == "" {
		return
	}
	_, _ = input.caller.callTool("trichat.turn_artifact", map[string]any{
		"mutation":      input.mutation.next("trichat.turn_artifact"),
		"turn_id":       input.turnID,
		"phase":         "propose",
		"artifact_type": "proposal_addendum",
		"agent_id":      response.agentID,
		"content":       response.content,
		"structured":    structured,
		"score":         proposalConfidence(structured),
		"metadata": map[string]any{
			"source":                  "trichat-tui",
			"late_addendum":           true,
			"high_signal":             true,
			"addendum_confidence":     confidence,
			"addendum_max_similarity": maxSimilarity,
			"addendum_budget_msec":    int(input.budget / time.Millisecond),
		},
	})
}

func fanoutTargets(target string) []string {
	normalized := strings.TrimSpace(strings.ToLower(target))
	switch normalized {
	case "codex", "cursor", "local-imprint":
		return []string{normalized}
	default:
		return []string{"codex", "cursor", "local-imprint"}
	}
}

func commandForAgent(agentID string, cfg appConfig) string {
	switch agentID {
	case "codex":
		return strings.TrimSpace(cfg.codexCommand)
	case "cursor":
		return strings.TrimSpace(cfg.cursorCommand)
	case "local-imprint":
		return strings.TrimSpace(cfg.imprintCommand)
	default:
		return ""
	}
}

func (a *agentRuntime) respond(
	ctx context.Context,
	prompt string,
	history []triChatMessage,
	bootstrapText string,
	command string,
	cfg appConfig,
	settings runtimeSettings,
	ollamaAPI string,
	threadID string,
	peerContext string,
) agentResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	start := time.Now()
	deadline := start.Add(time.Duration(maxInt(1, settings.adapterFailoverTimeoutSecond)) * time.Second)
	attempts := make([]string, 0, 4)
	events := make([]map[string]any, 0, 4)
	maxRetries := clampInt(envOrInt("TRICHAT_ADAPTER_RETRY_ATTEMPTS", adapterMaxRetries), 0, 3)
	minRetryBudget := 1200 * time.Millisecond

	a.mu.Lock()
	a.turnCount += 1
	a.commandBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
	a.commandBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
	a.modelBreaker.threshold = maxInt(1, settings.adapterCircuitThreshold)
	a.modelBreaker.recovery = time.Duration(maxInt(1, settings.adapterCircuitRecoverySecond)) * time.Second
	a.mu.Unlock()

	channels := []string{"model"}
	if strings.TrimSpace(command) != "" {
		channels = []string{"command", "model"}
	}

	messages := buildOllamaMessages(a.systemPrompt, prompt, history, bootstrapText, peerContext)

channelLoop:
	for _, channel := range channels {
		if ctx.Err() != nil {
			attempts = append(attempts, "fanout:aborted(quorum-finalize)")
			break channelLoop
		}
		now := time.Now()
		if !now.Before(deadline) {
			attempts = append(attempts, "deadline-exceeded")
			break
		}
		remaining := deadline.Sub(now)
		if channel == "command" {
			a.mu.Lock()
			open := a.commandBreaker.isOpen(now)
			remainingOpen := a.commandBreaker.remaining(now)
			commandSuppressedRemaining := suppressionRemaining(a.commandSuppressedUntil, now)
			commandSuppressionCause := a.commandSuppressionCause
			if commandSuppressedRemaining <= 0 && !a.commandSuppressedUntil.IsZero() {
				a.commandSuppressedUntil = time.Time{}
				a.commandSuppressionCause = ""
			}
			a.mu.Unlock()
			if open {
				attempts = append(attempts, fmt.Sprintf("command:circuit-open(%.1fs)", remainingOpen.Seconds()))
				continue
			}
			if commandSuppressedRemaining > 0 {
				reason := compactSingleLine(commandSuppressionCause, 90)
				attempts = append(attempts, fmt.Sprintf("command:suppressed(%.1fs:%s)", commandSuppressedRemaining.Seconds(), reason))
				events = append(events, telemetryEvent(a.agentID, "command", "suppressed_skip", "", "", map[string]any{
					"path":              "command",
					"suppressed_reason": reason,
					"remaining_sec":     commandSuppressedRemaining.Seconds(),
				}))
				continue
			}

			handshakeTTL := adapterHandshakeTTL()
			a.mu.Lock()
			needsHandshake := strings.TrimSpace(command) != a.lastCommandHandshakeFor ||
				!a.lastCommandHandshakeOK ||
				a.lastCommandHandshakeAt.IsZero() ||
				now.Sub(a.lastCommandHandshakeAt) >= handshakeTTL
			a.mu.Unlock()
			if needsHandshake {
				pingRequestID := adapterRequestID(a.agentID, "ping")
				pingPayload := map[string]any{
					"op":               "ping",
					"protocol_version": adapterProtocol,
					"request_id":       pingRequestID,
					"agent_id":         a.agentID,
					"thread_id":        threadID,
					"workspace":        cfg.repoRoot,
					"timestamp":        time.Now().UTC().Format(time.RFC3339),
				}
				pingTimeout := minDuration(remaining, 5*time.Second)
				handshakeStarted := time.Now()
				pingErr := pingCommandAdapter(ctx, command, pingPayload, pingTimeout)
				handshakeLatencyMS := time.Since(handshakeStarted).Milliseconds()
				a.mu.Lock()
				a.lastCommandHandshakeAt = time.Now().UTC()
				a.lastCommandHandshakeFor = strings.TrimSpace(command)
				a.lastCommandHandshakeOK = pingErr == nil
				a.mu.Unlock()
				if pingErr != nil {
					if isFanoutAbortError(pingErr) || ctx.Err() != nil {
						attempts = append(attempts, "command:aborted(quorum-finalize)")
						break channelLoop
					}
					errText := fmt.Sprintf("RuntimeError: adapter handshake failed: %v", pingErr)
					errClass := classifyCommandAdapterError(errText)
					events = append(events, telemetryEvent(a.agentID, "command", "handshake_failed", errText, "", map[string]any{
						"path":        "command",
						"request_id":  pingRequestID,
						"latency_ms":  handshakeLatencyMS,
						"timeout_sec": pingTimeout.Seconds(),
						"class":       errClass.Code,
					}))
					a.mu.Lock()
					tripped := a.commandBreaker.recordFailure(time.Now(), errText)
					openUntil := a.commandBreaker.openUntil
					lastError := a.commandBreaker.lastError
					var suppressedUntil time.Time
					var suppressionReason string
					if errClass.Persistent && errClass.SuppressFor > 0 {
						suppressedUntil = time.Now().Add(errClass.SuppressFor).UTC()
						suppressionReason = errClass.Code + ": " + compactSingleLine(errText, 160)
						a.commandSuppressedUntil = suppressedUntil
						a.commandSuppressionCause = suppressionReason
					}
					a.mu.Unlock()
					if tripped {
						events = append(events, telemetryEvent(a.agentID, "command", "trip_opened", lastError, openUntil.Format(time.RFC3339), map[string]any{
							"path":      "command",
							"stage":     "handshake",
							"threshold": maxInt(1, settings.adapterCircuitThreshold),
						}))
					}
					if !suppressedUntil.IsZero() {
						events = append(events, telemetryEvent(a.agentID, "command", "suppression_opened", suppressionReason, suppressedUntil.Format(time.RFC3339), map[string]any{
							"path":             "command",
							"class":            errClass.Code,
							"suppression_secs": int(errClass.SuppressFor.Seconds()),
						}))
					}
					attempts = append(attempts, "command:handshake("+compactSingleLine(errText, 120)+")")
					continue
				}
			}

			requestID := adapterRequestID(a.agentID, "ask")
			turnPhase := adapterDirective(prompt, "TRICHAT_TURN_PHASE")
			roleHint := adapterDirective(prompt, "TRICHAT_ROLE")
			roleObjective := adapterDirective(prompt, "TRICHAT_ROLE_OBJECTIVE")
			responseMode := inferAdapterResponseMode(prompt)
			timeout := minDuration(remaining, time.Duration(maxInt(1, settings.bridgeTimeoutSeconds))*time.Second)
			commandAttemptStarted := time.Now()
			requestPayload := map[string]any{
				"op":                     "ask",
				"protocol_version":       adapterProtocol,
				"request_id":             requestID,
				"agent_id":               a.agentID,
				"thread_id":              threadID,
				"prompt":                 prompt,
				"history":                history,
				"bootstrap_text":         bootstrapText,
				"peer_context":           peerContext,
				"workspace":              cfg.repoRoot,
				"timestamp":              time.Now().UTC().Format(time.RFC3339),
				"turn_phase":             turnPhase,
				"role_hint":              roleHint,
				"role_objective":         roleObjective,
				"response_mode":          responseMode,
				"collaboration_contract": "coordinate with other agents and avoid duplicate strategy",
			}
			envelope, err := callCommandAdapter(ctx, command, requestPayload, timeout)
			commandLatencyMS := time.Since(commandAttemptStarted).Milliseconds()
			retryAttempt := 0
			if err != nil {
				if isFanoutAbortError(err) || ctx.Err() != nil {
					attempts = append(attempts, "command:aborted(quorum-finalize)")
					break channelLoop
				}
				retryPayload := map[string]any{
					"op":                     "ask",
					"protocol_version":       adapterProtocol,
					"request_id":             requestID,
					"agent_id":               a.agentID,
					"thread_id":              threadID,
					"prompt":                 compactRetryPrompt(prompt),
					"history":                compactRetryHistory(history, 6),
					"bootstrap_text":         truncate(strings.TrimSpace(bootstrapText), 420),
					"peer_context":           truncate(compactSingleLine(peerContext, 420), 420),
					"workspace":              cfg.repoRoot,
					"timestamp":              time.Now().UTC().Format(time.RFC3339),
					"turn_phase":             turnPhase,
					"role_hint":              roleHint,
					"role_objective":         roleObjective,
					"response_mode":          responseMode,
					"retry_attempt":          1,
					"collaboration_contract": "coordinate with other agents and avoid duplicate strategy",
				}
				for retryAttempt < maxRetries && ctx.Err() == nil {
					errText := fmt.Sprintf("%T: %v", err, err)
					errClass := classifyCommandAdapterError(errText)
					if !errClass.Retryable || !time.Now().Add(minRetryBudget).Before(deadline) {
						break
					}
					retryAttempt += 1
					attempts = append(attempts, fmt.Sprintf("command:retry-%d(%s)", retryAttempt, errClass.Code))
					events = append(events, telemetryEvent(a.agentID, "command", "retry_scheduled", errText, "", map[string]any{
						"path":          "command",
						"request_id":    requestID,
						"attempt":       retryAttempt,
						"class":         errClass.Code,
						"compact_retry": true,
					}))
					retryTimeout := minDuration(deadline.Sub(time.Now()), timeout)
					if retryTimeout <= 0 {
						break
					}
					retryStart := time.Now()
					envelope, err = callCommandAdapter(ctx, command, retryPayload, retryTimeout)
					commandLatencyMS = time.Since(retryStart).Milliseconds()
					if err == nil {
						break
					}
					if isFanoutAbortError(err) || ctx.Err() != nil {
						break
					}
				}
			}
			if err != nil && (isFanoutAbortError(err) || ctx.Err() != nil) {
				attempts = append(attempts, "command:aborted(quorum-finalize)")
				break channelLoop
			}
			if err == nil {
				events = append(events, telemetryEvent(a.agentID, "command", "response_ok", "", "", map[string]any{
					"path":             "command",
					"request_id":       requestID,
					"latency_ms":       commandLatencyMS,
					"timeout_sec":      timeout.Seconds(),
					"protocol_version": envelope.ProtocolVersion,
					"retry_attempt":    retryAttempt,
				}))
				a.mu.Lock()
				recovered := a.commandBreaker.recordSuccess(time.Now())
				a.commandSuppressedUntil = time.Time{}
				a.commandSuppressionCause = ""
				turnCount := a.turnCount
				degraded := a.degradedTurns
				status := a.snapshotStateLocked(command != "", turnCount, degraded)
				a.mu.Unlock()
				if recovered {
					events = append(events, telemetryEvent(a.agentID, "command", "recovered", "", "", map[string]any{"path": "command"}))
				}
				content := envelope.Content
				meta := map[string]any{
					"adapter":          "command",
					"command":          command,
					"degraded":         false,
					"attempts":         attempts,
					"circuit":          status,
					"request_id":       envelope.RequestID,
					"protocol_version": envelope.ProtocolVersion,
					"bridge":           nullIfEmpty(envelope.Bridge),
					"bridge_meta":      envelope.Meta,
					"retry_attempt":    retryAttempt,
				}
				if len(attempts) > 0 {
					content = "[failover recovered via command after: " + strings.Join(attempts, "; ") + "]\n\n" + content
				}
				return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
			}

			errText := fmt.Sprintf("%T: %v", err, err)
			errClass := classifyCommandAdapterError(errText)
			events = append(events, telemetryEvent(a.agentID, "command", "response_error", errText, "", map[string]any{
				"path":        "command",
				"request_id":  requestID,
				"latency_ms":  commandLatencyMS,
				"timeout_sec": timeout.Seconds(),
				"class":       errClass.Code,
				"retry_count": retryAttempt,
			}))
			a.mu.Lock()
			tripped := a.commandBreaker.recordFailure(time.Now(), errText)
			openUntil := a.commandBreaker.openUntil
			lastError := a.commandBreaker.lastError
			var suppressedUntil time.Time
			var suppressionReason string
			if errClass.Persistent && errClass.SuppressFor > 0 {
				suppressedUntil = time.Now().Add(errClass.SuppressFor).UTC()
				suppressionReason = errClass.Code + ": " + compactSingleLine(errText, 160)
				a.commandSuppressedUntil = suppressedUntil
				a.commandSuppressionCause = suppressionReason
			}
			a.mu.Unlock()
			if tripped {
				events = append(events, telemetryEvent(a.agentID, "command", "trip_opened", lastError, openUntil.Format(time.RFC3339), map[string]any{"path": "command", "threshold": maxInt(1, settings.adapterCircuitThreshold)}))
			}
			if !suppressedUntil.IsZero() {
				events = append(events, telemetryEvent(a.agentID, "command", "suppression_opened", suppressionReason, suppressedUntil.Format(time.RFC3339), map[string]any{
					"path":             "command",
					"class":            errClass.Code,
					"suppression_secs": int(errClass.SuppressFor.Seconds()),
				}))
			}
			attempts = append(attempts, "command:failed("+compactSingleLine(errText, 120)+")")
			continue
		}

		a.mu.Lock()
		open := a.modelBreaker.isOpen(now)
		remainingOpen := a.modelBreaker.remaining(now)
		modelSuppressedRemaining := suppressionRemaining(a.modelSuppressedUntil, now)
		modelSuppressionCause := a.modelSuppressionCause
		if modelSuppressedRemaining <= 0 && !a.modelSuppressedUntil.IsZero() {
			a.modelSuppressedUntil = time.Time{}
			a.modelSuppressionCause = ""
		}
		a.mu.Unlock()
		if open {
			attempts = append(attempts, fmt.Sprintf("ollama:circuit-open(%.1fs)", remainingOpen.Seconds()))
			continue
		}
		if modelSuppressedRemaining > 0 {
			reason := compactSingleLine(modelSuppressionCause, 90)
			attempts = append(attempts, fmt.Sprintf("ollama:suppressed(%.1fs:%s)", modelSuppressedRemaining.Seconds(), reason))
			events = append(events, telemetryEvent(a.agentID, "model", "suppressed_skip", "", "", map[string]any{
				"path":              "ollama",
				"suppressed_reason": reason,
				"remaining_sec":     modelSuppressedRemaining.Seconds(),
			}))
			continue
		}

		timeout := minDuration(remaining, time.Duration(maxInt(1, settings.modelTimeoutSeconds))*time.Second)
		modelAttemptStarted := time.Now()
		content, err := callOllama(ctx, ollamaAPI, settings.model, messages, timeout)
		modelLatencyMS := time.Since(modelAttemptStarted).Milliseconds()
		retryAttempt := 0
		if err != nil {
			if isFanoutAbortError(err) || ctx.Err() != nil {
				attempts = append(attempts, "ollama:aborted(quorum-finalize)")
				break channelLoop
			}
			retryMessages := buildOllamaMessages(
				a.systemPrompt,
				compactRetryPrompt(prompt),
				compactRetryHistory(history, 6),
				truncate(strings.TrimSpace(bootstrapText), 420),
				truncate(compactSingleLine(peerContext, 420), 420),
			)
			for retryAttempt < maxRetries && ctx.Err() == nil {
				errText := fmt.Sprintf("%T: %v", err, err)
				errClass := classifyModelAdapterError(errText)
				if !errClass.Retryable || !time.Now().Add(minRetryBudget).Before(deadline) {
					break
				}
				retryAttempt += 1
				attempts = append(attempts, fmt.Sprintf("ollama:retry-%d(%s)", retryAttempt, errClass.Code))
				events = append(events, telemetryEvent(a.agentID, "model", "retry_scheduled", errText, "", map[string]any{
					"path":          "ollama",
					"model":         settings.model,
					"attempt":       retryAttempt,
					"class":         errClass.Code,
					"compact_retry": true,
				}))
				retryTimeout := minDuration(deadline.Sub(time.Now()), timeout)
				if retryTimeout <= 0 {
					break
				}
				retryStart := time.Now()
				content, err = callOllama(ctx, ollamaAPI, settings.model, retryMessages, retryTimeout)
				modelLatencyMS = time.Since(retryStart).Milliseconds()
				if err == nil {
					break
				}
				if isFanoutAbortError(err) || ctx.Err() != nil {
					break
				}
			}
		}
		if err != nil && (isFanoutAbortError(err) || ctx.Err() != nil) {
			attempts = append(attempts, "ollama:aborted(quorum-finalize)")
			break channelLoop
		}
		if err == nil {
			events = append(events, telemetryEvent(a.agentID, "model", "response_ok", "", "", map[string]any{
				"path":          "ollama",
				"model":         settings.model,
				"latency_ms":    modelLatencyMS,
				"timeout_sec":   timeout.Seconds(),
				"retry_attempt": retryAttempt,
			}))
			a.mu.Lock()
			recovered := a.modelBreaker.recordSuccess(time.Now())
			a.modelSuppressedUntil = time.Time{}
			a.modelSuppressionCause = ""
			turnCount := a.turnCount
			degraded := a.degradedTurns
			status := a.snapshotStateLocked(command != "", turnCount, degraded)
			a.mu.Unlock()
			if recovered {
				events = append(events, telemetryEvent(a.agentID, "model", "recovered", "", "", map[string]any{"path": "ollama"}))
			}
			meta := map[string]any{
				"adapter":       "ollama",
				"model":         settings.model,
				"degraded":      false,
				"attempts":      attempts,
				"circuit":       status,
				"retry_attempt": retryAttempt,
			}
			if len(attempts) > 0 {
				content = "[failover recovered via ollama after: " + strings.Join(attempts, "; ") + "]\n\n" + content
			}
			return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
		}

		errText := fmt.Sprintf("%T: %v", err, err)
		errClass := classifyModelAdapterError(errText)
		events = append(events, telemetryEvent(a.agentID, "model", "response_error", errText, "", map[string]any{
			"path":        "ollama",
			"model":       settings.model,
			"latency_ms":  modelLatencyMS,
			"timeout_sec": timeout.Seconds(),
			"class":       errClass.Code,
			"retry_count": retryAttempt,
		}))
		a.mu.Lock()
		tripped := a.modelBreaker.recordFailure(time.Now(), errText)
		openUntil := a.modelBreaker.openUntil
		lastError := a.modelBreaker.lastError
		var suppressedUntil time.Time
		var suppressionReason string
		if errClass.Persistent && errClass.SuppressFor > 0 {
			suppressedUntil = time.Now().Add(errClass.SuppressFor).UTC()
			suppressionReason = errClass.Code + ": " + compactSingleLine(errText, 160)
			a.modelSuppressedUntil = suppressedUntil
			a.modelSuppressionCause = suppressionReason
		}
		a.mu.Unlock()
		if tripped {
			events = append(events, telemetryEvent(a.agentID, "model", "trip_opened", lastError, openUntil.Format(time.RFC3339), map[string]any{"path": "ollama", "threshold": maxInt(1, settings.adapterCircuitThreshold)}))
		}
		if !suppressedUntil.IsZero() {
			events = append(events, telemetryEvent(a.agentID, "model", "suppression_opened", suppressionReason, suppressedUntil.Format(time.RFC3339), map[string]any{
				"path":             "ollama",
				"class":            errClass.Code,
				"suppression_secs": int(errClass.SuppressFor.Seconds()),
			}))
		}
		attempts = append(attempts, "ollama:failed("+compactSingleLine(errText, 120)+")")
	}

	if ctx.Err() != nil {
		reason := "quorum-finalize"
		if len(attempts) > 0 {
			reason = compactSingleLine(attempts[len(attempts)-1], 160)
		}
		events = append(events, telemetryEvent(a.agentID, "command", "fanout_aborted", "", "", map[string]any{
			"reason": reason,
		}))
		return agentResponse{
			agentID: a.agentID,
			content: fmt.Sprintf("[fanout-aborted] %s skipped after quorum finalize.", a.agentID),
			adapterMeta: map[string]any{
				"adapter":  "aborted",
				"degraded": true,
				"reason":   reason,
				"attempts": attempts,
			},
			telemetryEvents: events,
		}
	}

	a.mu.Lock()
	a.degradedTurns += 1
	turnCount := a.turnCount
	degraded := a.degradedTurns
	status := a.snapshotStateLocked(command != "", turnCount, degraded)
	a.mu.Unlock()

	reason := "no-channel-attempted"
	if len(attempts) > 0 {
		start := len(attempts) - 3
		if start < 0 {
			start = 0
		}
		reason = strings.Join(attempts[start:], "; ")
	}
	events = append(events, telemetryEvent(a.agentID, "model", "degraded_turn", "", "", map[string]any{"reason": reason}))
	content := fmt.Sprintf("[degraded-mode] %s unavailable for live inference this turn. Reason: %s. Continuing without blocking the tri-chat turn.", a.agentID, reason)
	meta := map[string]any{
		"adapter":  "degraded",
		"model":    settings.model,
		"degraded": true,
		"reason":   reason,
		"attempts": attempts,
		"circuit":  status,
	}
	return agentResponse{agentID: a.agentID, content: content, adapterMeta: meta, telemetryEvents: events}
}

func (a *agentRuntime) snapshotStateLocked(commandEnabled bool, turnCount, degraded int) map[string]any {
	now := time.Now()
	commandSuppressedRemaining := suppressionRemaining(a.commandSuppressedUntil, now)
	modelSuppressedRemaining := suppressionRemaining(a.modelSuppressedUntil, now)
	return map[string]any{
		"command": map[string]any{
			"open":                   a.commandBreaker.isOpen(now),
			"remaining_seconds":      maxFloat(0, a.commandBreaker.remaining(now).Seconds()),
			"open_until_epoch":       epochOrNil(a.commandBreaker.openUntil),
			"last_opened_at_epoch":   epochOrNil(a.commandBreaker.lastOpenedAt),
			"failure_count":          a.commandBreaker.failureCount,
			"last_error":             nullIfEmpty(a.commandBreaker.lastError),
			"last_result":            nullIfEmpty(a.commandBreaker.lastResult),
			"trip_count":             a.commandBreaker.tripCount,
			"success_count":          a.commandBreaker.successCount,
			"threshold":              a.commandBreaker.threshold,
			"recovery_seconds":       int(a.commandBreaker.recovery.Seconds()),
			"suppressed":             commandSuppressedRemaining > 0,
			"suppressed_seconds":     maxFloat(0, commandSuppressedRemaining.Seconds()),
			"suppressed_until_epoch": epochOrNil(a.commandSuppressedUntil),
			"suppression_reason":     nullIfEmpty(a.commandSuppressionCause),
		},
		"model": map[string]any{
			"open":                   a.modelBreaker.isOpen(now),
			"remaining_seconds":      maxFloat(0, a.modelBreaker.remaining(now).Seconds()),
			"open_until_epoch":       epochOrNil(a.modelBreaker.openUntil),
			"last_opened_at_epoch":   epochOrNil(a.modelBreaker.lastOpenedAt),
			"failure_count":          a.modelBreaker.failureCount,
			"last_error":             nullIfEmpty(a.modelBreaker.lastError),
			"last_result":            nullIfEmpty(a.modelBreaker.lastResult),
			"trip_count":             a.modelBreaker.tripCount,
			"success_count":          a.modelBreaker.successCount,
			"threshold":              a.modelBreaker.threshold,
			"recovery_seconds":       int(a.modelBreaker.recovery.Seconds()),
			"suppressed":             modelSuppressedRemaining > 0,
			"suppressed_seconds":     maxFloat(0, modelSuppressedRemaining.Seconds()),
			"suppressed_until_epoch": epochOrNil(a.modelSuppressedUntil),
			"suppression_reason":     nullIfEmpty(a.modelSuppressionCause),
		},
		"turn_count":          turnCount,
		"degraded_turn_count": degraded,
		"command_enabled":     commandEnabled,
	}
}

func telemetryEvent(agentID, channel, eventType, errorText, openUntil string, details map[string]any) map[string]any {
	payload := map[string]any{
		"agent_id":   agentID,
		"channel":    channel,
		"event_type": eventType,
		"details":    details,
	}
	if strings.TrimSpace(errorText) != "" {
		payload["error_text"] = compactSingleLine(errorText, 240)
	}
	if strings.TrimSpace(openUntil) != "" {
		payload["open_until"] = openUntil
	}
	return payload
}

func buildOllamaMessages(
	systemPrompt string,
	prompt string,
	history []triChatMessage,
	bootstrap string,
	peerContext string,
) []map[string]string {
	historyLines := make([]string, 0, 30)
	start := 0
	if len(history) > historyWindowSize {
		start = len(history) - historyWindowSize
	}
	for _, msg := range history[start:] {
		historyLines = append(historyLines, fmt.Sprintf("[%s/%s] %s", msg.AgentID, msg.Role, compactSingleLine(msg.Content, historyLineChars)))
	}
	historyBlock := "(no prior messages)"
	if len(historyLines) > 0 {
		historyBlock = strings.Join(historyLines, "\n")
	}
	parts := []string{
		"TriChat user request:",
		strings.TrimSpace(prompt),
		"",
		"Recent thread history:",
		historyBlock,
		"",
		"Output contract:",
		"- reply in plain text with a concise answer",
		"- keep under 6 lines unless the user asks for deep detail",
		"- do not include boilerplate sections like next actions or thread recap",
	}
	if strings.TrimSpace(peerContext) != "" {
		parts = append(parts, "", "Peer context:", truncate(compactSingleLine(peerContext, 1500), 1500))
	}
	if strings.TrimSpace(bootstrap) != "" {
		parts = append(parts, "", "Imprint bootstrap context:", truncate(bootstrap, bootstrapMaxChars))
	}
	user := strings.TrimSpace(strings.Join(parts, "\n"))
	return []map[string]string{
		{"role": "system", "content": systemPrompt},
		{"role": "user", "content": user},
	}
}

func compactRetryHistory(history []triChatMessage, limit int) []triChatMessage {
	if limit <= 0 || len(history) <= limit {
		out := make([]triChatMessage, len(history))
		copy(out, history)
		return out
	}
	start := len(history) - limit
	out := make([]triChatMessage, len(history[start:]))
	copy(out, history[start:])
	return out
}

func compactRetryPrompt(prompt string) string {
	return truncate(strings.TrimSpace(prompt), 1800)
}

func adapterHandshakeTTL() time.Duration {
	seconds := clampInt(envOrInt("TRICHAT_ADAPTER_HANDSHAKE_TTL_SECONDS", 120), 10, 900)
	return time.Duration(seconds) * time.Second
}

func adapterRequestID(agentID string, operation string) string {
	safeAgent := safeToolPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(agentID)), "-")
	safeAgent = strings.Trim(safeAgent, "-")
	if safeAgent == "" {
		safeAgent = "agent"
	}
	safeOp := safeToolPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(operation)), "-")
	safeOp = strings.Trim(safeOp, "-")
	if safeOp == "" {
		safeOp = "ask"
	}
	return fmt.Sprintf("trichat-%s-%s-%d", safeAgent, safeOp, time.Now().UnixNano())
}

func asTrimmedString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func adapterDirective(prompt string, key string) string {
	lines := strings.Split(strings.ReplaceAll(prompt, "\r", ""), "\n")
	prefix := strings.ToUpper(strings.TrimSpace(key)) + "="
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToUpper(trimmed), prefix) {
			continue
		}
		value := strings.TrimSpace(trimmed[len(prefix):])
		if value != "" {
			return value
		}
	}
	return ""
}

func inferAdapterResponseMode(prompt string) string {
	mode := strings.ToLower(strings.TrimSpace(adapterDirective(prompt, "TRICHAT_RESPONSE_MODE")))
	if mode == "json" {
		return "json"
	}
	normalized := strings.ToLower(prompt)
	if strings.Contains(normalized, "return only json") || strings.Contains(normalized, "valid json object") {
		return "json"
	}
	return "plain"
}

func isFanoutAbortError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	normalized := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(normalized, "bridge command canceled") ||
		strings.Contains(normalized, "ollama request canceled") ||
		strings.Contains(normalized, "quorum-finalize")
}

func runCommandAdapterRaw(ctx context.Context, command string, payload map[string]any, timeout time.Duration) (string, string, error) {
	parts := splitCommand(command)
	if len(parts) == 0 {
		return "", "", errors.New("empty command adapter")
	}
	baseCtx := ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(baseCtx, maxDuration(time.Second, timeout))
	defer cancel()
	cmd := exec.CommandContext(callCtx, parts[0], parts[1:]...)
	input, _ := json.Marshal(payload)
	cmd.Stdin = bytes.NewReader(input)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(callCtx.Err(), context.Canceled) {
			return "", strings.TrimSpace(stderr.String()), fmt.Errorf("bridge command canceled")
		}
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			return "", strings.TrimSpace(stderr.String()), fmt.Errorf("bridge timeout")
		}
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return "", errText, fmt.Errorf("bridge command failed: %s", errText)
	}
	output := strings.TrimSpace(stdout.String())
	if output == "" {
		return "", strings.TrimSpace(stderr.String()), errors.New("bridge command returned empty stdout")
	}
	return output, strings.TrimSpace(stderr.String()), nil
}

func parseJSONLineFallback[T any](output string) (T, bool, error) {
	var zero T
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return zero, false, errors.New("empty stdout")
	}
	var parsed T
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		return parsed, false, nil
	}
	lines := strings.Split(trimmed, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var candidate T
		if err := json.Unmarshal([]byte(line), &candidate); err == nil {
			return candidate, true, nil
		}
		start := strings.Index(line, "{")
		end := strings.LastIndex(line, "}")
		if start >= 0 && end > start {
			jsonSlice := strings.TrimSpace(line[start : end+1])
			if err := json.Unmarshal([]byte(jsonSlice), &candidate); err == nil {
				return candidate, true, nil
			}
		}
	}
	return zero, false, fmt.Errorf("invalid JSON envelope")
}

func callCommandAdapter(ctx context.Context, command string, payload map[string]any, timeout time.Duration) (commandAdapterResponse, error) {
	expectedRequestID := asTrimmedString(payload["request_id"])
	expectedAgentID := asTrimmedString(payload["agent_id"])
	if expectedRequestID == "" {
		return commandAdapterResponse{}, errors.New("adapter payload missing request_id")
	}
	if expectedAgentID == "" {
		return commandAdapterResponse{}, errors.New("adapter payload missing agent_id")
	}
	output, stderr, err := runCommandAdapterRaw(ctx, command, payload, timeout)
	if err != nil {
		return commandAdapterResponse{}, err
	}
	envelope, parsedWithFallback, decodeErr := parseJSONLineFallback[commandAdapterResponse](output)
	if decodeErr != nil {
		return commandAdapterResponse{}, fmt.Errorf(
			"bridge protocol violation: invalid JSON envelope: %v stdout=%s stderr=%s",
			decodeErr,
			compactSingleLine(output, 220),
			compactSingleLine(stderr, 180),
		)
	}
	if strings.TrimSpace(envelope.Kind) != adapterResponseKind {
		return commandAdapterResponse{}, fmt.Errorf("bridge protocol violation: expected kind=%s got=%s", adapterResponseKind, strings.TrimSpace(envelope.Kind))
	}
	if strings.TrimSpace(envelope.ProtocolVersion) != adapterProtocol {
		return commandAdapterResponse{}, fmt.Errorf(
			"bridge protocol violation: expected protocol_version=%s got=%s",
			adapterProtocol,
			strings.TrimSpace(envelope.ProtocolVersion),
		)
	}
	if strings.TrimSpace(envelope.RequestID) != expectedRequestID {
		return commandAdapterResponse{}, fmt.Errorf(
			"bridge protocol violation: request_id mismatch expected=%s got=%s",
			expectedRequestID,
			strings.TrimSpace(envelope.RequestID),
		)
	}
	if strings.TrimSpace(envelope.AgentID) != expectedAgentID {
		return commandAdapterResponse{}, fmt.Errorf(
			"bridge protocol violation: agent_id mismatch expected=%s got=%s",
			expectedAgentID,
			strings.TrimSpace(envelope.AgentID),
		)
	}
	envelope.Content = strings.TrimSpace(envelope.Content)
	if envelope.Content == "" {
		return commandAdapterResponse{}, errors.New("bridge protocol violation: empty content in adapter response")
	}
	if envelope.Meta == nil {
		envelope.Meta = map[string]any{}
	}
	if parsedWithFallback {
		envelope.Meta["stdout_fallback_parsed"] = true
	}
	return envelope, nil
}

func pingCommandAdapter(ctx context.Context, command string, payload map[string]any, timeout time.Duration) error {
	expectedRequestID := asTrimmedString(payload["request_id"])
	expectedAgentID := asTrimmedString(payload["agent_id"])
	output, stderr, err := runCommandAdapterRaw(ctx, command, payload, timeout)
	if err != nil {
		return err
	}
	pong, _, decodeErr := parseJSONLineFallback[commandAdapterPong](output)
	if decodeErr != nil {
		return fmt.Errorf(
			"adapter handshake invalid JSON: %v stdout=%s stderr=%s",
			decodeErr,
			compactSingleLine(output, 220),
			compactSingleLine(stderr, 180),
		)
	}
	if strings.TrimSpace(pong.Kind) != adapterPongKind {
		return fmt.Errorf("adapter handshake invalid kind: expected=%s got=%s", adapterPongKind, strings.TrimSpace(pong.Kind))
	}
	if strings.TrimSpace(pong.ProtocolVersion) != adapterProtocol {
		return fmt.Errorf(
			"adapter handshake protocol mismatch: expected=%s got=%s",
			adapterProtocol,
			strings.TrimSpace(pong.ProtocolVersion),
		)
	}
	if strings.TrimSpace(pong.RequestID) != expectedRequestID {
		return fmt.Errorf(
			"adapter handshake request_id mismatch: expected=%s got=%s",
			expectedRequestID,
			strings.TrimSpace(pong.RequestID),
		)
	}
	if strings.TrimSpace(pong.AgentID) != expectedAgentID {
		return fmt.Errorf(
			"adapter handshake agent_id mismatch: expected=%s got=%s",
			expectedAgentID,
			strings.TrimSpace(pong.AgentID),
		)
	}
	return nil
}

func callOllama(ctx context.Context, apiBase, model string, messages []map[string]string, timeout time.Duration) (string, error) {
	baseCtx := ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(baseCtx, maxDuration(time.Second, timeout))
	defer cancel()
	endpoint := strings.TrimRight(strings.TrimSpace(apiBase), "/") + "/api/chat"
	body := map[string]any{
		"model":    model,
		"stream":   false,
		"messages": messages,
		"options":  map[string]any{"temperature": 0.2},
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(callCtx.Err(), context.Canceled) {
			return "", fmt.Errorf("ollama request canceled")
		}
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("ollama request failed on /api/chat: context deadline exceeded")
		}
		return "", fmt.Errorf("ollama request failed on /api/chat: %w", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("ollama http %d: %s", resp.StatusCode, compactSingleLine(string(payload), 240))
	}
	var parsed struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", fmt.Errorf("ollama returned non-json payload")
	}
	content := strings.TrimSpace(parsed.Message.Content)
	if content == "" {
		return "", errors.New("ollama returned empty response content")
	}
	return content, nil
}

type adaptiveTimeoutTuning struct {
	Applied             bool
	Reason              string
	BaseModelTimeout    int
	BaseBridgeTimeout   int
	BaseFailoverTimeout int
	TunedModelTimeout   int
	TunedBridgeTimeout  int
	TunedFailover       int
	P95LatencyMS        float64
	SampleCount         int
	AdapterErrorRate    float64
	TurnFailureRate     float64
}

func deriveAdaptiveTimeouts(settings runtimeSettings, slo triChatSloStatusResp) (runtimeSettings, adaptiveTimeoutTuning) {
	result := settings
	tuning := adaptiveTimeoutTuning{
		BaseModelTimeout:    settings.modelTimeoutSeconds,
		BaseBridgeTimeout:   settings.bridgeTimeoutSeconds,
		BaseFailoverTimeout: settings.adapterFailoverTimeoutSecond,
		TunedModelTimeout:   settings.modelTimeoutSeconds,
		TunedBridgeTimeout:  settings.bridgeTimeoutSeconds,
		TunedFailover:       settings.adapterFailoverTimeoutSecond,
		Reason:              "disabled",
	}

	if !settings.adaptiveTimeoutsEnabled {
		return result, tuning
	}
	if slo.Metrics.Adapter.P95LatencyMS == nil {
		tuning.Reason = "slo-p95-unavailable"
		return result, tuning
	}
	if slo.Metrics.Adapter.LatencySamples < maxInt(1, settings.adaptiveTimeoutMinSamples) {
		tuning.Reason = "insufficient-samples"
		return result, tuning
	}

	p95 := maxFloat(*slo.Metrics.Adapter.P95LatencyMS, 1)
	adapterErrorRate := maxFloat(0, slo.Metrics.Adapter.ErrorRate)
	turnFailureRate := maxFloat(0, slo.Metrics.Turns.FailureRate)

	modelTarget := int(math.Ceil((p95*2.3 + 850) / 1000))
	bridgeTarget := int(math.Ceil((p95*2.9 + 1300) / 1000))

	if adapterErrorRate >= 0.10 || turnFailureRate >= 0.12 {
		modelTarget += 4
		bridgeTarget += 6
	} else if adapterErrorRate >= 0.05 || turnFailureRate >= 0.07 {
		modelTarget += 2
		bridgeTarget += 3
	} else if adapterErrorRate <= 0.015 && turnFailureRate <= 0.02 {
		modelTarget -= 1
		bridgeTarget -= 1
	}

	modelTarget = clampInt(modelTarget, 4, 120)
	bridgeTarget = clampInt(bridgeTarget, 6, 120)
	if bridgeTarget < modelTarget+2 {
		bridgeTarget = clampInt(modelTarget+2, 6, 120)
	}

	step := maxInt(1, settings.adaptiveTimeoutMaxStepSecond)
	modelTarget = moveTowardInt(settings.modelTimeoutSeconds, modelTarget, step)
	bridgeTarget = moveTowardInt(settings.bridgeTimeoutSeconds, bridgeTarget, step)
	if bridgeTarget < modelTarget+2 {
		bridgeTarget = clampInt(modelTarget+2, 6, 120)
	}

	failoverTarget := settings.adapterFailoverTimeoutSecond
	minFailover := clampInt(maxInt(modelTarget+8, bridgeTarget+5), 1, 120)
	if failoverTarget < minFailover {
		failoverTarget = minFailover
	}

	result.modelTimeoutSeconds = modelTarget
	result.bridgeTimeoutSeconds = bridgeTarget
	result.adapterFailoverTimeoutSecond = failoverTarget

	tuning.P95LatencyMS = p95
	tuning.SampleCount = slo.Metrics.Adapter.LatencySamples
	tuning.AdapterErrorRate = adapterErrorRate
	tuning.TurnFailureRate = turnFailureRate
	tuning.TunedModelTimeout = modelTarget
	tuning.TunedBridgeTimeout = bridgeTarget
	tuning.TunedFailover = failoverTarget
	tuning.Applied = modelTarget != settings.modelTimeoutSeconds ||
		bridgeTarget != settings.bridgeTimeoutSeconds ||
		failoverTarget != settings.adapterFailoverTimeoutSecond
	if tuning.Applied {
		tuning.Reason = "applied"
	} else {
		tuning.Reason = "steady"
	}
	return result, tuning
}

func moveTowardInt(current int, target int, step int) int {
	if step <= 0 {
		return target
	}
	if target > current {
		return minInt(current+step, target)
	}
	if target < current {
		return maxInt(current-step, target)
	}
	return current
}

func adaptiveTimeoutSummary(tuning adaptiveTimeoutTuning) string {
	if !tuning.Applied {
		return ""
	}
	return fmt.Sprintf(
		"adaptive=%d/%d/%d->%d/%d/%d p95=%.0fms n=%d err=%.1f%% turn_fail=%.1f%%",
		tuning.BaseModelTimeout,
		tuning.BaseBridgeTimeout,
		tuning.BaseFailoverTimeout,
		tuning.TunedModelTimeout,
		tuning.TunedBridgeTimeout,
		tuning.TunedFailover,
		tuning.P95LatencyMS,
		tuning.SampleCount,
		tuning.AdapterErrorRate*100,
		tuning.TurnFailureRate*100,
	)
}

func adaptiveDecisionLabel(tuning adaptiveTimeoutTuning) string {
	if tuning.Applied {
		return "applied"
	}
	return "steady"
}

func buildRuntimeCoordinationContext(settings runtimeSettings, tuning adaptiveTimeoutTuning) string {
	p95Text := "n/a"
	if tuning.P95LatencyMS > 0 {
		p95Text = fmt.Sprintf("%.0fms", tuning.P95LatencyMS)
	}
	return fmt.Sprintf(
		"runtime-sync: adaptive=%s decision=%s model_timeout=%ds bridge_timeout=%ds failover_timeout=%ds p95=%s samples=%d err=%.1f%% turn_fail=%.1f%% gate=%s interop_rounds=%d council_max_rounds=%d council_budget=%ds council_min_delta=%.2f council_strip=%s",
		onOff(settings.adaptiveTimeoutsEnabled),
		adaptiveDecisionLabel(tuning),
		settings.modelTimeoutSeconds,
		settings.bridgeTimeoutSeconds,
		settings.adapterFailoverTimeoutSecond,
		p95Text,
		maxInt(0, tuning.SampleCount),
		tuning.AdapterErrorRate*100,
		tuning.TurnFailureRate*100,
		settings.executeGateMode,
		settings.interopRounds,
		settings.councilConvergenceMaxRounds,
		settings.councilLatencyBudgetSecond,
		settings.councilMinNoveltyDelta,
		settings.councilStripMode,
	)
}

func mergeCoordinationContext(runtimeContext string, peerContext string) string {
	runtimeTrimmed := strings.TrimSpace(runtimeContext)
	peerTrimmed := strings.TrimSpace(peerContext)
	if runtimeTrimmed == "" {
		return peerTrimmed
	}
	if peerTrimmed == "" {
		return runtimeTrimmed
	}
	return runtimeTrimmed + "\n" + peerTrimmed
}

type tabID int

const (
	tabChat tabID = iota
	tabReliability
	tabSettings
	tabHelp
)

type model struct {
	cfg      appConfig
	settings runtimeSettings
	caller   mcpCaller
	mutation *mutationFactory
	orch     *orchestrator

	threadID    string
	threadTitle string
	messages    []triChatMessage
	busEvents   []triChatBusEvent
	reliability reliabilitySnapshot

	ready                bool
	startupErr           error
	statusLine           string
	logs                 []string
	lastAdaptiveDecision string
	lastAdaptiveReason   string
	lastAdaptiveP95MS    float64
	lastAdaptiveSamples  int
	lastAdaptiveAt       time.Time
	activeTab            tabID
	settingsIndex        int
	launcherActive       bool
	launcherIndex        int
	launcherItems        []string
	launcherPulse        int
	inflight             bool
	refreshing           bool
	lastRefresh          time.Time
	quitConfirm          bool
	busSocketPath        string
	busLiveConn          bool
	busLiveError         string
	busLastSeq           int
	busListening         bool
	busInbound           chan tea.Msg
	busSeenEventID       map[string]struct{}

	width  int
	height int

	input    textinput.Model
	timeline viewport.Model
	sidebar  viewport.Model
	spinner  spinner.Model

	theme uiTheme
}

type initDoneMsg struct {
	threadID    string
	threadTitle string
	bootstrap   string
	states      []adapterState
	err         error
}

type refreshDoneMsg struct {
	messages    []triChatMessage
	reliability reliabilitySnapshot
	err         error
}

type actionDoneMsg struct {
	status            string
	err               error
	threadID          string
	threadTitle       string
	refresh           bool
	routeCommand      string
	executionMode     string
	verifyStatus      string
	dispatchFailures  int
	autoSkipped       bool
	gatePassed        bool
	gateReasons       []string
	adaptiveEvaluated bool
	adaptiveApplied   bool
	modelTimeout      int
	bridgeTimeout     int
	failoverTimeout   int
	adaptiveReason    string
	adaptiveP95MS     float64
	adaptiveSamples   int
}

type tickMsg time.Time

type busInitMsg struct {
	status triChatBusStatusResp
	events []triChatBusEvent
	err    error
}

type busTailMsg struct {
	threadID string
	events   []triChatBusEvent
	err      error
}

type busLiveStatusMsg struct {
	connected bool
	socket    string
	info      string
}

type busLiveEventMsg struct {
	event triChatBusEvent
}

type uiTheme struct {
	root               lipgloss.Style
	header             lipgloss.Style
	tabActive          lipgloss.Style
	tabInactive        lipgloss.Style
	panel              lipgloss.Style
	panelTitle         lipgloss.Style
	footer             lipgloss.Style
	status             lipgloss.Style
	errorStatus        lipgloss.Style
	inputPanel         lipgloss.Style
	chatAgent          map[string]lipgloss.Style
	helpText           lipgloss.Style
	settingKey         lipgloss.Style
	settingValue       lipgloss.Style
	settingPick        lipgloss.Style
	launcherFrame      lipgloss.Style
	launcherFrameAlt   lipgloss.Style
	launcherTitle      lipgloss.Style
	launcherTitlePulse lipgloss.Style
	launcherAccent     lipgloss.Style
	launcherOption     lipgloss.Style
	launcherSelect     lipgloss.Style
	launcherBoot       lipgloss.Style
	launcherReady      lipgloss.Style
	launcherMuted      lipgloss.Style
	launcherScanlineA  lipgloss.Style
	launcherScanlineB  lipgloss.Style
}

func newTheme() uiTheme {
	pink := lipgloss.Color("#ff71ce")
	blue := lipgloss.Color("#01cdfe")
	mint := lipgloss.Color("#05ffa1")
	bg := lipgloss.Color("#120924")
	panelBg := lipgloss.Color("#1b0f35")
	text := lipgloss.Color("#f3f3ff")
	muted := lipgloss.Color("#9ca3d8")

	return uiTheme{
		root: lipgloss.NewStyle().
			Background(bg).
			Foreground(text).
			Padding(0, 1),
		header: lipgloss.NewStyle().
			Background(panelBg).
			Foreground(text).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(blue).
			Padding(0, 1),
		tabActive: lipgloss.NewStyle().
			Background(pink).
			Foreground(lipgloss.Color("#22062f")).
			Bold(true).
			Padding(0, 1),
		tabInactive: lipgloss.NewStyle().
			Background(lipgloss.Color("#2a184a")).
			Foreground(muted).
			Padding(0, 1),
		panel: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(blue).
			Padding(0, 1),
		panelTitle: lipgloss.NewStyle().
			Foreground(mint).
			Bold(true),
		footer: lipgloss.NewStyle().
			Background(panelBg).
			Foreground(muted).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(pink).
			Padding(0, 1),
		status:      lipgloss.NewStyle().Foreground(blue).Bold(true),
		errorStatus: lipgloss.NewStyle().Foreground(pink).Bold(true),
		inputPanel: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(mint).
			Padding(0, 1),
		helpText:     lipgloss.NewStyle().Foreground(muted),
		settingKey:   lipgloss.NewStyle().Foreground(blue),
		settingValue: lipgloss.NewStyle().Foreground(text),
		settingPick:  lipgloss.NewStyle().Foreground(pink).Bold(true),
		launcherFrame: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.ThickBorder()).
			BorderForeground(pink).
			Padding(1, 2),
		launcherFrameAlt: lipgloss.NewStyle().
			Background(panelBg).
			BorderStyle(lipgloss.ThickBorder()).
			BorderForeground(blue).
			Padding(1, 2),
		launcherTitle: lipgloss.NewStyle().
			Foreground(blue).
			Bold(true),
		launcherTitlePulse: lipgloss.NewStyle().
			Foreground(pink).
			Bold(true),
		launcherAccent: lipgloss.NewStyle().
			Foreground(mint).
			Bold(true),
		launcherOption: lipgloss.NewStyle().
			Foreground(text),
		launcherSelect: lipgloss.NewStyle().
			Foreground(lipgloss.Color("#22062f")).
			Background(pink).
			Bold(true).
			Padding(0, 1),
		launcherBoot:  lipgloss.NewStyle().Foreground(lipgloss.Color("#ffd166")).Bold(true),
		launcherReady: lipgloss.NewStyle().Foreground(mint).Bold(true),
		launcherMuted: lipgloss.NewStyle().Foreground(muted),
		launcherScanlineA: lipgloss.NewStyle().
			Background(lipgloss.Color("#150b2d")),
		launcherScanlineB: lipgloss.NewStyle().
			Background(lipgloss.Color("#311a63")),
		chatAgent: map[string]lipgloss.Style{
			"user":          lipgloss.NewStyle().Foreground(mint).Bold(true),
			"codex":         lipgloss.NewStyle().Foreground(pink).Bold(true),
			"cursor":        lipgloss.NewStyle().Foreground(blue).Bold(true),
			"local-imprint": lipgloss.NewStyle().Foreground(lipgloss.Color("#ffd166")).Bold(true),
			"router":        lipgloss.NewStyle().Foreground(muted).Bold(true),
			"system":        lipgloss.NewStyle().Foreground(muted).Bold(true),
		},
	}
}

func newModel(cfg appConfig) model {
	input := textinput.New()
	input.Prompt = "❯ "
	input.CharLimit = 4000
	input.Placeholder = "Type normally to fan out to codex/cursor/local-imprint. Slash commands are optional."
	if cfg.launcher {
		input.Blur()
	} else {
		input.Focus()
	}

	sp := spinner.New()
	sp.Spinner = spinner.Points
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("#05ffa1"))

	settings := runtimeSettings{
		transport:                    cfg.transport,
		model:                        cfg.model,
		fanoutTarget:                 "all",
		autoExecuteAfterDecision:     cfg.autoExecuteAfterDecision,
		autoExecuteCycleCount:        cfg.autoExecuteCycleCount,
		autoExecuteBreakerFailures:   cfg.autoExecuteBreakerFailures,
		executeGateMode:              cfg.executeGateMode,
		executeBackend:               cfg.executeBackend,
		tmuxSessionName:              cfg.tmuxSessionName,
		tmuxWorkerCount:              cfg.tmuxWorkerCount,
		tmuxMaxQueuePerWorker:        cfg.tmuxMaxQueuePerWorker,
		tmuxSyncAfterDispatch:        cfg.tmuxSyncAfterDispatch,
		tmuxLockLeaseSeconds:         cfg.tmuxLockLeaseSeconds,
		consensusMinAgents:           cfg.consensusMinAgents,
		interopRounds:                cfg.interopRounds,
		autoRefresh:                  true,
		pollInterval:                 cfg.pollInterval,
		modelTimeoutSeconds:          cfg.modelTimeoutSeconds,
		bridgeTimeoutSeconds:         cfg.bridgeTimeoutSeconds,
		adapterFailoverTimeoutSecond: cfg.adapterFailoverTimeoutSecond,
		adapterCircuitThreshold:      cfg.adapterCircuitThreshold,
		adapterCircuitRecoverySecond: cfg.adapterCircuitRecoverySecond,
		adaptiveTimeoutsEnabled:      cfg.adaptiveTimeoutsEnabled,
		adaptiveTimeoutMinSamples:    cfg.adaptiveTimeoutMinSamples,
		adaptiveTimeoutMaxStepSecond: cfg.adaptiveTimeoutMaxStepSecond,
		councilConvergenceMaxRounds:  cfg.councilConvergenceMaxRounds,
		councilLatencyBudgetSecond:   cfg.councilLatencyBudgetSecond,
		councilMinNoveltyDelta:       cfg.councilMinNoveltyDelta,
		councilStripMode:             cfg.councilStripMode,
	}

	caller := mcpCaller{
		repoRoot: cfg.repoRoot,
		helper:   filepath.Join(cfg.repoRoot, "scripts", "mcp_tool_call.mjs"),
		cfg:      cfg,
	}
	timeline := viewport.New(0, 0)
	timeline.MouseWheelEnabled = true
	timeline.MouseWheelDelta = 4
	sidebar := viewport.New(0, 0)
	sidebar.MouseWheelEnabled = true
	sidebar.MouseWheelDelta = 4

	return model{
		cfg:            cfg,
		settings:       settings,
		caller:         caller,
		mutation:       newMutationFactory(cfg.sessionSeed),
		orch:           newOrchestrator(cfg),
		threadID:       cfg.threadID,
		threadTitle:    cfg.threadTitle,
		statusLine:     "starting...",
		logs:           []string{},
		activeTab:      tabChat,
		launcherActive: cfg.launcher,
		launcherIndex:  0,
		launcherItems: []string{
			"Start Tri-Chat",
			"Open Reliability",
			"Open Settings",
			"Open Help",
			"Quit",
		},
		input:          input,
		timeline:       timeline,
		sidebar:        sidebar,
		spinner:        sp,
		theme:          newTheme(),
		busEvents:      []triChatBusEvent{},
		busSeenEventID: map[string]struct{}{},
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		m.initCmd(),
		tickEvery(m.settings.pollInterval),
	)
}

func (m model) initCmd() tea.Cmd {
	cfg := m.cfg
	caller := m.caller
	mutation := m.mutation
	return func() tea.Msg {
		toolPayload, err := caller.callTool("health.tools", map[string]any{})
		if err != nil {
			return initDoneMsg{err: err}
		}
		var health struct {
			Tools []string `json:"tools"`
		}
		health, _ = decodeAny[struct {
			Tools []string `json:"tools"`
		}](toolPayload)
		required := []string{
			"trichat.thread_open",
			"trichat.thread_list",
			"trichat.thread_get",
			"trichat.message_post",
			"trichat.turn_start",
			"trichat.turn_advance",
			"trichat.turn_artifact",
			"trichat.turn_get",
			"trichat.turn_orchestrate",
			"trichat.workboard",
			"trichat.novelty",
			"trichat.verify",
			"trichat.tmux_controller",
			"trichat.timeline",
			"trichat.bus",
			"trichat.summary",
			"trichat.consensus",
			"trichat.adapter_protocol_check",
			"trichat.adapter_telemetry",
			"trichat.turn_watchdog",
			"trichat.slo",
			"task.summary",
			"task.auto_retry",
			"transcript.auto_squish",
			"trichat.auto_retention",
		}
		missing := missingTools(health.Tools, required)
		if len(missing) > 0 {
			return initDoneMsg{err: fmt.Errorf("server missing required tools: %s", strings.Join(missing, ", "))}
		}

		threadID := strings.TrimSpace(cfg.threadID)
		threadTitle := strings.TrimSpace(cfg.threadTitle)
		if threadTitle == "" {
			threadTitle = defaultThreadTitle
		}

		if threadID == "" && cfg.resumeLatest {
			payload, err := caller.callTool("trichat.thread_list", map[string]any{"status": "active", "limit": 25})
			if err == nil {
				var listing struct {
					Threads []triChatThread `json:"threads"`
				}
				listing, _ = decodeAny[struct {
					Threads []triChatThread `json:"threads"`
				}](payload)
				if selected, ok := pickResumeThread(listing.Threads); ok {
					threadID = selected.ThreadID
					if selected.Title != "" {
						threadTitle = selected.Title
					}
				}
			}
		}

		if threadID == "" {
			threadID = fmt.Sprintf("trichat-%d", time.Now().Unix())
		}

		openArgs := map[string]any{
			"mutation":  mutation.next("trichat.thread_open"),
			"thread_id": threadID,
			"title":     threadTitle,
			"metadata": map[string]any{
				"source":    "cmd/trichat-tui",
				"resume":    cfg.resumeLatest,
				"transport": cfg.transport,
			},
		}
		if _, err := caller.callTool("trichat.thread_open", openArgs); err != nil {
			return initDoneMsg{err: err}
		}

		bootstrap := ""
		bootstrapPayload, err := caller.callTool("imprint.bootstrap", map[string]any{
			"profile_id":           "default",
			"max_memories":         20,
			"max_transcript_lines": 20,
			"max_snapshots":        5,
		})
		if err == nil {
			var parsed struct {
				BootstrapText string `json:"bootstrap_text"`
			}
			parsed, _ = decodeAny[struct {
				BootstrapText string `json:"bootstrap_text"`
			}](bootstrapPayload)
			bootstrap = parsed.BootstrapText
		}

		telemetryPayload, err := caller.callTool("trichat.adapter_telemetry", map[string]any{
			"action":         "status",
			"include_events": false,
			"event_limit":    0,
		})
		if err != nil {
			return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap}
		}
		telemetry, err := decodeAny[adapterTelemetryStatusResp](telemetryPayload)
		if err != nil {
			return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap}
		}
		return initDoneMsg{threadID: threadID, threadTitle: threadTitle, bootstrap: bootstrap, states: telemetry.States}
	}
}

func missingTools(actual, required []string) []string {
	set := make(map[string]bool, len(actual))
	for _, name := range actual {
		set[name] = true
	}
	missing := make([]string, 0)
	for _, name := range required {
		if !set[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

func pickResumeThread(threads []triChatThread) (triChatThread, bool) {
	for _, thread := range threads {
		if !isSmokeThread(thread) {
			return thread, true
		}
	}
	return triChatThread{}, false
}

func isSmokeThread(thread triChatThread) bool {
	threadID := strings.ToLower(strings.TrimSpace(thread.ThreadID))
	if strings.HasPrefix(threadID, "trichat-smoke-") {
		return true
	}
	title := strings.ToLower(strings.TrimSpace(thread.Title))
	if strings.Contains(title, "smoke") {
		return true
	}
	source, _ := thread.Metadata["source"].(string)
	source = strings.ToLower(strings.TrimSpace(source))
	return strings.Contains(source, "trichat_smoke")
}

func tickEvery(interval time.Duration) tea.Cmd {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	return tea.Tick(interval, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m model) refreshCmd() tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	settings := m.settings
	return func() tea.Msg {
		reliability := reliabilitySnapshot{}
		timelinePayload, err := caller.callTool("trichat.timeline", map[string]any{
			"thread_id": threadID,
			"limit":     120,
		})
		if err != nil {
			return refreshDoneMsg{err: err}
		}
		timeline, err := decodeAny[triChatTimelineResp](timelinePayload)
		if err != nil {
			return refreshDoneMsg{err: err}
		}

		taskSummaryPayload, err := caller.callTool("task.summary", map[string]any{"running_limit": 10})
		if err == nil {
			reliability.taskSummary, _ = decodeAny[taskSummaryResp](taskSummaryPayload)
		}
		autoRetryPayload, err := caller.callTool("task.auto_retry", map[string]any{"action": "status"})
		if err == nil {
			reliability.taskAutoRetry, _ = decodeAny[daemonStatusResp](autoRetryPayload)
		}
		autoSquishPayload, err := caller.callTool("transcript.auto_squish", map[string]any{"action": "status"})
		if err == nil {
			reliability.transcriptSquish, _ = decodeAny[daemonStatusResp](autoSquishPayload)
		}
		triRetPayload, err := caller.callTool("trichat.auto_retention", map[string]any{"action": "status"})
		if err == nil {
			reliability.triRetention, _ = decodeAny[daemonStatusResp](triRetPayload)
		}
		watchdogPayload, err := caller.callTool("trichat.turn_watchdog", map[string]any{"action": "status"})
		if err == nil {
			reliability.turnWatchdog, _ = decodeAny[triChatTurnWatchdogStatusResp](watchdogPayload)
		}
		sloPayload, err := caller.callTool("trichat.slo", map[string]any{
			"action":         "status",
			"window_minutes": 60,
			"event_limit":    8000,
		})
		if err == nil {
			reliability.slo, _ = decodeAny[triChatSloStatusResp](sloPayload)
		}
		triSummaryPayload, err := caller.callTool("trichat.summary", map[string]any{"busiest_limit": 5})
		if err == nil {
			reliability.triSummary, _ = decodeAny[triChatSummaryResp](triSummaryPayload)
		}
		consensusPayload, err := caller.callTool("trichat.consensus", map[string]any{
			"thread_id":         threadID,
			"limit":             240,
			"min_agents":        settings.consensusMinAgents,
			"recent_turn_limit": 6,
		})
		if err == nil {
			reliability.consensus, _ = decodeAny[triChatConsensusResp](consensusPayload)
		}
		workboardPayload, err := caller.callTool("trichat.workboard", map[string]any{
			"thread_id": threadID,
			"limit":     24,
		})
		if err == nil {
			reliability.workboard, _ = decodeAny[triChatWorkboardResp](workboardPayload)
		}
		if reliability.workboard.ActiveTurn != nil && strings.TrimSpace(reliability.workboard.ActiveTurn.TurnID) != "" {
			turnPayload, err := caller.callTool("trichat.turn_get", map[string]any{
				"turn_id":           reliability.workboard.ActiveTurn.TurnID,
				"include_artifacts": false,
			})
			if err == nil {
				reliability.activeTurn, _ = decodeAny[triChatTurnGetResp](turnPayload)
			}
			noveltyPayload, err := caller.callTool("trichat.novelty", map[string]any{
				"turn_id": reliability.workboard.ActiveTurn.TurnID,
			})
			if err == nil {
				reliability.novelty, _ = decodeAny[triChatNoveltyResp](noveltyPayload)
			}
		}
		busStatusPayload, err := caller.callTool("trichat.bus", map[string]any{"action": "status"})
		if err == nil {
			reliability.busStatus, _ = decodeAny[triChatBusStatusResp](busStatusPayload)
		}
		tmuxStatusPayload, err := caller.callTool("trichat.tmux_controller", map[string]any{"action": "status"})
		if err == nil {
			reliability.tmuxStatus, _ = decodeAny[triChatTmuxStatusResp](tmuxStatusPayload)
		}
		telemetryPayload, err := caller.callTool("trichat.adapter_telemetry", map[string]any{
			"action":         "status",
			"include_events": true,
			"event_limit":    8,
		})
		if err == nil {
			reliability.adapterTelemetry, _ = decodeAny[adapterTelemetryStatusResp](telemetryPayload)
		}
		reliability.updatedAt = time.Now()
		return refreshDoneMsg{messages: timeline.Messages, reliability: reliability}
	}
}

func (m model) busInitCmd(threadID string) tea.Cmd {
	caller := m.caller
	return func() tea.Msg {
		statusPayload, err := caller.callTool("trichat.bus", map[string]any{"action": "status"})
		if err != nil {
			return busInitMsg{err: err}
		}
		status, err := decodeAny[triChatBusStatusResp](statusPayload)
		if err != nil {
			return busInitMsg{err: err}
		}

		events := []triChatBusEvent{}
		if strings.TrimSpace(threadID) != "" {
			tailPayload, err := caller.callTool("trichat.bus", map[string]any{
				"action":    "tail",
				"thread_id": threadID,
				"limit":     80,
			})
			if err == nil {
				tail, decodeErr := decodeAny[triChatBusTailResp](tailPayload)
				if decodeErr == nil {
					events = tail.Events
				}
			}
		}
		return busInitMsg{
			status: status,
			events: events,
		}
	}
}

func (m model) busTailCmd(threadID string, limit int) tea.Cmd {
	caller := m.caller
	bounded := clampInt(limit, 1, 5000)
	return func() tea.Msg {
		if strings.TrimSpace(threadID) == "" {
			return busTailMsg{threadID: threadID, events: []triChatBusEvent{}}
		}
		payload, err := caller.callTool("trichat.bus", map[string]any{
			"action":    "tail",
			"thread_id": threadID,
			"limit":     bounded,
		})
		if err != nil {
			return busTailMsg{threadID: threadID, err: err}
		}
		tail, err := decodeAny[triChatBusTailResp](payload)
		if err != nil {
			return busTailMsg{threadID: threadID, err: err}
		}
		return busTailMsg{
			threadID: threadID,
			events:   tail.Events,
		}
	}
}

func waitBusMsg(ch <-chan tea.Msg) tea.Cmd {
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		msg, ok := <-ch
		if !ok {
			return nil
		}
		return msg
	}
}

func (m *model) startBusListener(socketPath string) tea.Cmd {
	normalized := strings.TrimSpace(socketPath)
	if normalized == "" || m.busListening {
		return nil
	}
	m.busSocketPath = normalized
	m.busInbound = make(chan tea.Msg, 256)
	m.busListening = true
	go runBusStream(normalized, m.busLastSeq, m.busInbound)
	m.appendLog("bus listener started: " + normalized)
	return waitBusMsg(m.busInbound)
}

func runBusStream(socketPath string, initialSinceSeq int, out chan<- tea.Msg) {
	sinceSeq := maxInt(0, initialSinceSeq)
	backoff := time.Second
	lastStatus := ""
	emitStatus := func(connected bool, info string) {
		label := "down"
		if connected {
			label = "up"
		}
		key := fmt.Sprintf("%s|%s", label, info)
		if key == lastStatus {
			return
		}
		lastStatus = key
		select {
		case out <- busLiveStatusMsg{connected: connected, socket: socketPath, info: info}:
		default:
		}
	}
	emitEvent := func(event triChatBusEvent) {
		select {
		case out <- busLiveEventMsg{event: event}:
		default:
		}
	}

	for {
		conn, err := net.DialTimeout("unix", socketPath, 1500*time.Millisecond)
		if err != nil {
			emitStatus(false, compactSingleLine(err.Error(), 160))
			time.Sleep(backoff)
			if backoff < 3*time.Second {
				backoff += 500 * time.Millisecond
			}
			continue
		}

		backoff = time.Second
		emitStatus(true, "connected")
		subscribe := map[string]any{
			"op":           "subscribe",
			"since_seq":    sinceSeq,
			"replay_limit": 120,
		}
		subscribeBuf, _ := json.Marshal(subscribe)
		if _, err := conn.Write(append(subscribeBuf, '\n')); err != nil {
			emitStatus(false, compactSingleLine(err.Error(), 160))
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		reader := bufio.NewReader(conn)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			line, err := reader.ReadString('\n')
			if err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) {
					continue
				}
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() {
					continue
				}
				emitStatus(false, compactSingleLine(err.Error(), 160))
				_ = conn.Close()
				break
			}
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			var payload map[string]any
			if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
				emitStatus(false, "invalid bus frame")
				continue
			}
			kind := strings.ToLower(strings.TrimSpace(fmt.Sprint(payload["kind"])))
			switch kind {
			case "event":
				eventRaw, ok := payload["event"]
				if !ok {
					continue
				}
				event, err := decodeAny[triChatBusEvent](eventRaw)
				if err != nil {
					continue
				}
				if event.EventSeq > sinceSeq {
					sinceSeq = event.EventSeq
				}
				emitEvent(event)
			case "subscribed":
				if parsed, ok := parseAnyInt(payload["since_seq"]); ok && parsed > sinceSeq {
					sinceSeq = parsed
				}
				emitStatus(true, "subscribed")
			case "error":
				emitStatus(false, compactSingleLine(fmt.Sprint(payload["error"]), 160))
			}
		}
	}
}

func (m model) postMessageCmd(agentID, role, content string, replyTo string, metadata map[string]any) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation.next("trichat.message_post")
	return func() tea.Msg {
		args := map[string]any{
			"mutation":  mutation,
			"thread_id": threadID,
			"agent_id":  agentID,
			"role":      role,
			"content":   content,
			"metadata":  metadata,
		}
		if strings.TrimSpace(replyTo) != "" {
			args["reply_to_message_id"] = replyTo
		}
		_, err := caller.callTool("trichat.message_post", args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		return actionDoneMsg{status: "message posted", refresh: true}
	}
}

func (m model) fanoutCmd(prompt string, target string) tea.Cmd {
	caller := m.caller
	cfg := m.cfg
	baseSettings := m.settings
	settings, timeoutTuning := deriveAdaptiveTimeouts(baseSettings, m.reliability.slo)
	adaptiveSummary := adaptiveTimeoutSummary(timeoutTuning)
	adaptiveTiebreak := deriveAdaptiveTiebreakThresholds(m.reliability)
	runtimeCoordinationContext := buildRuntimeCoordinationContext(settings, timeoutTuning)
	threadID := m.threadID
	mutation := m.mutation
	orch := m.orch
	currentMessages := append([]triChatMessage{}, m.messages...)
	return func() (msg tea.Msg) {
		turnID := ""
		turnPhase := "plan"
		turnWarning := ""
		defer func() {
			if recovered := recover(); recovered != nil {
				msg = actionDoneMsg{err: fmt.Errorf("fanout pipeline panic: %v", recovered)}
			}
			done, ok := msg.(actionDoneMsg)
			if !ok || done.err == nil || strings.TrimSpace(turnID) == "" {
				return
			}
			errorText := compactSingleLine(done.err.Error(), 220)
			_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
				"mutation":      mutation.next("trichat.turn_artifact"),
				"turn_id":       turnID,
				"phase":         turnPhase,
				"artifact_type": "router_error",
				"agent_id":      "router",
				"content":       "turn failed in phase " + turnPhase + ": " + errorText,
				"structured": map[string]any{
					"phase": turnPhase,
					"error": errorText,
				},
				"metadata": map[string]any{
					"source":             "trichat-tui",
					"auto_fail_finalize": true,
				},
			})
			_, _ = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":         mutation.next("trichat.turn_advance"),
				"turn_id":          turnID,
				"phase":            "summarize",
				"phase_status":     "completed",
				"status":           "failed",
				"verify_status":    "error",
				"verify_summary":   "fanout pipeline error: " + errorText,
				"decision_summary": "turn failed in phase " + turnPhase + ": " + errorText,
				"metadata": map[string]any{
					"source":             "trichat-tui",
					"allow_phase_skip":   true,
					"auto_fail_finalize": true,
				},
			})
			_, _ = caller.callTool("trichat.message_post", map[string]any{
				"mutation":  mutation.next("trichat.message_post"),
				"thread_id": threadID,
				"agent_id":  "router",
				"role":      "system",
				"content":   "tri-chat turn " + turnID + " failed in phase " + turnPhase + ": " + errorText,
				"metadata": map[string]any{
					"kind":               "turn-failed",
					"source":             "trichat-tui",
					"turn_id":            turnID,
					"phase":              turnPhase,
					"auto_fail_finalize": true,
				},
			})
		}()

		userMutation := mutation.next("trichat.message_post")
		userPostPayload := map[string]any{
			"mutation":  userMutation,
			"thread_id": threadID,
			"agent_id":  "user",
			"role":      "user",
			"content":   prompt,
			"metadata":  map[string]any{"kind": "user-turn", "source": "trichat-tui"},
		}
		postResult, err := caller.callTool("trichat.message_post", userPostPayload)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		var posted struct {
			Message struct {
				MessageID string `json:"message_id"`
			} `json:"message"`
		}
		posted, _ = decodeAny[struct {
			Message struct {
				MessageID string `json:"message_id"`
			} `json:"message"`
		}](postResult)
		userMessageID := posted.Message.MessageID

		expectedAgents := fanoutTargets(target)
		minAgents := settings.consensusMinAgents
		if len(expectedAgents) < minAgents {
			minAgents = len(expectedAgents)
		}
		minAgents = maxInt(1, minAgents)
		proposalFastQuorum := strings.EqualFold(target, "all") && len(expectedAgents) >= 3
		if proposalFastQuorum {
			minAgents = minInt(minAgents, 2)
		}
		turnStartPayload, err := caller.callTool("trichat.turn_start", map[string]any{
			"mutation":        mutation.next("trichat.turn_start"),
			"thread_id":       threadID,
			"user_message_id": userMessageID,
			"user_prompt":     prompt,
			"expected_agents": expectedAgents,
			"min_agents":      minAgents,
			"metadata": map[string]any{
				"source":      "trichat-tui",
				"fanout_mode": target,
				"adaptive_timeout": map[string]any{
					"enabled":                 settings.adaptiveTimeoutsEnabled,
					"reason":                  timeoutTuning.Reason,
					"base_model_timeout_s":    timeoutTuning.BaseModelTimeout,
					"base_bridge_timeout_s":   timeoutTuning.BaseBridgeTimeout,
					"base_failover_timeout_s": timeoutTuning.BaseFailoverTimeout,
					"model_timeout_s":         settings.modelTimeoutSeconds,
					"bridge_timeout_s":        settings.bridgeTimeoutSeconds,
					"failover_timeout_s":      settings.adapterFailoverTimeoutSecond,
					"p95_ms":                  timeoutTuning.P95LatencyMS,
					"latency_samples":         timeoutTuning.SampleCount,
				},
				"adaptive_tiebreak": map[string]any{
					"strategy_no_tiebreak":    adaptiveTiebreak.strategyNoTiebreak,
					"strategy_force_tiebreak": adaptiveTiebreak.strategyForceTiebreak,
					"command_force_tiebreak":  adaptiveTiebreak.commandForceTiebreak,
					"addendum_min_confidence": adaptiveTiebreak.addendumMinConfidence,
					"addendum_max_similarity": adaptiveTiebreak.addendumMaxSimilarity,
					"reason":                  adaptiveTiebreak.reason,
				},
			},
		})
		if err == nil {
			turnStart, decodeErr := decodeAny[triChatTurnStartResp](turnStartPayload)
			if decodeErr == nil {
				turnID = strings.TrimSpace(turnStart.Turn.TurnID)
				if turnID != "" {
					turnPhase = "propose"
					_, _ = caller.callTool("trichat.turn_advance", map[string]any{
						"mutation":     mutation.next("trichat.turn_advance"),
						"turn_id":      turnID,
						"phase":        "propose",
						"phase_status": "running",
						"status":       "running",
					})
				}
			}
		} else {
			turnWarning = compactSingleLine(err.Error(), 140)
		}

		historyPayload, err := caller.callTool("trichat.timeline", map[string]any{"thread_id": threadID, "limit": 48})
		if err != nil {
			return actionDoneMsg{err: err}
		}
		history, err := decodeAny[triChatTimelineResp](historyPayload)
		if err != nil {
			history.Messages = currentMessages
		}

		proposalPrompt := buildProposalPrompt(prompt, target)
		proposalPromptOverrides := buildProposalPromptOverrides(prompt, target, expectedAgents)
		proposalSettings := settings
		if proposalFastQuorum {
			proposalSettings.consensusMinAgents = minInt(proposalSettings.consensusMinAgents, 2)
		}
		responses, events := orch.fanout(
			proposalPrompt,
			proposalPromptOverrides,
			history.Messages,
			cfg,
			proposalSettings,
			target,
			threadID,
			mergeCoordinationContext(runtimeCoordinationContext, ""),
		)
		tiebreakTriggered := false
		tiebreakSimilarity := 1.0
		lateAddendumScheduled := false
		lateAddendumAgent := ""
		lateAddendumBudget := 2200 * time.Millisecond
		if proposalFastQuorum && len(responses) >= 2 {
			disagree, similarity := proposalResponsesDisagreeForTiebreak(responses, adaptiveTiebreak)
			tiebreakSimilarity = similarity
			tiebreakTriggered = disagree
			candidate := pickMissingFanoutAgent(expectedAgents, responses)
			if candidate != "" {
				lateAddendumAgent = candidate
				lateAddendumScheduled = true
				baselineResponses := append([]agentResponse{}, responses...)
				addendumHistory := append([]triChatMessage{}, history.Messages...)
				go captureLateProposalAddendum(lateAddendumInput{
					caller:            caller,
					mutation:          mutation,
					orch:              orch,
					cfg:               cfg,
					settings:          settings,
					threadID:          threadID,
					turnID:            turnID,
					userMessageID:     userMessageID,
					agentID:           candidate,
					prompt:            prompt,
					history:           addendumHistory,
					baselineResponses: baselineResponses,
					peerContext: mergeCoordinationContext(
						runtimeCoordinationContext,
						buildPeerContextFromResponses(baselineResponses),
					),
					thresholds: adaptiveTiebreak,
					budget:     lateAddendumBudget,
				})
			}
		}
		for _, response := range responses {
			structured := parseProposalStructured(response.content, response.agentID, false)
			postArgs := map[string]any{
				"mutation":            mutation.next("trichat.message_post"),
				"thread_id":           threadID,
				"agent_id":            response.agentID,
				"role":                "assistant",
				"content":             response.content,
				"reply_to_message_id": userMessageID,
				"metadata": map[string]any{
					"kind":                      "fanout-proposal",
					"source":                    "trichat-tui",
					"adapter":                   response.adapterMeta,
					"phase":                     "propose",
					"structured_v":              1,
					"structured":                structured,
					"tiebreak_triggered":        tiebreakTriggered,
					"tiebreak_similarity":       tiebreakSimilarity,
					"tiebreak_threshold_reason": adaptiveTiebreak.reason,
					"addendum_scheduled":        lateAddendumScheduled,
					"addendum_candidate_agent":  lateAddendumAgent,
				},
			}
			if _, err := caller.callTool("trichat.message_post", postArgs); err != nil {
				return actionDoneMsg{err: err}
			}
			if turnID != "" {
				_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
					"mutation":      mutation.next("trichat.turn_artifact"),
					"turn_id":       turnID,
					"phase":         "propose",
					"artifact_type": "proposal",
					"agent_id":      response.agentID,
					"content":       response.content,
					"structured":    structured,
					"score":         proposalConfidence(structured),
					"metadata": map[string]any{
						"source":              "trichat-tui",
						"target":              target,
						"tiebreak_triggered":  tiebreakTriggered,
						"tiebreak_similarity": tiebreakSimilarity,
						"tiebreak_reason":     adaptiveTiebreak.reason,
						"tiebreak_thresholds": map[string]any{
							"strategy_no_tiebreak":    adaptiveTiebreak.strategyNoTiebreak,
							"strategy_force_tiebreak": adaptiveTiebreak.strategyForceTiebreak,
							"command_force_tiebreak":  adaptiveTiebreak.commandForceTiebreak,
						},
						"late_addendum_scheduled": lateAddendumScheduled,
						"late_addendum_agent":     lateAddendumAgent,
						"late_addendum_budget_ms": int(lateAddendumBudget / time.Millisecond),
					},
				})
			}
		}

		noveltyThreshold := 0.35
		maxSimilarity := 0.82
		novelty := triChatNoveltyResp{}
		if turnID != "" {
			noveltyPayload, noveltyErr := caller.callTool("trichat.novelty", map[string]any{
				"turn_id":           turnID,
				"novelty_threshold": noveltyThreshold,
				"max_similarity":    maxSimilarity,
			})
			if noveltyErr == nil {
				decoded, decodeErr := decodeAny[triChatNoveltyResp](noveltyPayload)
				if decodeErr == nil {
					novelty = decoded
				}
			}
		}

		if novelty.Found && novelty.RetryRequired && len(novelty.RetryAgents) > 0 {
			_, _ = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":          mutation.next("trichat.turn_advance"),
				"turn_id":           turnID,
				"phase":             "propose",
				"phase_status":      "running",
				"status":            "running",
				"retry_required":    true,
				"retry_agents":      novelty.RetryAgents,
				"novelty_score":     novelty.NoveltyScore,
				"novelty_threshold": novelty.NoveltyThreshold,
				"disagreement":      novelty.Disagreement,
			})
			peerContext := buildPeerContext(novelty.Proposals)
			for _, retryAgent := range novelty.RetryAgents {
				agent := strings.ToLower(strings.TrimSpace(retryAgent))
				if agent == "" {
					continue
				}
				deltaPrompt := buildDeltaRetryPrompt(prompt, agent, peerContext)
				deltaResponses, deltaEvents := orch.fanout(
					deltaPrompt,
					nil,
					history.Messages,
					cfg,
					settings,
					agent,
					threadID,
					mergeCoordinationContext(runtimeCoordinationContext, peerContext),
				)
				events = append(events, deltaEvents...)
				for _, delta := range deltaResponses {
					deltaStructured := parseProposalStructured(delta.content, delta.agentID, true)
					_, err := caller.callTool("trichat.message_post", map[string]any{
						"mutation":            mutation.next("trichat.message_post"),
						"thread_id":           threadID,
						"agent_id":            delta.agentID,
						"role":                "assistant",
						"content":             delta.content,
						"reply_to_message_id": userMessageID,
						"metadata": map[string]any{
							"kind":         "fanout-proposal-delta",
							"source":       "trichat-tui",
							"adapter":      delta.adapterMeta,
							"phase":        "propose",
							"structured_v": 1,
							"structured":   deltaStructured,
						},
					})
					if err != nil {
						return actionDoneMsg{err: err}
					}
					if turnID != "" {
						_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
							"mutation":      mutation.next("trichat.turn_artifact"),
							"turn_id":       turnID,
							"phase":         "propose",
							"artifact_type": "proposal_retry",
							"agent_id":      delta.agentID,
							"content":       delta.content,
							"structured":    deltaStructured,
							"score":         proposalConfidence(deltaStructured),
							"metadata": map[string]any{
								"source":       "trichat-tui",
								"retry_agent":  agent,
								"retry_round":  1,
								"retry_origin": "novelty",
							},
						})
					}
				}
			}

			noveltyPayload, noveltyErr := caller.callTool("trichat.novelty", map[string]any{
				"turn_id":           turnID,
				"novelty_threshold": noveltyThreshold,
				"max_similarity":    maxSimilarity,
			})
			if noveltyErr == nil {
				decoded, decodeErr := decodeAny[triChatNoveltyResp](noveltyPayload)
				if decodeErr == nil {
					novelty = decoded
				}
			}
		}

		if turnID != "" {
			_, _ = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":          mutation.next("trichat.turn_advance"),
				"turn_id":           turnID,
				"phase":             "propose",
				"phase_status":      "completed",
				"status":            "running",
				"novelty_score":     novelty.NoveltyScore,
				"novelty_threshold": novelty.NoveltyThreshold,
				"retry_required":    novelty.RetryRequired,
				"retry_agents":      novelty.RetryAgents,
				"disagreement":      novelty.Disagreement,
			})
		}

		peerContext := buildPeerContext(novelty.Proposals)
		if strings.TrimSpace(peerContext) == "" {
			peerContext = buildPeerContextFromResponses(responses)
		}
		critiqueAgents := resolveCritiqueAgents(novelty, responses)
		critiqueNotes := make([]string, 0, 12)
		if turnID != "" {
			turnPhase = "critique"
			if len(critiqueAgents) > 1 {
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":     mutation.next("trichat.turn_advance"),
					"turn_id":      turnID,
					"phase":        "critique",
					"phase_status": "running",
					"status":       "running",
				})
				for index, critic := range critiqueAgents {
					targetAgent := critiqueAgents[(index+1)%len(critiqueAgents)]
					critiquePrompt := buildCritiquePrompt(prompt, critic, targetAgent, peerContext)
					critiqueResponses, critiqueEvents := orch.fanout(
						critiquePrompt,
						nil,
						history.Messages,
						cfg,
						settings,
						critic,
						threadID,
						mergeCoordinationContext(runtimeCoordinationContext, peerContext),
					)
					events = append(events, critiqueEvents...)
					for _, critiqueResponse := range critiqueResponses {
						critiqueStructured := parseCritiqueStructured(critiqueResponse.content, critic, targetAgent)
						if recommendation, ok := critiqueStructured["recommendation"].(string); ok {
							if trimmedRecommendation := strings.TrimSpace(recommendation); trimmedRecommendation != "" {
								critiqueNotes = append(
									critiqueNotes,
									fmt.Sprintf("%s->%s: %s", critic, targetAgent, compactSingleLine(trimmedRecommendation, 180)),
								)
							}
						}
						_, err := caller.callTool("trichat.message_post", map[string]any{
							"mutation":            mutation.next("trichat.message_post"),
							"thread_id":           threadID,
							"agent_id":            critiqueResponse.agentID,
							"role":                "assistant",
							"content":             critiqueResponse.content,
							"reply_to_message_id": userMessageID,
							"metadata": map[string]any{
								"kind":         "fanout-critique",
								"source":       "trichat-tui",
								"adapter":      critiqueResponse.adapterMeta,
								"phase":        "critique",
								"structured_v": 1,
								"structured":   critiqueStructured,
							},
						})
						if err != nil {
							return actionDoneMsg{err: err}
						}
						_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
							"mutation":      mutation.next("trichat.turn_artifact"),
							"turn_id":       turnID,
							"phase":         "critique",
							"artifact_type": "critique",
							"agent_id":      critiqueResponse.agentID,
							"content":       critiqueResponse.content,
							"structured":    critiqueStructured,
							"score":         critiqueConfidence(critiqueStructured),
							"metadata": map[string]any{
								"source":       "trichat-tui",
								"target_agent": targetAgent,
							},
						})
					}
				}
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":     mutation.next("trichat.turn_advance"),
					"turn_id":      turnID,
					"phase":        "critique",
					"phase_status": "completed",
					"status":       "running",
				})
			} else {
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":     mutation.next("trichat.turn_advance"),
					"turn_id":      turnID,
					"phase":        "critique",
					"phase_status": "skipped",
					"status":       "running",
				})
			}
		}

		critiqueContext := strings.Join(critiqueNotes, "\n")
		interopRoundsCompleted := 0
		totalCouncilQuestions := 0
		convergenceReason := ""
		baselineNoveltyScore := 0.0
		bestNoveltyScore := 0.0
		if novelty.Found {
			baselineNoveltyScore = novelty.NoveltyScore
			bestNoveltyScore = novelty.NoveltyScore
		}
		if settings.interopRounds > 0 && strings.EqualFold(target, "all") && len(expectedAgents) >= 2 {
			turnPhase = "merge"
			if turnID != "" {
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":     mutation.next("trichat.turn_advance"),
					"turn_id":      turnID,
					"phase":        "merge",
					"phase_status": "running",
					"status":       "running",
					"metadata": map[string]any{
						"source":           "trichat-tui",
						"allow_phase_skip": true,
						"interop_rounds":   settings.interopRounds,
					},
				})
			}
			minInteropRounds := maxInt(1, settings.interopRounds)
			maxCouncilRounds := maxInt(minInteropRounds, settings.councilConvergenceMaxRounds)
			councilLatencyBudget := time.Duration(maxInt(1, settings.councilLatencyBudgetSecond)) * time.Second
			councilLoopStarted := time.Now()
			for round := 1; round <= maxCouncilRounds; round++ {
				interopPeerContext := buildPeerContext(novelty.Proposals)
				if strings.TrimSpace(interopPeerContext) == "" {
					interopPeerContext = peerContext
				}
				if strings.TrimSpace(interopPeerContext) == "" {
					interopPeerContext = buildPeerContextFromResponses(responses)
				}
				councilQuestions := make([]councilQuestion, 0, len(expectedAgents))
				normalizedCouncilAgents := normalizeUniqueAgents(expectedAgents)
				if len(normalizedCouncilAgents) >= 2 {
					councilOverrides := buildCouncilQuestionPromptOverrides(
						prompt,
						normalizedCouncilAgents,
						round,
						interopPeerContext,
						critiqueContext,
					)
					if len(councilOverrides) > 0 {
						councilResponses, councilEvents := orch.fanout(
							"TRICHAT_TURN_PHASE=merge\nTRICHAT_RESPONSE_MODE=json\nAutonomous council question generation.",
							councilOverrides,
							history.Messages,
							cfg,
							settings,
							"all",
							threadID,
							mergeCoordinationContext(runtimeCoordinationContext, interopPeerContext),
						)
						events = append(events, councilEvents...)
						for _, councilResponse := range councilResponses {
							question := parseCouncilQuestion(councilResponse.content, councilResponse.agentID, normalizedCouncilAgents)
							if strings.TrimSpace(question.TargetAgent) == "" || strings.TrimSpace(question.Question) == "" {
								continue
							}
							councilQuestions = append(councilQuestions, question)
							totalCouncilQuestions += 1
							councilContent := fmt.Sprintf("@%s %s", question.TargetAgent, question.Question)
							_, err := caller.callTool("trichat.message_post", map[string]any{
								"mutation":            mutation.next("trichat.message_post"),
								"thread_id":           threadID,
								"agent_id":            question.AskerAgent,
								"role":                "assistant",
								"content":             councilContent,
								"reply_to_message_id": userMessageID,
								"metadata": map[string]any{
									"kind":             "fanout-council-question",
									"source":           "trichat-tui",
									"phase":            "merge",
									"interop_round":    round,
									"target_agent":     question.TargetAgent,
									"rationale":        question.Rationale,
									"urgency":          question.Urgency,
									"council_exchange": true,
									"adapter":          councilResponse.adapterMeta,
								},
							})
							if err != nil {
								return actionDoneMsg{err: err}
							}
							if turnID != "" {
								_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
									"mutation":      mutation.next("trichat.turn_artifact"),
									"turn_id":       turnID,
									"phase":         "merge",
									"artifact_type": "council_question",
									"agent_id":      question.AskerAgent,
									"content":       councilContent,
									"structured": map[string]any{
										"asker_agent":  question.AskerAgent,
										"target_agent": question.TargetAgent,
										"question":     question.Question,
										"rationale":    question.Rationale,
										"urgency":      question.Urgency,
									},
									"score": question.Urgency,
									"metadata": map[string]any{
										"source":        "trichat-tui",
										"interop_round": round,
									},
								})
							}
						}
					}
				}
				councilQuestionByTarget := groupCouncilQuestionsByTarget(councilQuestions)
				overrides := buildInteropPromptOverrides(
					prompt,
					expectedAgents,
					round,
					interopPeerContext,
					critiqueContext,
					councilQuestionByTarget,
				)
				if len(overrides) == 0 {
					break
				}
				interopResponses, interopEvents := orch.fanout(
					"TRICHAT_TURN_PHASE=merge\nTRICHAT_RESPONSE_MODE=json\nInterop refinement round in progress.",
					overrides,
					history.Messages,
					cfg,
					settings,
					"all",
					threadID,
					mergeCoordinationContext(runtimeCoordinationContext, interopPeerContext),
				)
				events = append(events, interopEvents...)
				interopRoundsCompleted += 1
				if len(interopResponses) == 0 {
					continueLoop, stopReason := shouldContinueCouncilConvergence(
						interopRoundsCompleted,
						minInteropRounds,
						maxCouncilRounds,
						time.Since(councilLoopStarted),
						councilLatencyBudget,
						novelty,
						baselineNoveltyScore,
						bestNoveltyScore,
						settings.councilMinNoveltyDelta,
					)
					if !continueLoop {
						convergenceReason = stopReason
						break
					}
					continue
				}

				for _, response := range interopResponses {
					interopStructured := parseProposalStructured(response.content, response.agentID, true)
					questionCount := len(councilQuestionByTarget[response.agentID])
					_, err := caller.callTool("trichat.message_post", map[string]any{
						"mutation":            mutation.next("trichat.message_post"),
						"thread_id":           threadID,
						"agent_id":            response.agentID,
						"role":                "assistant",
						"content":             response.content,
						"reply_to_message_id": userMessageID,
						"metadata": map[string]any{
							"kind":                   "fanout-interop",
							"source":                 "trichat-tui",
							"phase":                  "merge",
							"interop_round":          round,
							"council_question_count": questionCount,
							"council_exchange":       questionCount > 0,
							"adapter":                response.adapterMeta,
							"structured_v":           1,
							"structured":             interopStructured,
						},
					})
					if err != nil {
						return actionDoneMsg{err: err}
					}
					if turnID != "" {
						_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
							"mutation":      mutation.next("trichat.turn_artifact"),
							"turn_id":       turnID,
							"phase":         "propose",
							"artifact_type": "proposal_interop",
							"agent_id":      response.agentID,
							"content":       response.content,
							"structured":    interopStructured,
							"score":         proposalConfidence(interopStructured),
							"metadata": map[string]any{
								"source":                 "trichat-tui",
								"interop_round":          round,
								"phase_origin":           "merge",
								"council_question_count": questionCount,
							},
						})
					}
					history.Messages = append(history.Messages, triChatMessage{
						ThreadID:         threadID,
						AgentID:          response.agentID,
						Role:             "assistant",
						Content:          response.content,
						ReplyToMessageID: userMessageID,
					})
				}

				if turnID != "" {
					noveltyPayload, noveltyErr := caller.callTool("trichat.novelty", map[string]any{
						"turn_id":           turnID,
						"novelty_threshold": noveltyThreshold,
						"max_similarity":    maxSimilarity,
					})
					if noveltyErr == nil {
						decoded, decodeErr := decodeAny[triChatNoveltyResp](noveltyPayload)
						if decodeErr == nil {
							novelty = decoded
						}
					}
				}

				if novelty.Found {
					bestNoveltyScore = maxFloat(bestNoveltyScore, novelty.NoveltyScore)
				}
				continueLoop, stopReason := shouldContinueCouncilConvergence(
					interopRoundsCompleted,
					minInteropRounds,
					maxCouncilRounds,
					time.Since(councilLoopStarted),
					councilLatencyBudget,
					novelty,
					baselineNoveltyScore,
					bestNoveltyScore,
					settings.councilMinNoveltyDelta,
				)
				if !continueLoop {
					convergenceReason = stopReason
					break
				}
			}
			if convergenceReason == "" {
				switch {
				case interopRoundsCompleted <= 0:
					convergenceReason = "no-interop"
				case interopRoundsCompleted >= maxCouncilRounds:
					convergenceReason = "max-rounds"
				default:
					convergenceReason = "steady"
				}
			}
			if interopRoundsCompleted > 0 {
				_, _ = caller.callTool("trichat.message_post", map[string]any{
					"mutation":  mutation.next("trichat.message_post"),
					"thread_id": threadID,
					"agent_id":  "router",
					"role":      "assistant",
					"content": fmt.Sprintf(
						"[interop] rounds=%d council_q=%d novelty=%.2f delta=%.2f retry=%s disagreement=%s converge=%s budget=%ds",
						interopRoundsCompleted,
						totalCouncilQuestions,
						novelty.NoveltyScore,
						bestNoveltyScore-baselineNoveltyScore,
						onOff(novelty.RetryRequired),
						onOff(novelty.Disagreement),
						convergenceReason,
						settings.councilLatencyBudgetSecond,
					),
					"metadata": map[string]any{
						"kind":                   "interop-summary",
						"source":                 "trichat-tui",
						"interop_rounds":         interopRoundsCompleted,
						"novelty_score":          novelty.NoveltyScore,
						"novelty_baseline_score": baselineNoveltyScore,
						"novelty_best_score":     bestNoveltyScore,
						"novelty_delta":          bestNoveltyScore - baselineNoveltyScore,
						"retry_required":         novelty.RetryRequired,
						"disagreement":           novelty.Disagreement,
						"council_question_count": totalCouncilQuestions,
						"convergence_reason":     convergenceReason,
						"convergence_budget_sec": settings.councilLatencyBudgetSecond,
						"convergence_max_rounds": settings.councilConvergenceMaxRounds,
						"convergence_min_delta":  settings.councilMinNoveltyDelta,
					},
				})
			}
		}

		selectedAgent, selectedStrategy, decisionSummary := deriveTurnDecision(novelty, responses)
		turnPhase = "merge"
		if turnID != "" {
			orchestratePayload, orchestrateErr := caller.callTool("trichat.turn_orchestrate", map[string]any{
				"mutation":          mutation.next("trichat.turn_orchestrate"),
				"turn_id":           turnID,
				"action":            "decide",
				"novelty_threshold": noveltyThreshold,
				"max_similarity":    maxSimilarity,
			})
			if orchestrateErr != nil {
				turnWarning = compactSingleLine(orchestrateErr.Error(), 140)
			} else {
				orchestrated, decodeErr := decodeAny[triChatTurnOrchestrateResp](orchestratePayload)
				if decodeErr != nil {
					turnWarning = compactSingleLine("turn_orchestrate decode failed: "+decodeErr.Error(), 140)
				} else {
					if strings.TrimSpace(orchestrated.Decision.SelectedAgent) != "" {
						selectedAgent = strings.TrimSpace(orchestrated.Decision.SelectedAgent)
					}
					if strings.TrimSpace(orchestrated.Decision.SelectedStrategy) != "" {
						selectedStrategy = strings.TrimSpace(orchestrated.Decision.SelectedStrategy)
					}
					if strings.TrimSpace(orchestrated.Decision.DecisionSummary) != "" {
						decisionSummary = strings.TrimSpace(orchestrated.Decision.DecisionSummary)
					} else if strings.TrimSpace(orchestrated.Turn.DecisionSummary) != "" {
						decisionSummary = strings.TrimSpace(orchestrated.Turn.DecisionSummary)
					}
				}
			}
		}
		if strings.TrimSpace(decisionSummary) != "" {
			_, _ = caller.callTool("trichat.message_post", map[string]any{
				"mutation":  mutation.next("trichat.message_post"),
				"thread_id": threadID,
				"agent_id":  "router",
				"role":      "system",
				"content":   decisionSummary,
				"metadata": map[string]any{
					"kind":              "turn-decision",
					"turn_id":           turnID,
					"selected_agent":    selectedAgent,
					"selected_strategy": compactSingleLine(selectedStrategy, 220),
					"retry_required":    novelty.RetryRequired,
					"novelty_score":     novelty.NoveltyScore,
					"source":            "trichat-tui",
				},
			})
		}
		autoExecuteStatus := ""
		if settings.autoExecuteAfterDecision {
			autoExecuteAgent := strings.ToLower(strings.TrimSpace(selectedAgent))
			if autoExecuteAgent == "" && len(responses) > 0 {
				autoExecuteAgent = strings.ToLower(strings.TrimSpace(responses[0].agentID))
			}
			autoExecuteObjective := deriveAutoExecuteObjective(
				autoExecuteAgent,
				selectedStrategy,
				decisionSummary,
				responses,
			)
			if autoExecuteAgent == "" || strings.TrimSpace(autoExecuteObjective) == "" {
				autoExecuteStatus = " autoexec=skipped(no-decision)"
			} else {
				cycleCount := clampInt(settings.autoExecuteCycleCount, 1, 4)
				breakerThreshold := clampInt(settings.autoExecuteBreakerFailures, 1, 5)
				cycleNotes := make([]string, 0, cycleCount)
				previousCycleStatus := make([]string, 0, cycleCount)
				completedCycles := 0
				consecutiveGateFailures := 0
				totalGateFailures := 0
				breakerTripped := false

				for cycle := 1; cycle <= cycleCount; cycle++ {
					cycleObjective := buildAutoExecuteCycleObjective(autoExecuteObjective, decisionSummary, cycle, previousCycleStatus)
					execMsg := m.executeCmdWithRoute(autoExecuteAgent, cycleObjective, "/fanout-autoexec")()
					execDone, ok := execMsg.(actionDoneMsg)
					if !ok {
						totalGateFailures += 1
						consecutiveGateFailures += 1
						cycleNotes = append(cycleNotes, fmt.Sprintf("c%d:unknown", cycle))
						previousCycleStatus = append(previousCycleStatus, fmt.Sprintf("c%d:unknown", cycle))
						if consecutiveGateFailures >= breakerThreshold {
							breakerTripped = true
						}
						break
					}

					completedCycles = cycle
					cycleSummary := compactSingleLine(execDone.status, 120)
					if cycleSummary == "" {
						cycleSummary = "ok"
					}
					previousCycleStatus = append(previousCycleStatus, fmt.Sprintf("c%d:%s", cycle, cycleSummary))
					cyclePassed := execDone.err == nil && execDone.gatePassed
					if !cyclePassed {
						totalGateFailures += 1
						consecutiveGateFailures += 1
					} else {
						consecutiveGateFailures = 0
					}
					cycleNotes = append(
						cycleNotes,
						fmt.Sprintf(
							"c%d:%s/%s",
							cycle,
							ternary(cyclePassed, "pass", "fail"),
							nullCoalesce(execDone.executionMode, "unknown"),
						),
					)

					if turnID != "" {
						_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
							"mutation":      mutation.next("trichat.turn_artifact"),
							"turn_id":       turnID,
							"phase":         "execute",
							"artifact_type": "autoexec_cycle",
							"agent_id":      autoExecuteAgent,
							"content": fmt.Sprintf(
								"autoexec cycle=%d/%d gate=%s mode=%s verify=%s",
								cycle,
								cycleCount,
								ternary(cyclePassed, "pass", "fail"),
								nullCoalesce(execDone.executionMode, "unknown"),
								nullCoalesce(execDone.verifyStatus, "skipped"),
							),
							"structured": map[string]any{
								"cycle":             cycle,
								"cycle_total":       cycleCount,
								"gate_passed":       cyclePassed,
								"gate_reasons":      execDone.gateReasons,
								"execution_mode":    execDone.executionMode,
								"verify_status":     execDone.verifyStatus,
								"dispatch_failures": execDone.dispatchFailures,
								"auto_skipped":      execDone.autoSkipped,
								"status":            cycleSummary,
							},
							"metadata": map[string]any{
								"source":         "trichat-tui",
								"kind":           "fanout-autoexec-cycle",
								"selected_agent": autoExecuteAgent,
							},
						})
					}

					if execDone.err != nil {
						execErrText := compactSingleLine(execDone.err.Error(), 120)
						if strings.TrimSpace(turnWarning) == "" {
							turnWarning = "autoexec: " + execErrText
						} else {
							turnWarning += " | autoexec: " + execErrText
						}
					}

					if consecutiveGateFailures >= breakerThreshold {
						breakerTripped = true
						break
					}
				}

				if breakerTripped {
					breakerText := fmt.Sprintf(
						"autoexec breaker tripped after %d consecutive gate failures",
						consecutiveGateFailures,
					)
					if strings.TrimSpace(turnWarning) == "" {
						turnWarning = breakerText
					} else {
						turnWarning += " | " + breakerText
					}
				}
				if completedCycles == 0 {
					completedCycles = minInt(cycleCount, len(previousCycleStatus))
				}
				autoExecuteStatus = fmt.Sprintf(
					" autoexec=cycles(%d/%d gate=%s breaker=%s)",
					completedCycles,
					cycleCount,
					ternary(totalGateFailures == 0, "pass", "fail"),
					ternary(breakerTripped, "tripped", "ok"),
				)
				if len(cycleNotes) > 0 {
					autoExecuteStatus += "[" + compactSingleLine(strings.Join(cycleNotes, ","), 180) + "]"
				}
			}
		}

		states := orch.collectStates(cfg, settings)
		recordArgs := map[string]any{
			"action":   "record",
			"mutation": mutation.next("trichat.adapter_telemetry"),
			"states":   states,
		}
		if len(events) > 0 {
			recordArgs["events"] = events
		}
		_, _ = caller.callTool("trichat.adapter_telemetry", recordArgs)

		turnStatus := ""
		if turnID != "" {
			turnStatus = " turn=" + turnID
		}
		noveltyStatus := ""
		if novelty.Found {
			noveltyStatus = fmt.Sprintf(" novelty=%.2f retry=%s", novelty.NoveltyScore, onOff(novelty.RetryRequired))
			if novelty.RetrySuppressed {
				noveltyStatus += " dedupe=on"
			}
		}
		decisionStatus := ""
		if strings.TrimSpace(selectedAgent) != "" {
			decisionStatus = " selected=" + selectedAgent
		}
		warningStatus := ""
		if strings.TrimSpace(turnWarning) != "" {
			warningStatus = " turn_warn=" + turnWarning
		}
		interopStatus := ""
		if interopRoundsCompleted > 0 {
			interopStatus = fmt.Sprintf(" interop=%d", interopRoundsCompleted)
			if strings.TrimSpace(convergenceReason) != "" {
				interopStatus += fmt.Sprintf(" converge=%s", convergenceReason)
			}
		}
		councilStatus := ""
		if totalCouncilQuestions > 0 {
			councilStatus = fmt.Sprintf(" council_q=%d", totalCouncilQuestions)
		}
		tiebreakStatus := ""
		if tiebreakTriggered {
			tiebreakStatus = fmt.Sprintf(" tiebreak=%s:deferred(sim=%.2f)", nullCoalesce(lateAddendumAgent, "n/a"), tiebreakSimilarity)
		}
		addendumStatus := ""
		if lateAddendumScheduled {
			addendumStatus = fmt.Sprintf(
				" addendum=%s:pending(%dms)",
				nullCoalesce(lateAddendumAgent, "n/a"),
				int(lateAddendumBudget/time.Millisecond),
			)
		}
		adaptiveStatus := ""
		if adaptiveSummary != "" {
			adaptiveStatus = " " + adaptiveSummary
		}
		if strings.TrimSpace(autoExecuteStatus) != "" {
			adaptiveStatus += autoExecuteStatus
		}
		if target == "all" {
			return actionDoneMsg{
				status:            "fanout complete: codex, cursor, local-imprint" + turnStatus + noveltyStatus + decisionStatus + interopStatus + councilStatus + tiebreakStatus + addendumStatus + warningStatus + adaptiveStatus,
				refresh:           true,
				adaptiveEvaluated: true,
				adaptiveApplied:   timeoutTuning.Applied,
				modelTimeout:      settings.modelTimeoutSeconds,
				bridgeTimeout:     settings.bridgeTimeoutSeconds,
				failoverTimeout:   settings.adapterFailoverTimeoutSecond,
				adaptiveReason:    timeoutTuning.Reason,
				adaptiveP95MS:     timeoutTuning.P95LatencyMS,
				adaptiveSamples:   timeoutTuning.SampleCount,
			}
		}
		return actionDoneMsg{
			status:            "response complete: " + target + turnStatus + noveltyStatus + decisionStatus + interopStatus + councilStatus + tiebreakStatus + addendumStatus + warningStatus + adaptiveStatus,
			refresh:           true,
			adaptiveEvaluated: true,
			adaptiveApplied:   timeoutTuning.Applied,
			modelTimeout:      settings.modelTimeoutSeconds,
			bridgeTimeout:     settings.bridgeTimeoutSeconds,
			failoverTimeout:   settings.adapterFailoverTimeoutSecond,
			adaptiveReason:    timeoutTuning.Reason,
			adaptiveP95MS:     timeoutTuning.P95LatencyMS,
			adaptiveSamples:   timeoutTuning.SampleCount,
		}
	}
}

type proposalRoleProfile struct {
	RoleID          string
	RoleLabel       string
	PrimaryFocus    string
	DistinctiveMove string
	CoordinationTip string
}

type councilQuestion struct {
	AskerAgent  string
	TargetAgent string
	Question    string
	Rationale   string
	Urgency     float64
}

func proposalRoleForAgent(agentID string) proposalRoleProfile {
	switch strings.ToLower(strings.TrimSpace(agentID)) {
	case "codex":
		return proposalRoleProfile{
			RoleID:          "implementer",
			RoleLabel:       "Implementation Lead",
			PrimaryFocus:    "translate objective into concrete build steps with executable commands",
			DistinctiveMove: "optimize for direct, testable implementation velocity",
			CoordinationTip: "ask planner and critic lanes for constraints before final command list",
		}
	case "cursor":
		return proposalRoleProfile{
			RoleID:          "planner",
			RoleLabel:       "Planning Strategist",
			PrimaryFocus:    "decompose objective into milestones, tradeoffs, and execution sequence",
			DistinctiveMove: "optimize for architecture coherence and change sequencing",
			CoordinationTip: "handoff implementation-ready checklist to implementer lane",
		}
	default:
		return proposalRoleProfile{
			RoleID:          "reliability-critic",
			RoleLabel:       "Reliability Critic",
			PrimaryFocus:    "surface failure modes, safety constraints, and rollback planning",
			DistinctiveMove: "optimize for resilience, observability, and idempotent operations",
			CoordinationTip: "return edge cases and verifier hooks for peer lanes",
		}
	}
}

func buildProposalPrompt(userPrompt string, target string) string {
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=propose
TRICHAT_RESPONSE_MODE=json
User objective:
%s

Multi-agent contract:
- Produce a distinct strategy, not a copy of peers.
- Favor your agent's natural bias and strengths.
- Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
- "plan_steps", "risks", and "commands" must be arrays of short strings.
- confidence must be a number from 0 to 1.
- role_lane and coordination_handoff must be short strings.
- Do not add markdown fences or extra commentary.

Execution target:
%s`,
			strings.TrimSpace(userPrompt),
			strings.TrimSpace(target),
		),
	)
}

func buildProposalPromptOverrides(userPrompt string, target string, agents []string) map[string]string {
	overrides := make(map[string]string, len(agents))
	normalizedAgents := make([]string, 0, len(agents))
	seen := make(map[string]struct{}, len(agents))
	for _, agent := range agents {
		normalized := strings.ToLower(strings.TrimSpace(agent))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		normalizedAgents = append(normalizedAgents, normalized)
	}
	if len(normalizedAgents) == 0 {
		normalizedAgents = fanoutTargets(target)
	}

	for _, agent := range normalizedAgents {
		collaborators := make([]string, 0, len(normalizedAgents)-1)
		for _, other := range normalizedAgents {
			if other == agent {
				continue
			}
			collaborators = append(collaborators, other)
		}
		overrides[agent] = buildProposalPromptForAgent(userPrompt, target, agent, collaborators)
	}
	return overrides
}

func buildProposalPromptForAgent(userPrompt string, target string, agentID string, collaborators []string) string {
	profile := proposalRoleForAgent(agentID)
	collabLabel := strings.Join(collaborators, ",")
	if collabLabel == "" {
		collabLabel = "(none)"
	}
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=propose
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
TRICHAT_AGENT=%s
TRICHAT_COLLABORATORS=%s
User objective:
%s

Lane contract:
- You are the %s (%s lane).
- Primary focus: %s.
- Distinctive move: %s.
- Coordination tip: %s.

Multi-agent contract:
- Do not mirror peer wording or structure.
- Include one handoff the next lane can execute immediately.
- Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
- "plan_steps", "risks", and "commands" must be arrays of short strings.
- confidence must be a number from 0 to 1.
- role_lane and coordination_handoff must be short strings.

Execution target:
%s`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(agentID),
			collabLabel,
			strings.TrimSpace(userPrompt),
			profile.RoleLabel,
			profile.RoleID,
			profile.PrimaryFocus,
			profile.DistinctiveMove,
			profile.CoordinationTip,
			strings.TrimSpace(target),
		),
	)
}

func buildProposalTiebreakPromptForAgent(userPrompt string, agentID string, peerResponses []agentResponse) string {
	profile := proposalRoleForAgent(agentID)
	peerLines := make([]string, 0, len(peerResponses))
	for _, response := range peerResponses {
		peerAgent := strings.ToLower(strings.TrimSpace(response.agentID))
		if peerAgent == "" || peerAgent == strings.ToLower(strings.TrimSpace(agentID)) {
			continue
		}
		peerLines = append(peerLines, fmt.Sprintf("- %s: %s", peerAgent, compactSingleLine(response.content, 220)))
	}
	peerSnapshot := "(peer conflict snapshot unavailable)"
	if len(peerLines) > 0 {
		peerSnapshot = strings.Join(peerLines, "\n")
	}
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=propose_tiebreak
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
TRICHAT_AGENT=%s
User objective:
%s

Tiebreak context:
Two peer proposals disagree. Resolve the conflict quickly with one decisive strategy.

Peer proposals:
%s

Output contract:
- Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
- "plan_steps", "risks", and "commands" must be arrays of short strings.
- confidence must be a number from 0 to 1.
- role_lane and coordination_handoff must be short strings.
- Prefer an executable synthesis with explicit risk controls.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(agentID),
			strings.TrimSpace(userPrompt),
			peerSnapshot,
		),
	)
}

func buildProposalAddendumPromptForAgent(userPrompt string, agentID string, baseline []agentResponse) string {
	profile := proposalRoleForAgent(agentID)
	peerLines := make([]string, 0, len(baseline))
	for _, response := range baseline {
		peerAgent := strings.ToLower(strings.TrimSpace(response.agentID))
		if peerAgent == "" || peerAgent == strings.ToLower(strings.TrimSpace(agentID)) {
			continue
		}
		structured := parseProposalStructured(response.content, response.agentID, false)
		peerStrategy := compactSingleLine(fmt.Sprint(structured["strategy"]), 160)
		if peerStrategy == "" {
			peerStrategy = compactSingleLine(response.content, 160)
		}
		peerConfidence := proposalConfidence(structured)
		peerLines = append(
			peerLines,
			fmt.Sprintf("- %s (confidence %.2f): %s", peerAgent, peerConfidence, peerStrategy),
		)
	}
	peerSnapshot := "(no baseline proposal snapshot available)"
	if len(peerLines) > 0 {
		peerSnapshot = strings.Join(peerLines, "\n")
	}
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=propose_addendum
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
TRICHAT_AGENT=%s
User objective:
%s

Late addendum mode:
The router already finalized an initial quorum response without your lane.
Respond with a concise, high-signal addendum only if you can materially improve plan quality.

Baseline proposals:
%s

Output contract:
- Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
- "plan_steps", "risks", and "commands" must be arrays of short strings.
- confidence must be a number from 0 to 1.
- strategy should focus on one differential contribution (risk, command, or sequencing correction).
- Keep the addendum crisp and execution-oriented.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(agentID),
			strings.TrimSpace(userPrompt),
			peerSnapshot,
		),
	)
}

func buildPeerContext(proposals []triChatNoveltyProposal) string {
	if len(proposals) == 0 {
		return ""
	}
	lines := make([]string, 0, len(proposals))
	for _, proposal := range proposals {
		lines = append(lines, fmt.Sprintf("%s: %s", proposal.AgentID, compactSingleLine(proposal.Content, 180)))
	}
	return strings.Join(lines, "\n")
}

func buildPeerContextFromResponses(responses []agentResponse) string {
	if len(responses) == 0 {
		return ""
	}
	lines := make([]string, 0, len(responses))
	for _, response := range responses {
		agentID := strings.ToLower(strings.TrimSpace(response.agentID))
		if agentID == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("%s: %s", agentID, compactSingleLine(response.content, 180)))
	}
	return strings.Join(lines, "\n")
}

func normalizeUniqueAgents(agents []string) []string {
	normalizedAgents := make([]string, 0, len(agents))
	seen := make(map[string]struct{}, len(agents))
	for _, agent := range agents {
		normalized := strings.ToLower(strings.TrimSpace(agent))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		normalizedAgents = append(normalizedAgents, normalized)
	}
	return normalizedAgents
}

func firstCouncilTarget(agentID string, collaborators []string) string {
	self := strings.ToLower(strings.TrimSpace(agentID))
	for _, collaborator := range collaborators {
		normalized := strings.ToLower(strings.TrimSpace(collaborator))
		if normalized != "" && normalized != self {
			return normalized
		}
	}
	return self
}

func buildCouncilQuestionPromptForAgent(
	userPrompt string,
	agentID string,
	collaborators []string,
	round int,
	peerContext string,
	critiqueContext string,
) string {
	profile := proposalRoleForAgent(agentID)
	collabLabel := strings.Join(collaborators, ",")
	if collabLabel == "" {
		collabLabel = "(none)"
	}
	if strings.TrimSpace(critiqueContext) == "" {
		critiqueContext = "(no critiques captured)"
	}
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=merge
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
TRICHAT_AGENT=%s
TRICHAT_COLLABORATORS=%s
TRICHAT_INTEROP_ROUND=%d
User objective:
%s

Council behavior:
- You are in autonomous collaboration mode.
- Pick one collaborator that should answer a high-value question before final merge.
- Ask one concise question that improves cross-agent plan quality.

Peer strategy snapshot:
%s

Critique snapshot:
%s

Return ONLY JSON with keys: target_agent, question, rationale, urgency.
- target_agent must be one of: %s
- question and rationale must be concise strings.
- urgency must be a number from 0 to 1.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(agentID),
			collabLabel,
			round,
			strings.TrimSpace(userPrompt),
			truncate(peerContext, 1200),
			truncate(critiqueContext, 1200),
			collabLabel,
		),
	)
}

func buildCouncilQuestionPromptOverrides(
	userPrompt string,
	agents []string,
	round int,
	peerContext string,
	critiqueContext string,
) map[string]string {
	overrides := make(map[string]string, len(agents))
	normalizedAgents := normalizeUniqueAgents(agents)
	if len(normalizedAgents) == 0 {
		return overrides
	}
	for _, agent := range normalizedAgents {
		collaborators := make([]string, 0, len(normalizedAgents)-1)
		for _, other := range normalizedAgents {
			if other == agent {
				continue
			}
			collaborators = append(collaborators, other)
		}
		overrides[agent] = buildCouncilQuestionPromptForAgent(
			userPrompt,
			agent,
			collaborators,
			round,
			peerContext,
			critiqueContext,
		)
	}
	return overrides
}

func parseCouncilQuestion(content string, askerAgent string, validTargets []string) councilQuestion {
	raw := strings.TrimSpace(content)
	parsed := map[string]any{}
	if extracted := extractJSONObject(raw); extracted != "" {
		var obj map[string]any
		if err := json.Unmarshal([]byte(extracted), &obj); err == nil {
			parsed = obj
		}
	}
	normalizedAsker := strings.ToLower(strings.TrimSpace(askerAgent))
	targetCandidates := make([]string, 0, len(validTargets))
	for _, target := range validTargets {
		normalized := strings.ToLower(strings.TrimSpace(target))
		if normalized == "" || normalized == normalizedAsker {
			continue
		}
		targetCandidates = append(targetCandidates, normalized)
	}
	targetSet := make(map[string]struct{}, len(targetCandidates))
	for _, target := range targetCandidates {
		targetSet[target] = struct{}{}
	}
	target := strings.ToLower(strings.TrimSpace(fmt.Sprint(parsed["target_agent"])))
	if _, ok := targetSet[target]; !ok {
		target = firstCouncilTarget(normalizedAsker, targetCandidates)
	}
	question := strings.TrimSpace(fmt.Sprint(parsed["question"]))
	if question == "" {
		question = compactSingleLine(raw, 180)
	}
	if question == "" {
		question = "What is the highest-impact change to improve your lane output?"
	}
	rationale := strings.TrimSpace(fmt.Sprint(parsed["rationale"]))
	if rationale == "" {
		rationale = "coordinate strategy delta before merge"
	}
	urgency := 0.58
	switch value := parsed["urgency"].(type) {
	case float64:
		urgency = clampFloat(value, 0.05, 0.99)
	case int:
		urgency = clampFloat(float64(value), 0.05, 0.99)
	case string:
		if parsedValue, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			urgency = clampFloat(parsedValue, 0.05, 0.99)
		}
	}
	return councilQuestion{
		AskerAgent:  normalizedAsker,
		TargetAgent: target,
		Question:    compactSingleLine(question, 220),
		Rationale:   compactSingleLine(rationale, 200),
		Urgency:     urgency,
	}
}

func groupCouncilQuestionsByTarget(questions []councilQuestion) map[string][]councilQuestion {
	grouped := make(map[string][]councilQuestion, len(questions))
	for _, question := range questions {
		target := strings.ToLower(strings.TrimSpace(question.TargetAgent))
		if target == "" {
			continue
		}
		grouped[target] = append(grouped[target], question)
	}
	return grouped
}

func shouldContinueCouncilConvergence(
	roundsCompleted int,
	minRounds int,
	maxRounds int,
	elapsed time.Duration,
	latencyBudget time.Duration,
	novelty triChatNoveltyResp,
	baselineNovelty float64,
	bestNovelty float64,
	minDelta float64,
) (bool, string) {
	if roundsCompleted <= 0 {
		return true, ""
	}
	if roundsCompleted >= maxInt(1, maxRounds) {
		return false, "max-rounds"
	}
	if roundsCompleted < maxInt(1, minRounds) {
		return true, ""
	}
	if latencyBudget > 0 && elapsed >= latencyBudget {
		return false, "latency-budget"
	}
	if novelty.Found {
		if !novelty.RetryRequired && !novelty.Disagreement {
			return false, "novelty-converged"
		}
		if (bestNovelty - baselineNovelty) >= clampFloat(minDelta, 0.01, 0.8) {
			return false, "novelty-improved"
		}
	}
	return true, ""
}

func renderIncomingCouncilQuestions(agentID string, incoming []councilQuestion) string {
	if len(incoming) == 0 {
		return "(no direct council questions for this agent)"
	}
	normalizedAgent := strings.ToLower(strings.TrimSpace(agentID))
	lines := make([]string, 0, len(incoming))
	for _, question := range incoming {
		if strings.ToLower(strings.TrimSpace(question.TargetAgent)) != normalizedAgent {
			continue
		}
		lines = append(
			lines,
			fmt.Sprintf(
				"- from %s (urgency %.2f): %s | rationale: %s",
				question.AskerAgent,
				question.Urgency,
				question.Question,
				question.Rationale,
			),
		)
	}
	if len(lines) == 0 {
		return "(no direct council questions for this agent)"
	}
	return strings.Join(lines, "\n")
}

func buildDeltaRetryPrompt(userPrompt string, agentID string, peerContext string) string {
	profile := proposalRoleForAgent(agentID)
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=propose_delta
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
User objective:
%s

You are %s.
Your previous strategy was too similar to peers. Stay in your lane (%s) and increase novelty materially.
Generate a materially different plan from the peer context below.
Peer context:
%s

Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
Do not copy or lightly paraphrase existing strategies.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(userPrompt),
			strings.TrimSpace(agentID),
			profile.RoleID,
			truncate(peerContext, 1200),
		),
	)
}

func buildInteropPromptForAgent(
	userPrompt string,
	agentID string,
	collaborators []string,
	round int,
	peerContext string,
	critiqueContext string,
	incomingQuestions []councilQuestion,
) string {
	profile := proposalRoleForAgent(agentID)
	collabLabel := strings.Join(collaborators, ",")
	if collabLabel == "" {
		collabLabel = "(none)"
	}
	if strings.TrimSpace(critiqueContext) == "" {
		critiqueContext = "(no critiques captured)"
	}
	incomingQuestionsBlock := renderIncomingCouncilQuestions(agentID, incomingQuestions)
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=merge
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
TRICHAT_AGENT=%s
TRICHAT_COLLABORATORS=%s
TRICHAT_INTEROP_ROUND=%d
User objective:
%s

You are running interop round %d. Bounce off peers and critiques while staying in your lane.

Peer strategy snapshot:
%s

Critique snapshot:
%s

Incoming council questions (address these explicitly in your merge output):
%s

Output contract:
- Keep your lane identity (%s) and produce one meaningful delta from your earlier approach.
- Integrate at least one peer idea and one critique item.
- If incoming council questions exist, address them directly in strategy or coordination_handoff.
- Return ONLY JSON with keys: strategy, plan_steps, risks, commands, confidence, role_lane, coordination_handoff.
- "plan_steps", "risks", and "commands" must be arrays of short strings.
- confidence must be a number from 0 to 1.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(agentID),
			collabLabel,
			round,
			strings.TrimSpace(userPrompt),
			round,
			truncate(peerContext, 1200),
			truncate(critiqueContext, 1200),
			truncate(incomingQuestionsBlock, 1200),
			profile.RoleID,
		),
	)
}

func buildInteropPromptOverrides(
	userPrompt string,
	agents []string,
	round int,
	peerContext string,
	critiqueContext string,
	councilQuestionsByTarget map[string][]councilQuestion,
) map[string]string {
	overrides := make(map[string]string, len(agents))
	normalizedAgents := normalizeUniqueAgents(agents)
	sort.Strings(normalizedAgents)

	for _, agent := range normalizedAgents {
		collaborators := make([]string, 0, len(normalizedAgents)-1)
		for _, other := range normalizedAgents {
			if other == agent {
				continue
			}
			collaborators = append(collaborators, other)
		}
		overrides[agent] = buildInteropPromptForAgent(
			userPrompt,
			agent,
			collaborators,
			round,
			peerContext,
			critiqueContext,
			councilQuestionsByTarget[agent],
		)
	}
	return overrides
}

func buildCritiquePrompt(userPrompt string, criticAgent string, targetAgent string, peerContext string) string {
	profile := proposalRoleForAgent(criticAgent)
	return strings.TrimSpace(
		fmt.Sprintf(
			`TRICHAT_TURN_PHASE=critique
TRICHAT_RESPONSE_MODE=json
TRICHAT_ROLE=%s
TRICHAT_ROLE_OBJECTIVE=%s
User objective:
%s

You are %s reviewing %s's proposal.
Peer context:
%s

Return ONLY JSON with keys: critique, concerns, recommendation, confidence.
- concerns must be an array of short strings.
- recommendation is one concrete improvement.
- confidence is a number from 0 to 1.`,
			profile.RoleID,
			profile.PrimaryFocus,
			strings.TrimSpace(userPrompt),
			strings.TrimSpace(criticAgent),
			strings.TrimSpace(targetAgent),
			truncate(peerContext, 1200),
		),
	)
}

func resolveCritiqueAgents(novelty triChatNoveltyResp, responses []agentResponse) []string {
	unique := make(map[string]struct{}, 3)
	if novelty.Found {
		for _, proposal := range novelty.Proposals {
			agent := strings.ToLower(strings.TrimSpace(proposal.AgentID))
			if agent != "" {
				unique[agent] = struct{}{}
			}
		}
	}
	if len(unique) == 0 {
		for _, response := range responses {
			agent := strings.ToLower(strings.TrimSpace(response.agentID))
			if agent != "" {
				unique[agent] = struct{}{}
			}
		}
	}
	agents := make([]string, 0, len(unique))
	for agent := range unique {
		agents = append(agents, agent)
	}
	sort.Strings(agents)
	return agents
}

func parseProposalStructured(content string, agentID string, delta bool) map[string]any {
	raw := strings.TrimSpace(content)
	parsed := map[string]any{}
	profile := proposalRoleForAgent(agentID)
	if extracted := extractJSONObject(raw); extracted != "" {
		var obj map[string]any
		if err := json.Unmarshal([]byte(extracted), &obj); err == nil {
			parsed = obj
		}
	}

	strategy := compactSingleLine(raw, 280)
	if value, ok := parsed["strategy"].(string); ok && strings.TrimSpace(value) != "" {
		strategy = compactSingleLine(value, 280)
	}
	planSteps := normalizeAnyStringSlice(parsed["plan_steps"])
	if len(planSteps) == 0 {
		planSteps = inferPlanSteps(raw, 4)
	}
	risks := normalizeAnyStringSlice(parsed["risks"])
	if len(risks) == 0 {
		risks = []string{"unknown risk surface"}
	}
	commands := normalizeAnyStringSlice(parsed["commands"])
	if len(commands) == 0 {
		commands = []string{}
	}
	confidence := 0.62
	switch value := parsed["confidence"].(type) {
	case float64:
		confidence = clampFloat(value, 0.05, 0.99)
	case int:
		confidence = clampFloat(float64(value), 0.05, 0.99)
	case string:
		if parsedValue, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			confidence = clampFloat(parsedValue, 0.05, 0.99)
		}
	}
	roleLane := profile.RoleID
	if value, ok := parsed["role_lane"].(string); ok && strings.TrimSpace(value) != "" {
		roleLane = compactSingleLine(value, 80)
	}
	coordinationHandoff := profile.CoordinationTip
	if value, ok := parsed["coordination_handoff"].(string); ok && strings.TrimSpace(value) != "" {
		coordinationHandoff = compactSingleLine(value, 160)
	}

	return map[string]any{
		"agent_id":             agentID,
		"delta_retry":          delta,
		"strategy":             strategy,
		"plan_steps":           planSteps,
		"risks":                risks,
		"commands":             commands,
		"confidence":           confidence,
		"role_lane":            roleLane,
		"coordination_handoff": coordinationHandoff,
		"raw_excerpt":          compactSingleLine(raw, 360),
	}
}

func parseCritiqueStructured(content string, criticAgent string, targetAgent string) map[string]any {
	raw := strings.TrimSpace(content)
	parsed := map[string]any{}
	if extracted := extractJSONObject(raw); extracted != "" {
		var obj map[string]any
		if err := json.Unmarshal([]byte(extracted), &obj); err == nil {
			parsed = obj
		}
	}

	critique := compactSingleLine(raw, 260)
	if value, ok := parsed["critique"].(string); ok && strings.TrimSpace(value) != "" {
		critique = compactSingleLine(value, 260)
	}
	recommendation := ""
	if value, ok := parsed["recommendation"].(string); ok && strings.TrimSpace(value) != "" {
		recommendation = compactSingleLine(value, 220)
	}
	concerns := normalizeAnyStringSlice(parsed["concerns"])
	if len(concerns) == 0 {
		concerns = inferPlanSteps(raw, 3)
	}
	confidence := 0.58
	switch value := parsed["confidence"].(type) {
	case float64:
		confidence = clampFloat(value, 0.05, 0.99)
	case int:
		confidence = clampFloat(float64(value), 0.05, 0.99)
	case string:
		if parsedValue, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			confidence = clampFloat(parsedValue, 0.05, 0.99)
		}
	}
	return map[string]any{
		"critic_agent":   criticAgent,
		"target_agent":   targetAgent,
		"critique":       critique,
		"concerns":       concerns,
		"recommendation": recommendation,
		"confidence":     confidence,
		"raw_excerpt":    compactSingleLine(raw, 320),
	}
}

func normalizeAnyStringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(fmt.Sprint(item))
		if text != "" {
			out = append(out, compactSingleLine(text, 180))
		}
	}
	return out
}

func inferPlanSteps(content string, limit int) []string {
	lines := strings.Split(strings.ReplaceAll(content, "\r", ""), "\n")
	out := make([]string, 0, limit)
	for _, line := range lines {
		clean := strings.TrimSpace(strings.TrimLeft(line, "-*0123456789. "))
		if clean == "" {
			continue
		}
		out = append(out, compactSingleLine(clean, 140))
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		out = append(out, compactSingleLine(content, 140))
	}
	return out
}

func extractJSONObject(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		return trimmed
	}
	start := strings.Index(trimmed, "{")
	end := strings.LastIndex(trimmed, "}")
	if start < 0 || end <= start {
		return ""
	}
	return strings.TrimSpace(trimmed[start : end+1])
}

func proposalConfidence(structured map[string]any) float64 {
	if structured == nil {
		return 0.5
	}
	switch value := structured["confidence"].(type) {
	case float64:
		return clampFloat(value, 0.05, 0.99)
	case int:
		return clampFloat(float64(value), 0.05, 0.99)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err == nil {
			return clampFloat(parsed, 0.05, 0.99)
		}
	}
	return 0.5
}

func critiqueConfidence(structured map[string]any) float64 {
	if structured == nil {
		return 0.5
	}
	switch value := structured["confidence"].(type) {
	case float64:
		return clampFloat(value, 0.05, 0.99)
	case int:
		return clampFloat(float64(value), 0.05, 0.99)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err == nil {
			return clampFloat(parsed, 0.05, 0.99)
		}
	}
	return 0.5
}

func deriveTurnDecision(novelty triChatNoveltyResp, responses []agentResponse) (string, string, string) {
	if novelty.Found && len(novelty.Proposals) > 0 {
		selected := pickDecisionProposal(novelty)
		agentID := selected.AgentID
		strategy := compactSingleLine(selected.Content, 220)
		summary := fmt.Sprintf(
			"turn decision: selected %s strategy. novelty=%.2f retry_required=%s disagreement=%s",
			agentID,
			novelty.NoveltyScore,
			onOff(novelty.RetryRequired),
			onOff(novelty.Disagreement),
		)
		return agentID, strategy, summary
	}
	if len(responses) > 0 {
		selected := responses[0]
		return selected.agentID, compactSingleLine(selected.content, 220), "turn decision: selected first response (novelty unavailable)"
	}
	return "", "", "turn decision: no proposals available"
}

func buildVerifySummary(result triChatVerifyResp, err error) string {
	if err != nil {
		return "verify error: " + compactSingleLine(err.Error(), 160)
	}
	if !result.Executed {
		if strings.TrimSpace(result.Reason) != "" {
			return "verify skipped: " + compactSingleLine(result.Reason, 120)
		}
		return "verify skipped"
	}
	passed := result.Passed != nil && *result.Passed
	if passed {
		return fmt.Sprintf("verify passed (cmd=%s exit=%s)", compactSingleLine(result.Command, 80), nullCoalesceInt(result.ExitCode))
	}
	reason := compactSingleLine(result.Error, 80)
	if reason == "" {
		reason = compactSingleLine(result.Stderr, 80)
	}
	return fmt.Sprintf(
		"verify failed (cmd=%s exit=%s timed_out=%s err=%s)",
		compactSingleLine(result.Command, 60),
		nullCoalesceInt(result.ExitCode),
		onOff(result.TimedOut),
		nullCoalesce(reason, "n/a"),
	)
}

func parseAdapterCheckArgs(parts []string, defaultTimeout int) (runAsk bool, askDryRun bool, timeoutSeconds int, agentIDs []string, usageErr string) {
	runAsk = true
	askDryRun = true
	timeoutSeconds = clampInt(defaultTimeout, 1, 120)
	uniqueAgents := map[string]struct{}{}

	for _, raw := range parts {
		token := strings.ToLower(strings.TrimSpace(raw))
		if token == "" {
			continue
		}
		switch token {
		case "ping", "ping-only", "--ping-only":
			runAsk = false
		case "ask", "ask-dry", "dry", "dry-run", "--dry-run":
			runAsk = true
			askDryRun = true
		case "live", "ask-live", "--live":
			runAsk = true
			askDryRun = false
		default:
			if parsed, err := strconv.Atoi(token); err == nil {
				timeoutSeconds = clampInt(parsed, 1, 120)
				continue
			}
			chunks := strings.Split(token, ",")
			if len(chunks) == 0 {
				return runAsk, askDryRun, timeoutSeconds, nil, "usage: /adaptercheck [ping|live|dry] [agents] [timeout_s]"
			}
			for _, chunk := range chunks {
				agent := strings.ToLower(strings.TrimSpace(chunk))
				switch agent {
				case "codex", "cursor", "local-imprint":
					uniqueAgents[agent] = struct{}{}
				default:
					return runAsk, askDryRun, timeoutSeconds, nil, "usage: /adaptercheck [ping|live|dry] [agents] [timeout_s]"
				}
			}
		}
	}

	if len(uniqueAgents) > 0 {
		agentIDs = make([]string, 0, len(uniqueAgents))
		for agentID := range uniqueAgents {
			agentIDs = append(agentIDs, agentID)
		}
		sort.Strings(agentIDs)
	}
	return runAsk, askDryRun, timeoutSeconds, agentIDs, ""
}

func adapterProtocolStepState(step *triChatAdapterProtocolCheckStep) string {
	if step == nil {
		return "skip"
	}
	if step.OK {
		return "ok"
	}
	return "fail"
}

func adapterProtocolPrimaryError(result triChatAdapterProtocolCheckResult) string {
	if !result.Ping.OK && strings.TrimSpace(result.Ping.Error) != "" {
		return result.Ping.Error
	}
	if result.Ask != nil && !result.Ask.OK && strings.TrimSpace(result.Ask.Error) != "" {
		return result.Ask.Error
	}
	return ""
}

func buildAdapterProtocolPanel(result triChatAdapterProtocolCheckResp) string {
	mode := "ping+ask(dry)"
	if !result.RunAskCheck {
		mode = "ping-only"
	} else if !result.AskDryRun {
		mode = "ping+ask(live)"
	}
	protocol := nullCoalesce(strings.TrimSpace(result.ProtocolVersion), "n/a")
	total := maxInt(result.Counts.Total, len(result.Results))
	if total <= 0 {
		total = 1
	}

	var b strings.Builder
	b.WriteString(
		fmt.Sprintf(
			"[adaptercheck] mode=%s protocol=%s all_ok=%s timeout=%ds",
			mode,
			protocol,
			onOff(result.AllOK),
			maxInt(1, result.TimeoutSeconds),
		),
	)
	b.WriteString("\n")
	b.WriteString(
		fmt.Sprintf(
			"counts ok=%d/%d ping=%d/%d ask=%d/%d",
			result.Counts.OK,
			total,
			result.Counts.PingOK,
			total,
			result.Counts.AskOK,
			total,
		),
	)

	for _, entry := range result.Results {
		pingState := adapterProtocolStepState(&entry.Ping)
		askState := adapterProtocolStepState(entry.Ask)
		askDuration := 0
		if entry.Ask != nil {
			askDuration = maxInt(0, entry.Ask.DurationMS)
		}
		b.WriteString("\n")
		b.WriteString(
			fmt.Sprintf(
				"- %s %s ping=%s(%dms) ask=%s(%dms) src=%s",
				nullCoalesce(strings.TrimSpace(entry.AgentID), "unknown"),
				ternary(entry.OK, "OK", "FAIL"),
				pingState,
				maxInt(0, entry.Ping.DurationMS),
				askState,
				askDuration,
				nullCoalesce(strings.TrimSpace(entry.CommandSource), "n/a"),
			),
		)
		if errText := adapterProtocolPrimaryError(entry); errText != "" {
			b.WriteString("\n  err: " + compactSingleLine(errText, 132))
		}
	}

	return strings.TrimSpace(b.String())
}

func pickDecisionProposal(novelty triChatNoveltyResp) triChatNoveltyProposal {
	if len(novelty.Proposals) == 1 {
		return novelty.Proposals[0]
	}
	if len(novelty.Pairs) == 0 {
		return novelty.Proposals[0]
	}

	avgByAgent := map[string]float64{}
	countByAgent := map[string]int{}
	for _, pair := range novelty.Pairs {
		avgByAgent[pair.LeftAgent] += pair.Similarity
		countByAgent[pair.LeftAgent] += 1
		avgByAgent[pair.RightAgent] += pair.Similarity
		countByAgent[pair.RightAgent] += 1
	}
	best := novelty.Proposals[0]
	bestScore := -1.0
	for _, proposal := range novelty.Proposals {
		agent := proposal.AgentID
		total := avgByAgent[agent]
		count := countByAgent[agent]
		avg := 1.0
		if count > 0 {
			avg = total / float64(count)
		}
		uniqueness := 1 - avg
		if uniqueness > bestScore {
			bestScore = uniqueness
			best = proposal
			continue
		}
		if uniqueness == bestScore && strings.Compare(proposal.AgentID, best.AgentID) < 0 {
			best = proposal
		}
	}
	return best
}

func clampFloat(value float64, min float64, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func nullCoalesceInt(value *int) string {
	if value == nil {
		return "n/a"
	}
	return strconv.Itoa(*value)
}

func (m model) trichatRetentionCmd(days int, applyAll bool, doApply bool) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation.next("trichat.retention")
	return func() tea.Msg {
		args := map[string]any{
			"mutation":        mutation,
			"older_than_days": days,
			"limit":           2000,
			"dry_run":         !doApply,
		}
		if !applyAll {
			args["thread_id"] = threadID
		}
		payload, err := caller.callTool("trichat.retention", args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		var result struct {
			CandidateCount int  `json:"candidate_count"`
			DeletedCount   int  `json:"deleted_count"`
			DryRun         bool `json:"dry_run"`
		}
		result, _ = decodeAny[struct {
			CandidateCount int  `json:"candidate_count"`
			DeletedCount   int  `json:"deleted_count"`
			DryRun         bool `json:"dry_run"`
		}](payload)
		status := fmt.Sprintf("retention %s candidates=%d deleted=%d", ternary(result.DryRun, "dry-run", "apply"), result.CandidateCount, result.DeletedCount)
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) daemonActionCmd(toolName, action string) tea.Cmd {
	caller := m.caller
	mutation := m.mutation
	return func() tea.Msg {
		args := map[string]any{"action": action}
		if action != "status" {
			args["mutation"] = mutation.next(toolName)
			if action == "start" {
				args["run_immediately"] = true
			}
		}
		payload, err := caller.callTool(toolName, args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		buf, _ := json.Marshal(payload)
		status := fmt.Sprintf("%s %s", toolName, compactSingleLine(string(buf), 140))
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) threadCommandCmd(parts []string) tea.Cmd {
	caller := m.caller
	mutation := m.mutation
	currentThreadID := m.threadID
	if len(parts) == 0 {
		return func() tea.Msg {
			return actionDoneMsg{status: "usage: /thread list [limit] | /thread new [title] | /thread use <id> | /thread archive [id]"}
		}
	}
	action := strings.ToLower(parts[0])
	switch action {
	case "list":
		limit := 15
		if len(parts) > 1 {
			if parsed, err := strconv.Atoi(parts[1]); err == nil {
				limit = parsed
			}
		}
		return func() tea.Msg {
			payload, err := caller.callTool("trichat.thread_list", map[string]any{"status": "active", "limit": maxInt(1, minInt(limit, 100))})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			var listing struct {
				Threads []triChatThread `json:"threads"`
			}
			listing, _ = decodeAny[struct {
				Threads []triChatThread `json:"threads"`
			}](payload)
			if len(listing.Threads) == 0 {
				return actionDoneMsg{status: "no active threads"}
			}
			lines := make([]string, 0, len(listing.Threads))
			for _, thread := range listing.Threads {
				lines = append(lines, fmt.Sprintf("%s (%s)", thread.ThreadID, nullCoalesce(thread.Title, "untitled")))
			}
			return actionDoneMsg{status: "threads: " + compactSingleLine(strings.Join(lines, " | "), 200)}
		}
	case "new":
		title := strings.TrimSpace(strings.Join(parts[1:], " "))
		if title == "" {
			title = fmt.Sprintf("TriChat %s", time.Now().Format("2006-01-02 15:04"))
		}
		threadID := fmt.Sprintf("trichat-%d", time.Now().Unix())
		return func() tea.Msg {
			_, err := caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"title":     title,
				"metadata":  map[string]any{"source": "trichat-tui", "created_by": "thread-new"},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "now using thread " + threadID, threadID: threadID, threadTitle: title, refresh: true}
		}
	case "use":
		if len(parts) < 2 {
			return func() tea.Msg { return actionDoneMsg{status: "usage: /thread use <thread_id>"} }
		}
		threadID := strings.TrimSpace(parts[1])
		return func() tea.Msg {
			payload, err := caller.callTool("trichat.thread_get", map[string]any{"thread_id": threadID})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			var threadGet struct {
				Found  bool          `json:"found"`
				Thread triChatThread `json:"thread"`
			}
			threadGet, _ = decodeAny[struct {
				Found  bool          `json:"found"`
				Thread triChatThread `json:"thread"`
			}](payload)
			if !threadGet.Found {
				return actionDoneMsg{status: "thread not found: " + threadID}
			}
			_, err = caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"status":    "active",
				"metadata":  map[string]any{"source": "trichat-tui", "resumed": true},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "now using thread " + threadID, threadID: threadID, threadTitle: threadGet.Thread.Title, refresh: true}
		}
	case "archive":
		threadID := currentThreadID
		if len(parts) > 1 {
			threadID = strings.TrimSpace(parts[1])
		}
		return func() tea.Msg {
			_, err := caller.callTool("trichat.thread_open", map[string]any{
				"mutation":  mutation.next("trichat.thread_open"),
				"thread_id": threadID,
				"status":    "archived",
				"metadata":  map[string]any{"source": "trichat-tui", "archived": true},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: "archived thread " + threadID, refresh: true}
		}
	default:
		return func() tea.Msg {
			return actionDoneMsg{status: "usage: /thread list [limit] | /thread new [title] | /thread use <id> | /thread archive [id]"}
		}
	}
}

func (m model) workboardCmd(limit int) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	return func() tea.Msg {
		payload, err := caller.callTool("trichat.workboard", map[string]any{
			"thread_id": threadID,
			"limit":     maxInt(1, minInt(limit, 100)),
		})
		if err != nil {
			return actionDoneMsg{err: err}
		}
		board, err := decodeAny[triChatWorkboardResp](payload)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		activePhase := "none"
		if board.ActiveTurn != nil {
			activePhase = fmt.Sprintf("%s/%s", nullCoalesce(board.ActiveTurn.Phase, "n/a"), nullCoalesce(board.ActiveTurn.PhaseStatus, "n/a"))
		}
		status := fmt.Sprintf(
			"workboard turns=%d running=%d completed=%d failed=%d active=%s",
			board.Counts["total"],
			board.Counts["running"],
			board.Counts["completed"],
			board.Counts["failed"],
			activePhase,
		)
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m model) turnCommandCmd(parts []string) tea.Cmd {
	caller := m.caller
	mutation := m.mutation
	threadID := m.threadID
	if len(parts) == 0 || strings.EqualFold(parts[0], "show") {
		turnID := ""
		if len(parts) > 1 {
			turnID = strings.TrimSpace(parts[1])
		}
		return func() tea.Msg {
			args := map[string]any{
				"include_artifacts": false,
				"include_closed":    false,
			}
			if turnID != "" {
				args["turn_id"] = turnID
			} else {
				args["thread_id"] = threadID
			}
			payload, err := caller.callTool("trichat.turn_get", args)
			if err != nil {
				return actionDoneMsg{err: err}
			}
			turn, err := decodeAny[triChatTurnGetResp](payload)
			if err != nil {
				return actionDoneMsg{err: err}
			}
			if !turn.Found {
				return actionDoneMsg{status: "no active turn"}
			}
			status := fmt.Sprintf(
				"turn %s phase=%s/%s status=%s selected=%s verify=%s",
				turn.Turn.TurnID,
				nullCoalesce(turn.Turn.Phase, "n/a"),
				nullCoalesce(turn.Turn.PhaseStatus, "n/a"),
				nullCoalesce(turn.Turn.Status, "n/a"),
				nullCoalesce(turn.Turn.SelectedAgent, "n/a"),
				nullCoalesce(turn.Turn.VerifyStatus, "n/a"),
			)
			return actionDoneMsg{status: status, refresh: true}
		}
	}

	action := strings.ToLower(strings.TrimSpace(parts[0]))
	if action == "phase" {
		if len(parts) < 2 {
			return func() tea.Msg {
				return actionDoneMsg{status: "usage: /turn phase <plan|propose|critique|merge|execute|verify|summarize> [running|completed|failed|skipped]"}
			}
		}
		phase := strings.ToLower(strings.TrimSpace(parts[1]))
		phaseStatus := "running"
		if len(parts) > 2 {
			phaseStatus = strings.ToLower(strings.TrimSpace(parts[2]))
		}
		return func() tea.Msg {
			currentPayload, err := caller.callTool("trichat.turn_get", map[string]any{
				"thread_id":         threadID,
				"include_closed":    false,
				"include_artifacts": false,
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			current, err := decodeAny[triChatTurnGetResp](currentPayload)
			if err != nil {
				return actionDoneMsg{err: err}
			}
			if !current.Found {
				return actionDoneMsg{status: "no active turn to advance"}
			}
			_, err = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":     mutation.next("trichat.turn_advance"),
				"turn_id":      current.Turn.TurnID,
				"phase":        phase,
				"phase_status": phaseStatus,
				"status":       current.Turn.Status,
				"metadata": map[string]any{
					"source":           "trichat-tui",
					"allow_phase_skip": true,
				},
			})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			return actionDoneMsg{status: fmt.Sprintf("turn %s advanced to %s/%s", current.Turn.TurnID, phase, phaseStatus), refresh: true}
		}
	}

	return func() tea.Msg {
		return actionDoneMsg{status: "usage: /turn show [turn_id] | /turn phase <phase> [phase_status]"}
	}
}

func (m model) adapterProtocolCheckCmd(parts []string) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation
	defaultTimeout := clampInt(m.settings.bridgeTimeoutSeconds, 2, 45)
	runAskCheck, askDryRun, timeoutSeconds, agentIDs, usageErr := parseAdapterCheckArgs(parts, defaultTimeout)
	if usageErr != "" {
		return func() tea.Msg {
			return actionDoneMsg{status: usageErr}
		}
	}

	return func() tea.Msg {
		args := map[string]any{
			"timeout_seconds": timeoutSeconds,
			"run_ask_check":   runAskCheck,
			"ask_dry_run":     askDryRun,
			"workspace":       m.cfg.repoRoot,
			"thread_id":       threadID,
		}
		if len(agentIDs) > 0 {
			args["agent_ids"] = agentIDs
		}

		payload, err := caller.callTool("trichat.adapter_protocol_check", args)
		if err != nil {
			return actionDoneMsg{err: err}
		}
		result, err := decodeAny[triChatAdapterProtocolCheckResp](payload)
		if err != nil {
			return actionDoneMsg{err: err}
		}

		panel := buildAdapterProtocolPanel(result)
		_, postErr := caller.callTool("trichat.message_post", map[string]any{
			"mutation":  mutation.next("trichat.message_post"),
			"thread_id": threadID,
			"agent_id":  "router",
			"role":      "assistant",
			"content":   panel,
			"metadata": map[string]any{
				"kind":            "adapter-protocol-check",
				"command":         "/adaptercheck",
				"run_ask_check":   result.RunAskCheck,
				"ask_dry_run":     result.AskDryRun,
				"timeout_seconds": result.TimeoutSeconds,
			},
		})
		if postErr != nil {
			return actionDoneMsg{err: postErr}
		}

		total := maxInt(result.Counts.Total, len(result.Results))
		status := fmt.Sprintf(
			"/adaptercheck posted · ok=%d/%d ping=%d/%d ask=%d/%d",
			result.Counts.OK,
			total,
			result.Counts.PingOK,
			total,
			result.Counts.AskOK,
			total,
		)
		if !result.AllOK {
			status += " · adapter issues detected"
		}
		return actionDoneMsg{status: status, refresh: true}
	}
}

func (m *model) interopCommandCmd(parts []string) tea.Cmd {
	if len(parts) == 0 {
		m.inflight = false
		m.statusLine = fmt.Sprintf("interop rounds=%d", m.settings.interopRounds)
		m.renderPanes()
		return nil
	}
	mode := strings.ToLower(strings.TrimSpace(parts[0]))
	next := m.settings.interopRounds
	switch mode {
	case "status":
		m.inflight = false
		m.statusLine = fmt.Sprintf("interop rounds=%d", m.settings.interopRounds)
		m.renderPanes()
		return nil
	case "off", "disable", "0":
		next = 0
	case "on", "enable", "1":
		next = maxInt(1, m.settings.interopRounds)
	case "2", "3":
		parsed, _ := strconv.Atoi(mode)
		next = parsed
	default:
		parsed, err := strconv.Atoi(mode)
		if err != nil {
			m.inflight = false
			m.statusLine = "usage: /interop status|on|off|0|1|2|3"
			return nil
		}
		next = parsed
	}
	m.settings.interopRounds = clampInt(next, 0, 3)
	m.inflight = false
	m.statusLine = fmt.Sprintf("interop rounds set: %d", m.settings.interopRounds)
	m.renderPanes()
	return nil
}

func (m model) executeCmd(agentID, objective string) tea.Cmd {
	return m.executeCmdWithRoute(agentID, objective, "/execute")
}

func (m model) executeCmdWithRoute(agentID, objective string, routeCommand string) tea.Cmd {
	caller := m.caller
	threadID := m.threadID
	mutation := m.mutation
	gateMode := m.settings.executeGateMode
	allow := m.cfg.executeAllowAgents
	approvalPhrase := m.cfg.executeApprovalPhrase
	executeBackend := normalizeExecuteBackend(m.settings.executeBackend)
	tmuxSessionName := strings.TrimSpace(m.settings.tmuxSessionName)
	if tmuxSessionName == "" {
		tmuxSessionName = "trichat-live"
	}
	tmuxWorkerCount := clampInt(m.settings.tmuxWorkerCount, 1, 12)
	tmuxMaxQueuePerWorker := clampInt(m.settings.tmuxMaxQueuePerWorker, 1, 200)
	tmuxSyncAfterDispatch := m.settings.tmuxSyncAfterDispatch
	tmuxLockLeaseSeconds := clampInt(m.settings.tmuxLockLeaseSeconds, 15, 3600)
	autoDispatchOnly := isFanoutAutoDispatchRoute(routeCommand)
	return func() (msg tea.Msg) {
		normalizedAgent := strings.ToLower(strings.TrimSpace(agentID))
		activeTurnID := ""
		defer func() {
			if recovered := recover(); recovered != nil {
				msg = actionDoneMsg{err: fmt.Errorf("execute pipeline panic: %v", recovered)}
			}
			done, ok := msg.(actionDoneMsg)
			if !ok || done.err == nil || strings.TrimSpace(activeTurnID) == "" || autoDispatchOnly {
				return
			}
			errorText := compactSingleLine(done.err.Error(), 220)
			_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
				"mutation":      mutation.next("trichat.turn_artifact"),
				"turn_id":       activeTurnID,
				"phase":         "execute",
				"artifact_type": "router_error",
				"agent_id":      "router",
				"content":       "execute failed: " + errorText,
				"structured": map[string]any{
					"agent_id": normalizedAgent,
					"error":    errorText,
				},
				"metadata": map[string]any{
					"source":             "trichat-tui",
					"auto_fail_finalize": true,
				},
			})
			_, _ = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":         mutation.next("trichat.turn_advance"),
				"turn_id":          activeTurnID,
				"phase":            "summarize",
				"phase_status":     "completed",
				"status":           "failed",
				"verify_status":    "error",
				"verify_summary":   "execute pipeline error: " + errorText,
				"decision_summary": "execute failed via " + normalizedAgent + ": " + errorText,
				"selected_agent":   normalizedAgent,
				"metadata": map[string]any{
					"source":             "trichat-tui",
					"allow_phase_skip":   true,
					"auto_fail_finalize": true,
				},
			})
			_, _ = caller.callTool("trichat.message_post", map[string]any{
				"mutation":  mutation.next("trichat.message_post"),
				"thread_id": threadID,
				"agent_id":  "router",
				"role":      "system",
				"content":   "execute for turn " + activeTurnID + " failed via " + normalizedAgent + ": " + errorText,
				"metadata": map[string]any{
					"kind":               "execute-failed",
					"source":             "trichat-tui",
					"turn_id":            activeTurnID,
					"agent_id":           normalizedAgent,
					"auto_fail_finalize": true,
				},
			})
		}()

		if normalizedAgent == "" {
			if strings.EqualFold(routeCommand, "/execute") {
				return actionDoneMsg{status: "usage: /execute <agent> [objective]"}
			}
			return actionDoneMsg{status: "auto execute skipped: missing selected agent"}
		}
		if gateMode == "allowlist" && !allow[normalizedAgent] {
			return actionDoneMsg{status: fmt.Sprintf("%s blocked: %s not in allowlist", routeCommand, normalizedAgent)}
		}
		if gateMode == "approval" {
			if !strings.Contains(objective, approvalPhrase) {
				return actionDoneMsg{status: fmt.Sprintf("%s blocked: include approval phrase '%s' in objective", routeCommand, approvalPhrase)}
			}
		}

		if strings.TrimSpace(objective) == "" {
			timelinePayload, err := caller.callTool("trichat.timeline", map[string]any{"thread_id": threadID, "limit": 140})
			if err != nil {
				return actionDoneMsg{err: err}
			}
			timeline, err := decodeAny[triChatTimelineResp](timelinePayload)
			if err != nil {
				return actionDoneMsg{err: err}
			}
			for i := len(timeline.Messages) - 1; i >= 0; i-- {
				msg := timeline.Messages[i]
				if msg.AgentID == normalizedAgent && msg.Role == "assistant" {
					objective = strings.TrimSpace(msg.Content)
					break
				}
			}
		}
		if strings.TrimSpace(objective) == "" {
			return actionDoneMsg{status: "no objective found from latest agent message"}
		}

		turnPayload, turnErr := caller.callTool("trichat.turn_get", map[string]any{
			"thread_id":         threadID,
			"include_closed":    false,
			"include_artifacts": false,
		})
		if turnErr == nil {
			turnResp, decodeErr := decodeAny[triChatTurnGetResp](turnPayload)
			if decodeErr == nil && turnResp.Found {
				activeTurnID = strings.TrimSpace(turnResp.Turn.TurnID)
			}
		}
		if activeTurnID != "" {
			_, _ = caller.callTool("trichat.turn_advance", map[string]any{
				"mutation":       mutation.next("trichat.turn_advance"),
				"turn_id":        activeTurnID,
				"phase":          "execute",
				"phase_status":   "running",
				"status":         "running",
				"selected_agent": normalizedAgent,
			})
		}

		commandPlan := extractExecuteCommandsFromObjective(objective)
		ownershipPlan := deriveOwnershipBoundExecutePlan(objective, commandPlan)
		if len(commandPlan) == 0 && len(ownershipPlan.tasks) > 0 {
			for _, task := range ownershipPlan.tasks {
				if strings.TrimSpace(task.Command) == "" {
					continue
				}
				commandPlan = append(commandPlan, task.Command)
			}
		}
		dispatchTasks := buildInteractiveTmuxTasks(commandPlan, normalizedAgent, threadID, activeTurnID)
		if len(ownershipPlan.tasks) > 0 {
			dispatchTasks = buildInteractiveTmuxTasksFromOwnedPlan(ownershipPlan.tasks, normalizedAgent, threadID, activeTurnID)
		}
		ownershipScopes := collectOwnershipScopesFromPlan(ownershipPlan.tasks)
		selectedBackend := resolveInteractiveExecuteBackend(executeBackend, commandPlan)
		executionMode := "task_create"
		tmuxDispatch := triChatTmuxDispatchResp{}
		tmuxFallbackReason := ""
		var createdPayload any = map[string]any{}
		if autoDispatchOnly {
			if len(dispatchTasks) == 0 {
				executionMode = "auto_skipped"
				tmuxFallbackReason = "no executable commands extracted from decision strategy"
			} else {
				selectedBackend = "tmux"
			}
		}

		if selectedBackend == "tmux" && executionMode != "auto_skipped" {
			if len(dispatchTasks) == 0 {
				tmuxFallbackReason = "no executable commands extracted from objective"
				if executeBackend == "tmux" && !autoDispatchOnly {
					return actionDoneMsg{err: errors.New(tmuxFallbackReason)}
				}
			} else {
				_, startErr := caller.callTool("trichat.tmux_controller", map[string]any{
					"action":               "start",
					"mutation":             mutation.next("trichat.tmux_controller.start"),
					"session_name":         tmuxSessionName,
					"workspace":            m.cfg.repoRoot,
					"worker_count":         tmuxWorkerCount,
					"max_queue_per_worker": tmuxMaxQueuePerWorker,
				})
				if startErr != nil {
					tmuxFallbackReason = "tmux start failed: " + compactSingleLine(startErr.Error(), 160)
					if executeBackend == "tmux" && !autoDispatchOnly {
						return actionDoneMsg{err: startErr}
					}
				} else {
					dispatchPayload, dispatchErr := caller.callTool("trichat.tmux_controller", map[string]any{
						"action":               "dispatch",
						"mutation":             mutation.next("trichat.tmux_controller.dispatch"),
						"session_name":         tmuxSessionName,
						"workspace":            m.cfg.repoRoot,
						"worker_count":         tmuxWorkerCount,
						"max_queue_per_worker": tmuxMaxQueuePerWorker,
						"lock_lease_seconds":   tmuxLockLeaseSeconds,
						"tasks":                dispatchTasks,
					})
					if dispatchErr != nil {
						tmuxFallbackReason = "tmux dispatch failed: " + compactSingleLine(dispatchErr.Error(), 160)
						if executeBackend == "tmux" && !autoDispatchOnly {
							return actionDoneMsg{err: dispatchErr}
						}
					} else {
						decodedDispatch, decodeErr := decodeAny[triChatTmuxDispatchResp](dispatchPayload)
						if decodeErr != nil {
							tmuxFallbackReason = "tmux dispatch decode failed: " + compactSingleLine(decodeErr.Error(), 160)
							if executeBackend == "tmux" && !autoDispatchOnly {
								return actionDoneMsg{err: decodeErr}
							}
						} else {
							tmuxDispatch = decodedDispatch
							executionMode = "tmux_dispatch"
							createdPayload = dispatchPayload
							if tmuxSyncAfterDispatch {
								_, syncErr := caller.callTool("trichat.tmux_controller", map[string]any{
									"action":               "sync",
									"mutation":             mutation.next("trichat.tmux_controller.sync"),
									"session_name":         tmuxSessionName,
									"worker_count":         tmuxWorkerCount,
									"max_queue_per_worker": tmuxMaxQueuePerWorker,
									"capture_lines":        400,
								})
								if syncErr != nil {
									tmuxFallbackReason = compactSingleLine(syncErr.Error(), 160)
								}
							}
							if activeTurnID != "" {
								_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
									"mutation":      mutation.next("trichat.turn_artifact"),
									"turn_id":       activeTurnID,
									"phase":         "execute",
									"artifact_type": "tmux_dispatch",
									"agent_id":      normalizedAgent,
									"content": fmt.Sprintf(
										"interactive tmux dispatch queued=%d dispatched=%d workers=%d",
										tmuxDispatch.QueuedCount,
										tmuxDispatch.DispatchedCount,
										tmuxDispatch.Status.WorkerCount,
									),
									"structured": map[string]any{
										"backend":                "tmux",
										"command_count":          len(commandPlan),
										"task_count":             len(dispatchTasks),
										"session_name":           tmuxDispatch.Status.SessionName,
										"enqueued_count":         tmuxDispatch.EnqueuedCount,
										"assigned_count":         tmuxDispatch.AssignedCount,
										"dispatched_count":       tmuxDispatch.DispatchedCount,
										"queued_count":           tmuxDispatch.QueuedCount,
										"failure_class":          tmuxDispatch.Dashboard.FailureClass,
										"failure_count":          tmuxDispatch.Dashboard.FailureCount,
										"ownership_plan_source":  ownershipPlan.source,
										"ownership_scope_count":  len(ownershipScopes),
										"ownership_scopes":       ownershipScopes,
										"ownership_plan_warning": nullIfEmpty(ownershipPlan.warning),
									},
									"metadata": map[string]any{
										"source":   "trichat-tui",
										"agent_id": normalizedAgent,
									},
								})
							}
						}
					}
				}
			}
		}
		if autoDispatchOnly && executionMode != "tmux_dispatch" {
			executionMode = "auto_skipped"
		}

		verifyResult := triChatVerifyResp{}
		var verifyErr error
		if executionMode == "tmux_dispatch" {
			verifyResult = triChatVerifyResp{
				OK:       tmuxDispatch.OK,
				Executed: false,
				Reason: fmt.Sprintf(
					"tmux dispatch queued=%d dispatched=%d workers=%d fail_class=%s",
					tmuxDispatch.QueuedCount,
					tmuxDispatch.DispatchedCount,
					maxInt(1, tmuxDispatch.Status.WorkerCount),
					nullCoalesce(tmuxDispatch.Dashboard.FailureClass, "none"),
				),
			}
			if len(tmuxDispatch.Failures) > 0 && strings.TrimSpace(verifyResult.Reason) != "" {
				verifyResult.Reason += " with dispatch failures"
			}
		} else if executionMode == "auto_skipped" {
			verifyResult = triChatVerifyResp{
				OK:       true,
				Executed: false,
				Reason:   "auto-dispatch skipped: " + nullCoalesce(compactSingleLine(tmuxFallbackReason, 180), "no tmux command plan"),
			}
		} else {
			taskPayload := map[string]any{
				"mutation":      mutation.next("task.create"),
				"objective":     objective,
				"project_dir":   m.cfg.repoRoot,
				"priority":      50,
				"source":        "trichat.execute",
				"source_client": "trichat-tui",
				"metadata": map[string]any{
					"thread_id":          threadID,
					"agent_id":           normalizedAgent,
					"gate_mode":          gateMode,
					"turn_id":            activeTurnID,
					"execute_backend":    executeBackend,
					"tmux_fallback_used": tmuxFallbackReason != "",
					"tmux_fallback":      nullIfEmpty(tmuxFallbackReason),
				},
			}
			var taskErr error
			createdPayload, taskErr = caller.callTool("task.create", taskPayload)
			if taskErr != nil {
				return actionDoneMsg{err: taskErr}
			}

			verifyPayload, callErr := caller.callTool("trichat.verify", map[string]any{
				"project_dir":     m.cfg.repoRoot,
				"timeout_seconds": 180,
				"capture_limit":   4000,
			})
			verifyErr = callErr
			if verifyErr == nil {
				verifyResult, _ = decodeAny[triChatVerifyResp](verifyPayload)
			}
			if strings.TrimSpace(tmuxFallbackReason) != "" {
				if strings.TrimSpace(verifyResult.Reason) != "" {
					verifyResult.Reason += "; "
				}
				verifyResult.Reason += "tmux_fallback=" + compactSingleLine(tmuxFallbackReason, 120)
			}
		}

		resultVerifyStatus := "skipped"
		if verifyErr != nil {
			resultVerifyStatus = "error"
		} else if verifyResult.Executed {
			if verifyResult.Passed != nil && *verifyResult.Passed {
				resultVerifyStatus = "passed"
			} else {
				resultVerifyStatus = "failed"
			}
		}
		gatePassed, gateReasons := evaluateExecuteReleaseGate(executeReleaseGateInput{
			executionMode:      executionMode,
			verifyStatus:       resultVerifyStatus,
			tmuxDispatch:       tmuxDispatch,
			autoDispatchOnly:   autoDispatchOnly,
			tmuxFallbackReason: tmuxFallbackReason,
		})

		turnFinalizeWarning := ""

		if activeTurnID != "" {
			verifySummary := buildVerifySummary(verifyResult, verifyErr)
			_, orchestrateErr := caller.callTool("trichat.turn_orchestrate", map[string]any{
				"mutation":      mutation.next("trichat.turn_orchestrate"),
				"turn_id":       activeTurnID,
				"action":        "verify_finalize",
				"verify_status": resultVerifyStatus,
				"verify_summary": fmt.Sprintf(
					"execute routed via %s; %s",
					normalizedAgent,
					verifySummary,
				),
				"verify_details": map[string]any{
					"executed":  verifyResult.Executed,
					"passed":    verifyResult.Passed,
					"command":   verifyResult.Command,
					"exit_code": verifyResult.ExitCode,
					"timed_out": verifyResult.TimedOut,
					"error":     compactSingleLine(nullCoalesce(verifyResult.Error, ""), 160),
					"objective": compactSingleLine(objective, 220),
					"agent_id":  normalizedAgent,
					"backend":   executionMode,
					"tmux": map[string]any{
						"session_name":      tmuxDispatch.Status.SessionName,
						"queue_depth":       tmuxDispatch.Dashboard.QueueDepth,
						"queue_age_seconds": tmuxDispatch.Dashboard.QueueAgeSeconds,
						"failure_class":     tmuxDispatch.Dashboard.FailureClass,
						"failure_count":     tmuxDispatch.Dashboard.FailureCount,
						"dispatched_count":  tmuxDispatch.DispatchedCount,
						"queued_count":      tmuxDispatch.QueuedCount,
					},
				},
			})
			if orchestrateErr != nil {
				turnFinalizeWarning = compactSingleLine(orchestrateErr.Error(), 140)
				_, _ = caller.callTool("trichat.turn_artifact", map[string]any{
					"mutation":      mutation.next("trichat.turn_artifact"),
					"turn_id":       activeTurnID,
					"phase":         "verify",
					"artifact_type": "verifier_result",
					"agent_id":      "router",
					"content":       verifySummary,
					"structured": map[string]any{
						"executed":  verifyResult.Executed,
						"passed":    verifyResult.Passed,
						"command":   verifyResult.Command,
						"exit_code": verifyResult.ExitCode,
						"timed_out": verifyResult.TimedOut,
						"error":     compactSingleLine(nullCoalesce(verifyResult.Error, ""), 160),
					},
					"metadata": map[string]any{"source": "trichat-tui-fallback"},
				})
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":       mutation.next("trichat.turn_advance"),
					"turn_id":        activeTurnID,
					"phase":          "verify",
					"phase_status":   ternary(resultVerifyStatus == "failed" || resultVerifyStatus == "error", "failed", "completed"),
					"status":         ternary(resultVerifyStatus == "failed" || resultVerifyStatus == "error", "failed", "running"),
					"verify_status":  resultVerifyStatus,
					"verify_summary": verifySummary,
				})
				_, _ = caller.callTool("trichat.turn_advance", map[string]any{
					"mutation":          mutation.next("trichat.turn_advance"),
					"turn_id":           activeTurnID,
					"phase":             "summarize",
					"phase_status":      "completed",
					"status":            ternary(resultVerifyStatus == "failed" || resultVerifyStatus == "error", "failed", "completed"),
					"verify_status":     resultVerifyStatus,
					"verify_summary":    verifySummary,
					"decision_summary":  fmt.Sprintf("execute routed via %s; verify=%s", normalizedAgent, resultVerifyStatus),
					"selected_agent":    normalizedAgent,
					"selected_strategy": compactSingleLine(objective, 220),
				})
			}
		}

		status := ""
		if executionMode == "tmux_dispatch" {
			status = fmt.Sprintf(
				"tmux dispatch: session=%s dispatched=%d queued=%d workers=%d queue_age=%s fail_class=%s",
				nullCoalesce(tmuxDispatch.Status.SessionName, tmuxSessionName),
				tmuxDispatch.DispatchedCount,
				tmuxDispatch.QueuedCount,
				maxInt(1, tmuxDispatch.Status.WorkerCount),
				formatTmuxQueueAge(tmuxDispatch.Dashboard.QueueAgeSeconds),
				nullCoalesce(tmuxDispatch.Dashboard.FailureClass, "none"),
			)
			if len(tmuxDispatch.Failures) > 0 {
				status += fmt.Sprintf(" | dispatch_failures=%d", len(tmuxDispatch.Failures))
			}
		} else if executionMode == "auto_skipped" {
			status = "auto execute skipped: " + nullCoalesce(compactSingleLine(tmuxFallbackReason, 160), "no tmux dispatch reason")
		} else {
			createdJSON, _ := json.Marshal(createdPayload)
			status = "task created: " + compactSingleLine(string(createdJSON), 160)
		}
		if verifyErr != nil {
			status += " | verify=error(" + compactSingleLine(verifyErr.Error(), 90) + ")"
		} else if verifyResult.Executed {
			passed := verifyResult.Passed != nil && *verifyResult.Passed
			status += fmt.Sprintf(" | verify=%s", ternary(passed, "passed", "failed"))
		} else {
			status += " | verify=skipped"
		}
		if strings.TrimSpace(tmuxFallbackReason) != "" && executionMode != "tmux_dispatch" {
			status += " | tmux_fallback=" + compactSingleLine(tmuxFallbackReason, 120)
		}
		if strings.TrimSpace(turnFinalizeWarning) != "" {
			status += " | turn_finalize=fallback(" + turnFinalizeWarning + ")"
		}
		if gatePassed {
			status += " | gate=passed"
		} else {
			status += " | gate=failed(" + compactSingleLine(strings.Join(gateReasons, "; "), 140) + ")"
		}

		_, _ = caller.callTool("trichat.message_post", map[string]any{
			"mutation":  mutation.next("trichat.message_post"),
			"thread_id": threadID,
			"agent_id":  "router",
			"role":      "system",
			"content":   status,
			"metadata":  map[string]any{"kind": "command-route", "command": routeCommand},
		})
		return actionDoneMsg{
			status:           status,
			refresh:          true,
			routeCommand:     routeCommand,
			executionMode:    executionMode,
			verifyStatus:     resultVerifyStatus,
			dispatchFailures: len(tmuxDispatch.Failures),
			autoSkipped:      executionMode == "auto_skipped",
			gatePassed:       gatePassed,
			gateReasons:      gateReasons,
		}
	}
}

func resolveInteractiveExecuteBackend(preferred string, commands []string) string {
	backend := normalizeExecuteBackend(preferred)
	switch backend {
	case "tmux":
		return "tmux"
	case "direct":
		return "direct"
	default:
		if len(commands) > 0 {
			return "tmux"
		}
		return "direct"
	}
}

func isFanoutAutoDispatchRoute(routeCommand string) bool {
	return strings.EqualFold(strings.TrimSpace(routeCommand), "/fanout-autoexec")
}

type ownershipBoundExecuteTask struct {
	Title          string
	Command        string
	Priority       int
	Complexity     int
	OwnershipScope string
	OwnershipMode  string
	OwnershipRule  string
}

type ownershipBoundExecutePlan struct {
	tasks   []ownershipBoundExecuteTask
	source  string
	warning string
}

type executeReleaseGateInput struct {
	executionMode      string
	verifyStatus       string
	tmuxDispatch       triChatTmuxDispatchResp
	autoDispatchOnly   bool
	tmuxFallbackReason string
}

func evaluateExecuteReleaseGate(input executeReleaseGateInput) (bool, []string) {
	reasons := make([]string, 0, 6)
	switch strings.ToLower(strings.TrimSpace(input.verifyStatus)) {
	case "failed", "error":
		reasons = append(reasons, "verify="+strings.ToLower(strings.TrimSpace(input.verifyStatus)))
	}
	if len(input.tmuxDispatch.Failures) > 0 {
		reasons = append(reasons, fmt.Sprintf("dispatch_failures=%d", len(input.tmuxDispatch.Failures)))
	}
	if input.executionMode == "auto_skipped" {
		reason := strings.TrimSpace(input.tmuxFallbackReason)
		if reason == "" {
			reason = "no-dispatch"
		}
		reasons = append(reasons, "auto_skipped="+compactSingleLine(reason, 120))
	}
	if input.executionMode == "tmux_dispatch" && input.tmuxDispatch.DispatchedCount <= 0 {
		reasons = append(reasons, "dispatch_count=0")
	}
	if input.autoDispatchOnly && input.executionMode != "tmux_dispatch" && input.executionMode != "auto_skipped" {
		reasons = append(reasons, "route-not-tmux")
	}
	return len(reasons) == 0, reasons
}

func deriveOwnershipBoundExecutePlan(objective string, fallbackCommands []string) ownershipBoundExecutePlan {
	trimmed := strings.TrimSpace(objective)
	if trimmed != "" {
		if structured := extractOwnershipBoundTasksFromJSON(trimmed); len(structured) > 0 {
			return ownershipBoundExecutePlan{
				tasks:  structured,
				source: "structured",
			}
		}
	}
	tasks := make([]ownershipBoundExecuteTask, 0, len(fallbackCommands))
	for idx, command := range fallbackCommands {
		clean := compactSingleLine(strings.TrimSpace(command), 260)
		if clean == "" {
			continue
		}
		scope := inferOwnershipScopeForCommand(clean)
		mode := inferOwnershipModeForCommand(clean)
		tasks = append(tasks, ownershipBoundExecuteTask{
			Title:          inferOwnershipTaskTitle(scope, clean, idx+1),
			Command:        clean,
			Priority:       clampInt(100-idx*4, 40, 100),
			Complexity:     estimateInteractiveTmuxTaskComplexity(clean),
			OwnershipScope: scope,
			OwnershipMode:  mode,
			OwnershipRule:  fmt.Sprintf("Restrict mutations to scope '%s' and avoid cross-scope writes.", scope),
		})
	}
	return ownershipBoundExecutePlan{
		tasks:  tasks,
		source: ternary(len(tasks) > 0, "heuristic", "none"),
	}
}

func extractOwnershipBoundTasksFromJSON(raw string) []ownershipBoundExecuteTask {
	payload := extractJSONObject(raw)
	if strings.TrimSpace(payload) == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return nil
	}

	tasks := make([]ownershipBoundExecuteTask, 0, 16)
	if direct, ok := parsed["tmux_tasks"]; ok {
		tasks = append(tasks, normalizeOwnershipTaskInput(direct)...)
	}
	if len(tasks) == 0 {
		if workstreams, ok := parsed["workstreams"]; ok {
			tasks = append(tasks, normalizeOwnershipTaskInput(workstreams)...)
		}
	}
	if len(tasks) == 0 {
		if tasksValue, ok := parsed["tasks"]; ok {
			tasks = append(tasks, normalizeOwnershipTaskInput(tasksValue)...)
		}
	}
	return dedupeOwnershipBoundTasks(tasks)
}

func normalizeOwnershipTaskInput(value any) []ownershipBoundExecuteTask {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	tasks := make([]ownershipBoundExecuteTask, 0, len(items)*2)
	for index, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		title := compactSingleLine(strings.TrimSpace(fmt.Sprint(row["title"])), 120)
		scope := inferOwnershipScopeForValue(row["ownership_scope"])
		if scope == "" {
			scope = inferOwnershipScopeForValue(row["scope"])
		}
		if scope == "" {
			scope = inferOwnershipScopeForValue(row["ownership_path"])
		}
		if scope == "" {
			scope = inferOwnershipScopeForValue(row["path"])
		}
		if scope == "" {
			scope = "repo-root"
		}
		ownershipMode := strings.ToLower(strings.TrimSpace(fmt.Sprint(row["ownership_mode"])))
		if ownershipMode != "mutating" && ownershipMode != "read_only" {
			ownershipMode = ""
		}
		if ownershipMode == "" {
			ownershipMode = inferOwnershipModeForCommand(fmt.Sprint(row["command"]))
		}
		rule := compactSingleLine(strings.TrimSpace(fmt.Sprint(row["ownership_rule"])), 180)
		if rule == "" {
			rule = fmt.Sprintf("Restrict mutations to scope '%s' and avoid cross-scope writes.", scope)
		}
		commands := normalizeExecuteCommandList(row["commands"])
		singleCommand := compactSingleLine(strings.TrimSpace(fmt.Sprint(row["command"])), 260)
		if len(commands) == 0 && looksLikeExecutableCommand(singleCommand) {
			commands = append(commands, singleCommand)
		}
		for cmdIndex, command := range commands {
			trimmed := compactSingleLine(strings.TrimSpace(command), 260)
			if trimmed == "" {
				continue
			}
			taskTitle := title
			if taskTitle == "" {
				taskTitle = inferOwnershipTaskTitle(scope, trimmed, index+cmdIndex+1)
			}
			tasks = append(tasks, ownershipBoundExecuteTask{
				Title:          taskTitle,
				Command:        trimmed,
				Priority:       clampInt(100-(index+cmdIndex)*4, 35, 100),
				Complexity:     estimateInteractiveTmuxTaskComplexity(trimmed),
				OwnershipScope: scope,
				OwnershipMode:  ownershipMode,
				OwnershipRule:  rule,
			})
		}
	}
	return tasks
}

func dedupeOwnershipBoundTasks(tasks []ownershipBoundExecuteTask) []ownershipBoundExecuteTask {
	out := make([]ownershipBoundExecuteTask, 0, len(tasks))
	seen := map[string]struct{}{}
	for _, task := range tasks {
		command := compactSingleLine(strings.TrimSpace(task.Command), 260)
		if command == "" {
			continue
		}
		scope := task.OwnershipScope
		if scope == "" {
			scope = "repo-root"
		}
		mode := task.OwnershipMode
		if mode == "" {
			mode = inferOwnershipModeForCommand(command)
		}
		key := strings.ToLower(strings.TrimSpace(scope + "::" + mode + "::" + command))
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		task.Command = command
		task.OwnershipScope = scope
		task.OwnershipMode = mode
		if strings.TrimSpace(task.Title) == "" {
			task.Title = inferOwnershipTaskTitle(scope, command, len(out)+1)
		}
		task.Priority = clampInt(task.Priority, 1, 100)
		if task.Priority == 0 {
			task.Priority = clampInt(100-len(out)*4, 35, 100)
		}
		task.Complexity = clampInt(task.Complexity, 1, 100)
		if task.Complexity == 0 {
			task.Complexity = estimateInteractiveTmuxTaskComplexity(command)
		}
		out = append(out, task)
	}
	return out
}

func inferOwnershipScopeForValue(value any) string {
	raw := strings.TrimSpace(fmt.Sprint(value))
	if raw == "" || raw == "<nil>" {
		return ""
	}
	return normalizeOwnershipScope(raw)
}

func normalizeOwnershipScope(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "\\", "/")
	normalized = strings.Trim(normalized, "/")
	if normalized == "" || normalized == "." {
		return "repo-root"
	}
	normalized = strings.Join(strings.Fields(normalized), "-")
	return normalized
}

func inferOwnershipScopeForCommand(command string) string {
	normalized := strings.ToLower(strings.TrimSpace(command))
	if normalized == "" {
		return "repo-root"
	}
	if match := ownershipScopePattern.FindStringSubmatch(normalized); len(match) >= 2 {
		return normalizeOwnershipScope(match[1])
	}
	switch {
	case strings.Contains(normalized, "test"):
		return "tests"
	case strings.Contains(normalized, "lint") || strings.Contains(normalized, "format"):
		return "quality"
	case strings.Contains(normalized, "build") || strings.Contains(normalized, "bundle") || strings.Contains(normalized, "tsc"):
		return "build"
	default:
		return "repo-root"
	}
}

func inferOwnershipModeForCommand(command string) string {
	if looksLikeMutatingCommand(command) {
		return "mutating"
	}
	return "read_only"
}

func inferOwnershipTaskTitle(scope string, command string, index int) string {
	baseScope := strings.TrimSpace(scope)
	if baseScope == "" {
		baseScope = "repo-root"
	}
	firstToken := ""
	parts := strings.Fields(strings.TrimSpace(command))
	if len(parts) > 0 {
		firstToken = strings.ToLower(strings.TrimSpace(parts[0]))
	}
	if firstToken == "" {
		firstToken = "task"
	}
	return fmt.Sprintf("%s lane %d (%s)", baseScope, index, firstToken)
}

func collectOwnershipScopesFromPlan(tasks []ownershipBoundExecuteTask) []string {
	seen := map[string]struct{}{}
	scopes := make([]string, 0, len(tasks))
	for _, task := range tasks {
		scope := strings.TrimSpace(task.OwnershipScope)
		if scope == "" {
			continue
		}
		key := strings.ToLower(scope)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	return scopes
}

func deriveAutoExecuteObjective(
	selectedAgent string,
	selectedStrategy string,
	decisionSummary string,
	responses []agentResponse,
) string {
	normalizedSelected := strings.ToLower(strings.TrimSpace(selectedAgent))
	if normalizedSelected != "" {
		for _, response := range responses {
			candidateAgent := strings.ToLower(strings.TrimSpace(response.agentID))
			if candidateAgent == "" || candidateAgent != normalizedSelected {
				continue
			}
			candidate := strings.TrimSpace(response.content)
			if candidate == "" {
				continue
			}
			if len(extractExecuteCommandsFromObjective(candidate)) > 0 {
				return candidate
			}
		}
	}
	if strings.TrimSpace(selectedStrategy) != "" {
		return strings.TrimSpace(selectedStrategy)
	}
	if strings.TrimSpace(decisionSummary) != "" {
		return strings.TrimSpace(decisionSummary)
	}
	for _, response := range responses {
		candidate := strings.TrimSpace(response.content)
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

func buildAutoExecuteCycleObjective(
	baseObjective string,
	decisionSummary string,
	cycle int,
	previousCycleStatus []string,
) string {
	trimmedBase := strings.TrimSpace(baseObjective)
	if cycle <= 1 || trimmedBase == "" {
		return trimmedBase
	}
	baseCommands := extractExecuteCommandsFromObjective(trimmedBase)
	if len(baseCommands) == 0 {
		return trimmedBase
	}
	reviewCommand := "git status --short"
	verifyCommand := pickAutoExecuteVerifyCommand(baseCommands)
	fixCommand := baseCommands[(cycle-2)%len(baseCommands)]
	featureCommand := baseCommands[(cycle-1)%len(baseCommands)]
	tmuxTasks := []map[string]any{
		{
			"title":           fmt.Sprintf("cycle-%d review", cycle),
			"commands":        []string{reviewCommand},
			"ownership_scope": "repo-root",
			"ownership_mode":  "read_only",
			"ownership_rule":  "Inspect current repo state and identify highest-signal fixes.",
		},
		{
			"title":           fmt.Sprintf("cycle-%d fix", cycle),
			"commands":        []string{fixCommand},
			"ownership_scope": inferOwnershipScopeForCommand(fixCommand),
			"ownership_mode":  inferOwnershipModeForCommand(fixCommand),
			"ownership_rule":  "Apply highest-priority corrective action in assigned scope only.",
		},
		{
			"title":           fmt.Sprintf("cycle-%d feature", cycle),
			"commands":        []string{featureCommand},
			"ownership_scope": inferOwnershipScopeForCommand(featureCommand),
			"ownership_mode":  inferOwnershipModeForCommand(featureCommand),
			"ownership_rule":  "Apply incremental quality/feature improvement in assigned scope only.",
		},
		{
			"title":           fmt.Sprintf("cycle-%d verify", cycle),
			"commands":        []string{verifyCommand},
			"ownership_scope": inferOwnershipScopeForCommand(verifyCommand),
			"ownership_mode":  "read_only",
			"ownership_rule":  "Run release verification and report pass/fail status for this cycle.",
		},
	}
	mergedCommands := dedupeStringList([]string{
		reviewCommand,
		fixCommand,
		featureCommand,
		verifyCommand,
	})
	payload := map[string]any{
		"strategy":         fmt.Sprintf("Iterative auto-exec cycle %d (review/fix/feature/verify)", cycle),
		"decision_summary": compactSingleLine(decisionSummary, 220),
		"cycle":            cycle,
		"cycle_kind":       "review_fix_feature_verify",
		"commands":         mergedCommands,
		"tmux_tasks":       tmuxTasks,
	}
	if len(previousCycleStatus) > 0 {
		payload["previous_cycles"] = previousCycleStatus
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return trimmedBase
	}
	return string(raw)
}

func pickAutoExecuteVerifyCommand(commands []string) string {
	for _, command := range commands {
		lower := strings.ToLower(strings.TrimSpace(command))
		if lower == "" {
			continue
		}
		if strings.Contains(lower, "test") || strings.Contains(lower, "verify") {
			return compactSingleLine(strings.TrimSpace(command), 260)
		}
	}
	for _, command := range commands {
		lower := strings.ToLower(strings.TrimSpace(command))
		if lower == "" {
			continue
		}
		if strings.Contains(lower, "lint") || strings.Contains(lower, "build") {
			return compactSingleLine(strings.TrimSpace(command), 260)
		}
	}
	return compactSingleLine(strings.TrimSpace(commands[0]), 260)
}

func dedupeStringList(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		candidate := compactSingleLine(strings.TrimSpace(value), 260)
		if candidate == "" {
			continue
		}
		key := strings.ToLower(candidate)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, candidate)
	}
	return out
}

func extractExecuteCommandsFromObjective(objective string) []string {
	trimmed := strings.TrimSpace(objective)
	if trimmed == "" {
		return nil
	}

	if fromStructured := extractExecuteCommandsFromJSON(trimmed); len(fromStructured) > 0 {
		return fromStructured
	}
	return extractExecuteCommandsFromText(trimmed)
}

func extractExecuteCommandsFromJSON(raw string) []string {
	payload := extractJSONObject(raw)
	if strings.TrimSpace(payload) == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return nil
	}
	return normalizeExecuteCommandList(parsed["commands"])
}

func normalizeExecuteCommandList(value any) []string {
	var raw []string
	switch typed := value.(type) {
	case []string:
		raw = append(raw, typed...)
	case []any:
		for _, item := range typed {
			raw = append(raw, fmt.Sprint(item))
		}
	default:
		return nil
	}
	seen := map[string]struct{}{}
	commands := make([]string, 0, len(raw))
	for _, item := range raw {
		candidate := strings.TrimSpace(item)
		candidate = strings.Trim(candidate, "`")
		if candidate == "" {
			continue
		}
		if !looksLikeExecutableCommand(candidate) {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(candidate))
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		commands = append(commands, compactSingleLine(candidate, 240))
	}
	return commands
}

func extractExecuteCommandsFromText(raw string) []string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r", ""), "\n")
	candidates := make([]string, 0, 8)
	for _, line := range lines {
		clean := strings.TrimSpace(strings.TrimLeft(line, "-*0123456789. "))
		clean = strings.Trim(clean, "`")
		if clean == "" {
			continue
		}
		if !looksLikeExecutableCommand(clean) {
			continue
		}
		candidates = append(candidates, clean)
		if len(candidates) >= 8 {
			break
		}
	}
	return normalizeExecuteCommandList(anySliceFromString(candidates))
}

func anySliceFromString(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func looksLikeExecutableCommand(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if strings.Contains(trimmed, "{") && strings.Contains(trimmed, "}") {
		return false
	}
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return false
	}
	head := strings.ToLower(strings.TrimSpace(fields[0]))
	if head == "" {
		return false
	}
	if strings.HasPrefix(head, "./") || strings.HasPrefix(head, "/") {
		return true
	}
	knownHeads := map[string]struct{}{
		"npm": {}, "pnpm": {}, "yarn": {}, "npx": {}, "node": {}, "python": {}, "python3": {}, "uv": {},
		"pytest": {}, "go": {}, "cargo": {}, "make": {}, "git": {}, "bash": {}, "sh": {}, "zsh": {},
		"docker": {}, "kubectl": {}, "terraform": {}, "ansible": {}, "rg": {}, "cat": {}, "ls": {},
	}
	if _, ok := knownHeads[head]; ok {
		return true
	}
	if len(fields) < 2 {
		return false
	}
	if strings.Contains(trimmed, "&&") || strings.Contains(trimmed, "|") || strings.Contains(trimmed, ";") {
		return true
	}
	for _, token := range fields[1:] {
		if strings.HasPrefix(token, "-") {
			return true
		}
		if strings.ContainsAny(token, "/.=:_") {
			return true
		}
	}
	return false
}

func looksLikeMutatingCommand(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return false
	}
	if strings.Contains(normalized, ">") || strings.Contains(normalized, ">>") {
		return true
	}
	patterns := []string{
		" npm install", " pnpm install", " yarn add", " yarn remove", " git add", " git commit", " git merge",
		" git cherry-pick", " rm ", " mv ", " cp ", " sed -i", " perl -i", " tee ", " touch ", " mkdir ",
	}
	padded := " " + normalized + " "
	for _, marker := range patterns {
		if strings.Contains(padded, marker) {
			return true
		}
	}
	return false
}

func buildInteractiveTmuxTasks(commands []string, agentID string, threadID string, turnID string) []map[string]any {
	tasks := make([]map[string]any, 0, len(commands))
	for index, command := range commands {
		priority := clampInt(100-index*4, 50, 100)
		complexity := estimateInteractiveTmuxTaskComplexity(command)
		task := map[string]any{
			"title":      fmt.Sprintf("%s lane task %d", nullCoalesce(agentID, "agent"), index+1),
			"command":    command,
			"priority":   priority,
			"complexity": complexity,
			"thread_id":  threadID,
			"metadata": map[string]any{
				"source":      "trichat.execute",
				"agent_id":    agentID,
				"command_idx": index + 1,
			},
		}
		if strings.TrimSpace(turnID) != "" {
			task["turn_id"] = turnID
		}
		tasks = append(tasks, task)
	}
	return tasks
}

func buildInteractiveTmuxTasksFromOwnedPlan(
	plan []ownershipBoundExecuteTask,
	agentID string,
	threadID string,
	turnID string,
) []map[string]any {
	tasks := make([]map[string]any, 0, len(plan))
	for index, lane := range plan {
		command := compactSingleLine(strings.TrimSpace(lane.Command), 260)
		if command == "" || !looksLikeExecutableCommand(command) {
			continue
		}
		scope := normalizeOwnershipScope(lane.OwnershipScope)
		mode := strings.ToLower(strings.TrimSpace(lane.OwnershipMode))
		if mode != "mutating" && mode != "read_only" {
			mode = inferOwnershipModeForCommand(command)
		}
		rule := strings.TrimSpace(lane.OwnershipRule)
		if rule == "" {
			rule = fmt.Sprintf("Restrict mutations to scope '%s' and avoid cross-scope writes.", scope)
		}
		title := strings.TrimSpace(lane.Title)
		if title == "" {
			title = inferOwnershipTaskTitle(scope, command, index+1)
		}
		priority := clampInt(lane.Priority, 1, 100)
		if priority == 0 {
			priority = clampInt(100-index*4, 35, 100)
		}
		complexity := clampInt(lane.Complexity, 1, 100)
		if complexity == 0 {
			complexity = estimateInteractiveTmuxTaskComplexity(command)
		}

		task := map[string]any{
			"title":      title,
			"command":    command,
			"priority":   priority,
			"complexity": complexity,
			"thread_id":  threadID,
			"metadata": map[string]any{
				"source":              "trichat.execute",
				"agent_id":            agentID,
				"command_idx":         index + 1,
				"ownership_scope":     scope,
				"ownership_mode":      mode,
				"ownership_rule":      rule,
				"ownership_guardrail": true,
				"mutating_command":    looksLikeMutatingCommand(command),
			},
		}
		if strings.TrimSpace(turnID) != "" {
			task["turn_id"] = turnID
		}
		tasks = append(tasks, task)
	}
	return tasks
}

func estimateInteractiveTmuxTaskComplexity(command string) int {
	text := strings.ToLower(strings.TrimSpace(command))
	words := strings.Fields(text)
	score := 28 + len(words)*4 + minInt(len(text)/12, 26)
	heavyMarkers := []string{
		"build", "test", "install", "deploy", "docker", "compose", "benchmark", "lint", "format", "bundle",
	}
	for _, marker := range heavyMarkers {
		if strings.Contains(text, marker) {
			score += 10
		}
	}
	if strings.Contains(text, "&&") || strings.Contains(text, ";") || strings.Contains(text, "|") {
		score += 12
	}
	return clampInt(score, 10, 95)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	switch msg := msg.(type) {
	case initDoneMsg:
		if msg.err != nil {
			m.startupErr = msg.err
			m.statusLine = "startup failed"
			m.logError(msg.err)
			return m, nil
		}
		m.threadID = msg.threadID
		m.threadTitle = msg.threadTitle
		m.orch.setBootstrap(msg.bootstrap)
		m.orch.restoreStates(msg.states, m.settings)
		m.ready = true
		m.statusLine = fmt.Sprintf("ready · thread=%s", m.threadID)
		cmds = append(cmds, m.refreshCmd(), m.busInitCmd(m.threadID))
	case refreshDoneMsg:
		m.refreshing = false
		if msg.err != nil {
			m.logError(msg.err)
			m.statusLine = "refresh failed"
			break
		}
		m.messages = msg.messages
		m.reliability = msg.reliability
		m.lastRefresh = time.Now()
		if !m.busListening && msg.reliability.busStatus.Running && strings.TrimSpace(msg.reliability.busStatus.SocketPath) != "" {
			cmd := m.startBusListener(msg.reliability.busStatus.SocketPath)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		m.renderPanes()
	case busInitMsg:
		if msg.err != nil {
			m.appendLog("bus init failed: " + compactSingleLine(msg.err.Error(), 160))
			break
		}
		m.reliability.busStatus = msg.status
		m.mergeBusEvents(msg.events)
		if !m.busListening && msg.status.Running && strings.TrimSpace(msg.status.SocketPath) != "" {
			cmd := m.startBusListener(msg.status.SocketPath)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		m.renderPanes()
	case busTailMsg:
		if msg.err != nil {
			m.appendLog("bus tail failed: " + compactSingleLine(msg.err.Error(), 160))
			break
		}
		m.mergeBusEvents(msg.events)
		m.renderPanes()
	case busLiveStatusMsg:
		m.busLiveConn = msg.connected
		m.busSocketPath = nullCoalesce(msg.socket, m.busSocketPath)
		if strings.TrimSpace(msg.info) != "" {
			if msg.connected {
				m.busLiveError = ""
			} else {
				m.busLiveError = msg.info
			}
		}
		m.renderPanes()
		cmds = append(cmds, waitBusMsg(m.busInbound))
	case busLiveEventMsg:
		if m.mergeBusEvents([]triChatBusEvent{msg.event}) {
			m.renderPanes()
		}
		cmds = append(cmds, waitBusMsg(m.busInbound))
	case actionDoneMsg:
		m.inflight = false
		if msg.err != nil {
			m.logError(msg.err)
			m.statusLine = "action failed"
		} else if strings.TrimSpace(msg.status) != "" {
			m.statusLine = msg.status
			m.appendLog(msg.status)
		}
		if msg.adaptiveEvaluated {
			m.lastAdaptiveDecision = ternary(msg.adaptiveApplied, "applied", "steady")
			m.lastAdaptiveReason = strings.TrimSpace(msg.adaptiveReason)
			m.lastAdaptiveP95MS = msg.adaptiveP95MS
			m.lastAdaptiveSamples = maxInt(0, msg.adaptiveSamples)
			m.lastAdaptiveAt = time.Now()
		}
		if msg.adaptiveApplied {
			m.settings.modelTimeoutSeconds = clampInt(msg.modelTimeout, 1, 120)
			m.settings.bridgeTimeoutSeconds = clampInt(msg.bridgeTimeout, 1, 120)
			m.settings.adapterFailoverTimeoutSecond = clampInt(msg.failoverTimeout, 1, 120)
			if strings.TrimSpace(msg.adaptiveReason) != "" {
				m.appendLog(
					fmt.Sprintf(
						"adaptive timeouts applied (%s): model=%ds bridge=%ds failover=%ds",
						msg.adaptiveReason,
						m.settings.modelTimeoutSeconds,
						m.settings.bridgeTimeoutSeconds,
						m.settings.adapterFailoverTimeoutSecond,
					),
				)
			}
		}
		threadChanged := false
		if strings.TrimSpace(msg.threadID) != "" {
			if msg.threadID != m.threadID {
				threadChanged = true
			}
			m.threadID = msg.threadID
		}
		if strings.TrimSpace(msg.threadTitle) != "" {
			m.threadTitle = msg.threadTitle
		}
		if msg.refresh {
			cmds = append(cmds, m.refreshCmd())
		}
		if threadChanged {
			cmds = append(cmds, m.busTailCmd(m.threadID, 80))
		}
	case tickMsg:
		if m.settings.autoRefresh && m.ready && !m.refreshing && !m.inflight {
			m.refreshing = true
			cmds = append(cmds, m.refreshCmd())
		}
		cmds = append(cmds, tickEvery(m.settings.pollInterval))
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resize()
		m.renderPanes()
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		if m.launcherActive {
			m.launcherPulse = (m.launcherPulse + 1) % 24
		}
		cmds = append(cmds, cmd)
	case tea.MouseMsg:
		if m.launcherActive || m.startupErr != nil || m.quitConfirm {
			break
		}
		switch m.activeTab {
		case tabChat:
			var cmd tea.Cmd
			m.timeline, cmd = m.timeline.Update(msg)
			cmds = append(cmds, cmd)
		case tabReliability:
			var cmd tea.Cmd
			m.sidebar, cmd = m.sidebar.Update(msg)
			cmds = append(cmds, cmd)
		}
	case tea.KeyMsg:
		if key := msg.String(); key == "ctrl+c" {
			return m, tea.Quit
		}
		if m.startupErr != nil {
			if msg.String() == "q" || msg.String() == "esc" || msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
			return m, nil
		}
		if m.quitConfirm {
			switch msg.String() {
			case "y", "Y", "enter":
				return m, tea.Quit
			case "n", "N", "esc":
				m.quitConfirm = false
				m.statusLine = "quit canceled"
				m.renderPanes()
				return m, tea.Batch(cmds...)
			default:
				return m, tea.Batch(cmds...)
			}
		}
		if m.launcherActive {
			switch msg.String() {
			case "up", "k":
				m.launcherIndex = (m.launcherIndex + len(m.launcherItems) - 1) % len(m.launcherItems)
			case "down", "j":
				m.launcherIndex = (m.launcherIndex + 1) % len(m.launcherItems)
			case "esc":
				m.launcherActive = false
				m.activeTab = tabChat
				m.input.Focus()
				m.statusLine = "launcher skipped · chat ready"
				m.renderPanes()
			case "q":
				m.beginQuitConfirm()
				return m, tea.Batch(cmds...)
			case "enter":
				switch m.launcherIndex {
				case 0:
					m.launcherActive = false
					m.activeTab = tabChat
					m.input.Focus()
					if m.ready {
						m.statusLine = "tri-chat ready"
					} else {
						m.statusLine = "starting tri-chat..."
					}
					m.renderPanes()
				case 1:
					m.launcherActive = false
					m.activeTab = tabReliability
					m.input.Blur()
					m.statusLine = "reliability panel"
					m.renderPanes()
				case 2:
					m.launcherActive = false
					m.activeTab = tabSettings
					m.input.Blur()
					m.statusLine = "settings panel"
					m.renderPanes()
				case 3:
					m.launcherActive = false
					m.activeTab = tabHelp
					m.input.Blur()
					m.statusLine = "help panel"
					m.renderPanes()
				case 4:
					m.beginQuitConfirm()
					return m, tea.Batch(cmds...)
				}
			}
			return m, tea.Batch(cmds...)
		}

		switch msg.String() {
		case "esc":
			if m.activeTab == tabChat {
				m.beginQuitConfirm()
				return m, tea.Batch(cmds...)
			}
			m.launcherActive = true
			m.launcherIndex = launcherIndexForTab(m.activeTab)
			m.input.Blur()
			m.statusLine = "launcher menu"
			m.renderPanes()
			return m, tea.Batch(cmds...)
		case "tab":
			m.activeTab = (m.activeTab + 1) % 4
			if m.activeTab == tabChat {
				m.input.Focus()
			} else {
				m.input.Blur()
			}
			m.renderPanes()
			return m, tea.Batch(cmds...)
		case "shift+tab":
			m.activeTab = (m.activeTab + 3) % 4
			if m.activeTab == tabChat {
				m.input.Focus()
			} else {
				m.input.Blur()
			}
			m.renderPanes()
			return m, tea.Batch(cmds...)
		}

		switch m.activeTab {
		case tabChat:
			switch msg.String() {
			case "ctrl+a":
				if m.inflight || !m.ready {
					return m, tea.Batch(cmds...)
				}
				m.inflight = true
				cmds = append(cmds, m.adapterProtocolCheckCmd(nil))
				return m, tea.Batch(cmds...)
			case "enter":
				if m.inflight || !m.ready {
					return m, tea.Batch(cmds...)
				}
				raw := strings.TrimSpace(m.input.Value())
				if raw == "" {
					return m, tea.Batch(cmds...)
				}
				m.input.SetValue("")
				if strings.HasPrefix(raw, "/") {
					cmd := m.handleSlash(raw)
					if cmd != nil {
						m.inflight = true
						cmds = append(cmds, cmd)
					}
					return m, tea.Batch(cmds...)
				}
				m.inflight = true
				cmds = append(cmds, m.fanoutCmd(raw, m.settings.fanoutTarget))
				return m, tea.Batch(cmds...)
			case "pgup", "ctrl+b":
				m.timeline.LineUp(8)
				return m, tea.Batch(cmds...)
			case "pgdown", "ctrl+f":
				m.timeline.LineDown(8)
				return m, tea.Batch(cmds...)
			case "up":
				if strings.TrimSpace(m.input.Value()) == "" {
					m.timeline.LineUp(4)
					return m, tea.Batch(cmds...)
				}
			case "down":
				if strings.TrimSpace(m.input.Value()) == "" {
					m.timeline.LineDown(4)
					return m, tea.Batch(cmds...)
				}
			case "-", "_", "ctrl+u":
				if strings.TrimSpace(m.input.Value()) == "" {
					m.timeline.LineUp(8)
					return m, tea.Batch(cmds...)
				}
			case "=", "+", "ctrl+d":
				if strings.TrimSpace(m.input.Value()) == "" {
					m.timeline.LineDown(8)
					return m, tea.Batch(cmds...)
				}
			case "home":
				m.timeline.GotoTop()
				return m, tea.Batch(cmds...)
			case "end":
				m.timeline.GotoBottom()
				return m, tea.Batch(cmds...)
			}
			var cmd tea.Cmd
			m.input, cmd = m.input.Update(msg)
			cmds = append(cmds, cmd)
		case tabSettings:
			adjusted := false
			switch msg.String() {
			case "up", "k":
				m.settingsIndex = maxInt(0, m.settingsIndex-1)
			case "down", "j":
				m.settingsIndex = minInt(m.maxSettingsIndex(), m.settingsIndex+1)
			case "left", "h", "-":
				m.adjustSetting(-1)
				adjusted = true
			case "right", "l", "+":
				m.adjustSetting(1)
				adjusted = true
			}
			if adjusted && m.ready && !m.refreshing && !m.inflight {
				m.refreshing = true
				cmds = append(cmds, m.refreshCmd())
			}
			m.renderPanes()
		case tabReliability:
			switch msg.String() {
			case "pgup", "k", "up", "-", "_", "ctrl+u":
				m.sidebar.LineUp(4)
			case "pgdown", "j", "down", "=", "+", "ctrl+d":
				m.sidebar.LineDown(4)
			}
		}
	}
	return m, tea.Batch(cmds...)
}

func (m *model) handleSlash(raw string) tea.Cmd {
	parts := strings.Fields(strings.TrimSpace(raw))
	if len(parts) == 0 {
		return nil
	}
	cmd := strings.ToLower(parts[0])
	tail := parts[1:]
	switch cmd {
	case "/help":
		m.activeTab = tabHelp
		m.renderPanes()
		m.inflight = false
		return nil
	case "/quit", "/exit":
		m.inflight = false
		m.beginQuitConfirm()
		return nil
	case "/panel":
		return m.refreshCmd()
	case "/adaptercheck":
		return m.adapterProtocolCheckCmd(tail)
	case "/interop":
		return m.interopCommandCmd(tail)
	case "/autoexec":
		if len(tail) == 0 || strings.EqualFold(strings.TrimSpace(tail[0]), "status") {
			m.inflight = false
			m.statusLine = fmt.Sprintf(
				"auto post-decision execute: %s cycles=%d breaker=%d",
				onOff(m.settings.autoExecuteAfterDecision),
				m.settings.autoExecuteCycleCount,
				m.settings.autoExecuteBreakerFailures,
			)
			return nil
		}
		mode := strings.ToLower(strings.TrimSpace(tail[0]))
		switch mode {
		case "on", "enable", "1", "true":
			m.settings.autoExecuteAfterDecision = true
		case "off", "disable", "0", "false":
			m.settings.autoExecuteAfterDecision = false
		case "cycles":
			if len(tail) < 2 {
				m.inflight = false
				m.statusLine = "usage: /autoexec cycles <1-4>"
				return nil
			}
			parsed, err := strconv.Atoi(strings.TrimSpace(tail[1]))
			if err != nil {
				m.inflight = false
				m.statusLine = "usage: /autoexec cycles <1-4>"
				return nil
			}
			m.settings.autoExecuteCycleCount = clampInt(parsed, 1, 4)
		case "breaker":
			if len(tail) < 2 {
				m.inflight = false
				m.statusLine = "usage: /autoexec breaker <1-5>"
				return nil
			}
			parsed, err := strconv.Atoi(strings.TrimSpace(tail[1]))
			if err != nil {
				m.inflight = false
				m.statusLine = "usage: /autoexec breaker <1-5>"
				return nil
			}
			m.settings.autoExecuteBreakerFailures = clampInt(parsed, 1, 5)
		default:
			m.inflight = false
			m.statusLine = "usage: /autoexec status|on|off|cycles <1-4>|breaker <1-5>"
			return nil
		}
		m.inflight = false
		m.statusLine = fmt.Sprintf(
			"auto post-decision execute set: %s cycles=%d breaker=%d",
			onOff(m.settings.autoExecuteAfterDecision),
			m.settings.autoExecuteCycleCount,
			m.settings.autoExecuteBreakerFailures,
		)
		m.renderPanes()
		return nil
	case "/councilstrip":
		if len(tail) == 0 {
			m.inflight = false
			m.statusLine = "council strip mode: " + m.settings.councilStripMode
			return nil
		}
		mode := normalizeCouncilStripMode(tail[0])
		if mode != strings.ToLower(strings.TrimSpace(tail[0])) {
			m.inflight = false
			m.statusLine = "usage: /councilstrip always|auto|off"
			return nil
		}
		m.settings.councilStripMode = mode
		m.inflight = false
		m.statusLine = "council strip mode set: " + mode
		m.renderPanes()
		return nil
	case "/fanout":
		if len(tail) == 0 {
			m.inflight = false
			m.statusLine = "fanout target: " + m.settings.fanoutTarget
			return nil
		}
		target := strings.ToLower(strings.TrimSpace(tail[0]))
		if target != "all" && target != "codex" && target != "cursor" && target != "local-imprint" {
			m.inflight = false
			m.statusLine = "usage: /fanout all|codex|cursor|local-imprint"
			return nil
		}
		m.settings.fanoutTarget = target
		m.inflight = false
		m.statusLine = "fanout target set: " + target
		m.renderPanes()
		return nil
	case "/agent":
		if len(tail) < 2 {
			m.inflight = false
			m.statusLine = "usage: /agent <codex|cursor|local-imprint> <message>"
			return nil
		}
		target := strings.ToLower(strings.TrimSpace(tail[0]))
		if target != "codex" && target != "cursor" && target != "local-imprint" {
			m.inflight = false
			m.statusLine = "unknown agent: " + target
			return nil
		}
		prompt := strings.TrimSpace(strings.Join(tail[1:], " "))
		if prompt == "" {
			m.inflight = false
			m.statusLine = "usage: /agent <agent> <message>"
			return nil
		}
		return m.fanoutCmd(prompt, target)
	case "/thread":
		return m.threadCommandCmd(tail)
	case "/workboard":
		limit := 20
		if len(tail) > 0 {
			if parsed, err := strconv.Atoi(strings.TrimSpace(tail[0])); err == nil {
				limit = parsed
			}
		}
		return m.workboardCmd(limit)
	case "/turn":
		return m.turnCommandCmd(tail)
	case "/retry":
		action := "status"
		if len(tail) > 0 {
			action = strings.ToLower(tail[0])
		}
		if !validAction(action) {
			m.inflight = false
			m.statusLine = "usage: /retry status|start|stop|run_once"
			return nil
		}
		return m.daemonActionCmd("task.auto_retry", action)
	case "/retentiond":
		action := "status"
		if len(tail) > 0 {
			action = strings.ToLower(tail[0])
		}
		if !validAction(action) {
			m.inflight = false
			m.statusLine = "usage: /retentiond status|start|stop|run_once"
			return nil
		}
		return m.daemonActionCmd("trichat.auto_retention", action)
	case "/retention":
		days := 14
		apply := false
		allThreads := false
		if len(tail) > 0 {
			if parsed, err := strconv.Atoi(tail[0]); err == nil {
				days = parsed
			}
		}
		for _, token := range tail[1:] {
			normalized := strings.ToLower(strings.TrimSpace(token))
			if normalized == "apply" {
				apply = true
			}
			if normalized == "all" {
				allThreads = true
			}
		}
		return m.trichatRetentionCmd(maxInt(0, days), allThreads, apply)
	case "/execute":
		if len(tail) == 0 {
			m.inflight = false
			m.statusLine = "usage: /execute <agent> [objective]"
			return nil
		}
		agentID := tail[0]
		objective := strings.TrimSpace(strings.Join(tail[1:], " "))
		return m.executeCmd(agentID, objective)
	default:
		m.inflight = false
		m.statusLine = "unknown command: " + cmd
		return nil
	}
}

func validAction(action string) bool {
	switch action {
	case "status", "start", "stop", "run_once":
		return true
	default:
		return false
	}
}

func (m model) View() string {
	if m.startupErr != nil {
		errorPanel := m.theme.panel.
			Width(maxInt(20, m.width-4)).
			Render(
				m.theme.panelTitle.Render("TriChat TUI Startup Failed") + "\n\n" +
					m.theme.errorStatus.Render(m.startupErr.Error()) + "\n\n" +
					m.theme.helpText.Render("Press q or Ctrl+C to exit."),
			)
		return m.theme.root.Render(errorPanel)
	}
	out := ""
	if m.launcherActive {
		out = m.renderLauncher()
	} else {
		header := m.renderHeader()
		content := m.renderContent()
		input := m.renderInput()
		footer := m.renderFooter()
		out = lipgloss.JoinVertical(lipgloss.Left, header, content, input, footer)
	}
	if m.quitConfirm {
		out = m.renderQuitModal()
	}
	return m.theme.root.Render(out)
}

func (m *model) renderLauncher() string {
	contentWidth := maxInt(48, minInt(100, m.width-4))
	if contentWidth <= 0 {
		contentWidth = 72
	}

	pulseOn := ((m.launcherPulse / 2) % 2) == 0
	titleStyle := m.theme.launcherTitle
	frameStyle := m.theme.launcherFrame
	if pulseOn {
		titleStyle = m.theme.launcherTitlePulse
		frameStyle = m.theme.launcherFrameAlt
	}

	innerWidth := clampInt(contentWidth-8, 34, 74)
	rule := "+" + strings.Repeat("-", innerWidth) + "+"
	headerA := "| " + padRight("TRI-CHAT ARCADE CONSOLE", innerWidth-2) + " |"
	headerB := "| " + padRight("one prompt -> three agents", innerWidth-2) + " |"

	statusLabel := "BOOTING"
	statusStyle := m.theme.launcherBoot
	statusDetail := "running startup pipeline: tool health -> thread open -> imprint bootstrap"
	if m.ready {
		statusLabel = "ONLINE"
		statusStyle = m.theme.launcherReady
		statusDetail = "anamnesis runtime synced. pick a pane or start chatting."
	} else if strings.TrimSpace(m.statusLine) != "" && !strings.EqualFold(strings.TrimSpace(m.statusLine), "starting...") {
		statusDetail = compactSingleLine(m.statusLine, 120)
	}
	bootLine := statusStyle.Render("["+statusLabel+"]") + " " + statusDetail

	var options strings.Builder
	for idx, item := range m.launcherItems {
		prefix := "   "
		if idx == m.launcherIndex {
			prefix = ">> "
		}
		line := fmt.Sprintf("%s%d. %s", prefix, idx+1, item)
		if idx == m.launcherIndex {
			options.WriteString(m.theme.launcherSelect.Render(line))
		} else {
			options.WriteString(m.theme.launcherOption.Render(line))
		}
		options.WriteString("\n")
	}

	art := []string{
		"    /\\_/\\        /\\_/\\        /\\_/\\",
		"   ( o.o )      ( o.o )      ( o.o )",
		"    > ^ <        > ^ <        > ^ <",
	}

	body := strings.Join([]string{
		titleStyle.Render("TriChat"),
		m.theme.launcherMuted.Render("Retro launcher for your three-agent terminal apartment"),
		"",
		m.theme.launcherAccent.Render(rule),
		m.theme.launcherAccent.Render(headerA),
		m.theme.launcherAccent.Render(headerB),
		m.theme.launcherAccent.Render(rule),
		"",
		m.theme.launcherAccent.Render(strings.Join(art, "\n")),
		"",
		m.spinner.View() + " " + bootLine,
		m.theme.launcherMuted.Render("Thread: " + nullCoalesce(m.threadID, "initializing...")),
		m.theme.launcherMuted.Render("Roster: codex | cursor | local-imprint"),
		"",
		strings.TrimRight(options.String(), "\n"),
		"",
		m.theme.launcherMuted.Render("Keys: up/down choose | enter launch | esc skip to chat | q quit prompt"),
	}, "\n")
	body = applyScanlineOverlay(body, m.theme.launcherScanlineA, m.theme.launcherScanlineB)

	panel := frameStyle.Width(contentWidth).Render(body)
	return lipgloss.Place(
		maxInt(contentWidth+2, m.width-2),
		maxInt(16, m.height-2),
		lipgloss.Center,
		lipgloss.Center,
		panel,
	)
}

func padRight(text string, width int) string {
	if width <= 0 {
		return ""
	}
	if len(text) >= width {
		return text[:width]
	}
	return text + strings.Repeat(" ", width-len(text))
}

func launcherIndexForTab(tab tabID) int {
	switch tab {
	case tabReliability:
		return 1
	case tabSettings:
		return 2
	case tabHelp:
		return 3
	default:
		return 0
	}
}

func (m *model) beginQuitConfirm() {
	m.quitConfirm = true
	m.statusLine = "ARE YOU SURE YOU WANT TO QUIT?"
}

func applyScanlineOverlay(text string, lineA lipgloss.Style, lineB lipgloss.Style) string {
	lines := strings.Split(text, "\n")
	maxWidth := 0
	for _, line := range lines {
		maxWidth = maxInt(maxWidth, lipgloss.Width(line))
	}
	if maxWidth <= 0 {
		return text
	}
	out := make([]string, 0, len(lines))
	for idx, line := range lines {
		padded := line + strings.Repeat(" ", maxInt(0, maxWidth-lipgloss.Width(line)))
		if idx%2 == 0 {
			out = append(out, lineA.Render(padded))
		} else {
			out = append(out, lineB.Render(padded))
		}
	}
	return strings.Join(out, "\n")
}

func (m *model) renderHeader() string {
	tabs := []struct {
		id    tabID
		label string
	}{
		{tabChat, "Chat"},
		{tabReliability, "Reliability"},
		{tabSettings, "Settings"},
		{tabHelp, "Help"},
	}
	segments := make([]string, 0, len(tabs)+1)
	for _, tab := range tabs {
		style := m.theme.tabInactive
		if tab.id == m.activeTab {
			style = m.theme.tabActive
		}
		segments = append(segments, style.Render(tab.label))
	}
	threadMeta := fmt.Sprintf("Thread: %s", nullCoalesce(m.threadID, "n/a"))
	segments = append(segments, m.theme.helpText.Render(threadMeta))
	joined := lipgloss.JoinHorizontal(lipgloss.Left, segments...)
	return m.theme.header.Width(maxInt(20, m.width-4)).Render(joined)
}

func (m *model) renderContent() string {
	contentHeight := maxInt(8, m.height-12)
	contentWidth := maxInt(40, m.width-4)

	switch m.activeTab {
	case tabChat:
		mainPanelHeight, busStripHeight := chatPanelHeights(contentHeight)
		leftWidth := int(float64(contentWidth) * 0.66)
		rightWidth := contentWidth - leftWidth - 1
		if rightWidth < 28 {
			rightWidth = 28
			leftWidth = contentWidth - rightWidth - 1
		}
		left := m.theme.panel.Width(leftWidth).Height(mainPanelHeight).Render(
			m.theme.panelTitle.Render("Live Timeline") + "\n" + m.timeline.View(),
		)
		right := m.theme.panel.Width(rightWidth).Height(mainPanelHeight).Render(
			m.theme.panelTitle.Render("Reliability + Workboard") + "\n" + m.sidebar.View(),
		)
		top := lipgloss.JoinHorizontal(lipgloss.Top, left, right)
		bus := m.theme.panel.Width(contentWidth).Height(busStripHeight).Render(
			m.theme.panelTitle.Render("Live Bus Strip") + "\n" + m.renderBusStrip(),
		)
		return lipgloss.JoinVertical(lipgloss.Left, top, bus)
	case tabReliability:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("Reliability Detail") + "\n" + m.renderReliabilityDetail())
	case tabSettings:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("Runtime Settings") + "\n" + m.renderSettings())
	case tabHelp:
		panel := m.theme.panel.Width(contentWidth).Height(contentHeight)
		return panel.Render(m.theme.panelTitle.Render("TriChat TUI Help") + "\n" + m.renderHelp())
	default:
		return ""
	}
}

func (m *model) renderBusStrip() string {
	threadID := strings.TrimSpace(m.threadID)
	socketName := "(unset)"
	if strings.TrimSpace(m.busSocketPath) != "" {
		socketName = filepath.Base(m.busSocketPath)
	} else if strings.TrimSpace(m.reliability.busStatus.SocketPath) != "" {
		socketName = filepath.Base(m.reliability.busStatus.SocketPath)
	}
	connection := "reconnecting"
	if m.busLiveConn {
		connection = "connected"
	} else if !m.busListening {
		connection = "idle"
	}

	var b strings.Builder
	b.WriteString(
		m.theme.helpText.Render(
			fmt.Sprintf(
				"Feed %s · socket=%s · clients=%d subs=%d · published=%d",
				connection,
				socketName,
				m.reliability.busStatus.ClientCount,
				m.reliability.busStatus.SubscriptionCount,
				m.reliability.busStatus.Metrics.TotalPublished,
			),
		),
	)

	rendered := 0
	selected := make([]triChatBusEvent, 0, busStripMaxRows)
	for i := len(m.busEvents) - 1; i >= 0 && len(selected) < busStripMaxRows; i-- {
		event := m.busEvents[i]
		if threadID != "" && strings.TrimSpace(event.ThreadID) != threadID {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(event.EventType), "trichat.message_post") {
			continue
		}
		selected = append(selected, event)
	}
	for i := len(selected) - 1; i >= 0; i-- {
		event := selected[i]
		agent := strings.TrimSpace(event.SourceAgent)
		if agent == "" {
			agent = "system"
		}
		style, ok := m.theme.chatAgent[agent]
		if !ok {
			style = m.theme.chatAgent["system"]
		}
		prefix := style.Render(fmt.Sprintf("%s %s", shortTime(event.CreatedAt), agent))
		content := compactSingleLine(strings.TrimSpace(event.Content), 100)
		detail := event.EventType
		if content != "" {
			detail += " :: " + content
		}
		b.WriteString("\n")
		b.WriteString(prefix + " " + detail)
		rendered++
	}

	if rendered == 0 {
		b.WriteString("\n")
		if strings.TrimSpace(m.busLiveError) != "" {
			b.WriteString(m.theme.helpText.Render("No adapter events yet. " + compactSingleLine(m.busLiveError, 110)))
		} else {
			b.WriteString(m.theme.helpText.Render("No adapter events yet for this thread. Live bridge signals will appear here."))
		}
	}
	return strings.TrimSpace(b.String())
}

func (m *model) renderInput() string {
	contentWidth := maxInt(40, m.width-4)
	if m.activeTab != tabChat {
		return m.theme.inputPanel.Width(contentWidth).Render(m.theme.helpText.Render("Input disabled outside Chat tab. Press Tab to return."))
	}
	inputView := m.input.View()
	if m.inflight {
		inputView = m.spinner.View() + " processing... " + inputView
	}
	return m.theme.inputPanel.Width(contentWidth).Render(inputView)
}

func (m *model) renderFooter() string {
	contentWidth := maxInt(40, m.width-4)
	statusStyle := m.theme.status
	if strings.Contains(strings.ToLower(m.statusLine), "failed") || strings.Contains(strings.ToLower(m.statusLine), "error") {
		statusStyle = m.theme.errorStatus
	}
	line := statusStyle.Render(compactSingleLine(m.statusLine, 180))
	hints := m.theme.helpText.Render("Keys: Tab switch view · Enter send · Ctrl+A adapter check · PgUp/PgDn or Up/Down (input empty) or +/- scroll · Esc menu/quit prompt · Ctrl+C quit")
	return m.theme.footer.Width(contentWidth).Render(line + "\n" + hints)
}

func (m *model) renderQuitModal() string {
	canvasWidth := maxInt(40, m.width-4)
	canvasHeight := maxInt(12, m.height-4)
	modalWidth := clampInt(int(float64(canvasWidth)*0.56), 42, 78)
	if modalWidth > canvasWidth-2 {
		modalWidth = canvasWidth - 2
	}
	if modalWidth < 32 {
		modalWidth = 32
	}

	title := m.theme.errorStatus.Render("EXIT ARCADE?")
	subtitle := m.theme.helpText.Render("Are you sure you want to quit TriChat?")
	prompt := m.theme.settingPick.Render("[Y / Enter] Quit") + "    " + m.theme.helpText.Render("[N / Esc] Return")
	accent := m.theme.launcherAccent.Render("========================================")
	body := strings.Join([]string{
		title,
		subtitle,
		"",
		accent,
		m.theme.helpText.Render("Your thread and telemetry are already persisted."),
		accent,
		"",
		prompt,
	}, "\n")
	panel := m.theme.launcherFrameAlt.Width(modalWidth).Render(body)
	return lipgloss.Place(
		canvasWidth,
		canvasHeight,
		lipgloss.Center,
		lipgloss.Center,
		panel,
		lipgloss.WithWhitespaceBackground(lipgloss.Color("#120924")),
	)
}

func (m *model) renderPanes() {
	prevTimelineYOffset := m.timeline.YOffset
	prevTimelineAtBottom := m.timeline.AtBottom()
	prevSidebarYOffset := m.sidebar.YOffset
	prevSidebarAtBottom := m.sidebar.AtBottom()

	contentHeight := maxInt(8, m.height-12)
	contentWidth := maxInt(40, m.width-4)
	mainPanelHeight, _ := chatPanelHeights(contentHeight)
	leftWidth := int(float64(contentWidth) * 0.66)
	rightWidth := contentWidth - leftWidth - 1
	if rightWidth < 28 {
		rightWidth = 28
		leftWidth = contentWidth - rightWidth - 1
	}

	m.timeline.Width = maxInt(20, leftWidth-4)
	m.timeline.Height = maxInt(5, mainPanelHeight-3)
	m.sidebar.Width = maxInt(20, rightWidth-4)
	m.sidebar.Height = maxInt(5, mainPanelHeight-3)

	m.timeline.SetContent(m.renderTimeline())
	if prevTimelineAtBottom {
		m.timeline.GotoBottom()
	} else {
		m.timeline.SetYOffset(prevTimelineYOffset)
	}
	m.sidebar.SetContent(m.renderSidebar())
	if prevSidebarAtBottom {
		m.sidebar.GotoBottom()
	} else {
		m.sidebar.SetYOffset(prevSidebarYOffset)
	}
}

func (m *model) mergeBusEvents(events []triChatBusEvent) bool {
	if len(events) == 0 {
		return false
	}
	changed := false
	for _, event := range events {
		eventID := strings.TrimSpace(event.EventID)
		if eventID != "" {
			if _, exists := m.busSeenEventID[eventID]; exists {
				continue
			}
			m.busSeenEventID[eventID] = struct{}{}
		}
		m.busEvents = append(m.busEvents, event)
		if event.EventSeq > m.busLastSeq {
			m.busLastSeq = event.EventSeq
		}
		changed = true
	}
	if len(m.busEvents) > busStripMaxEvents {
		m.busEvents = m.busEvents[len(m.busEvents)-busStripMaxEvents:]
		seen := make(map[string]struct{}, len(m.busEvents))
		for _, event := range m.busEvents {
			if id := strings.TrimSpace(event.EventID); id != "" {
				seen[id] = struct{}{}
			}
		}
		m.busSeenEventID = seen
	}
	return changed
}

func chatPanelHeights(contentHeight int) (mainPanelHeight int, busStripHeight int) {
	mainPanelHeight = maxInt(6, contentHeight-7)
	busStripHeight = maxInt(5, contentHeight-mainPanelHeight)
	if mainPanelHeight+busStripHeight > contentHeight {
		mainPanelHeight = maxInt(5, contentHeight-busStripHeight)
	}
	return mainPanelHeight, busStripHeight
}

func (m *model) resize() {
	contentWidth := maxInt(40, m.width-4)
	m.input.Width = maxInt(20, contentWidth-6)
}

func (m *model) renderTimeline() string {
	if len(m.messages) == 0 {
		return "No messages yet. Send a prompt to start tri-agent fanout."
	}
	councilMode := normalizeCouncilStripMode(m.settings.councilStripMode)
	councilMessages := make([]triChatMessage, 0, len(m.messages))
	userFacingMessages := make([]triChatMessage, 0, len(m.messages))
	for _, msg := range m.messages {
		// System/router chatter is useful for audit trails but noisy in live chat.
		if msg.Role == "system" {
			continue
		}
		if isCouncilTranscriptMessage(msg) {
			councilMessages = append(councilMessages, msg)
			continue
		}
		userFacingMessages = append(userFacingMessages, msg)
	}
	if len(councilMessages) > councilStripMaxRows {
		councilMessages = councilMessages[len(councilMessages)-councilStripMaxRows:]
	}
	showCouncilStrip := false
	switch councilMode {
	case "always":
		showCouncilStrip = true
	case "auto":
		showCouncilStrip = len(councilMessages) > 0
	case "off":
		showCouncilStrip = false
	}

	var b strings.Builder
	if showCouncilStrip {
		b.WriteString(m.theme.panelTitle.Render("Council Transcript Strip"))
		b.WriteString("\n")
		if len(councilMessages) == 0 {
			b.WriteString(m.theme.helpText.Render("(no agent-to-agent council exchanges yet)"))
			b.WriteString("\n\n")
		} else {
			for _, msg := range councilMessages {
				timestamp := shortTime(msg.CreatedAt)
				agentLabel := msg.AgentID
				if strings.TrimSpace(agentLabel) == "" {
					agentLabel = msg.Role
				}
				style, ok := m.theme.chatAgent[agentLabel]
				if !ok {
					style = m.theme.chatAgent["system"]
				}
				header := fmt.Sprintf("%s [council %s/%s]", timestamp, agentLabel, msg.Role)
				b.WriteString(style.Render(header))
				b.WriteString("\n")
				preview := compactTimelineMessage(msg.Content, 5, timelineMaxChars)
				b.WriteString(wrapText(preview, maxInt(24, m.timeline.Width-2)))
				b.WriteString("\n\n")
			}
		}
	}

	b.WriteString(m.theme.panelTitle.Render("User-Facing Timeline"))
	b.WriteString("\n")
	if len(userFacingMessages) == 0 {
		b.WriteString(m.theme.helpText.Render("(no user-facing messages yet)"))
		b.WriteString("\n")
	}
	for _, msg := range userFacingMessages {
		timestamp := shortTime(msg.CreatedAt)
		agentLabel := msg.AgentID
		if strings.TrimSpace(agentLabel) == "" {
			agentLabel = msg.Role
		}
		style, ok := m.theme.chatAgent[agentLabel]
		if !ok {
			style = m.theme.chatAgent["system"]
		}
		header := fmt.Sprintf("%s [%s/%s]", timestamp, agentLabel, msg.Role)
		b.WriteString(style.Render(header))
		b.WriteString("\n")
		preview := compactTimelineMessage(msg.Content, timelineMaxLines, timelineMaxChars)
		b.WriteString(wrapText(preview, maxInt(24, m.timeline.Width-2)))
		b.WriteString("\n\n")
	}
	if strings.TrimSpace(b.String()) == "" {
		return "No user/assistant messages yet. Send a prompt to start tri-agent fanout."
	}
	return strings.TrimSpace(b.String())
}

func (m *model) adaptiveSidebarLine() string {
	decision := strings.TrimSpace(m.lastAdaptiveDecision)
	reason := strings.TrimSpace(m.lastAdaptiveReason)
	p95 := m.lastAdaptiveP95MS
	samples := m.lastAdaptiveSamples

	if decision == "" {
		_, tuning := deriveAdaptiveTimeouts(m.settings, m.reliability.slo)
		decision = adaptiveDecisionLabel(tuning)
		reason = strings.TrimSpace(tuning.Reason)
		p95 = tuning.P95LatencyMS
		samples = tuning.SampleCount
	}
	if decision == "" {
		decision = "steady"
	}

	line := fmt.Sprintf(
		"Adaptive  %s active=%ds/%ds/%ds",
		decision,
		m.settings.modelTimeoutSeconds,
		m.settings.bridgeTimeoutSeconds,
		m.settings.adapterFailoverTimeoutSecond,
	)
	if p95 > 0 && samples > 0 {
		line += fmt.Sprintf(" p95=%.0fms n=%d", p95, samples)
	}
	if reason != "" && reason != "applied" && reason != "steady" {
		line += " reason=" + compactSingleLine(reason, 22)
	}
	return line
}

func (m *model) renderSidebar() string {
	r := m.reliability
	counts := r.taskSummary.Counts
	pending := counts["pending"]
	running := counts["running"]
	failed := counts["failed"]
	completed := counts["completed"]

	var b strings.Builder
	b.WriteString(fmt.Sprintf("Tasks  pending=%d running=%d failed=%d completed=%d\n", pending, running, failed, completed))
	b.WriteString(fmt.Sprintf("Daemons  retry=%s squish=%s retention=%s watchdog=%s\n",
		onOff(r.taskAutoRetry.Running), onOff(r.transcriptSquish.Running), onOff(r.triRetention.Running), onOff(r.turnWatchdog.Running)))
	b.WriteString(fmt.Sprintf("TriChat  threads=%d messages=%d\n",
		r.triSummary.ThreadCounts.Total, r.triSummary.MessageCount))
	latestConsensusStatus := "n/a"
	if r.consensus.LatestTurn != nil && strings.TrimSpace(r.consensus.LatestTurn.Status) != "" {
		latestConsensusStatus = r.consensus.LatestTurn.Status
	}
	consensusMode := strings.TrimSpace(r.consensus.Mode)
	if consensusMode == "" {
		consensusMode = "basic"
	}
	b.WriteString(fmt.Sprintf("Consensus  mode=%s latest=%s agree=%d disagree=%d incomplete=%d\n",
		consensusMode,
		latestConsensusStatus,
		r.consensus.ConsensusTurns,
		r.consensus.DisagreementTurns,
		r.consensus.IncompleteTurns,
	))
	b.WriteString(fmt.Sprintf("Interop  rounds=%d\n", m.settings.interopRounds))
	b.WriteString(fmt.Sprintf("Council  auto=%s strip=%s\n",
		onOff(m.settings.interopRounds > 0 && strings.EqualFold(m.settings.fanoutTarget, "all")),
		m.settings.councilStripMode,
	))
	b.WriteString(fmt.Sprintf("Execute  gate=%s backend=%s auto=%s c=%d b=%d\n",
		m.settings.executeGateMode,
		m.settings.executeBackend,
		onOff(m.settings.autoExecuteAfterDecision),
		m.settings.autoExecuteCycleCount,
		m.settings.autoExecuteBreakerFailures,
	))
	workboardRunning := r.workboard.Counts["running"]
	workboardTotal := r.workboard.Counts["total"]
	activePhase := "n/a"
	if r.workboard.ActiveTurn != nil && strings.TrimSpace(r.workboard.ActiveTurn.Phase) != "" {
		activePhase = r.workboard.ActiveTurn.Phase + "/" + r.workboard.ActiveTurn.PhaseStatus
	}
	b.WriteString(fmt.Sprintf("Workboard  turns=%d running=%d active=%s\n", workboardTotal, workboardRunning, activePhase))
	if r.novelty.Found {
		b.WriteString(fmt.Sprintf("Decision  novelty=%.2f retry=%s hint=%s\n",
			r.novelty.NoveltyScore,
			onOff(r.novelty.RetryRequired),
			nullCoalesce(r.novelty.DecisionHint, "n/a"),
		))
		if r.novelty.RetrySuppressed {
			b.WriteString("Retry guard  dedupe=on")
			if strings.TrimSpace(r.novelty.RetryReason) != "" {
				b.WriteString(" reason=" + compactSingleLine(r.novelty.RetryReason, 52))
			}
			b.WriteString("\n")
		}
	}
	sloWindow := r.slo.Metrics.WindowMinutes
	if sloWindow <= 0 {
		sloWindow = 60
	}
	p95Text := "n/a"
	if r.slo.Metrics.Adapter.P95LatencyMS != nil {
		p95Text = fmt.Sprintf("%.0fms", *r.slo.Metrics.Adapter.P95LatencyMS)
	}
	b.WriteString(fmt.Sprintf("SLO %dm  p95=%s err=%.1f%% turn_fail=%.1f%%\n",
		sloWindow,
		p95Text,
		r.slo.Metrics.Adapter.ErrorRate*100,
		r.slo.Metrics.Turns.FailureRate*100,
	))
	tmuxFailureClass := strings.TrimSpace(r.tmuxStatus.Dashboard.FailureClass)
	if tmuxFailureClass == "" {
		tmuxFailureClass = "none"
	}
	b.WriteString(fmt.Sprintf("Tmux exec  on=%s workers=%d queue=%d age=%s fail=%s\n",
		onOff(r.tmuxStatus.State.Enabled),
		r.tmuxStatus.State.WorkerCount,
		r.tmuxStatus.Dashboard.QueueDepth,
		formatTmuxQueueAge(r.tmuxStatus.Dashboard.QueueAgeSeconds),
		tmuxFailureClass,
	))
	if len(r.tmuxStatus.Dashboard.WorkerLoad) > 0 {
		laneCounts := map[string]int{}
		for _, worker := range r.tmuxStatus.Dashboard.WorkerLoad {
			key := strings.ToLower(strings.TrimSpace(worker.LaneState))
			if key == "" {
				key = "unknown"
			}
			laneCounts[key] += 1
		}
		b.WriteString(fmt.Sprintf(
			"Tmux lanes  idle=%d working=%d blocked=%d error=%d\n",
			laneCounts["idle"],
			laneCounts["working"],
			laneCounts["blocked_trust"]+laneCounts["blocked_plan"]+laneCounts["blocked_prompt"],
			laneCounts["error"]+laneCounts["offline"],
		))
	}
	b.WriteString(m.adaptiveSidebarLine() + "\n")
	b.WriteString(fmt.Sprintf("Bus  running=%s clients=%d subs=%d events=%d\n",
		onOff(r.busStatus.Running),
		r.busStatus.ClientCount,
		r.busStatus.SubscriptionCount,
		r.busStatus.Metrics.TotalPublished,
	))
	b.WriteString(fmt.Sprintf("Adapters  open=%d/%d trips=%d degraded=%d/%d\n",
		r.adapterTelemetry.Summary.OpenChannels,
		r.adapterTelemetry.Summary.TotalChannels,
		r.adapterTelemetry.Summary.TotalTrips,
		r.adapterTelemetry.Summary.TotalDegradedTurns,
		r.adapterTelemetry.Summary.TotalTurns,
	))
	if strings.TrimSpace(r.busStatus.LastError) != "" {
		b.WriteString("Bus err  " + compactSingleLine(r.busStatus.LastError, 72) + "\n")
	}
	if strings.TrimSpace(r.turnWatchdog.LastError) != "" {
		b.WriteString("Watchdog err  " + compactSingleLine(r.turnWatchdog.LastError, 66) + "\n")
	}
	if strings.TrimSpace(r.adapterTelemetry.Summary.NewestTripOpenedAt) != "" {
		b.WriteString("Last trip  " + r.adapterTelemetry.Summary.NewestTripOpenedAt + "\n")
	}
	if r.consensus.Flagged && r.consensus.LatestTurn != nil {
		userText := compactSingleLine(r.consensus.LatestTurn.UserExcerpt, 70)
		b.WriteString("Consensus alert  " + userText + "\n")
	}
	if r.workboard.LatestDecision != nil && strings.TrimSpace(r.workboard.LatestDecision.DecisionSummary) != "" {
		b.WriteString("Merge decision  " + compactSingleLine(r.workboard.LatestDecision.DecisionSummary, 72) + "\n")
	}
	if r.workboard.ActiveTurn != nil {
		b.WriteString(fmt.Sprintf("Turn owner  %s status=%s\n",
			nullCoalesce(r.workboard.ActiveTurn.SelectedAgent, "n/a"),
			nullCoalesce(r.workboard.ActiveTurn.Status, "n/a"),
		))
	}

	if len(r.taskSummary.Running) > 0 {
		b.WriteString("\nActive leases:\n")
		for _, row := range r.taskSummary.Running {
			b.WriteString("- " + row.TaskID + " owner=" + nullCoalesce(row.OwnerID, "none") + "\n")
		}
	}

	if len(r.adapterTelemetry.LastOpenEvents) > 0 {
		b.WriteString("\nRecent trip events:\n")
		limit := minInt(3, len(r.adapterTelemetry.LastOpenEvents))
		for i := 0; i < limit; i++ {
			event := r.adapterTelemetry.LastOpenEvents[i]
			b.WriteString(fmt.Sprintf("- %s %s/%s %s\n",
				shortTime(event.CreatedAt),
				event.AgentID,
				event.Channel,
				compactSingleLine(event.ErrorText, 60),
			))
		}
	}
	return strings.TrimSpace(b.String())
}

func (m *model) renderReliabilityDetail() string {
	var b strings.Builder
	b.WriteString(m.renderSidebar())
	b.WriteString("\n\nConsensus detail:\n")
	if m.reliability.consensus.LatestTurn == nil {
		b.WriteString("(no consensus turns yet)")
	} else {
		latest := m.reliability.consensus.LatestTurn
		b.WriteString(fmt.Sprintf("- latest status: %s (%d/%d responses)\n",
			nullCoalesce(latest.Status, "n/a"),
			latest.ResponseCount,
			latest.RequiredCount,
		))
		if m.reliability.consensus.Flagged {
			b.WriteString(fmt.Sprintf("- disagreement agents: %s\n",
				nullCoalesce(strings.Join(latest.DisagreementAgents, ","), "n/a"),
			))
		}
		for _, answer := range latest.Answers {
			line := fmt.Sprintf("- %s [%s] %s",
				answer.AgentID,
				answer.Mode,
				compactSingleLine(answer.AnswerExcerpt, 90),
			)
			b.WriteString(line + "\n")
		}
	}
	b.WriteString("\n\nWorkboard detail:\n")
	b.WriteString(fmt.Sprintf("- turns total=%d running=%d completed=%d failed=%d\n",
		m.reliability.workboard.Counts["total"],
		m.reliability.workboard.Counts["running"],
		m.reliability.workboard.Counts["completed"],
		m.reliability.workboard.Counts["failed"],
	))
	if m.reliability.workboard.ActiveTurn != nil {
		active := m.reliability.workboard.ActiveTurn
		b.WriteString(fmt.Sprintf("- active turn: %s phase=%s/%s status=%s\n",
			active.TurnID,
			nullCoalesce(active.Phase, "n/a"),
			nullCoalesce(active.PhaseStatus, "n/a"),
			nullCoalesce(active.Status, "n/a"),
		))
		if strings.TrimSpace(active.DecisionSummary) != "" {
			b.WriteString("- decision: " + compactSingleLine(active.DecisionSummary, 100) + "\n")
		}
	}
	if m.reliability.novelty.Found {
		b.WriteString(fmt.Sprintf("- novelty: %.2f threshold=%.2f retry=%s\n",
			m.reliability.novelty.NoveltyScore,
			m.reliability.novelty.NoveltyThreshold,
			onOff(m.reliability.novelty.RetryRequired),
		))
		if m.reliability.novelty.RetrySuppressed {
			b.WriteString("- retry dedupe guard: on\n")
			if strings.TrimSpace(m.reliability.novelty.RetryReason) != "" {
				b.WriteString("- dedupe reason: " + compactSingleLine(m.reliability.novelty.RetryReason, 96) + "\n")
			}
			if strings.TrimSpace(m.reliability.novelty.RetryReference) != "" {
				b.WriteString("- dedupe reference turn: " + m.reliability.novelty.RetryReference + "\n")
			}
		}
		if len(m.reliability.novelty.RetryAgents) > 0 {
			b.WriteString("- retry agents: " + strings.Join(m.reliability.novelty.RetryAgents, ",") + "\n")
		}
	}

	b.WriteString("\n\nSLO detail:\n")
	windowMinutes := m.reliability.slo.Metrics.WindowMinutes
	if windowMinutes <= 0 {
		windowMinutes = 60
	}
	p95Text := "n/a"
	if m.reliability.slo.Metrics.Adapter.P95LatencyMS != nil {
		p95Text = fmt.Sprintf("%.2fms", *m.reliability.slo.Metrics.Adapter.P95LatencyMS)
	}
	b.WriteString(fmt.Sprintf("- window: %dm since=%s\n", windowMinutes, nullCoalesce(m.reliability.slo.Metrics.SinceISO, "n/a")))
	b.WriteString(fmt.Sprintf("- adapter samples=%d latency_samples=%d p95=%s\n",
		m.reliability.slo.Metrics.Adapter.SampleCount,
		m.reliability.slo.Metrics.Adapter.LatencySamples,
		p95Text,
	))
	b.WriteString(fmt.Sprintf("- adapter error rate=%.2f%% (%d/%d)\n",
		m.reliability.slo.Metrics.Adapter.ErrorRate*100,
		m.reliability.slo.Metrics.Adapter.ErrorCount,
		m.reliability.slo.Metrics.Adapter.SampleCount,
	))
	b.WriteString(fmt.Sprintf("- turn failure rate=%.2f%% (%d/%d)\n",
		m.reliability.slo.Metrics.Turns.FailureRate*100,
		m.reliability.slo.Metrics.Turns.FailedCount,
		m.reliability.slo.Metrics.Turns.TotalCount,
	))
	if m.reliability.slo.LatestSnapshot != nil {
		b.WriteString(fmt.Sprintf("- latest snapshot: %s at %s\n",
			nullCoalesce(m.reliability.slo.LatestSnapshot.SnapshotID, "n/a"),
			nullCoalesce(m.reliability.slo.LatestSnapshot.CreatedAt, "n/a"),
		))
	}

	b.WriteString("\n\nWatchdog detail:\n")
	b.WriteString(fmt.Sprintf("- running=%s in_tick=%s interval=%ds stale_after=%ds batch=%d\n",
		onOff(m.reliability.turnWatchdog.Running),
		onOff(m.reliability.turnWatchdog.InTick),
		m.reliability.turnWatchdog.Config.IntervalSeconds,
		m.reliability.turnWatchdog.Config.StaleAfterSeconds,
		m.reliability.turnWatchdog.Config.BatchLimit,
	))
	b.WriteString(fmt.Sprintf("- ticks=%d stale_detected=%d escalated=%d\n",
		m.reliability.turnWatchdog.Stats.TickCount,
		m.reliability.turnWatchdog.Stats.StaleDetected,
		m.reliability.turnWatchdog.Stats.EscalatedCount,
	))
	if strings.TrimSpace(m.reliability.turnWatchdog.LastError) != "" {
		b.WriteString("- last error: " + compactSingleLine(m.reliability.turnWatchdog.LastError, 96) + "\n")
	}
	if len(m.reliability.turnWatchdog.Stats.LastEscalatedTurn) > 0 {
		b.WriteString("- last escalated turns: " + strings.Join(m.reliability.turnWatchdog.Stats.LastEscalatedTurn, ",") + "\n")
	}

	b.WriteString("\n\nTmux execution detail:\n")
	b.WriteString(fmt.Sprintf("- enabled=%s session=%s workers=%d\n",
		onOff(m.reliability.tmuxStatus.State.Enabled),
		nullCoalesce(m.reliability.tmuxStatus.State.SessionName, "n/a"),
		m.reliability.tmuxStatus.State.WorkerCount,
	))
	b.WriteString(fmt.Sprintf("- queue depth=%d age=%s oldest_task=%s\n",
		m.reliability.tmuxStatus.Dashboard.QueueDepth,
		formatTmuxQueueAge(m.reliability.tmuxStatus.Dashboard.QueueAgeSeconds),
		nullCoalesce(m.reliability.tmuxStatus.Dashboard.QueueOldestTask, "n/a"),
	))
	b.WriteString(fmt.Sprintf("- failure class=%s count=%d\n",
		nullCoalesce(m.reliability.tmuxStatus.Dashboard.FailureClass, "none"),
		m.reliability.tmuxStatus.Dashboard.FailureCount,
	))
	if strings.TrimSpace(m.reliability.tmuxStatus.Dashboard.LastError) != "" {
		b.WriteString("- last error: " + compactSingleLine(m.reliability.tmuxStatus.Dashboard.LastError, 96) + "\n")
	}
	if strings.TrimSpace(m.reliability.tmuxStatus.Dashboard.LastFailureAt) != "" {
		b.WriteString("- last failure at: " + m.reliability.tmuxStatus.Dashboard.LastFailureAt + "\n")
	}
	if len(m.reliability.tmuxStatus.Dashboard.WorkerLoad) > 0 {
		b.WriteString("- worker load:\n")
		for _, worker := range m.reliability.tmuxStatus.Dashboard.WorkerLoad {
			laneState := strings.TrimSpace(worker.LaneState)
			if laneState == "" {
				laneState = "unknown"
			}
			line := fmt.Sprintf("  %s queue=%d load=%d lane=%s", worker.WorkerID, worker.ActiveQueue, worker.ActiveLoad, laneState)
			if strings.TrimSpace(worker.LaneSignal) != "" {
				line += " signal=" + compactSingleLine(worker.LaneSignal, 56)
			}
			b.WriteString(line + "\n")
		}
	}

	b.WriteString("\n\nBus detail:\n")
	b.WriteString(fmt.Sprintf("- socket: %s\n", nullCoalesce(m.reliability.busStatus.SocketPath, "(unset)")))
	b.WriteString(fmt.Sprintf("- io: in=%d out=%d delivered=%d\n",
		m.reliability.busStatus.Metrics.MessagesIn,
		m.reliability.busStatus.Metrics.MessagesOut,
		m.reliability.busStatus.Metrics.TotalDelivered,
	))
	b.WriteString("\n\nRecent adapter events:\n")
	if len(m.reliability.adapterTelemetry.RecentEvents) == 0 {
		b.WriteString("(none)")
	} else {
		for _, event := range m.reliability.adapterTelemetry.RecentEvents {
			line := fmt.Sprintf("- %s %s/%s %s",
				shortTime(event.CreatedAt),
				event.AgentID,
				event.Channel,
				event.EventType,
			)
			if strings.TrimSpace(event.ErrorText) != "" {
				line += " :: " + compactSingleLine(event.ErrorText, 90)
			}
			b.WriteString(line + "\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func (m *model) maxSettingsIndex() int {
	return 17
}

func (m *model) adjustSetting(delta int) {
	if delta == 0 {
		return
	}
	switch m.settingsIndex {
	case 0:
		options := []string{"all", "codex", "cursor", "local-imprint"}
		m.settings.fanoutTarget = cycleString(options, m.settings.fanoutTarget, delta)
	case 1:
		options := []string{"open", "allowlist", "approval"}
		m.settings.executeGateMode = cycleString(options, m.settings.executeGateMode, delta)
	case 2:
		options := []int{2, 3}
		m.settings.consensusMinAgents = cycleInt(options, m.settings.consensusMinAgents, delta)
	case 3:
		options := []int{0, 1, 2, 3}
		m.settings.interopRounds = cycleInt(options, m.settings.interopRounds, delta)
	case 4:
		options := []string{"always", "auto", "off"}
		m.settings.councilStripMode = cycleString(options, m.settings.councilStripMode, delta)
	case 5:
		m.settings.councilConvergenceMaxRounds = clampInt(m.settings.councilConvergenceMaxRounds+delta, 1, 12)
	case 6:
		m.settings.councilLatencyBudgetSecond = clampInt(m.settings.councilLatencyBudgetSecond+delta*5, 5, 300)
	case 7:
		next := math.Round((m.settings.councilMinNoveltyDelta+float64(delta)*0.01)*100) / 100
		m.settings.councilMinNoveltyDelta = clampFloat(next, 0.01, 0.8)
	case 8:
		m.settings.pollInterval = time.Duration(clampInt(int(m.settings.pollInterval.Seconds())+delta, 1, 60)) * time.Second
	case 9:
		m.settings.modelTimeoutSeconds = clampInt(m.settings.modelTimeoutSeconds+delta, 1, 120)
	case 10:
		m.settings.bridgeTimeoutSeconds = clampInt(m.settings.bridgeTimeoutSeconds+delta, 1, 120)
	case 11:
		m.settings.adapterFailoverTimeoutSecond = clampInt(m.settings.adapterFailoverTimeoutSecond+delta, 1, 120)
	case 12:
		m.settings.adapterCircuitThreshold = clampInt(m.settings.adapterCircuitThreshold+delta, 1, 10)
	case 13:
		m.settings.adapterCircuitRecoverySecond = clampInt(m.settings.adapterCircuitRecoverySecond+delta, 1, 600)
	case 14:
		if delta != 0 {
			m.settings.autoRefresh = !m.settings.autoRefresh
		}
	case 15:
		if delta != 0 {
			m.settings.autoExecuteAfterDecision = !m.settings.autoExecuteAfterDecision
		}
	case 16:
		m.settings.autoExecuteCycleCount = clampInt(m.settings.autoExecuteCycleCount+delta, 1, 4)
	case 17:
		m.settings.autoExecuteBreakerFailures = clampInt(m.settings.autoExecuteBreakerFailures+delta, 1, 5)
	}
	m.renderPanes()
	m.statusLine = "settings updated"
}

func (m *model) renderSettings() string {
	rows := []struct {
		label string
		value string
		help  string
	}{
		{"Fanout Target", m.settings.fanoutTarget, "all/codex/cursor/local-imprint"},
		{"Execute Gate", m.settings.executeGateMode, "open/allowlist/approval"},
		{"Consensus Min Agents", strconv.Itoa(m.settings.consensusMinAgents), "2 or 3 required responses for consensus/disagreement"},
		{"Interop Rounds", strconv.Itoa(m.settings.interopRounds), "0 disables peer bounce; 1-3 runs merge refinement loops"},
		{"Council Strip", m.settings.councilStripMode, "always=show, auto=show when council exists, off=collapse strip"},
		{"Council Max Rounds", strconv.Itoa(m.settings.councilConvergenceMaxRounds), "max autonomous council rounds per turn (1-12)"},
		{"Council Budget", fmt.Sprintf("%ds", m.settings.councilLatencyBudgetSecond), "latency budget for autonomous council loop"},
		{"Council Min Delta", fmt.Sprintf("%.2f", m.settings.councilMinNoveltyDelta), "stop when novelty gain reaches this threshold"},
		{"Poll Interval", fmt.Sprintf("%ds", int(m.settings.pollInterval.Seconds())), "sidebar and timeline refresh interval"},
		{"Model Timeout", fmt.Sprintf("%ds", m.settings.modelTimeoutSeconds), "per Ollama request timeout"},
		{"Bridge Timeout", fmt.Sprintf("%ds", m.settings.bridgeTimeoutSeconds), "per command-adapter timeout"},
		{"Failover Timeout", fmt.Sprintf("%ds", m.settings.adapterFailoverTimeoutSecond), "per-agent turn budget"},
		{"Circuit Threshold", strconv.Itoa(m.settings.adapterCircuitThreshold), "failures before channel opens"},
		{"Circuit Recovery", fmt.Sprintf("%ds", m.settings.adapterCircuitRecoverySecond), "recovery window before retry"},
		{"Auto Refresh", onOff(m.settings.autoRefresh), "periodic state refresh"},
		{"Auto Execute", onOff(m.settings.autoExecuteAfterDecision), "run post-decision execute path automatically"},
		{"Auto Exec Cycles", strconv.Itoa(m.settings.autoExecuteCycleCount), "bounded review/fix/feature/verify cycles (1-4)"},
		{"Auto Exec Breaker", strconv.Itoa(m.settings.autoExecuteBreakerFailures), "halt cycles after this many consecutive gate failures"},
	}
	var b strings.Builder
	b.WriteString(m.theme.helpText.Render("Use ↑/↓ to select and ←/→ (or -/+) to change values."))
	b.WriteString("\n\n")
	for i, row := range rows {
		labelStyle := m.theme.settingKey
		valueStyle := m.theme.settingValue
		prefix := "  "
		if i == m.settingsIndex {
			labelStyle = m.theme.settingPick
			valueStyle = m.theme.settingPick
			prefix = "▶ "
		}
		b.WriteString(prefix + labelStyle.Render(fmt.Sprintf("%-18s", row.label)) + " " + valueStyle.Render(row.value) + "\n")
		b.WriteString("   " + m.theme.helpText.Render(row.help) + "\n")
	}
	b.WriteString("\nCurrent transport: " + m.cfg.transport + " · model: " + m.settings.model)
	b.WriteString(" · execute backend: " + m.settings.executeBackend)
	return strings.TrimSpace(b.String())
}

func (m *model) renderHelp() string {
	lines := []string{
		"Core Keys",
		"- Launcher: Up/Down select, Enter launch, Esc skip to chat",
		"- Tab / Shift+Tab: switch views",
		"- Enter: send prompt (Chat tab)",
		"- Ctrl+A (chat): run /adaptercheck quickly",
		"- Esc: from non-chat tabs, return to launcher menu",
		"- Esc in chat: show retro quit confirmation",
		"- Timeline scroll: PgUp/PgDn, Up/Down (input empty), +/- (or Ctrl+U/Ctrl+D)",
		"- Ctrl+C: quit",
		"- Chat timeline auto-hides system chatter and compacts long responses",
		"- Reliability sidebar includes consensus status and disagreement alerts",
		"- Workboard shows turn phase state (plan/propose/merge/execute/verify) and latest decision",
		"- Novelty scoring can trigger forced delta retries before merge for non-identical strategies",
		"- Interop rounds let agents refine against peer/critique context before selection",
		"- Autonomous council loop (when interop>0 and fanout=all) auto-continues rounds until novelty improves or budget/max-round limits are hit",
		"- Council Transcript Strip isolates agent-to-agent exchanges from user-facing replies",
		"- Settings includes consensus threshold toggle (2 or 3 required agent responses)",
		"- Live Bus Strip shows real-time adapter events (socket stream) before timeline persistence",
		"- /execute uses tmux allocator in auto mode when structured commands are present",
		"- Optional auto post-decision execute can dispatch selected strategy without manual /execute",
		"- Auto execute supports bounded review/fix/feature/verify cycles with breaker halts on repeated gate failures",
		"",
		"Slash Commands",
		"- /adaptercheck [ping|live|dry] [agents] [timeout_s]",
		"- /interop status|on|off|0|1|2|3",
		"- /autoexec status|on|off|cycles <1-4>|breaker <1-5>",
		"- /councilstrip always|auto|off",
		"- /fanout all|codex|cursor|local-imprint",
		"- /agent <agent> <message>",
		"- /thread list [limit]",
		"- /thread new [title]",
		"- /thread use <thread_id>",
		"- /thread archive [thread_id]",
		"- /workboard [limit]",
		"- /turn show [turn_id]",
		"- /turn phase <phase> [phase_status]",
		"- /retry status|start|stop|run_once",
		"- /retentiond status|start|stop|run_once",
		"- /retention [days] [apply] [all]",
		"- /execute <agent> [objective]",
		"- /panel",
		"- /help",
		"- /quit",
		"",
		"Visual Theme",
		"- Neon cotton-candy palette (pink/blue/mint)",
		"- Framed split panes with live timeline and reliability telemetry",
		"- Bridge wrappers auto-load from ./bridges for codex/cursor/local-imprint (override with --codex-command / --cursor-command / --imprint-command)",
	}
	return m.theme.helpText.Render(strings.Join(lines, "\n"))
}

func (m *model) appendLog(line string) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return
	}
	m.logs = append(m.logs, fmt.Sprintf("%s %s", time.Now().Format("15:04:05"), compactSingleLine(trimmed, 220)))
	if len(m.logs) > 50 {
		m.logs = m.logs[len(m.logs)-50:]
	}
}

func (m *model) logError(err error) {
	if err == nil {
		return
	}
	m.appendLog("error: " + err.Error())
	m.statusLine = "error: " + compactSingleLine(err.Error(), 160)
}

func parseFlags() appConfig {
	cwd, _ := os.Getwd()
	repoRootDefault := cwd
	if repoRootDefault == "" {
		repoRootDefault = "."
	}

	cfg := appConfig{}
	flag.StringVar(&cfg.repoRoot, "repo-root", repoRootDefault, "Repository root path")
	flag.StringVar(&cfg.threadID, "thread-id", "", "Existing tri-chat thread id")
	flag.StringVar(&cfg.threadTitle, "thread-title", defaultThreadTitle, "Thread title")
	flag.BoolVar(&cfg.resumeLatest, "resume-latest", true, "Resume most recent active thread")
	flag.StringVar(&cfg.transport, "transport", envOr("TRICHAT_MCP_TRANSPORT", "stdio"), "MCP transport (stdio|http)")
	flag.StringVar(&cfg.url, "url", envOr("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"), "MCP HTTP URL")
	flag.StringVar(&cfg.origin, "origin", envOr("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"), "Origin header for MCP HTTP")
	flag.StringVar(&cfg.stdioCommand, "stdio-command", envOr("TRICHAT_MCP_STDIO_COMMAND", "node"), "stdio command for MCP helper")
	flag.StringVar(&cfg.stdioArgs, "stdio-args", envOr("TRICHAT_MCP_STDIO_ARGS", "dist/server.js"), "stdio args for MCP helper")
	flag.StringVar(&cfg.model, "model", envOr("TRICHAT_OLLAMA_MODEL", defaultModel), "Default Ollama model")
	flag.StringVar(&cfg.codexCommand, "codex-command", envOr("TRICHAT_CODEX_CMD", ""), "Optional command adapter for codex (auto-default: ./bridges/codex_bridge.py)")
	flag.StringVar(&cfg.cursorCommand, "cursor-command", envOr("TRICHAT_CURSOR_CMD", ""), "Optional command adapter for cursor (auto-default: ./bridges/cursor_bridge.py)")
	flag.StringVar(&cfg.imprintCommand, "imprint-command", envOr("TRICHAT_IMPRINT_CMD", ""), "Optional command adapter for local-imprint (auto-default: ./bridges/local-imprint_bridge.py or ./bridges/local_imprint_bridge.py if present)")
	flag.IntVar(&cfg.modelTimeoutSeconds, "model-timeout", envOrInt("TRICHAT_MODEL_TIMEOUT", 30), "Per-request Ollama timeout seconds")
	flag.IntVar(&cfg.bridgeTimeoutSeconds, "bridge-timeout", envOrInt("TRICHAT_BRIDGE_TIMEOUT", 60), "Bridge command timeout seconds")
	flag.IntVar(&cfg.adapterFailoverTimeoutSecond, "adapter-failover-timeout", envOrInt("TRICHAT_ADAPTER_FAILOVER_TIMEOUT", 75), "Per-agent failover timeout seconds")
	flag.IntVar(&cfg.adapterCircuitThreshold, "adapter-circuit-threshold", envOrInt("TRICHAT_ADAPTER_CIRCUIT_THRESHOLD", 2), "Consecutive failures before opening circuit")
	flag.IntVar(&cfg.adapterCircuitRecoverySecond, "adapter-circuit-recovery-seconds", envOrInt("TRICHAT_ADAPTER_CIRCUIT_RECOVERY_SECONDS", 45), "Circuit recovery window seconds")
	flag.BoolVar(&cfg.adaptiveTimeoutsEnabled, "adaptive-timeouts", envOrBool("TRICHAT_ADAPTIVE_TIMEOUTS", true), "Enable adaptive timeout tuning from trichat.slo metrics")
	flag.IntVar(
		&cfg.adaptiveTimeoutMinSamples,
		"adaptive-timeout-min-samples",
		envOrInt("TRICHAT_ADAPTIVE_TIMEOUT_MIN_SAMPLES", 12),
		"Minimum SLO latency samples required before adaptive timeout tuning",
	)
	flag.IntVar(
		&cfg.adaptiveTimeoutMaxStepSecond,
		"adaptive-timeout-max-step",
		envOrInt("TRICHAT_ADAPTIVE_TIMEOUT_MAX_STEP_SECONDS", 8),
		"Maximum timeout adjustment (seconds) per turn when adaptive tuning is enabled",
	)
	flag.IntVar(
		&cfg.councilConvergenceMaxRounds,
		"council-max-rounds",
		envOrInt("TRICHAT_COUNCIL_MAX_ROUNDS", 5),
		"Maximum autonomous council rounds per turn (>= interop rounds)",
	)
	flag.IntVar(
		&cfg.councilLatencyBudgetSecond,
		"council-latency-budget",
		envOrInt("TRICHAT_COUNCIL_LATENCY_BUDGET_SECONDS", 45),
		"Latency budget in seconds for autonomous council convergence loop",
	)
	flag.Float64Var(
		&cfg.councilMinNoveltyDelta,
		"council-min-novelty-delta",
		envOrFloat("TRICHAT_COUNCIL_MIN_NOVELTY_DELTA", 0.05),
		"Minimum novelty gain needed before council loop can stop early",
	)
	flag.StringVar(
		&cfg.councilStripMode,
		"council-strip-mode",
		envOr("TRICHAT_COUNCIL_STRIP_MODE", "auto"),
		"Council transcript strip rendering mode (always|auto|off)",
	)
	flag.IntVar(&cfg.consensusMinAgents, "consensus-min-agents", envOrInt("TRICHAT_CONSENSUS_MIN_AGENTS", 3), "Consensus threshold (2 or 3 agents)")
	flag.IntVar(&cfg.interopRounds, "interop-rounds", envOrInt("TRICHAT_INTEROP_ROUNDS", 1), "Interop bounce rounds before merge decision (0-3)")
	flag.BoolVar(
		&cfg.autoExecuteAfterDecision,
		"auto-execute-after-decision",
		envOrBool("TRICHAT_AUTO_EXECUTE_AFTER_DECISION", false),
		"Automatically run execute routing after fanout decision",
	)
	flag.IntVar(
		&cfg.autoExecuteCycleCount,
		"auto-execute-cycles",
		envOrInt("TRICHAT_AUTO_EXECUTE_CYCLES", 2),
		"Auto execute iterative cycle count (1-4) for fanout post-decision execution",
	)
	flag.IntVar(
		&cfg.autoExecuteBreakerFailures,
		"auto-execute-breaker-failures",
		envOrInt("TRICHAT_AUTO_EXECUTE_BREAKER_FAILURES", 2),
		"Consecutive gate failures before auto execute breaker halts additional cycles",
	)
	flag.StringVar(&cfg.executeGateMode, "execute-gate-mode", envOr("TRICHAT_EXECUTE_GATE_MODE", "open"), "execute gate mode (open|allowlist|approval)")
	flag.StringVar(&cfg.executeBackend, "execute-backend", envOr("TRICHAT_EXECUTE_BACKEND", "auto"), "execute backend (auto|tmux|direct)")
	allowAgents := envOr("TRICHAT_EXECUTE_ALLOW_AGENTS", "codex,cursor,local-imprint")
	flag.StringVar(&allowAgents, "execute-allow-agents", allowAgents, "Comma-separated execute allowlist")
	flag.StringVar(&cfg.executeApprovalPhrase, "execute-approval-phrase", envOr("TRICHAT_EXECUTE_APPROVAL_PHRASE", "approve"), "Approval phrase for execute gate mode=approval")
	flag.StringVar(&cfg.tmuxSessionName, "tmux-session-name", envOr("TRICHAT_TMUX_SESSION_NAME", "trichat-live"), "tmux controller session name for interactive execute routing")
	flag.IntVar(&cfg.tmuxWorkerCount, "tmux-worker-count", envOrInt("TRICHAT_TMUX_WORKER_COUNT", 3), "tmux controller worker count for interactive execute routing")
	flag.IntVar(&cfg.tmuxMaxQueuePerWorker, "tmux-max-queue-per-worker", envOrInt("TRICHAT_TMUX_MAX_QUEUE_PER_WORKER", 8), "tmux controller max queue depth per worker")
	flag.BoolVar(&cfg.tmuxSyncAfterDispatch, "tmux-sync-after-dispatch", envOrBool("TRICHAT_TMUX_SYNC_AFTER_DISPATCH", true), "run tmux sync action immediately after dispatch")
	flag.IntVar(&cfg.tmuxLockLeaseSeconds, "tmux-lock-lease-seconds", envOrInt("TRICHAT_TMUX_LOCK_LEASE_SECONDS", 600), "lock lease seconds for interactive tmux dispatch")
	pollIntervalSeconds := envOrInt("TRICHAT_TUI_POLL_INTERVAL", 2)
	flag.IntVar(&pollIntervalSeconds, "poll-interval", pollIntervalSeconds, "Refresh interval seconds")
	launcherDefault := envOrBool("TRICHAT_TUI_LAUNCHER", true)
	flag.BoolVar(&cfg.launcher, "launcher", launcherDefault, "Show startup launcher menu")
	noLauncher := envOrBool("TRICHAT_TUI_NO_LAUNCHER", false)
	flag.BoolVar(&noLauncher, "no-launcher", noLauncher, "Disable launcher and open chat input immediately")
	flag.BoolVar(&cfg.altScreen, "alt-screen", true, "Use alternate screen buffer")
	flag.StringVar(&cfg.sessionSeed, "session-seed", "", "Optional idempotency seed")
	flag.Parse()

	resolvedRoot, _ := filepath.Abs(cfg.repoRoot)
	cfg.repoRoot = resolvedRoot
	cfg.transport = strings.ToLower(strings.TrimSpace(cfg.transport))
	if cfg.transport != "http" {
		cfg.transport = "stdio"
	}
	cfg.modelTimeoutSeconds = clampInt(cfg.modelTimeoutSeconds, 1, 120)
	cfg.bridgeTimeoutSeconds = clampInt(cfg.bridgeTimeoutSeconds, 1, 120)
	cfg.adapterFailoverTimeoutSecond = clampInt(cfg.adapterFailoverTimeoutSecond, 1, 120)
	cfg.adapterCircuitThreshold = clampInt(cfg.adapterCircuitThreshold, 1, 10)
	cfg.adapterCircuitRecoverySecond = clampInt(cfg.adapterCircuitRecoverySecond, 1, 600)
	cfg.adaptiveTimeoutMinSamples = clampInt(cfg.adaptiveTimeoutMinSamples, 1, 1000)
	cfg.adaptiveTimeoutMaxStepSecond = clampInt(cfg.adaptiveTimeoutMaxStepSecond, 1, 30)
	cfg.councilConvergenceMaxRounds = clampInt(cfg.councilConvergenceMaxRounds, 1, 12)
	cfg.councilLatencyBudgetSecond = clampInt(cfg.councilLatencyBudgetSecond, 5, 300)
	cfg.councilMinNoveltyDelta = clampFloat(cfg.councilMinNoveltyDelta, 0.01, 0.8)
	cfg.councilStripMode = normalizeCouncilStripMode(cfg.councilStripMode)
	cfg.consensusMinAgents = clampInt(cfg.consensusMinAgents, 2, 3)
	cfg.interopRounds = clampInt(cfg.interopRounds, 0, 3)
	cfg.autoExecuteCycleCount = clampInt(cfg.autoExecuteCycleCount, 1, 4)
	cfg.autoExecuteBreakerFailures = clampInt(cfg.autoExecuteBreakerFailures, 1, 5)
	cfg.executeBackend = normalizeExecuteBackend(cfg.executeBackend)
	cfg.tmuxSessionName = strings.TrimSpace(cfg.tmuxSessionName)
	if cfg.tmuxSessionName == "" {
		cfg.tmuxSessionName = "trichat-live"
	}
	cfg.tmuxWorkerCount = clampInt(cfg.tmuxWorkerCount, 1, 12)
	cfg.tmuxMaxQueuePerWorker = clampInt(cfg.tmuxMaxQueuePerWorker, 1, 200)
	cfg.tmuxLockLeaseSeconds = clampInt(cfg.tmuxLockLeaseSeconds, 15, 3600)
	minFailover := clampInt(maxInt(cfg.modelTimeoutSeconds+8, cfg.bridgeTimeoutSeconds+5), 1, 120)
	if cfg.adapterFailoverTimeoutSecond < minFailover {
		cfg.adapterFailoverTimeoutSecond = minFailover
	}
	cfg.pollInterval = time.Duration(clampInt(pollIntervalSeconds, 1, 60)) * time.Second
	if noLauncher {
		cfg.launcher = false
	}
	cfg.executeGateMode = normalizeGateMode(cfg.executeGateMode)
	cfg.executeAllowAgents = parseAllowlist(allowAgents)
	if strings.TrimSpace(cfg.codexCommand) == "" {
		cfg.codexCommand = autoBridgeCommand(cfg.repoRoot, "codex")
	}
	if strings.TrimSpace(cfg.cursorCommand) == "" {
		cfg.cursorCommand = autoBridgeCommand(cfg.repoRoot, "cursor")
	}
	if strings.TrimSpace(cfg.imprintCommand) == "" {
		cfg.imprintCommand = autoBridgeCommand(cfg.repoRoot, "local-imprint")
	}
	if cfg.executeApprovalPhrase == "" {
		cfg.executeApprovalPhrase = "approve"
	}
	if strings.TrimSpace(cfg.sessionSeed) == "" {
		cfg.sessionSeed = fmt.Sprintf("trichat-tui-%d", time.Now().Unix())
	}
	return cfg
}

func normalizeGateMode(mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	switch normalized {
	case "allowlist", "approval", "open":
		return normalized
	default:
		return "open"
	}
}

func normalizeExecuteBackend(backend string) string {
	normalized := strings.ToLower(strings.TrimSpace(backend))
	switch normalized {
	case "auto", "tmux", "direct":
		return normalized
	default:
		return "auto"
	}
}

func normalizeCouncilStripMode(mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	switch normalized {
	case "always", "auto", "off":
		return normalized
	default:
		return "auto"
	}
}

func parseAllowlist(raw string) map[string]bool {
	parts := strings.Split(raw, ",")
	out := map[string]bool{}
	for _, part := range parts {
		value := strings.TrimSpace(strings.ToLower(part))
		if value != "" {
			out[value] = true
		}
	}
	if len(out) == 0 {
		out["codex"] = true
		out["cursor"] = true
		out["local-imprint"] = true
	}
	return out
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envOrInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envOrBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envOrFloat(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func autoBridgeCommand(repoRoot, agentID string) string {
	candidates := []string{
		filepath.Join(repoRoot, "bridges", agentID+"_bridge.py"),
		filepath.Join(repoRoot, "bridges", strings.ReplaceAll(agentID, "-", "_")+"_bridge.py"),
	}
	scriptPath := ""
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			scriptPath = candidate
			break
		}
	}
	if scriptPath == "" {
		return ""
	}
	pythonBin := strings.TrimSpace(os.Getenv("TRICHAT_BRIDGE_PYTHON"))
	if pythonBin == "" {
		pythonBin = "python3"
	}
	return shellQuote(pythonBin) + " " + shellQuote(scriptPath)
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if !strings.ContainsAny(value, " \t\n'\"\\$`") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func splitCommand(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	args := make([]string, 0, 8)
	var current strings.Builder
	inSingle := false
	inDouble := false
	escaped := false
	flush := func() {
		if current.Len() == 0 {
			return
		}
		args = append(args, current.String())
		current.Reset()
	}
	for _, r := range trimmed {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\' && !inSingle:
			escaped = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case unicode.IsSpace(r) && !inSingle && !inDouble:
			flush()
		default:
			current.WriteRune(r)
		}
	}
	if escaped {
		current.WriteRune('\\')
	}
	flush()
	if inSingle || inDouble {
		// Fallback for malformed quoted strings.
		return strings.Fields(trimmed)
	}
	return args
}

func shortTime(iso string) string {
	parsed, err := parseISO(iso)
	if err != nil {
		return "--:--:--"
	}
	return parsed.Local().Format("15:04:05")
}

func parseISO(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, errors.New("empty")
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err == nil {
		return parsed, nil
	}
	parsed, err = time.Parse(time.RFC3339Nano, trimmed)
	if err == nil {
		return parsed, nil
	}
	return time.Time{}, err
}

func parseAnyInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.Atoi(trimmed)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func parseAnyBool(value any) (bool, bool) {
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		switch normalized {
		case "1", "true", "yes", "on":
			return true, true
		case "0", "false", "no", "off":
			return false, true
		default:
			return false, false
		}
	case float64:
		return typed != 0, true
	case int:
		return typed != 0, true
	default:
		return false, false
	}
}

func isCouncilTranscriptMessage(msg triChatMessage) bool {
	if strings.EqualFold(msg.Role, "system") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(msg.AgentID), "user") {
		return false
	}
	if len(msg.Metadata) == 0 {
		return false
	}
	if councilExchange, ok := parseAnyBool(msg.Metadata["council_exchange"]); ok && councilExchange {
		return true
	}
	kind := strings.ToLower(strings.TrimSpace(fmt.Sprint(msg.Metadata["kind"])))
	if strings.Contains(kind, "council") {
		return true
	}
	if kind == "fanout-interop" {
		if questionCount, ok := parseAnyInt(msg.Metadata["council_question_count"]); ok && questionCount > 0 {
			return true
		}
	}
	return false
}

func wrapText(text string, width int) string {
	if width <= 0 {
		return text
	}
	lines := strings.Split(text, "\n")
	wrapped := make([]string, 0, len(lines))
	for _, line := range lines {
		words := strings.Fields(line)
		if len(words) == 0 {
			wrapped = append(wrapped, "")
			continue
		}
		current := words[0]
		for _, word := range words[1:] {
			if len(current)+1+len(word) <= width {
				current += " " + word
				continue
			}
			wrapped = append(wrapped, current)
			current = word
		}
		wrapped = append(wrapped, current)
	}
	return strings.Join(wrapped, "\n")
}

func compactTimelineMessage(text string, maxLines int, maxChars int) string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.TrimSpace(normalized)
	if normalized == "" {
		return ""
	}

	rawLines := strings.Split(normalized, "\n")
	lines := make([]string, 0, len(rawLines))
	lastBlank := false
	for _, line := range rawLines {
		trimmed := strings.TrimRight(line, " \t")
		isBlank := strings.TrimSpace(trimmed) == ""
		if isBlank && lastBlank {
			continue
		}
		lines = append(lines, trimmed)
		lastBlank = isBlank
	}

	if maxLines > 0 && len(lines) > maxLines {
		hidden := len(lines) - maxLines
		lines = append(lines[:maxLines], fmt.Sprintf("[... %d lines hidden]", hidden))
	}

	joined := strings.TrimSpace(strings.Join(lines, "\n"))
	if maxChars > 0 && len(joined) > maxChars {
		return strings.TrimSpace(truncate(joined, maxChars-18) + "\n[... truncated]")
	}
	return joined
}

func truncate(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(text) <= limit {
		return text
	}
	if limit <= 3 {
		return text[:limit]
	}
	return text[:limit-3] + "..."
}

func compactSingleLine(text string, limit int) string {
	compact := strings.Join(strings.Fields(text), " ")
	return truncate(compact, limit)
}

func cycleString(options []string, current string, delta int) string {
	if len(options) == 0 {
		return current
	}
	idx := 0
	for i, option := range options {
		if option == current {
			idx = i
			break
		}
	}
	idx = (idx + delta) % len(options)
	if idx < 0 {
		idx += len(options)
	}
	return options[idx]
}

func cycleInt(options []int, current int, delta int) int {
	if len(options) == 0 {
		return current
	}
	idx := 0
	for i, option := range options {
		if option == current {
			idx = i
			break
		}
	}
	idx = (idx + delta) % len(options)
	if idx < 0 {
		idx += len(options)
	}
	return options[idx]
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func formatTmuxQueueAge(seconds *float64) string {
	if seconds == nil {
		return "n/a"
	}
	rounded := int(math.Round(*seconds))
	if rounded < 0 {
		rounded = 0
	}
	if rounded < 60 {
		return fmt.Sprintf("%ds", rounded)
	}
	minutes := rounded / 60
	remain := rounded % 60
	return fmt.Sprintf("%dm%02ds", minutes, remain)
}

func nullCoalesce(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func epochOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return float64(t.Unix()) + float64(t.Nanosecond())/1e9
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func ternary[T any](condition bool, whenTrue T, whenFalse T) T {
	if condition {
		return whenTrue
	}
	return whenFalse
}

func main() {
	cfg := parseFlags()
	if _, err := os.Stat(filepath.Join(cfg.repoRoot, "scripts", "mcp_tool_call.mjs")); err != nil {
		fmt.Fprintf(os.Stderr, "missing scripts/mcp_tool_call.mjs in repo root %s\n", cfg.repoRoot)
		os.Exit(1)
	}
	p := tea.NewProgram(newModel(cfg), tea.WithMouseCellMotion())
	if cfg.altScreen {
		p = tea.NewProgram(newModel(cfg), tea.WithAltScreen(), tea.WithMouseCellMotion())
	}
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "trichat-tui fatal error: %v\n", err)
		os.Exit(1)
	}
}
