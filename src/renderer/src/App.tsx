/*
-T ---
*/

import React, { useCallback, useEffect, useState } from "react";
import { CodeDiffView } from "./components/CodeDiffView/CodeDiffView";
import { CodeCompressionView } from "./components/CodeCompressionView/CodeCompressionView";
import { CodeSourceView } from "./components/CodeSourceView/CodeSourceView";
import { CodeCampaignView } from "./components/CodeCampaignView/CodeCampaignView";
import { CodeJourneyView } from "./components/CodeJourneyView/CodeJourneyView";
import { CodeMapView } from "./components/CodeMapView/CodeMapView";
import { CodeDashView } from "./components/CodeDashView/CodeDashView";
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

  // Inicialização antecipada e desacoplada do CodeMap no ciclo de vida do projeto ativo
  useEffect(() => {
    if (!activeProject?.path) return;
    window.codeAwareness.openRepository(activeProject.path).catch((err) => {
      console.warn('[App] Falha ao inicializar CodeMap para o projeto ativo:', err);
    });
  }, [activeProject?.path]);

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
        {activeTab === "dash" && (
          <CodeDashView
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