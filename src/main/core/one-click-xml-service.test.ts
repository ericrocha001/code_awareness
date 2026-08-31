/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente o comportamento do OneClickXmlService com dublês de IgnorePolicy e RepomixDirectOutputPort.
2. Garantir fidelidade estrita do XML retornado (sem envelopes artificiais do Code Dash).
3. Garantir o bloqueio imediato com erro claro quando a allowlist estiver vazia.
4. Validar o correto repasse de opções de limpeza (removeComments, removeEmptyLines, truncateBase64) e formato XML no RepomixRequest.
5. Validar o tratamento de falhas e exceções da porta de Direct Output.

Mapa de Relacionamentos do Script

1. one-click-xml-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e testa a classe OneClickXmlService.
   - Criticidade: Alta

2. ignore-policy.ts
   - Tipo: Dependência Direta
   - Relação: Mockado para simular resolução de allowlists.
   - Criticidade: Alta

Invariantes do Script

1. Testes não devem chamar o Repomix CLI real nem depender de Electron real.
2. Testes operam em memória com isolamento completo.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, expect, it, vi } from 'vitest'
import type { IgnorePolicy } from './ignore-policy'
import {
  OneClickXmlService,
  type RepomixDirectOutputPort
} from './one-click-xml-service'
import type { RepomixRequest } from './repomix-request'

describe('OneClickXmlService', () => {
  const repoPath = '/test/repo'

  it('1. Fidelidade de retorno: retorna exatamente o conteúdo nativo gerado pelo Repomix', async () => {
    const nativeRepomixXml = `<?xml version="1.0" encoding="UTF-8"?>
<repomix>
  <file path="src/index.ts">
    console.log("hello");
  </file>
</repomix>`

    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockResolvedValue({
        content: nativeRepomixXml,
        failed: false
      })
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).toBe(nativeRepomixXml)
    expect(result.metadata?.fileCount).toBe(1)
    expect(result.timings).toBeDefined()
    expect(result.timings?.totalMs).toBeGreaterThanOrEqual(0)
  })

  it('2. Nenhum envelope próprio: não encapsula o XML com tags do Code Dash', async () => {
    const rawXml = '<custom-native-xml>code</custom-native-xml>'

    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['a.ts', 'b.ts'])
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockResolvedValue({
        content: rawXml,
        failed: false
      })
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).toBe(rawXml)
    expect(result.xml).not.toContain('<code-dash-context>')
    expect(result.xml).not.toContain('<![CDATA[')
    expect(result.xml).not.toContain('<requested-count>')
  })

  it('3. Allowlist vazia: encerra com erro claro e NÃO chama a porta de Direct Output', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue([])
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn()
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Nenhum arquivo elegível/)
    expect(result.xml).toBeUndefined()
    expect(mockPort.generateDirectOutput).not.toHaveBeenCalled()
  })

  it('4. Opções de limpeza são propagadas para o RepomixRequest com formato XML', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['src/app.ts'])
    } as unknown as IgnorePolicy

    let capturedRequest: RepomixRequest | null = null
    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockImplementation(async (req: RepomixRequest) => {
        capturedRequest = req
        return { content: '<xml/>', failed: false }
      })
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    await service.generateOneClickXml(repoPath, {
      removeComments: true,
      removeEmptyLines: true,
      truncateBase64: true
    })

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.outputFormat).toBe('xml')
    expect(capturedRequest!.profile.removeComments).toBe(true)
    expect(capturedRequest!.profile.removeEmptyLines).toBe(true)
    expect(capturedRequest!.profile.truncateBase64).toBe(true)
    expect(capturedRequest!.profile.path).toBe('direct-output')
    expect(capturedRequest!.selectedFiles).toEqual(['src/app.ts'])
  })

  it('5. Opções ausentes assumem valor padrão false', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['src/app.ts'])
    } as unknown as IgnorePolicy

    let capturedRequest: RepomixRequest | null = null
    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockImplementation(async (req: RepomixRequest) => {
        capturedRequest = req
        return { content: '<xml/>', failed: false }
      })
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    await service.generateOneClickXml(repoPath)

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.outputFormat).toBe('xml')
    expect(capturedRequest!.profile.removeComments).toBe(false)
    expect(capturedRequest!.profile.removeEmptyLines).toBe(false)
    expect(capturedRequest!.profile.truncateBase64).toBe(false)
  })

  it('6. Falha do adapter: repassa a mensagem de erro sem fabricar XML', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['src/app.ts'])
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockResolvedValue({
        content: '',
        failed: true,
        reason: 'Repomix falhou com exitCode 1: out of memory'
      })
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('out of memory')
    expect(result.xml).toBeUndefined()
  })

  it('7. Exceção do adapter: captura erro inesperado e retorna failure estruturado', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockResolvedValue(['src/app.ts'])
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn().mockRejectedValue(new Error('Processo morto por SIGKILL'))
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Processo morto por SIGKILL')
    expect(result.xml).toBeUndefined()
  })

  it('8. Exceção na IgnorePolicy: captura erro de listagem e retorna failure estruturado', async () => {
    const mockIgnorePolicy = {
      resolveAllowlist: vi.fn().mockRejectedValue(new Error('Permissão negada ao listar diretório'))
    } as unknown as IgnorePolicy

    const mockPort: RepomixDirectOutputPort = {
      generateDirectOutput: vi.fn()
    }

    const service = new OneClickXmlService(mockIgnorePolicy, mockPort)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Permissão negada ao listar diretório')
    expect(mockPort.generateDirectOutput).not.toHaveBeenCalled()
  })
})
