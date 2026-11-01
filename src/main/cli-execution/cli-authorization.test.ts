import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmCliExecution } from './cli-authorization'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

describe('Native CLI approval disclosure', () => {
  beforeEach(() => showMessageBox.mockReset())
  it('requires an exact-command decision and displays the selected identity and literal argv', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    const window = { isDestroyed: () => false } as never
    const worktree = { worktreeId: 'tree', generation: 'generation', head: 'commit', branch: 'topic', indexRevision: 'index' }
    const command = { executable: 'node.exe', originalExecutable: 'node', args: ['-e', 'console.log("a b")'], cwd: 'selected', relativeCwd: '.', displayCommandLine: 'node.exe -e "console.log(\"a b\")"' }
    expect(await confirmCliExecution(window, { proposalId: 'p', operationId: 'o', repositoryId: 'repo',
      repositoryDirectory: 'selected', activeCheckoutDirectory: 'active', worktree, command, risks: ['INLINE_SCRIPT_EVALUATION'] })).toBe(true)
    const options = showMessageBox.mock.calls[0][1]
    for (const value of ['selected', 'active', ...Object.values(worktree), JSON.stringify(command.args), command.displayCommandLine, 'INLINE_SCRIPT_EVALUATION', 'não concede lease Git']) {
      expect(options.detail).toContain(value)
    }
    expect(options.message).toContain('Worktree selecionada')
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    showMessageBox.mockResolvedValue({ response: 0 })
    expect(await confirmCliExecution(window, { proposalId: 'p', operationId: 'o', command, repositoryDirectory: 'active', repositoryId: null, risks: [] })).toBe(false)
  })
  it('refuses when no live owner window exists', async () => {
    expect(await confirmCliExecution(null, {} as never)).toBe(false)
    expect(await confirmCliExecution({ isDestroyed: () => true } as never, {} as never)).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
