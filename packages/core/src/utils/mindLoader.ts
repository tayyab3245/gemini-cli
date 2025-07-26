/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic loader for mind prompts to decouple public code from private assets
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Dynamically loads a prompt file from the mind directory
 * @param promptBaseName Base file name without extension - e.g., 'synth.prompt'
 * @returns The prompt content as string, or null if file not found
 * @throws Error if the loaded content is not a valid string
 */
export async function loadPrompt(promptBaseName: string): Promise<string | null> {
  try {
    // Construct path to mind directory relative to project root
    const mindDir = path.resolve(process.cwd(), 'packages', 'core', 'src', 'mind');
    
    // Try both .ts and .js extensions (dev vs build)
    const extensions = ['.ts', '.js'];
    let fileContent: string | null = null;
    let foundPath: string | null = null;
    
    for (const ext of extensions) {
      const fullPath = path.join(mindDir, promptBaseName + ext);
      try {
        await fs.access(fullPath);
        fileContent = await fs.readFile(fullPath, 'utf-8');
        foundPath = fullPath;
        break;
      } catch {
        // Try next extension
        continue;
      }
    }
    
    if (!fileContent || !foundPath) {
      // File not found with any extension - return null for graceful fallback
      return null;
    }
    
    // Parse the TypeScript/JavaScript file content to extract prompt
    let promptContent: string | null = null;
    
    // First, look for direct literal export patterns
    const literalExportPatterns = [
      /export\s+default\s+`([^`]*(?:`[^`]*)*)`/s,        // export default `content` (with nested backticks)
      /export\s+default\s+"([^"\\]*(?:\\.[^"\\]*)*)"/s,  // export default "content" (with escapes)
      /export\s+default\s+'([^'\\]*(?:\\.[^'\\]*)*)'/s,  // export default 'content' (with escapes)
      /export\s+default\s*=\s*`([^`]*(?:`[^`]*)*)`/s,    // export default = `content`
      /export\s+default\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s,  // export default = "content"
      /export\s+default\s*=\s*'([^'\\]*(?:\\.[^'\\]*)*)'/s,  // export default = 'content'
    ];
    
    for (const pattern of literalExportPatterns) {
      const match = fileContent.match(pattern);
      if (match && match[1] !== undefined) {
        promptContent = match[1];
        break;
      }
    }
    
    // If no literal export found, look for variable-exported patterns
    if (promptContent === null) {
      // Look for: export default <identifier>; (with flexible whitespace)
      const variableExportMatch = fileContent.match(/export\s+default\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/);
      
      if (variableExportMatch && variableExportMatch[1]) {
        const variableName = variableExportMatch[1];
        
        // Look for the variable declaration: const|let|var <variableName> = <string> (with flexible whitespace)
        const variableDeclarationPatterns = [
          // Template literal (multi-line with potential nested backticks)
          new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*\`([^]*?)\`\\s*;`, 's'),
          // Double quoted string (with escapes)
          new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*;`, 's'),
          // Single quoted string (with escapes)
          new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'\\s*;`, 's'),
        ];
        
        for (const pattern of variableDeclarationPatterns) {
          const match = fileContent.match(pattern);
          if (match && match[1] !== undefined) {
            promptContent = match[1];
            break;
          }
        }
      }
    }
    
    if (promptContent === null) {
      throw new Error(`loadPrompt() could not parse prompt file ${foundPath}. Ensure your prompt file exports a string as the default export using either: export default \`your-prompt-here\` or const prompt = \`your-prompt-here\`; export default prompt;`);
    }

    // Process escaped characters if we found content from quoted strings
    if (promptContent.includes('\\')) {
      // Simple unescape for common cases: \" \' \\
      promptContent = promptContent
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }

    if (promptContent.length === 0) {
      throw new Error(`loadPrompt() found empty prompt content in ${foundPath}`);
    }

    return promptContent;
  } catch (error) {
    if (error instanceof Error && error.message.includes('loadPrompt()')) {
      // Re-throw contract violation errors - these should bubble up
      throw error;
    }
    // File not found or other filesystem error - return null for graceful fallback
    return null;
  }
}
