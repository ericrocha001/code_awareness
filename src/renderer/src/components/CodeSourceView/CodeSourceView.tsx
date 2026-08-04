/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a interface da aba Code Source com ViewToolbar + ActionBar + FileGrid como visualização exclusiva.
2. Gerenciar a seleção reativa de arquivos com sistema de Ignore.
3. Monitorar alterações de arquivos em tempo real via WatcherService com debounce de 300ms.
4. Fornecer ações contextuais (Copiar, Exportar Normal, Exportar para NotebookLM, Exportar com nome personalizado).
5. Manter sincronizados os estados de tags (allTags e fileTagsMap) após alterações no TagManagerModal.
6. Exibir contador de selecionados no resumo do topo e toggle "Selecionados no topo" na ViewToolbar.

Mapa de Relacionamentos do Script

1. useProjectPreferences.ts
   - Tipo: Dependência Direta
   - Relação: Fornece preferências de UI do projeto (ex: sidebarOpen).
   - Criticidade: Alta

2. CodeSourceView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

3. ViewToolbar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 1 com SearchBox, contagem, controlsSlot e FilterPopover de tags.
   - Criticidade: Alta

4. ActionBar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 2 com botões de ação à direita.
   - Criticidade: Alta

5. FilterPopover.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o dropdown de filtro de tags coloridas.
   - Criticidade: Média

6. FileGrid.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza grade de FileCards.
   - Criticidade: Alta

7. ExportDropdown.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o menu de exportação compartilhado.
   - Criticidade: Alta

8. ExportNameModal.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o modal de nome personalizado para exportação.
   - Criticidade: Alta

9. ignore-patterns.ts
   - Tipo: Dependência Direta
   - Relação: Fornece padrões de ruído.
   - Criticidade: Média

10. window.codeAwareness.exportToNotebookLM
    - Tipo: Dependência Inversa
    - Relação: Consome API IPC para exportação no formato NotebookLM.
    - Criticidade: Alta

Invariantes do Script

1. O FileGrid deve ocupar 100% do espaço disponível no painel principal.
2. O total de tokens selecionados deve ser calculado apenas com base nos arquivos checkados.
3. O listener deve ser removido quando o componente desmonta para evitar memory leaks.
4. O dropdown de exportação e o modal de nome são gerenciados pelos componentes compartilhados.
5. O sistema de ignore opera exclusivamente com caminhos exatos de arquivos.
6. A ViewToolbar substitui a CommandBar — nenhuma referência a command-bar no JSX.
7. O toggle "Selecionados no topo" é estado local (não persiste ao trocar de projeto).
8. A reordenação por seleção é puramente visual e não afeta a geração de markdown.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  DiffFileStatus,
  Tag,
} from "../../../../shared/types";
import {
  NOISE_FILES,
} from "../../constants/ignore-patterns";
import { FileText, BookOpen, PenLine, ArrowUpNarrowWide } from "lucide-react";
import { ViewToolbar } from "../shared/ViewToolbar/ViewToolbar";
import { ActionBar } from "../shared/ActionBar/ActionBar";
import { FilterPopover } from "../shared/FilterPopover/FilterPopover";
import { FileGrid } from "../FileGrid/FileGrid";
import { PreviewModal } from "../PreviewModal/PreviewModal";
import { TagManagerModal } from "../TagManagerModal/TagManagerModal";
import { ProcessingStatusBar } from "../ProcessingStatusBar/ProcessingStatusBar";
import { ExportDropdown } from "../shared/ExportDropdown/ExportDropdown";
import { ExportNameModal, type FormatOption } from "../shared/ExportNameModal/ExportNameModal";
import { useProjectPreferences } from "../../hooks/useProjectPreferences";
import type { FileCardFile } from "../FileCard/FileCard";
import { estimateTokensFromSize } from "../../utils/token-utils";
import { getContrastColor } from "../../utils/color-utils";
import "./CodeSourceView.css";

// Tipos para API de ignore simplificada
type IgnoredResult = { ignoredDiffFiles: Record<string, string[]> } | null;

const EXPORT_FORMATS: FormatOption[] = [
  { id: 'markdown', label: 'Markdown (.md)' },
  { id: 'notebooklm', label: 'NotebookLM (.docx)' },
]

interface CodeSourceViewProps {
  activeProject: { path: string; name: string } | null;
  onSelectProject: (project: { path: string; name: string } | null) => void;
  onStatusMessage: (message: string, isError?: boolean) => void;
}

export const CodeSourceView: React.FC<CodeSourceViewProps> = ({
  activeProject,
  onSelectProject,
  onStatusMessage,
}) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [markdown, setMarkdown] = useState<string>("");
  const [tokenCount, setTokenCount] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportNameModalOpen, setIsExportNameModalOpen] = useState(false);
  const [selectedOnTop, setSelectedOnTop] = useState(false);

  // Reseta o toggle ao trocar de projeto
  useEffect(() => {
    setSelectedOnTop(false)
  }, [activeProject?.path])

  const tokenEstimates = useMemo(() => {
    const estimates: Record<string, number> = {};
    for (const f of trackedFiles) {
      estimates[f.relativePath] = estimateTokensFromSize(f.size);
    }
    return estimates;
  }, [trackedFiles]);

  // Sistema de Ignore (apenas caminhos exatos de arquivos individuais)
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const watcherDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { preferences: viewPrefs } = useProjectPreferences(activeProject?.path ?? null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [fileTagsMap, setFileTagsMap] = useState<Record<string, string[]>>({});

  // Formata contagem de tokens para exibição amigável (ex: 1234 → "1.2k")
  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return count.toString();
  }, []);

  // Carrega os arquivos ignorados das settings para o repositório atual
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return;
    const settings = await window.codeAwareness.loadSettings();
    setIgnoredFiles(settings.ignoredDiffFiles[activeProject.path] || []);
  }, [activeProject]);

  const loadFileTagsMap = useCallback(async () => {
    if (!activeProject?.path) {
      setFileTagsMap({});
      return;
    }
    try {
      const result = await window.codeAwareness.getFileTags(activeProject.path);
      if (result.success && result.data) {
        setFileTagsMap(result.data);
      } else {
        setFileTagsMap({});
      }
    } catch (err) {
      console.error("Erro ao carregar fileTagsMap:", err);
      setFileTagsMap({});
    }
  }, [activeProject?.path]);

  useEffect(() => {
    loadFileTagsMap();
  }, [loadFileTagsMap]);

  useEffect(() => {
    if (!activeProject) return;
    const handleUpdate = async () => {
      await Promise.all([
        window.codeAwareness.reconcileIgnoredFiles(
          activeProject.path,
          (await window.codeAwareness.getAllFiles(activeProject.path)).map((f) => f.relativePath)
        ),
        loadIgnoredFiles(),
      ]);
      const files = await window.codeAwareness.getAllFiles(activeProject.path);
      setTrackedFiles(files);
    };
    window.addEventListener("ignored-files-updated", handleUpdate);
    return () => window.removeEventListener("ignored-files-updated", handleUpdate);
  }, [activeProject, loadIgnoredFiles]);

  useEffect(() => {
    let isMounted = true;
    const bootstrapProject = async () => {
      if (!activeProject) {
        if (isMounted) {
          setTrackedFiles([]);
          setSelectedFiles(new Set());
          setMarkdown("");
          setTokenCount(0);
        }
        await window.codeAwareness.stopWatcher();
        return;
      }
      try {
        const [, files] = await Promise.all([
          window.codeAwareness.startWatcher(activeProject.path),
          window.codeAwareness.getAllFiles(activeProject.path),
        ]);
        if (!isMounted) return;
        const currentPaths = files.map((f) => f.relativePath);
        await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths);
        if (!isMounted) return;
        await loadIgnoredFiles();
        if (!isMounted) return;
        setTrackedFiles(files);
        setSelectedFiles(new Set());
      } catch (err) {
        console.error("Falha ao inicializar projeto no Code Source:", err);
      }
    };
    bootstrapProject();
    const unsubscribe = window.codeAwareness.onFileChanged(() => {
      if (!activeProject || !isMounted) return;

      // Debounce: aguarda 300ms após o último evento do watcher para fazer uma única varredura
      if (watcherDebounceRef.current) clearTimeout(watcherDebounceRef.current);
      watcherDebounceRef.current = setTimeout(async () => {
        try {
          const files = await window.codeAwareness.getAllFiles(activeProject.path);
          if (!isMounted) return;
          const currentPaths = files.map((f) => f.relativePath);
          await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths);
          if (!isMounted) return;
          await loadIgnoredFiles();
          if (!isMounted) return;
          setTrackedFiles(files);
        } catch (err) {
          console.error("Falha ao atualizar lista de arquivos:", err);
        }
      }, 300);
    });
    return () => {
      isMounted = false;
      if (watcherDebounceRef.current) clearTimeout(watcherDebounceRef.current);
      unsubscribe();
      window.codeAwareness.stopWatcher();
    };
  }, [activeProject, loadIgnoredFiles]);



  // Lista visível: filtra apenas arquivos ignorados por caminho exato, ordenada alfabeticamente
  const visibleFiles = useMemo(() => {
    const filtered = trackedFiles.filter((f) => !ignoredFiles.includes(f.relativePath));
    return filtered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }, [trackedFiles, ignoredFiles]);

  const totalSelectedTokens = useMemo(() => {
    let total = 0;
    for (const path of selectedFiles) total += tokenEstimates[path] || 0;
    return total;
  }, [selectedFiles, tokenEstimates]);

  const hasNoiseFiles = useMemo(() => visibleFiles.some((f) => NOISE_FILES.has(f.name)), [visibleFiles]);

  // Geração reativa do markdown
  useEffect(() => {
    if (!activeProject) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (selectedFiles.size === 0) {
      setMarkdown("");
      setTokenCount(0);
      setError("");
      setIsGenerating(false);
      return;
    }
    const thisRequestId = ++requestIdRef.current;
    setIsGenerating(true);
    setError("");
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const selectedArray = Array.from(selectedFiles);
        const result = await window.codeAwareness.generateCodeSource(activeProject.path, {
          selectedFiles: selectedArray,
          format: "markdown",
        });
        if (thisRequestId === requestIdRef.current) {
          if (result.success && result.markdown) {
            setMarkdown(result.markdown);
            setTokenCount(result.tokenCount || 0);
          } else {
            setError(result.error || "Falha ao gerar Code Source.");
            setMarkdown("");
            setTokenCount(0);
          }
          setIsGenerating(false);
        }
      } catch (err: any) {
        if (thisRequestId === requestIdRef.current) {
          setError(err?.message || "Falha ao gerar Code Source.");
          setIsGenerating(false);
        }
      }
    }, 300);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [activeProject, selectedFiles]);

  const ignoreFileTemporary = useCallback(async (relativePath: string) => {
    if (!activeProject) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      next.delete(relativePath);
      return next;
    });
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath) as IgnoredResult;
    if (result) {
      loadIgnoredFiles();
      onStatusMessage("Arquivo ocultado!");
    }
  }, [activeProject, onStatusMessage, loadIgnoredFiles]);

  const handleCopyPath = useCallback((relativePath: string) => {
    navigator.clipboard.writeText(relativePath);
    onStatusMessage("Caminho copiado!");
  }, [onStatusMessage]);

  const handleCopyName = useCallback((name: string) => {
    navigator.clipboard.writeText(name);
    onStatusMessage("Nome copiado!");
  }, [onStatusMessage]);

  const handleRevealInExplorer = useCallback(async (relativePath: string) => {
    if (!activeProject) return;
    await window.codeAwareness.revealInExplorer(activeProject.path, relativePath);
    onStatusMessage("Arquivo revelado no sistema!");
  }, [activeProject, onStatusMessage]);



  const handleCopy = () => {
    navigator.clipboard.writeText(markdown);
    setIsCopied(true);
    onStatusMessage("Markdown copiado!");
    setTimeout(() => setIsCopied(false), 2000);
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  const loadTags = useCallback(async () => {
    if (!activeProject?.path) {
      setAllTags([]);
      return;
    }
    try {
      const response = await window.codeAwareness.getTags(activeProject.path);
      if (response.success && response.data) {
        setAllTags(response.data);
      } else {
        setAllTags([]);
      }
    } catch (err) {
      console.error("Erro ao carregar tags:", err);
      setAllTags([]);
    }
  }, [activeProject?.path]);

  const refreshTagsData = useCallback(async () => {
    await loadTags();
    await loadFileTagsMap();
  }, [loadTags, loadFileTagsMap]);

  useEffect(() => {
    const handleTagsChanged = async () => {
      await refreshTagsData();
    };
    window.addEventListener("tags-changed", handleTagsChanged);
    return () => window.removeEventListener("tags-changed", handleTagsChanged);
  }, [refreshTagsData]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return visibleFiles.filter((file) => {
      const matchesQuery =
        !q ||
        file.name.toLowerCase().includes(q) ||
        file.relativePath.toLowerCase().includes(q);
      const matchesTags =
        filterTagIds.length === 0 ||
        filterTagIds.some((tagId) => {
          const fileTagIds = fileTagsMap[file.relativePath] || [];
          return fileTagIds.includes(tagId);
        });
      return matchesQuery && matchesTags;
    });
  }, [visibleFiles, searchQuery, filterTagIds, fileTagsMap]);

  const toggleTag = useCallback((tagId: string) => {
    setFilterTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    )
  }, [])

  const summaryText = useMemo(() => {
    const base = filteredFiles.length === visibleFiles.length
      ? `${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
      : `${filteredFiles.length} de ${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
    if (selectedFiles.size > 0) {
      return `✓ ${selectedFiles.size} selecionado${selectedFiles.size !== 1 ? 's' : ''} · ${base}`
    }
    return base
  }, [visibleFiles, filteredFiles, selectedFiles])

  // Memo 1 — mapeamento (só recalcula quando arquivos ou estimativas mudam)
  const mappedFiles: FileCardFile[] = useMemo(() => {
    return filteredFiles.map((f) => ({
      ...f,
      tokenEstimate: tokenEstimates[f.relativePath] || 0,
    }))
  }, [filteredFiles, tokenEstimates])

  // Memo 2 — reordenação por seleção (só recalcula quando seleção ou toggle muda)
  const fileCardFiles: FileCardFile[] = useMemo(() => {
    if (selectedOnTop) {
      const selected: FileCardFile[] = []
      const notSelected: FileCardFile[] = []
      for (const f of mappedFiles) {
        if (selectedFiles.has(f.relativePath)) {
          selected.push(f)
        } else {
          notSelected.push(f)
        }
      }
      return [...selected, ...notSelected]
    }
    return mappedFiles
  }, [mappedFiles, selectedOnTop, selectedFiles]);

  const handleSelectionChange = useCallback((next: Set<string>) => {
    setSelectedFiles(next);
  }, []);

  const handleExportNormal = async () => {
    if (!activeProject || !markdown) return;
    setIsExporting(true);
    try {
      const fileName = `${activeProject.name}-source`;
      const result = await window.codeAwareness.saveToDownloads(markdown, fileName);
      if (result.success) onStatusMessage("Exportado para Downloads!");
      else onStatusMessage("Erro ao exportar", true);
    } catch (err) {
      console.error("Falha ao exportar:", err);
      onStatusMessage("Erro ao exportar", true);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportNotebookLM = async () => {
    if (!activeProject || !markdown) return;
    setIsExporting(true);
    try {
      const fileName = `${activeProject.name}-notebooklm`;
      const result = await window.codeAwareness.exportToNotebookLM(markdown, fileName);
      if (result.success) {
        const message = result.fileCount === 1 ? "Exportado para Downloads (.docx)!" : `Exportado ${result.fileCount} arquivo(s) .docx para Downloads!`;
        onStatusMessage(message);
      } else {
        onStatusMessage(result.error || "Erro ao exportar para NotebookLM", true);
      }
    } catch (err) {
      console.error("Falha ao exportar para NotebookLM:", err);
      onStatusMessage("Erro ao exportar para NotebookLM", true);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportWithName = async (name: string, formatId: string) => {
    if (!activeProject || !markdown) return
    setIsExporting(true)
    try {
      if (formatId === 'markdown') {
        const result = await window.codeAwareness.saveToDownloads(markdown, name)
        if (result.success) onStatusMessage("Exportado para Downloads!")
        else onStatusMessage("Erro ao exportar", true)
      } else if (formatId === 'notebooklm') {
        const result = await window.codeAwareness.exportToNotebookLM(markdown, name)
        if (result.success) {
          const message = result.fileCount === 1 ? "Exportado para Downloads (.docx)!" : `Exportado ${result.fileCount} arquivo(s) .docx para Downloads!`
          onStatusMessage(message)
        } else {
          onStatusMessage(result.error || "Erro ao exportar para NotebookLM", true)
        }
      }
    } catch (err) {
      console.error("Falha ao exportar com nome personalizado:", err)
      onStatusMessage("Erro ao exportar", true)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cs-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: "none", background: "transparent" }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerar o código fonte.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cs-container">
      {/* Camada 1: ViewToolbar com busca + contagem + toggle + funil de tags */}
      <ViewToolbar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Buscar por nome ou caminho..."
        summary={<span>{summaryText}</span>}
        controlsSlot={
          <button
            className={`app-pill-btn cs-sort-toggle${selectedOnTop ? ' active' : ''}`}
            onClick={() => setSelectedOnTop(prev => !prev)}
            title="Selecionados no topo"
            aria-pressed={selectedOnTop}
          >
            <ArrowUpNarrowWide size={14} strokeWidth={2} />
            Selecionados no topo
          </button>
        }
        filterSlot={
          <FilterPopover activeCount={filterTagIds.length}>
            {allTags.map(tag => {
              const isActive = filterTagIds.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  className={`am-item fp-item${isActive ? ' active' : ''}`}
                  onClick={() => toggleTag(tag.id)}
                  role="menuitemcheckbox"
                  aria-checked={isActive}
                  style={isActive ? {
                    backgroundColor: tag.color,
                    borderColor: tag.color,
                    color: getContrastColor(tag.color)
                  } : undefined}
                >
                  {tag.name}
                </button>
              )
            })}
          </FilterPopover>
        }
      />

      {/* Camada 2: ActionBar com botões à direita */}
      <ActionBar
        right={
          <>
            <button className="app-pill-btn" onClick={() => setIsPreviewOpen(true)} disabled={!markdown || isGenerating}>Visualizar Preview</button>
            <button className="app-pill-btn" onClick={handleCopy} disabled={!markdown || isGenerating}>{isCopied ? "Copiado!" : "Copiar"}</button>
            <ExportDropdown label={isExporting ? 'Exportando...' : 'Exportar'} disabled={!markdown || isGenerating || isExporting}>
              <button onClick={handleExportNormal}><FileText size={14} strokeWidth={2} /> Exportar Normal</button>
              <button onClick={handleExportNotebookLM}><BookOpen size={14} strokeWidth={2} /> Exportar para NotebookLM (.docx)</button>
              <button onClick={() => setIsExportNameModalOpen(true)}><PenLine size={14} strokeWidth={2} /> Exportar com nome personalizado…</button>
            </ExportDropdown>
          </>
        }
      />

      <ProcessingStatusBar isVisible={isGenerating} />

      <FileGrid
        files={fileCardFiles}
        allTags={allTags}
        fileTagsMap={fileTagsMap}
        selectedFiles={selectedFiles}
        onSelectionChange={handleSelectionChange}
        tokenEstimates={tokenEstimates}
        formatTokenCount={formatTokenCount}
        onHideFile={ignoreFileTemporary}
        onRevealInExplorer={handleRevealInExplorer}
        onCopyPath={handleCopyPath}
        onCopyName={handleCopyName}
        onOpenTagManager={() => setIsTagManagerOpen(true)}
        onTagsChanged={refreshTagsData}
        repoPath={activeProject?.path}
      />
      <PreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} markdown={markdown} title="Code Source Preview" onExportDownloads={handleExportNormal} onStatusMessage={onStatusMessage} />
      {isTagManagerOpen && activeProject && (
        <TagManagerModal repoPath={activeProject.path} onClose={() => setIsTagManagerOpen(false)} onTagsChanged={refreshTagsData} />
      )}
      <ExportNameModal
        isOpen={isExportNameModalOpen}
        onClose={() => setIsExportNameModalOpen(false)}
        onConfirm={handleExportWithName}
        defaultName={`${activeProject.name}-source`}
        formats={EXPORT_FORMATS}
        defaultFormat="markdown"
      />
    </div>
  );
};