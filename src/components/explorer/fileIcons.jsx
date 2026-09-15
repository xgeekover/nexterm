import React from 'react';
import {
  File,
  FileCode2,
  FileJson,
  FileText,
  FileTerminal,
  FileImage,
  FileArchive,
  FileLock2,
  Folder,
  FolderOpen,
  Settings2,
  GitBranch,
  Database,
  Palette,
} from 'lucide-react';
import { extname } from '../../lib/paths.js';

/**
 * File icons, tinted by language the way VS Code's Seti theme is.
 *
 * The colour is what makes a file type readable at a glance in a long list —
 * a wall of identical grey glyphs is the thing that stops an explorer looking
 * like an editor's.
 */
const BY_EXTENSION = {
  js: { icon: FileCode2, color: '#cbcb41' },
  mjs: { icon: FileCode2, color: '#cbcb41' },
  cjs: { icon: FileCode2, color: '#cbcb41' },
  jsx: { icon: FileCode2, color: '#519aba' },
  ts: { icon: FileCode2, color: '#519aba' },
  tsx: { icon: FileCode2, color: '#519aba' },
  rs: { icon: FileCode2, color: '#dea584' },
  py: { icon: FileCode2, color: '#519aba' },
  go: { icon: FileCode2, color: '#519aba' },
  rb: { icon: FileCode2, color: '#cc3e44' },
  java: { icon: FileCode2, color: '#cc3e44' },
  c: { icon: FileCode2, color: '#519aba' },
  h: { icon: FileCode2, color: '#a074c4' },
  cpp: { icon: FileCode2, color: '#519aba' },
  cs: { icon: FileCode2, color: '#519aba' },
  php: { icon: FileCode2, color: '#a074c4' },
  swift: { icon: FileCode2, color: '#e37933' },
  kt: { icon: FileCode2, color: '#a074c4' },

  json: { icon: FileJson, color: '#cbcb41' },
  jsonc: { icon: FileJson, color: '#cbcb41' },
  toml: { icon: Settings2, color: '#6d8086' },
  yaml: { icon: Settings2, color: '#cc3e44' },
  yml: { icon: Settings2, color: '#cc3e44' },
  lock: { icon: FileLock2, color: '#6d8086' },
  env: { icon: Settings2, color: '#cbcb41' },
  ini: { icon: Settings2, color: '#6d8086' },
  conf: { icon: Settings2, color: '#6d8086' },

  css: { icon: Palette, color: '#519aba' },
  scss: { icon: Palette, color: '#cc6395' },
  less: { icon: Palette, color: '#519aba' },
  html: { icon: FileCode2, color: '#e37933' },
  svg: { icon: FileImage, color: '#a074c4' },

  md: { icon: FileText, color: '#519aba' },
  mdx: { icon: FileText, color: '#519aba' },
  txt: { icon: FileText, color: '#9d9d9d' },
  pdf: { icon: FileText, color: '#cc3e44' },

  sh: { icon: FileTerminal, color: '#8dc149' },
  bash: { icon: FileTerminal, color: '#8dc149' },
  zsh: { icon: FileTerminal, color: '#8dc149' },
  fish: { icon: FileTerminal, color: '#8dc149' },
  ps1: { icon: FileTerminal, color: '#519aba' },
  bat: { icon: FileTerminal, color: '#8dc149' },
  cmd: { icon: FileTerminal, color: '#8dc149' },

  png: { icon: FileImage, color: '#a074c4' },
  jpg: { icon: FileImage, color: '#a074c4' },
  jpeg: { icon: FileImage, color: '#a074c4' },
  gif: { icon: FileImage, color: '#a074c4' },
  webp: { icon: FileImage, color: '#a074c4' },
  ico: { icon: FileImage, color: '#a074c4' },

  zip: { icon: FileArchive, color: '#cbcb41' },
  gz: { icon: FileArchive, color: '#cbcb41' },
  tar: { icon: FileArchive, color: '#cbcb41' },
  db: { icon: Database, color: '#6d8086' },
  sqlite: { icon: Database, color: '#6d8086' },
};

/** Whole-filename matches win over the extension (`.gitignore`, `Cargo.toml`). */
const BY_NAME = {
  '.gitignore': { icon: GitBranch, color: '#e37933' },
  '.gitattributes': { icon: GitBranch, color: '#e37933' },
  '.gitmodules': { icon: GitBranch, color: '#e37933' },
  'package.json': { icon: FileJson, color: '#8dc149' },
  'package-lock.json': { icon: FileLock2, color: '#6d8086' },
  'cargo.toml': { icon: Settings2, color: '#dea584' },
  'cargo.lock': { icon: FileLock2, color: '#6d8086' },
  dockerfile: { icon: Settings2, color: '#519aba' },
  makefile: { icon: Settings2, color: '#6d8086' },
  'readme.md': { icon: FileText, color: '#519aba' },
  'license': { icon: FileText, color: '#cbcb41' },
};

export function fileIconFor(fileName, size = 16) {
  const lower = String(fileName || '').toLowerCase();
  const entry = BY_NAME[lower] || BY_EXTENSION[extname(lower)];
  const Icon = entry?.icon || File;
  return (
    <Icon
      size={size}
      style={entry ? { color: entry.color } : undefined}
      className={entry ? undefined : 'text-vsc-muted'}
    />
  );
}

export function folderIconFor(_folderName, isExpanded, size = 16) {
  const Icon = isExpanded ? FolderOpen : Folder;
  return <Icon size={size} style={{ color: '#90a4ae' }} />;
}
