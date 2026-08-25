// Package processenv builds child-process environments shared by Chat drivers.
package processenv

import (
	"os"
	"runtime"
	"sort"
	"strings"
)

// Merge overlays session-specific values on the daemon environment and returns
// the KEY=VALUE form expected by os/exec. Sorting makes launches deterministic
// enough to inspect and compare in tests and process diagnostics.
func Merge(overlay map[string]string) []string {
	return mergeWith(os.Environ(), overlay, runtime.GOOS == "windows")
}

func mergeWith(base []string, overlay map[string]string, caseInsensitive bool) []string {
	merged := make(map[string]string, len(base)+len(overlay))
	canonical := make(map[string]string, len(base)+len(overlay))
	for _, entry := range base {
		if key, value, ok := strings.Cut(entry, "="); ok {
			setEnv(merged, canonical, caseInsensitive, key, value)
		}
	}
	for key, value := range overlay {
		setEnv(merged, canonical, caseInsensitive, key, value)
	}

	out := make([]string, 0, len(merged))
	for key := range merged {
		out = append(out, key+"="+merged[key])
	}
	sort.Strings(out)
	return out
}

func setEnv(merged, canonical map[string]string, caseInsensitive bool, key, value string) {
	if caseInsensitive {
		folded := strings.ToUpper(key)
		if existing, ok := canonical[folded]; ok && existing != key {
			delete(merged, existing)
		}
		canonical[folded] = key
	}
	merged[key] = value
}
