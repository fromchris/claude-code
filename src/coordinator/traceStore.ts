/**
 * TraceStore — in-memory shared store for multi-agent reasoning trace sharing.
 *
 * Allows parallel Worker Agents to publish their current reasoning state and
 * subscribe to peer traces so each agent can see what its siblings are thinking.
 *
 * Design constraints:
 * - Pure in-memory, zero persistence (prototype only)
 * - No circular dependencies (no imports from query.ts or Tool.ts)
 * - Thread-safe at the JS level (single-threaded event loop)
 */

import { appendFileSync } from 'node:fs'

const TRACE_LOG = '/tmp/agent-trace.log'
function traceLog(msg: string) {
  try { appendFileSync(TRACE_LOG, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

export interface TraceEntry {
  /** ISO timestamp when the trace was written */
  timestamp: number
  /** Human-readable summary of what the agent is currently doing */
  summary: string
  /** Optional last tool used */
  lastTool?: string
  /** Optional snippet of assistant reasoning / thinking */
  reasoning?: string
}

interface AgentTraceState {
  agentId: string
  /** Optional human-readable label (e.g. "worker-1") */
  label?: string
  /** All trace entries for this agent, oldest first */
  entries: TraceEntry[]
  /** Monotonic sequence for "since last read" tracking */
  sequence: number
}

/** Lightweight per-reader cursor: tracks the last sequence number consumed */
type ReadCursor = Map<string /* peerId */, number /* lastSeenSequence */>

class TraceStore {
  private readonly agents = new Map<string, AgentTraceState>()
  /** Per-agent read cursors: readerAgentId → (writerAgentId → lastSeq) */
  private readonly cursors = new Map<string, ReadCursor>()
  /** Maximum entries retained per agent to bound memory */
  private readonly maxEntriesPerAgent = 20

  /** Register an agent so peers can discover it. Idempotent.
   * Fix #9: Re-registration updates the label if provided.
   */
  register(agentId: string, label?: string): void {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        agentId,
        label,
        entries: [],
        sequence: 0,
      })
      const name = label ?? agentId.slice(0, 8)
      traceLog(`[TRACE-STORE] Agent registered: ${name} (total: ${this.agents.size})`)
    } else if (label !== undefined) {
      // Fix #9: update label on re-registration
      this.agents.get(agentId)!.label = label
    }
    if (!this.cursors.has(agentId)) {
      // Fix #3: initialise cursor to current sequence of all existing agents so a
      // freshly-registered reader does not receive entries that pre-date its
      // registration (which may already be partially pruned).
      const cursor: ReadCursor = new Map()
      for (const [id, state] of this.agents) {
        if (id !== agentId) {
          cursor.set(id, state.sequence)
        }
      }
      this.cursors.set(agentId, cursor)
    }
  }

  /** Unregister an agent on completion to free memory. */
  unregister(agentId: string): void {
    const label = this.agents.get(agentId)?.label ?? agentId.slice(0, 8)
    traceLog(`[TRACE-STORE] Agent unregistered: ${label}`)
    this.agents.delete(agentId)
    this.cursors.delete(agentId)
    // Remove stale cursors pointing to this agent
    for (const cursor of this.cursors.values()) {
      cursor.delete(agentId)
    }
  }

  /**
   * Write a new trace entry for an agent.
   * Automatically prunes old entries beyond maxEntriesPerAgent.
   * Fix #5: warns when writing for an unregistered agent.
   */
  write(agentId: string, entry: Omit<TraceEntry, 'timestamp'>): void {
    const state = this.agents.get(agentId)
    if (!state) {
      // Fix #5: log a warning instead of silently ignoring
      traceLog(`[TRACE-WARN] write() called for unregistered agent: ${agentId.slice(0, 8)}`)
      return
    }

    state.entries.push({
      timestamp: Date.now(),
      ...entry,
    })
    state.sequence++

    // Visual logging for debugging
    const label = state.label ?? agentId.slice(0, 8)
    const tool = entry.lastTool ? ` [${entry.lastTool}]` : ''
    traceLog(`[TRACE-WRITE] ${label}${tool} → ${entry.summary}`)

    // Prune oldest entries if over limit
    if (state.entries.length > this.maxEntriesPerAgent) {
      state.entries.splice(0, state.entries.length - this.maxEntriesPerAgent)
    }
  }

  /**
   * Internal: collect new peer trace entries WITHOUT advancing the cursor.
   * Returns both the data and the cursor updates that should be committed.
   */
  private _peekPeerTraces(readerAgentId: string): {
    traces: Array<{ agentId: string; label?: string; entries: TraceEntry[] }>
    cursorUpdates: Map<string, number>
  } {
    const cursor = this.cursors.get(readerAgentId)
    if (!cursor) return { traces: [], cursorUpdates: new Map() }

    const traces: Array<{ agentId: string; label?: string; entries: TraceEntry[] }> = []
    const cursorUpdates = new Map<string, number>()

    for (const [peerId, peerState] of this.agents) {
      if (peerId === readerAgentId) continue // skip self

      const lastSeenSeq = cursor.get(peerId) ?? 0
      if (peerState.sequence <= lastSeenSeq) continue // no new entries

      // Find entries added after the last seen sequence.
      // sequence is incremented once per write(), so entries.length == sequence
      // (after pruning, entries.length may be less — we take the last N entries
      // relative to what we've already seen).
      const newCount = peerState.sequence - lastSeenSeq
      const newEntries = peerState.entries.slice(-Math.min(newCount, peerState.entries.length))

      if (newEntries.length > 0) {
        traces.push({
          agentId: peerId,
          label: peerState.label,
          entries: newEntries,
        })
        // Record what we would advance to — but don't touch the real cursor yet
        cursorUpdates.set(peerId, peerState.sequence)
      }
    }

    return { traces, cursorUpdates }
  }

  /**
   * Read new trace entries from all *peer* agents (i.e. every registered agent
   * except the caller). Returns only entries that arrived since the last call
   * from this reader (delta reads via per-reader cursors).
   *
   * Advances the cursor immediately (eager commit).
   * Returns an empty array if there are no peers or no new entries.
   */
  readPeerTraces(readerAgentId: string): Array<{
    agentId: string
    label?: string
    entries: TraceEntry[]
  }> {
    const cursor = this.cursors.get(readerAgentId)
    if (!cursor) return []

    const { traces, cursorUpdates } = this._peekPeerTraces(readerAgentId)

    // Advance cursor eagerly
    for (const [peerId, seq] of cursorUpdates) {
      cursor.set(peerId, seq)
    }

    return traces
  }

  /**
   * Peek at new peer traces and return a deferred-commit handle.
   *
   * Fix #2: the cursor is NOT advanced until `commit()` is called, so if the
   * caller yields the data and then gets aborted before the yield succeeds the
   * trace entries are not lost.
   *
   * Returns `{ text, commit }` where:
   * - `text` is the formatted XML string (empty if no new traces)
   * - `commit()` advances the read cursor; call it after a successful yield
   */
  peekFormatPeerTraces(readerAgentId: string): { text: string; commit: () => void } {
    const cursor = this.cursors.get(readerAgentId)
    if (!cursor) return { text: '', commit: () => {} }

    const { traces, cursorUpdates } = this._peekPeerTraces(readerAgentId)
    if (traces.length === 0) return { text: '', commit: () => {} }

    // Logging
    const readerLabel = this.agents.get(readerAgentId)?.label ?? readerAgentId.slice(0, 8)
    for (const peer of traces) {
      const peerLabel = peer.label ?? peer.agentId.slice(0, 8)
      for (const entry of peer.entries) {
        traceLog(`[TRACE-READ] ${readerLabel} ← received from ${peerLabel}: "${entry.summary}"`)
      }
    }

    const text = this._formatTraces(traces)

    return {
      text,
      commit: () => {
        for (const [peerId, seq] of cursorUpdates) {
          cursor.set(peerId, seq)
        }
      },
    }
  }

  /** Shared formatter used by both peekFormatPeerTraces and formatPeerTracesForInjection. */
  private _formatTraces(
    peerTraces: Array<{ agentId: string; label?: string; entries: TraceEntry[] }>,
  ): string {
    const lines: string[] = ['<peer_agent_traces>']
    for (const peer of peerTraces) {
      const name = peer.label ?? peer.agentId.slice(0, 8)
      lines.push(`  <agent id="${name}">`)
      for (const entry of peer.entries) {
        const parts: string[] = [`    [${new Date(entry.timestamp).toISOString()}]`]
        if (entry.lastTool) parts.push(`tool=${entry.lastTool}`)
        parts.push(entry.summary)
        if (entry.reasoning) parts.push(`| reasoning: ${entry.reasoning}`)
        lines.push(parts.join(' '))
      }
      lines.push('  </agent>')
    }
    lines.push('</peer_agent_traces>')
    return lines.join('\n')
  }

  /**
   * Format peer traces as a human-readable string suitable for injection
   * into a tool result message.
   *
   * Returns an empty string if there are no new peer traces.
   * Advances the cursor immediately (backward-compatible eager behaviour).
   * Prefer `peekFormatPeerTraces()` when a deferred-commit is needed.
   */
  formatPeerTracesForInjection(readerAgentId: string): string {
    const { text, commit } = this.peekFormatPeerTraces(readerAgentId)
    if (text) commit()
    return text
  }

  /** Returns the number of currently registered agents. */
  get size(): number {
    return this.agents.size
  }

  /** Returns IDs of all registered agents. */
  getRegisteredAgentIds(): string[] {
    return Array.from(this.agents.keys())
  }
}

/**
 * Process-global singleton TraceStore.
 * All workers share this instance via the module cache.
 */
export const globalTraceStore = new TraceStore()
