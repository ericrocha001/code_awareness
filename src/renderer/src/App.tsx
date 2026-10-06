/*
-T ---
*/

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveProjectState } from "../../shared/types/active-project-types";
import { CodeDiffView } from "./components/CodeDiffView/CodeDiffView";
import { CodeCompressionView } from "./components/CodeCompressionView/CodeCompressionView";
import { CodeSourceView } from "./components/CodeSourceView/CodeSourceView";
import { CodeCampaignView } from "./components/CodeCampaignView/CodeCampaignView";
import { CodeJourneyView } from "./components/CodeJourneyView/CodeJourneyView";
import { CodeMapView } from "./components/CodeMapView/CodeMapView";
import { CodeDashView } from "./components/CodeDashView/CodeDashView";
import { HomeView } from "./components/HomeView/HomeView";
import { ChannelView } from "./components/ChannelView/ChannelView";
import { AcademyView } from "./components/AcademyView/AcademyView";


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
  const [{ project: activeProject }, setActiveProjectState] = useState<ActiveProjectState>({ revision: -1, project: null });
  const selectionRequest = useRef(0);
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

  useEffect(() => {
    let mounted = true;
    const receive = (state: ActiveProjectState) => {
      if (mounted) setActiveProjectState((previous) => state.revision > previous.revision ? state : previous);
    };
    const unsubscribe = window.codeAwareness.onActiveProjectChanged(receive);
    window.codeAwareness.getActiveProject().then(receive).catch(() => {
      if (mounted) handleStatusMessage('Falha ao consultar o projeto ativo', true);
    });
    return () => {
      mounted = false;
      selectionRequest.current++;
      unsubscribe();
    };
  }, [handleStatusMessage]);

  const setActiveProject = useCallback(async (project: { path: string; name: string } | null) => {
    const request = ++selectionRequest.current;
    try {
      let projectId: string | null = null;
      if (project) {
        const opened = await window.codeAwareness.openRepository(project.path);
        if (!opened.success || !opened.projectId) throw new Error(opened.error ?? 'Falha ao abrir projeto');
        projectId = opened.projectId;
      }
      if (request !== selectionRequest.current) return;
      const result = await window.codeAwareness.activateProject(projectId);
      if (!result.success) throw new Error(result.error ?? 'Falha ao ativar projeto');
    } catch (error) {
      if (request === selectionRequest.current) handleStatusMessage(error instanceof Error ? error.message : 'Falha ao ativar projeto', true);
    }
  }, [handleStatusMessage]);

  const setActiveRepository = useCallback(async (repositoryId: string) => {
    const request = ++selectionRequest.current;
    try {
      const result = await window.codeAwareness.activateRepository(repositoryId);
      if (request === selectionRequest.current && !result.success) {
        throw new Error(result.error ?? 'Falha ao ativar repositório');
      }
    } catch (error) {
      if (request === selectionRequest.current) handleStatusMessage(error instanceof Error ? error.message : 'Falha ao ativar repositório', true);
    }
  }, [handleStatusMessage]);

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
        onSelectRepository={setActiveRepository}
        onOpenTags={() => {
          if (activeProject?.path) setIsTagManagerOpen(true);
        }}
        onOpenIgnored={() => {
          if (activeProject?.path) setIsIgnoreModalOpen(true);
        }}
      />

      <main className="app-main">
        {activeTab === "channel" && <ChannelView />}
        {activeTab === "academy" && <AcademyView />}
        {activeTab === "home" && (
          <HomeView
            activeProject={activeProject}
            onSelectRepository={setActiveRepository}
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
