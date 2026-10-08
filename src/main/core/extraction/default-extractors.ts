import { TypeScriptStructureExtractor } from './typescript-extractor'
import { JavaScriptStructureExtractor } from './javascript-extractor'
import { CssStructureExtractor } from './css-extractor'
import { JsonStructureExtractor } from './json-extractor'
import { MarkdownStructureExtractor } from './markdown-extractor'
import type { StructureExtractionPort } from './structure-extraction-port'

export function createDefaultExtractors(): StructureExtractionPort[] {
  return [new TypeScriptStructureExtractor(), new JavaScriptStructureExtractor(), new CssStructureExtractor(), new JsonStructureExtractor(), new MarkdownStructureExtractor()]
}
