import { describe, test, expect } from 'bun:test'
import { globalTraceStore } from './traceStore.js'

// Use unique IDs per test AND unregister after each test
let testNum = 0
function uid(prefix: string) {
  testNum++
  return `${prefix}-${testNum}-${Date.now()}`
}

describe('TraceStore', () => {
  test('register and write', () => {
    const a = uid('a')
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.write(a, { summary: 'Reading auth module', lastTool: 'FileRead' })
    
    expect(globalTraceStore.getRegisteredAgentIds()).toContain(a)
    
    globalTraceStore.unregister(a)
  })

  test('peer traces are visible to other agents', () => {
    const a = uid('a')
    const b = uid('b')
    
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.register(b, 'Worker B')
    
    globalTraceStore.write(a, { summary: 'Found null pointer in validate.ts:42', lastTool: 'FileRead' })
    
    const traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(1)
    expect(traces[0]!.agentId).toBe(a)
    expect(traces[0]!.entries[0]!.summary).toBe('Found null pointer in validate.ts:42')
    
    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  test('self traces are NOT visible', () => {
    const a = uid('a')
    
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.write(a, { summary: 'My own trace' })
    
    const traces = globalTraceStore.readPeerTraces(a)
    expect(traces.length).toBe(0)
    
    globalTraceStore.unregister(a)
  })

  test('delta reads — only new traces since last read', () => {
    const a = uid('a')
    const b = uid('b')
    
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.register(b, 'Worker B')
    
    // A writes first trace
    globalTraceStore.write(a, { summary: 'Step 1: reading files' })
    
    // B reads — sees 1 trace
    let traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(1)
    expect(traces[0]!.entries.length).toBe(1)
    
    // B reads again — no new traces
    traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(0)
    
    // A writes second trace
    globalTraceStore.write(a, { summary: 'Step 2: found the bug' })
    
    // B reads — sees only the NEW trace
    traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(1)
    expect(traces[0]!.entries.length).toBe(1)
    expect(traces[0]!.entries[0]!.summary).toBe('Step 2: found the bug')
    
    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  test('multiple peers visible', () => {
    const a = uid('a')
    const b = uid('b')
    const c = uid('c')
    
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.register(b, 'Worker B')
    globalTraceStore.register(c, 'Worker C')
    
    globalTraceStore.write(a, { summary: 'A is doing research' })
    globalTraceStore.write(b, { summary: 'B is running tests' })
    
    const traces = globalTraceStore.readPeerTraces(c)
    expect(traces.length).toBe(2)
    
    const summaries = traces.map(t => t.entries[0]!.summary).sort()
    expect(summaries).toEqual(['A is doing research', 'B is running tests'])
    
    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
    globalTraceStore.unregister(c)
  })

  test('formatPeerTracesForInjection produces XML', () => {
    const a = uid('a')
    const b = uid('b')
    
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.register(b, 'Worker B')
    
    globalTraceStore.write(a, { 
      summary: 'Investigating auth bug', 
      lastTool: 'BashTool',
      reasoning: 'The error trace points to validate.ts'
    })
    
    const xml = globalTraceStore.formatPeerTracesForInjection(b)
    expect(xml).toContain('<peer_agent_traces>')
    expect(xml).toContain('</peer_agent_traces>')
    expect(xml).toContain('Worker A')
    expect(xml).toContain('Investigating auth bug')
    expect(xml).toContain('tool=BashTool')
    expect(xml).toContain('reasoning: The error trace points to validate.ts')
    
    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  test('empty when no peers', () => {
    const a = uid('a')
    globalTraceStore.register(a, 'Lonely Worker')
    globalTraceStore.write(a, { summary: 'Working alone' })
    
    const xml = globalTraceStore.formatPeerTracesForInjection(a)
    expect(xml).toBe('')
    
    globalTraceStore.unregister(a)
  })

  test('unregister cleans up', () => {
    const a = uid('a')
    const b = uid('b')
    
    globalTraceStore.register(a)
    globalTraceStore.register(b)
    
    globalTraceStore.write(a, { summary: 'trace from a' })
    globalTraceStore.unregister(a)
    
    const traces = globalTraceStore.readPeerTraces(b)
    const fromA = traces.filter(t => t.agentId === a)
    expect(fromA.length).toBe(0)
    
    globalTraceStore.unregister(b)
  })

  // ── Fix #3: new reader should NOT see pre-registration entries ───────────
  test('new reader does not see entries written before registration (fix #3)', () => {
    const a = uid('a')
    const b = uid('b')

    // a is registered and writes a trace BEFORE b even exists
    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.write(a, { summary: 'pre-registration trace' })

    // b registers after a has already written
    globalTraceStore.register(b, 'Worker B')

    // b should see NO traces from a because they pre-date b's registration
    const traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(0)

    // Now a writes a new trace — b should see that one
    globalTraceStore.write(a, { summary: 'post-registration trace' })
    const traces2 = globalTraceStore.readPeerTraces(b)
    expect(traces2.length).toBe(1)
    expect(traces2[0]!.entries[0]!.summary).toBe('post-registration trace')

    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  // ── Fix #2: peekFormatPeerTraces deferred cursor commit ─────────────────
  test('peekFormatPeerTraces does not advance cursor until commit() is called (fix #2)', () => {
    const a = uid('a')
    const b = uid('b')

    globalTraceStore.register(a, 'Worker A')
    globalTraceStore.register(b, 'Worker B')

    globalTraceStore.write(a, { summary: 'some trace' })

    // Peek but do NOT commit
    const { text, commit: _unusedCommit } = globalTraceStore.peekFormatPeerTraces(b)
    expect(text).toContain('some trace')

    // Read again — cursor was NOT advanced, so we should still see the trace
    const { text: text2, commit: commit2 } = globalTraceStore.peekFormatPeerTraces(b)
    expect(text2).toContain('some trace')

    // Now commit
    commit2()

    // After commit, cursor advanced — no more new traces
    const { text: text3 } = globalTraceStore.peekFormatPeerTraces(b)
    expect(text3).toBe('')

    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  // ── Fix #9: re-registration updates label ───────────────────────────────
  test('re-registration updates label (fix #9)', () => {
    const a = uid('a')
    const b = uid('b')

    globalTraceStore.register(a, 'Old Label')
    globalTraceStore.register(b, 'Worker B')

    globalTraceStore.write(a, { summary: 'trace with new label' })

    // Re-register a with a new label
    globalTraceStore.register(a, 'New Label')

    const traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(1)
    expect(traces[0]!.label).toBe('New Label')

    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })

  // ── Fix #3: new reader with pruned entries doesn't crash ─────────────────
  test('new reader is safe when pre-existing agent has pruned entries (fix #3)', () => {
    const a = uid('a')
    const b = uid('b')

    globalTraceStore.register(a, 'Worker A')

    // Write 25 entries (exceeds maxEntriesPerAgent=20 so pruning happens)
    for (let i = 0; i < 25; i++) {
      globalTraceStore.write(a, { summary: `entry ${i}` })
    }

    // b registers after pruning
    globalTraceStore.register(b, 'Worker B')

    // b should NOT see any pruned-then-re-derived entries
    const traces = globalTraceStore.readPeerTraces(b)
    expect(traces.length).toBe(0)

    // New entries after b registered should be visible
    globalTraceStore.write(a, { summary: 'after b registered' })
    const traces2 = globalTraceStore.readPeerTraces(b)
    expect(traces2.length).toBe(1)
    expect(traces2[0]!.entries[0]!.summary).toBe('after b registered')

    globalTraceStore.unregister(a)
    globalTraceStore.unregister(b)
  })
})
