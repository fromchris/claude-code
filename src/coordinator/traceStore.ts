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

  /** Register an agent so peers can discover it. Idempotent. */
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
    }
    if (!this.cursors.has(agentId)) {
      this.cursors.set(agentId, new Map())
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
   */
  write(agentId: string, entry: Omit<TraceEntry, 'timestamp'>): void {
    const state = this.agents.get(agentId)
    if (!state) return

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
   * Read new trace entries from all *peer* agents (i.e. every registered agent
   * except the caller). Returns only entries that arrived since the last call
   * from this reader (delta reads via per-reader cursors).
   *
   * Returns an empty array if there are no peers or no new entries.
   */
  readPeerTraces(readerAgentId: string): Array<{
    agentId: string
    label?: string
    entries: TraceEntry[]
  }> {
    const cursor = this.cursors.get(readerAgentId)
    if (!cursor) return []

    const result: Array<{ agentId: string; label?: string; entries: TraceEntry[] }> = []

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
        result.push({
          agentId: peerId,
          label: peerState.label,
          entries: newEntries,
        })
      }

      // Advance cursor
      cursor.set(peerId, peerState.sequence)
    }

    return result
  }

  /**
   * Format peer traces as a human-readable string suitable for injection
   * into a tool result message.
   *
   * Returns an empty string if there are no new peer traces.
   */
  formatPeerTracesForInjection(readerAgentId: string): string {
    const peerTraces = this.readPeerTraces(readerAgentId)
    if (peerTraces.length === 0) return ''

    // Visual logging for debugging
    const readerLabel = this.agents.get(readerAgentId)?.label ?? readerAgentId.slice(0, 8)
    for (const peer of peerTraces) {
      const peerLabel = peer.label ?? peer.agentId.slice(0, 8)
      for (const entry of peer.entries) {
        traceLog(`[TRACE-READ] ${readerLabel} ← received from ${peerLabel}: "${entry.summary}"`)
      }
    }

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
