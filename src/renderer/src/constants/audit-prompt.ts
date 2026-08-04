/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Armazenar a constante do prompt padrão de auditoria de implementações.

Mapa de Relacionamentos do Script

1. ../components/CodeJourneyView/hooks/useJourneyAudit.ts
   - Tipo: Dependência Inversa
   - Relação: Importa DEFAULT_AUDIT_PROMPT para inicializar o prompt padrão de auditoria.
   - Criticidade: Média

Invariantes do Script

1. O prompt padrão deve ser exportado como uma string imutável preservando exatamente o texto estabelecido.

--- FIM ARQUITETURA DO SCRIPT ---
*/

export const DEFAULT_AUDIT_PROMPT = `Analise as alterações de código abaixo como um Engenheiro de Software Staff extremamente rigoroso.

Seu papel é auditar o trabalho realizado pelo agente de implementação e validar se a tarefa foi cumprida de forma íntegra, segura e profissional.

Instruções da sua auditoria:
1. Avalie se os requisitos foram completamente atendidos.
2. Identifique bugs ocultos, problemas de lógica ou quebras de arquitetura.
3. Forneça um veredito direto: "APROVADO" ou "REPROVADO COM AJUSTES".

Abaixo está o diff semântico das alterações:
--------------------------------------------------`
