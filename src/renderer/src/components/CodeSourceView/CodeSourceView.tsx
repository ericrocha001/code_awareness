/*
-T ---
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
import { ArrowUpNarrowWide } from "lucide-react";
import { ViewToolbar } from "../shared/ViewToolbar/ViewToolbar";
import { ActionBar } from "../shared/ActionBar/ActionBar";
import { FilterPopover } from "../shared/FilterPopover/FilterPopover";
import { FileCollectionView } from "../FileCollection/FileCollectionView";
import { TagManagerModal } from "../TagManagerModal/TagManagerModal";
import { SourceOutputModal } from "./SourceOutputModal";
import type { FileCardFile } from "../FileCollection/types";
import { estimateTokensFromSize } from "../../utils/token-utils";
import { getContrastColor } from "../../utils/color-utils";
import "./CodeSourceView.css";

// Tipos para API de ignore simplificada
type IgnoredResult = { ignoredDiffFiles: Record<string, string[]> } | null;

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
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [selectedOnTop, setSelectedOnTop] = useState(false);

  // Reseta o toggle ao trocar de projeto
  useEffect(() => {
    setSelectedOnTop(false);
  }, [activeProject?.path]);

  const tokenEstimates = useMemo(() => {
    const estimates: Record<string, number> = {};
    for (const f of trackedFiles) {
      estimates[f.relativePath] = estimateTokensFromSize(f.size);
    }
    return estimates;
  }, [trackedFiles]);

  // Sistema de Ignore (apenas caminhos exatos de arquivos individuais)
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([]);
  const watcherDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const ignoredSet = useMemo(() => new Set(ignoredFiles), [ignoredFiles]);

  const visibleFiles = useMemo(() => {
    const filtered = trackedFiles.filter((f) => !ignoredSet.has(f.relativePath));
    return filtered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }, [trackedFiles, ignoredSet]);

  const hasNoiseFiles = useMemo(() => visibleFiles.some((f) => NOISE_FILES.has(f.name)), [visibleFiles]);

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
        filterTagIds.every((tagId) => {
          const fileTagIds = fileTagsMap[file.relativePath] || [];
          return fileTagIds.includes(tagId);
        });
      return matchesQuery && matchesTags;
    });
  }, [visibleFiles, searchQuery, filterTagIds, fileTagsMap]);

  const toggleTag = useCallback((tagId: string) => {
    setFilterTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    );
  }, []);

  const summaryText = useMemo(() => {
    const base = filteredFiles.length === visibleFiles.length
      ? `${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
      : `${filteredFiles.length} de ${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`;
    if (selectedFiles.size > 0) {
      return `✓ ${selectedFiles.size} selecionado${selectedFiles.size !== 1 ? 's' : ''} · ${base}`;
    }
    return base;
  }, [visibleFiles, filteredFiles, selectedFiles]);

  // Memo 1 — mapeamento (só recalcula quando arquivos ou estimativas mudam)
  const mappedFiles: FileCardFile[] = useMemo(() => {
    return filteredFiles.map((f) => ({
      ...f,
      tokenEstimate: tokenEstimates[f.relativePath] || 0,
    }));
  }, [filteredFiles, tokenEstimates]);

  // Memo 2 — reordenação por seleção (só recalcula quando seleção ou toggle muda)
  const fileCardFiles: FileCardFile[] = useMemo(() => {
    if (selectedOnTop) {
      const selected: FileCardFile[] = [];
      const notSelected: FileCardFile[] = [];
      for (const f of mappedFiles) {
        if (selectedFiles.has(f.relativePath)) {
          selected.push(f);
        } else {
          notSelected.push(f);
        }
      }
      return [...selected, ...notSelected];
    }
    return mappedFiles;
  }, [mappedFiles, selectedOnTop, selectedFiles]);

  const handleSelectionChange = useCallback((next: Set<string>) => {
    setSelectedFiles(next);
  }, []);

  const handleOpenTagManager = useCallback(() => setIsTagManagerOpen(true), []);

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
              const isActive = filterTagIds.includes(tag.id);
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
              );
            })}
          </FilterPopover>
        }
      />

      {/* Camada 2: ActionBar com botão Gerar Saída à direita */}
      <ActionBar
        right={
          <button
            className="app-pill-btn"
            onClick={() => setIsSourceModalOpen(true)}
            disabled={selectedFiles.size === 0}
          >
            Gerar Saída
          </button>
        }
      />

      <FileCollectionView
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
        onOpenTagManager={handleOpenTagManager}
        onTagsChanged={refreshTagsData}
        repoPath={activeProject?.path}
      />

      <SourceOutputModal
        isOpen={isSourceModalOpen}
        onClose={() => setIsSourceModalOpen(false)}
        repoPath={activeProject.path}
        selectedFiles={Array.from(selectedFiles)}
        onStatusMessage={onStatusMessage}
      />

      {isTagManagerOpen && activeProject && (
        <TagManagerModal
          repoPath={activeProject.path}
          onClose={() => setIsTagManagerOpen(false)}
          onTagsChanged={refreshTagsData}
        />
      )}
    </div>
  );
};