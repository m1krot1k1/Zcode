package main

import "fmt"

// WorkspaceIdentity keeps the index isolation key explicit.
type WorkspaceIdentity struct {
	Raw string
}

// Normalized returns the trimmed identity or an empty string.
func (w WorkspaceIdentity) Normalized() string {
	return trimSpace(w.Raw)
}

// IndexState describes the local index lifecycle.
type IndexState string

const (
	StateIdle     IndexState = "idle"
	StateIndexing IndexState = "indexing"
	StateReady    IndexState = "ready"
)

func trimSpace(value string) string {
	start := 0
	end := len(value)
	for start < end && value[start] == ' ' {
		start++
	}
	for end > start && value[end-1] == ' ' {
		end--
	}
	return value[start:end]
}

func resolveIdentity(identity string, fallback string) string {
	trimmed := trimSpace(identity)
	if trimmed != "" {
		return trimmed
	}
	return trimSpace(fallback)
}

func main() {
	key := resolveIdentity("", "/workspace")
	fmt.Println(WorkspaceIdentity{Raw: key}.Normalized(), StateReady)
}
