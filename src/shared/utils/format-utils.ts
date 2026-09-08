/*
-T ---
*/

import type { OutputFormat } from '../types'

/** Mapeia o formato de transporte para a extensão de arquivo (com ponto). */
export function outputFormatToExtension(format: OutputFormat): string {
  switch (format) {
    case 'plain':
      return '.txt'
    case 'markdown':
      return '.md'
    case 'xml':
      return '.xml'
    case 'json':
      return '.json'
  }
}