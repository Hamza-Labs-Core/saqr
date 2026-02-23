---
name: recall
description: Retrieve context from previous Claude Code sessions. Use when the user asks about what was done before, when continuing work from a prior session, or when you need to understand previous decisions and file changes.
argument-hint: "[session-id | --chain | --search keyword]"
allowed-tools: "Bash(gc-query *)"
---

# Recall Previous Session Context

You have access to GlobalContext, an event store that captures all Claude Code session activity. Use it to recall what happened in previous sessions.

## Commands

Run these via Bash:

### Default: last session context
```
gc-query last
```

### Full session chain (parent sessions)
```
gc-query last --include-parent
```

### Specific session
```
gc-query session $ARGUMENTS
```

### List sessions
```
gc-query sessions
gc-query sessions --all-projects
```

### Search across sessions
```
gc-query search $ARGUMENTS
```

## Behavior

1. If no arguments given, run `gc-query last` to show context from the most recent session for this project.
2. If `--chain` is passed, run `gc-query last --include-parent` to follow the session chain.
3. If `--search` is passed, run `gc-query search` with the remaining arguments.
4. Otherwise, treat the argument as a session ID and run `gc-query session <id>`.
5. Present the output clearly to the user. Summarize key points: what was being worked on, files modified, and decisions made.
