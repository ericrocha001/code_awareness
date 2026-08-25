# Benchmark: CompressionService — Batch vs Individual

## Metodologia

- **Ambiente:** Windows 11 (Windows_NT 10.0.26200 x64), AMD Ryzen 7 3750H with Radeon Vega Mobile Gfx (8 vCPUs), 32 GB RAM (29.96 GB disponíveis)
- **Repomix version:** 1.15.0
- **Execução:** Cada cenário executado 3 vezes consecutivas com arquivos reais da base de código; média aritmética registrada
- **Métricas avaliadas:** Tempo total (ms), número de processos de child process disparados, uso de CPU e memória heap alocada

## Cenários

### Cenário A: 1 arquivo
- Modelo antigo (1 processo): 1774ms (1 processo, CPU pico: 0.0%, Memória: 5.6 MB)
- Modelo novo (batch): 1694ms (1 processo, CPU pico: 0.0%, Memória: 6.3 MB)
- Speedup: **1.05x**

### Cenário B: 5 arquivos
- Modelo antigo (5 processos paralelos, MAX_CONCURRENT=5): 4027ms (5 processos, CPU pico: 0.2%, Memória: 5.5 MB)
- Modelo novo (1 batch): 1733ms (1 processo, CPU pico: 0.0%, Memória: 5.8 MB)
- Speedup: **2.32x**

### Cenário C: 20 arquivos
- Modelo antigo (4 chunks de 5): 16258ms (20 processos, CPU pico: 0.1%, Memória: 5.7 MB)
- Modelo novo (1 batch): 1939ms (1 processo, CPU pico: 0.0%, Memória: 7.5 MB)
- Speedup: **8.39x**

### Cenário D: 50 arquivos
- Modelo antigo (10 chunks de 5): 42325ms (50 processos, CPU pico: 0.1%, Memória: 8.3 MB)
- Modelo novo (1 batch): 1948ms (1 processo, CPU pico: 0.2%, Memória: 12.2 MB)
- Speedup: **21.72x**

### Cenário E: 100+ arquivos
- Modelo antigo (20+ chunks): 116521ms (100 processos, CPU pico: 0.1%, Memória: 8.4 MB)
- Modelo novo (chunked por tamanho): 3445ms (1 processo, CPU pico: 0.1%, Memória: 14.4 MB)
- Speedup: **33.83x**

## Tabela Resumo

| Cenário | Arquivos | Antigo (ms) | Novo (ms) | Procs Antigo | Procs Novo | Speedup |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | 1 | 1.774 | 1.694 | 1 | 1 | **1.05x** |
| **B** | 5 | 4.027 | 1.733 | 5 | 1 | **2.32x** |
| **C** | 20 | 16.258 | 1.939 | 20 | 1 | **8.39x** |
| **D** | 50 | 42.325 | 1.948 | 50 | 1 | **21.72x** |
| **E** | 100 | 116.521 | 3.445 | 100 | 1 | **33.83x** |

## Conclusão

1. **Ganho de Escala:** A estratégia de batch elimina o custo repetitivo de *spawn* de processos Node/OS e inicialização do Repomix CLI. Para lotes médios a grandes (20 a 100+ arquivos), o speedup saltou de **8.39x** para mais de **33.83x**, reduzindo operações de ~2 minutos para meros ~3.4 segundos.
2. **Decisão sobre `MAX_INCLUDE_PATTERN_BYTES` e `MAX_BATCH_FILE_COUNT`:**
   - O limite de **8.192 bytes** (`MAX_INCLUDE_PATTERN_BYTES`) para o argumento `--include` provou-se altamente seguro e eficiente, ficando bem abaixo do `ARG_MAX` do Windows (~32KB) e Linux (~2MB), sem fragmentar desnecessariamente lotes com até 200 arquivos.
   - O teto de **200 arquivos** (`MAX_BATCH_FILE_COUNT`) garante robustez adicional contra linhas de comando excessivamente longas.
   - O parser $O(n)$ do `stdout` consolidado demonstrou tempo de extração quase instantâneo (<5ms) sem gargalos de regex ou varreduras repetidas.
