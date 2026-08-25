/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar o estado global da aplicação (aba ativa, projeto ativo e mensagens de status).
2. Gerenciar preferências de UI por projeto via hook useProjectPreferences (sidebar e viewMode).
3. Renderizar o layout principal com GlobalSidebar, conteúdo da aba ativa e toast de status.
4. Orquestrar a resolução de deep links de campanha (pedir URL pendente no mount, ouvir novas URLs) e navegar para a aba Code Campaign.

Mapa de Relacionamentos do Script

1. useProjectPreferences.ts
   - Tipo: Dependência Direta
   - Relação: Fornece preferências de UI (sidebarOpen, viewMode) persistentes por projeto.
   - Criticidade: Alta

2. HomeView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a tela inicial de seleção de projetos.
   - Criticidade: Alta

3. CodeSourceView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Source quando ativa.
   - Criticidade: Alta

4. CodeCompressionView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Compression quando ativa.
   - Criticidade: Alta

5. CodeDiffView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a aba Code Diff quando ativa.
   - Criticidade: Alta

6. App.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS globais, incluindo o toast de status.
   - Criticidade: Alta

Invariantes do Script

1. Apenas uma aba deve estar ativa por vez.
2. Preferências de sidebar devem persistir por projeto e sincronizar estado da UI com o settings.json.
3. Mensagens de erro devem persistir até descarte manual; mensagens de sucesso devem desaparecer após 5 segundos.
4. O estado statusMessage nunca deve referenciar memória liberada após o timeout.
5. Deep links inválidos, de projeto não aberto ou de campanha inexistente sempre produzem erro e nunca navegam.
6. A URL pendente é consumida exatamente uma vez (limpa após a resolução).
7. O resolvedCampaignId é limpo após o CodeCampaignView consumir (via onResolvedCampaignConsumed), impedindo reabertura automática do painel.
8. handleStatusMessage é estável (useCallback com dependências vazias) — nunca recriada a cada render, evitando reexecuções redundantes de effects dependentes.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useCallback, useEffect, useState } from "react";
import { CodeDiffView } from "./components/CodeDiffView/CodeDiffView";
import { CodeCompressionView } from "./components/CodeCompressionView/CodeCompressionView";
import { CodeSourceView } from "./components/CodeSourceView/CodeSourceView";
import { CodeCampaignView } from "./components/CodeCampaignView/CodeCampaignView";
import { CodeJourneyView } from "./components/CodeJourneyView/CodeJourneyView";
import { CodeMapView } from "./components/CodeMapView/CodeMapView";
import { HomeView } from "./components/HomeView/HomeView";
import { GlobalSidebar } from "./components/GlobalSidebar/GlobalSidebar";
import { TagManagerModal } from "./components/TagManagerModal/TagManagerModal";
import { CodeAwarenessIgnoreModal } from "./components/CodeAwarenessIgnoreModal/CodeAwarenessIgnoreModal";
import { useProjectPreferences } from "./hooks/useProjectPreferences";
import { useTheme } from "./hooks/useTheme";
import { resolveDeepLink } from "./utils/deep-link-resolver";
import type { Tab } from "./config/navigation";
import "./App.css";

export const App: React.FC = () => {
  // Invoca o hook para aplicar data-theme no <body> imediatamente
  useTheme();

  const [activeTab, setActiveTab] = useState<Tab>("home");
    const [activeProject, setActiveProject] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [isIgnoreModalOpen, setIsIgnoreModalOpen] = useState(false);
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null);
  const [resolvedCampaignId, setResolvedCampaignId] = useState<string | null>(null);
  const { preferences: sidebarPreferences, updateSidebarOpen } =
    useProjectPreferences(activeProject?.path ?? null);

  // Gerenciamento de mensagens temporárias de status
  // BUGFIX: useCallback com dependências vazias estabiliza a referência. Antes, a função era
  // recriada a cada render do App, recriando loadData no CodeMapView e reexecutando o effect
  // de troca de projeto, que limpava selectedFileId (reset duplo da seleção).
  const handleStatusMessage = useCallback((text: string, isError = false) => {
    setStatusMessage({ text, isError });
    if (!isError) {
      setTimeout(() => {
        setStatusMessage(null);
      }, 5000);
    }
  }, []);

  // Pede a URL pendente no mount (cold start) e ouve novas URLs (warm start)
  useEffect(() => {
    const loadPending = async () => {
      const url = await window.codeAwareness.getPendingDeepLink();
      console.log('[DL][rdr-pending]', JSON.stringify(url));
      if (url) setPendingDeepLink(url);
    };
    loadPending();
    const cleanup = window.codeAwareness.onDeepLink((url) => {
      console.log('[DL][rdr-on]', JSON.stringify(url));
      setPendingDeepLink(url);
    });
    return cleanup;
  }, []);

  // Resolve a URL do deep link via resolver puro: busca as campanhas do projeto (se aberto),
  // valida parse/projeto/campanha e navega ou exibe erro
  useEffect(() => {
    if (!pendingDeepLink) return;
    const run = async () => {
      const campaigns = activeProject
        ? await window.codeAwareness.listCampaigns(activeProject.path)
        : { success: false as const, data: null };
      const campaignList = campaigns.success && campaigns.data ? campaigns.data : [];
      console.log('[DL][rdr-resolve-in]', JSON.stringify({ url: pendingDeepLink, activeProjectPath: activeProject?.path ?? null, campaignCount: campaignList.length }));
      const decision = resolveDeepLink(pendingDeepLink, activeProject, campaignList);
      console.log('[DL][rdr-resolve-out]', JSON.stringify(decision));
      if (decision.type === "error") {
        handleStatusMessage(decision.message, true);
        setPendingDeepLink(null);
        return;
      }
      setActiveTab("campaigns");
      setResolvedCampaignId(decision.campaignId);
      setPendingDeepLink(null);
    };
    run();
  }, [pendingDeepLink, activeProject, handleStatusMessage]);

  return (
    <div
      className={`app-layout ${sidebarPreferences.sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
    >
      <GlobalSidebar
        isSidebarOpen={sidebarPreferences.sidebarOpen}
        setIsSidebarOpen={updateSidebarOpen}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeProject={activeProject}
        onSelectProject={setActiveProject}
        onOpenTags={() => {
          if (activeProject?.path) setIsTagManagerOpen(true);
        }}
        onOpenIgnored={() => {
          if (activeProject?.path) setIsIgnoreModalOpen(true);
        }}
      />

      <main className="app-main">
        {activeTab === "home" && (
          <HomeView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
        {activeTab === "campaigns" && (
          <CodeCampaignView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
            resolvedCampaignId={resolvedCampaignId}
            onResolvedCampaignConsumed={() => setResolvedCampaignId(null)}
          />
        )}
        {activeTab === "codebase" && (
          <CodeSourceView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
        {activeTab === "compression" && (
          <CodeCompressionView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
        {activeTab === "diff" && (
          <CodeDiffView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
        {activeTab === "journey" && (
          <CodeJourneyView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
        {activeTab === "code-map" && (
          <CodeMapView
            activeProject={activeProject}
            onSelectProject={setActiveProject}
            onStatusMessage={handleStatusMessage}
          />
        )}
      </main>

      {isTagManagerOpen && activeProject?.path && (
        <TagManagerModal
          repoPath={activeProject.path}
          onClose={() => setIsTagManagerOpen(false)}
        />
      )}

      {isIgnoreModalOpen && activeProject?.path && (
        <CodeAwarenessIgnoreModal
          isOpen={isIgnoreModalOpen}
          repoPath={activeProject.path}
          onClose={() => setIsIgnoreModalOpen(false)}
          onFilesRestored={() => Promise.resolve()}
        />
      )}

      {/* Toast de status */}
      {statusMessage && (
        <div
          className={`status-toast ${statusMessage.isError ? "error" : "success"}`}
        >
          {statusMessage.text}
        </div>
      )}
    </div>
  );
};