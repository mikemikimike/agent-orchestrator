//go:build chatui_regression

package sessionmanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// MQA-06 reproduces a legacy user+assistant checkpoint that provider replay can
// never reach. Strict retries remain closed; only explicit provider-history
// consent admits the same native thread, and that consent cannot be replayed
// against a trusted mismatch. The source worktree is an invariant throughout.
func TestChatUIRegressionTUIToChatProviderHistoryRecoveryIsScoped(t *testing.T) {
	manager, store, runtime, baseChat, _ := newTransitionManager(t, domain.SessionModeTUI)
	chat := &checkpointAwareHistoryTransitionChat{transitionChat: baseChat, store: store}
	manager.chat = chat
	runtime.aliveByHandle = map[string]bool{"runtime-1": true}
	rec := store.sessions["session-1"]
	rec.Metadata.LatestUserPrompt = "poisoned user checkpoint"
	rec.Metadata.LatestAssistantUpdate = "poisoned assistant checkpoint"
	rec.Metadata.ConversationCheckpointState = domain.ConversationCheckpointLegacy
	store.sessions[rec.ID] = rec

	worktree := t.TempDir()
	sentinel := filepath.Join(worktree, "unchanged.txt")
	if err := os.WriteFile(sentinel, []byte("must remain unchanged\n"), 0o644); err != nil {
		t.Fatalf("seed worktree sentinel: %v", err)
	}
	assertWorktreeUnchanged := func() {
		got, err := os.ReadFile(sentinel)
		if err != nil || string(got) != "must remain unchanged\n" {
			t.Fatalf("worktree sentinel changed: content=%q err=%v", got, err)
		}
	}

	strict, err := manager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeChat, domain.SessionInterfaceTransitionInterrupt, domain.SessionInterfaceTransitionHistoryStrict)

	if err != nil {
		t.Fatalf("start strict MQA-06 transition: %v", err)
	}
	strict = awaitTransition(t, store, strict.ID)
	if strict.ErrorCode != "TARGET_HISTORY_UNTRUSTED_TEXT_MISMATCH" {
		t.Fatalf("strict transition = %+v, want legacy text-only mismatch", strict)
	}
	assertWorktreeUnchanged()

	confirmRestoredOwner := func() {
		current := store.sessions["session-1"]
		current.Metadata.AgentSessionIDLaunchID = current.Metadata.RuntimeLaunchID
		store.sessions[current.ID] = current
	}
	confirmRestoredOwner()
	ordinary, err := manager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeChat, domain.SessionInterfaceTransitionDrain, domain.SessionInterfaceTransitionHistoryStrict)

	if err != nil {
		t.Fatalf("start strict retry: %v", err)
	}
	ordinary = awaitTransition(t, store, ordinary.ID)
	if ordinary.ErrorCode != "TARGET_HISTORY_UNTRUSTED_TEXT_MISMATCH" {
		t.Fatalf("strict retry = %+v, want the same closed mismatch", ordinary)
	}
	assertWorktreeUnchanged()

	confirmRestoredOwner()
	recovery, err := manager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeChat, domain.SessionInterfaceTransitionDrain,
		domain.SessionInterfaceTransitionHistoryProvider)
	if err != nil {
		t.Fatalf("start provider-history recovery: %v", err)
	}
	recovery = awaitTransition(t, store, recovery.ID)
	if recovery.Phase != domain.SessionInterfaceTransitionCompleted ||
		recovery.HistoryPolicy != domain.SessionInterfaceTransitionHistoryProvider {
		t.Fatalf("provider-history recovery = %+v, want completed scoped consent", recovery)
	}
	assertWorktreeUnchanged()

	// A separate trusted mismatch must remain closed and must not even stop the
	// source when a caller attempts to reuse provider-history authority.
	trustedManager, trustedStore, trustedRuntime, trustedChat, _ := newTransitionManager(t, domain.SessionModeTUI)
	trustedRuntime.aliveByHandle = map[string]bool{"runtime-1": true}
	trustedChat.startErr = &ports.ChatHistoryUnsettledError{Dimensions: []ports.ChatHistoryMismatchDimension{
		ports.ChatHistoryMismatchTrustedUserText,
	}}
	trusted, err := trustedManager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeChat, domain.SessionInterfaceTransitionInterrupt, domain.SessionInterfaceTransitionHistoryStrict)

	if err != nil {
		t.Fatalf("start trusted mismatch: %v", err)
	}
	trusted = awaitTransition(t, trustedStore, trusted.ID)
	if trusted.ErrorCode != "TARGET_HISTORY_UNSETTLED" {
		t.Fatalf("trusted mismatch = %+v, want non-recoverable history error", trusted)
	}
	destroyed := trustedRuntime.destroyed
	_, err = trustedManager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeChat, domain.SessionInterfaceTransitionDrain,
		domain.SessionInterfaceTransitionHistoryProvider)
	if !errors.Is(err, ErrInterfaceProviderHistoryRecoveryUnavailable) {
		t.Fatalf("trusted provider-history request = %v, want unavailable", err)
	}
	if trustedRuntime.destroyed != destroyed {
		t.Fatalf("rejected trusted recovery touched source runtime: %d -> %d", destroyed, trustedRuntime.destroyed)
	}
	assertWorktreeUnchanged()
}
