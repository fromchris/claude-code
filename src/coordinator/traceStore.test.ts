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
})
