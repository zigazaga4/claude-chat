/**
 * File-extension → real icon component + brand color + Prism language id.
 *
 * Single source of truth for the IDE view. Language brands come from Simple
 * Icons (`react-icons/si`), tinted with the official brand colour. Generic
 * file kinds fall back to lucide-react glyphs.
 *
 * No emojis. These are real SVG icons, the way a code editor draws them.
 */

import type { ComponentType, SVGProps } from 'react';
import {
  Archive,
  Binary,
  BookOpen,
  Calendar,
  Code2,
  Database,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Hammer,
  Hash,
  KeyRound,
  Lock,
  Music,
  Scale,
  ScrollText,
  Settings,
  Sigma,
  Slash,
  Sparkles,
  TerminalSquare,
  Triangle,
  Zap,
} from 'lucide-react';
import {
  SiAstro,
  SiClojure,
  SiCplusplus,
  SiCrystal,
  SiDart,
  SiDocker,
  SiDotenv,
  SiElixir,
  SiErlang,
  SiFishshell,
  SiFsharp,
  SiGit,
  SiGnubash,
  SiGo,
  SiGradle,
  SiGraphql,
  SiHaskell,
  SiHtml5,
  SiJavascript,
  SiJulia,
  SiJupyter,
  SiKotlin,
  SiLess,
  SiLua,
  SiMarkdown,
  SiMdx,
  SiNextdotjs,
  SiNginx,
  SiNpm,
  SiOcaml,
  SiOpenjdk,
  SiPhp,
  SiPrisma,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiScala,
  SiSharp,
  SiSqlite,
  SiSvelte,
  SiSvg,
  SiSwift,
  SiTailwindcss,
  SiTerraform,
  SiToml,
  SiTypescript,
  SiVite,
  SiVuedotjs,
  SiYaml,
  SiZig,
  SiZsh,
} from 'react-icons/si';

/**
 * Anything renderable as an icon. lucide-react and react-icons both produce
 * components that accept the SVG prop set plus an optional numeric `size` —
 * so we describe the union here and let the call site forward whatever the
 * underlying library understands.
 */
export type FileIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; title?: string }
>;

export type FileMeta = {
  Icon: FileIcon;
  /** CSS colour for the icon glyph. Brand colour where one exists. */
  color: string;
  label: string;
  /** Prism language id, or `null` for plain text / binary. */
  lang: string | null;
};

/** Default folder icon — same family as the file icons for visual cohesion. */
export const FolderIcon: FileIcon = Folder;
export const FolderOpenIcon: FileIcon = FolderOpen;
export const FOLDER_COLOR = '#60a5fa'; // lucide blue-400

// Brand colours. Where a brand has a "light on dark" variant, we lean toward
// the dark-background reading because the app's theme is dark.
const C = {
  ts: '#3178c6',
  js: '#f7df1e',
  react: '#61dafb',
  python: '#3776ab',
  jupyter: '#f37626',
  rust: '#dea584',
  go: '#00add8',
  c: '#a8b9cc',
  cpp: '#00599c',
  java: '#f89820',
  kotlin: '#7f52ff',
  scala: '#dc322f',
  swift: '#fa7343',
  ruby: '#cc342d',
  php: '#777bb4',
  csharp: '#9b4f96',
  lua: '#2c2d72',
  dart: '#0175c2',
  elixir: '#4b275f',
  erlang: '#a90533',
  haskell: '#5e5086',
  ocaml: '#ee6a1a',
  clojure: '#5881d8',
  julia: '#9558b2',
  zig: '#f7a41d',
  crystal: '#cccccc',
  fsharp: '#378bba',
  bash: '#4eaa25',
  zsh: '#f15a24',
  fish: '#4ba3e3',
  powershell: '#5391fe',
  windows: '#0078d6',
  html: '#e34f26',
  css: '#1572b6',
  sass: '#cc6699',
  less: '#1d365d',
  vue: '#4fc08d',
  svelte: '#ff3e00',
  astro: '#ff5d01',
  json: '#f5b933',
  yaml: '#cb171e',
  toml: '#9c4221',
  ini: '#9ca3af',
  env: '#ecd53f',
  prisma: '#5a67d8',
  graphql: '#e10098',
  md: '#e5e7eb',
  svg: '#ffb13b',
  pdf: '#ec1c24',
  docker: '#2496ed',
  make: '#a8a29e',
  gradle: '#02303a',
  terraform: '#7b42bc',
  nginx: '#009639',
  npm: '#cb3837',
  next: '#e5e7eb',
  tailwind: '#06b6d4',
  vite: '#646cff',
  git: '#f05032',
  sqlite: '#003b57',
  image: '#a78bfa',
  audio: '#22d3ee',
  video: '#f472b6',
  archive: '#fbbf24',
  lock: '#9ca3af',
  text: '#cbd5e1',
  log: '#94a3b8',
  fallback: '#94a3b8',
};

const EXT: Record<string, FileMeta> = {
  // ── JS / TS ────────────────────────────────────────────────────────────
  ts: { Icon: SiTypescript, color: C.ts, label: 'TypeScript', lang: 'typescript' },
  tsx: { Icon: SiReact, color: C.react, label: 'TS React', lang: 'tsx' },
  js: { Icon: SiJavascript, color: C.js, label: 'JavaScript', lang: 'javascript' },
  jsx: { Icon: SiReact, color: C.react, label: 'JS React', lang: 'jsx' },
  mjs: { Icon: SiJavascript, color: C.js, label: 'JS Module', lang: 'javascript' },
  cjs: { Icon: SiJavascript, color: C.js, label: 'CommonJS', lang: 'javascript' },

  // ── Python / data ──────────────────────────────────────────────────────
  py: { Icon: SiPython, color: C.python, label: 'Python', lang: 'python' },
  ipynb: { Icon: SiJupyter, color: C.jupyter, label: 'Jupyter', lang: 'json' },

  // ── Systems ────────────────────────────────────────────────────────────
  rs: { Icon: SiRust, color: C.rust, label: 'Rust', lang: 'rust' },
  go: { Icon: SiGo, color: C.go, label: 'Go', lang: 'go' },
  c: { Icon: SiCplusplus, color: C.c, label: 'C', lang: 'c' },
  h: { Icon: SiCplusplus, color: C.c, label: 'C Header', lang: 'c' },
  cpp: { Icon: SiCplusplus, color: C.cpp, label: 'C++', lang: 'cpp' },
  cc: { Icon: SiCplusplus, color: C.cpp, label: 'C++', lang: 'cpp' },
  hpp: { Icon: SiCplusplus, color: C.cpp, label: 'C++ Header', lang: 'cpp' },
  java: { Icon: SiOpenjdk, color: C.java, label: 'Java', lang: 'java' },
  kt: { Icon: SiKotlin, color: C.kotlin, label: 'Kotlin', lang: 'kotlin' },
  scala: { Icon: SiScala, color: C.scala, label: 'Scala', lang: 'scala' },
  swift: { Icon: SiSwift, color: C.swift, label: 'Swift', lang: 'swift' },
  rb: { Icon: SiRuby, color: C.ruby, label: 'Ruby', lang: 'ruby' },
  php: { Icon: SiPhp, color: C.php, label: 'PHP', lang: 'php' },
  cs: { Icon: SiSharp, color: C.csharp, label: 'C#', lang: 'csharp' },
  fs: { Icon: SiFsharp, color: C.fsharp, label: 'F#', lang: null },
  zig: { Icon: SiZig, color: C.zig, label: 'Zig', lang: null },
  lua: { Icon: SiLua, color: C.lua, label: 'Lua', lang: 'lua' },
  dart: { Icon: SiDart, color: C.dart, label: 'Dart', lang: 'dart' },
  ex: { Icon: SiElixir, color: C.elixir, label: 'Elixir', lang: 'elixir' },
  exs: { Icon: SiElixir, color: C.elixir, label: 'Elixir', lang: 'elixir' },
  erl: { Icon: SiErlang, color: C.erlang, label: 'Erlang', lang: 'erlang' },
  hs: { Icon: SiHaskell, color: C.haskell, label: 'Haskell', lang: 'haskell' },
  ml: { Icon: SiOcaml, color: C.ocaml, label: 'OCaml', lang: 'ocaml' },
  mli: { Icon: SiOcaml, color: C.ocaml, label: 'OCaml Iface', lang: 'ocaml' },
  clj: { Icon: SiClojure, color: C.clojure, label: 'Clojure', lang: 'clojure' },
  cljs: { Icon: SiClojure, color: C.clojure, label: 'ClojureScript', lang: 'clojure' },
  lisp: { Icon: Sigma, color: C.fallback, label: 'Lisp', lang: 'lisp' },
  jl: { Icon: SiJulia, color: C.julia, label: 'Julia', lang: null },
  cr: { Icon: SiCrystal, color: C.crystal, label: 'Crystal', lang: null },

  // ── Shell ──────────────────────────────────────────────────────────────
  sh: { Icon: SiGnubash, color: C.bash, label: 'Shell', lang: 'bash' },
  bash: { Icon: SiGnubash, color: C.bash, label: 'Bash', lang: 'bash' },
  zsh: { Icon: SiZsh, color: C.zsh, label: 'Zsh', lang: 'bash' },
  fish: { Icon: SiFishshell, color: C.fish, label: 'Fish', lang: 'bash' },
  ps1: { Icon: TerminalSquare, color: C.powershell, label: 'PowerShell', lang: 'powershell' },
  bat: { Icon: TerminalSquare, color: C.windows, label: 'Batch', lang: 'batch' },
  cmd: { Icon: TerminalSquare, color: C.windows, label: 'Batch', lang: 'batch' },

  // ── Web ────────────────────────────────────────────────────────────────
  html: { Icon: SiHtml5, color: C.html, label: 'HTML', lang: 'markup' },
  htm: { Icon: SiHtml5, color: C.html, label: 'HTML', lang: 'markup' },
  xml: { Icon: Code2, color: C.fallback, label: 'XML', lang: 'markup' },
  svg: { Icon: SiSvg, color: C.svg, label: 'SVG', lang: 'markup' },
  css: { Icon: Hash, color: C.css, label: 'CSS', lang: 'css' },
  scss: { Icon: SiSass, color: C.sass, label: 'Sass', lang: 'scss' },
  sass: { Icon: SiSass, color: C.sass, label: 'Sass', lang: 'sass' },
  less: { Icon: SiLess, color: C.less, label: 'Less', lang: 'less' },
  vue: { Icon: SiVuedotjs, color: C.vue, label: 'Vue', lang: 'markup' },
  svelte: { Icon: SiSvelte, color: C.svelte, label: 'Svelte', lang: 'markup' },
  astro: { Icon: SiAstro, color: C.astro, label: 'Astro', lang: 'markup' },

  // ── Config / data ──────────────────────────────────────────────────────
  json: { Icon: Code2, color: C.json, label: 'JSON', lang: 'json' },
  jsonc: { Icon: Code2, color: C.json, label: 'JSON-C', lang: 'json' },
  yaml: { Icon: SiYaml, color: C.yaml, label: 'YAML', lang: 'yaml' },
  yml: { Icon: SiYaml, color: C.yaml, label: 'YAML', lang: 'yaml' },
  toml: { Icon: SiToml, color: C.toml, label: 'TOML', lang: 'toml' },
  ini: { Icon: Settings, color: C.ini, label: 'INI', lang: 'ini' },
  conf: { Icon: Settings, color: C.ini, label: 'Config', lang: 'ini' },
  env: { Icon: SiDotenv, color: C.env, label: 'Env', lang: 'bash' },
  csv: { Icon: FileText, color: C.text, label: 'CSV', lang: null },
  tsv: { Icon: FileText, color: C.text, label: 'TSV', lang: null },

  // ── SQL / DB ───────────────────────────────────────────────────────────
  sql: { Icon: Database, color: C.sqlite, label: 'SQL', lang: 'sql' },
  sqlite: { Icon: SiSqlite, color: C.sqlite, label: 'SQLite', lang: null },
  db: { Icon: Database, color: C.sqlite, label: 'Database', lang: null },
  prisma: { Icon: SiPrisma, color: C.prisma, label: 'Prisma', lang: null },
  graphql: { Icon: SiGraphql, color: C.graphql, label: 'GraphQL', lang: 'graphql' },
  gql: { Icon: SiGraphql, color: C.graphql, label: 'GraphQL', lang: 'graphql' },

  // ── Docs ───────────────────────────────────────────────────────────────
  md: { Icon: SiMarkdown, color: C.md, label: 'Markdown', lang: 'markdown' },
  mdx: { Icon: SiMdx, color: C.md, label: 'MDX', lang: 'markdown' },
  rst: { Icon: FileText, color: C.text, label: 'reST', lang: null },
  tex: { Icon: Sigma, color: C.text, label: 'LaTeX', lang: 'latex' },
  txt: { Icon: FileText, color: C.text, label: 'Text', lang: null },
  log: { Icon: ScrollText, color: C.log, label: 'Log', lang: null },
  pdf: { Icon: FileText, color: C.pdf, label: 'PDF', lang: null },

  // ── Build / DevOps ────────────────────────────────────────────────────
  dockerfile: { Icon: SiDocker, color: C.docker, label: 'Docker', lang: 'docker' },
  dockerignore: { Icon: SiDocker, color: C.docker, label: 'Docker', lang: null },
  makefile: { Icon: Hammer, color: C.make, label: 'Make', lang: 'makefile' },
  mk: { Icon: Hammer, color: C.make, label: 'Make', lang: 'makefile' },
  cmake: { Icon: Hammer, color: C.make, label: 'CMake', lang: null },
  gradle: { Icon: SiGradle, color: C.gradle, label: 'Gradle', lang: 'groovy' },
  groovy: { Icon: Code2, color: C.fallback, label: 'Groovy', lang: 'groovy' },
  tf: { Icon: SiTerraform, color: C.terraform, label: 'Terraform', lang: null },
  tfvars: { Icon: SiTerraform, color: C.terraform, label: 'Terraform Vars', lang: null },
  hcl: { Icon: SiTerraform, color: C.terraform, label: 'HCL', lang: null },
  nginx: { Icon: SiNginx, color: C.nginx, label: 'NGINX', lang: 'nginx' },

  // ── Images / media ────────────────────────────────────────────────────
  png: { Icon: FileImage, color: C.image, label: 'PNG', lang: null },
  jpg: { Icon: FileImage, color: C.image, label: 'JPEG', lang: null },
  jpeg: { Icon: FileImage, color: C.image, label: 'JPEG', lang: null },
  gif: { Icon: FileImage, color: C.image, label: 'GIF', lang: null },
  webp: { Icon: FileImage, color: C.image, label: 'WebP', lang: null },
  ico: { Icon: FileImage, color: C.image, label: 'Icon', lang: null },
  bmp: { Icon: FileImage, color: C.image, label: 'Bitmap', lang: null },
  mp3: { Icon: Music, color: C.audio, label: 'MP3', lang: null },
  wav: { Icon: Music, color: C.audio, label: 'WAV', lang: null },
  ogg: { Icon: Music, color: C.audio, label: 'OGG', lang: null },
  flac: { Icon: Music, color: C.audio, label: 'FLAC', lang: null },
  mp4: { Icon: Film, color: C.video, label: 'MP4', lang: null },
  mov: { Icon: Film, color: C.video, label: 'MOV', lang: null },
  webm: { Icon: Film, color: C.video, label: 'WebM', lang: null },
  mkv: { Icon: Film, color: C.video, label: 'MKV', lang: null },

  // ── Archives ──────────────────────────────────────────────────────────
  zip: { Icon: Archive, color: C.archive, label: 'ZIP', lang: null },
  tar: { Icon: Archive, color: C.archive, label: 'TAR', lang: null },
  gz: { Icon: Archive, color: C.archive, label: 'GZip', lang: null },
  bz2: { Icon: Archive, color: C.archive, label: 'Bzip2', lang: null },
  xz: { Icon: Archive, color: C.archive, label: 'XZ', lang: null },
  rar: { Icon: Archive, color: C.archive, label: 'RAR', lang: null },
  '7z': { Icon: Archive, color: C.archive, label: '7-Zip', lang: null },

  // ── Lock / metadata ───────────────────────────────────────────────────
  lock: { Icon: Lock, color: C.lock, label: 'Lock', lang: null },
  gitignore: { Icon: SiGit, color: C.git, label: 'gitignore', lang: null },
  gitattributes: { Icon: SiGit, color: C.git, label: 'gitattr', lang: null },

  // ── Binaries / misc ───────────────────────────────────────────────────
  exe: { Icon: Binary, color: C.fallback, label: 'Executable', lang: null },
  dll: { Icon: Binary, color: C.fallback, label: 'DLL', lang: null },
  so: { Icon: Binary, color: C.fallback, label: 'Shared Lib', lang: null },
  dylib: { Icon: Binary, color: C.fallback, label: 'Mach-O Dylib', lang: null },
  o: { Icon: Binary, color: C.fallback, label: 'Object', lang: null },
  wasm: { Icon: Binary, color: C.fallback, label: 'WebAssembly', lang: null },
};

/**
 * Whole-filename overrides for files that don't carry an extension or
 * carry one that's misleading (e.g. `Dockerfile`).
 */
const SPECIAL_NAMES: Record<string, FileMeta> = {
  Dockerfile: { Icon: SiDocker, color: C.docker, label: 'Docker', lang: 'docker' },
  Makefile: { Icon: Hammer, color: C.make, label: 'Make', lang: 'makefile' },
  Rakefile: { Icon: SiRuby, color: C.ruby, label: 'Rake', lang: 'ruby' },
  Procfile: { Icon: Settings, color: C.ini, label: 'Procfile', lang: null },
  README: { Icon: BookOpen, color: C.md, label: 'README', lang: 'markdown' },
  LICENSE: { Icon: Scale, color: C.text, label: 'License', lang: null },
  CHANGELOG: { Icon: Calendar, color: C.md, label: 'Changelog', lang: 'markdown' },
  '.env': { Icon: SiDotenv, color: C.env, label: 'Env', lang: 'bash' },
  '.gitignore': { Icon: SiGit, color: C.git, label: 'gitignore', lang: null },
  '.gitattributes': { Icon: SiGit, color: C.git, label: 'gitattr', lang: null },
  '.editorconfig': { Icon: Settings, color: C.ini, label: 'editorconfig', lang: 'ini' },
  '.dockerignore': { Icon: SiDocker, color: C.docker, label: 'Docker', lang: null },
  '.npmrc': { Icon: SiNpm, color: C.npm, label: 'npmrc', lang: 'ini' },
  '.nvmrc': { Icon: Slash, color: C.fallback, label: 'nvmrc', lang: null },
  'package.json': { Icon: SiNpm, color: C.npm, label: 'NPM Pkg', lang: 'json' },
  'package-lock.json': { Icon: Lock, color: C.npm, label: 'NPM Lock', lang: 'json' },
  'tsconfig.json': { Icon: SiTypescript, color: C.ts, label: 'TS Config', lang: 'json' },
  'next.config.ts': { Icon: SiNextdotjs, color: C.next, label: 'Next', lang: 'typescript' },
  'next.config.js': { Icon: SiNextdotjs, color: C.next, label: 'Next', lang: 'javascript' },
  'tailwind.config.ts': { Icon: SiTailwindcss, color: C.tailwind, label: 'Tailwind', lang: 'typescript' },
  'tailwind.config.js': { Icon: SiTailwindcss, color: C.tailwind, label: 'Tailwind', lang: 'javascript' },
  'vite.config.ts': { Icon: SiVite, color: C.vite, label: 'Vite', lang: 'typescript' },
  'vite.config.js': { Icon: SiVite, color: C.vite, label: 'Vite', lang: 'javascript' },
  'postcss.config.mjs': { Icon: Hash, color: C.css, label: 'PostCSS', lang: 'javascript' },
  'postcss.config.js': { Icon: Hash, color: C.css, label: 'PostCSS', lang: 'javascript' },
  'eslint.config.mjs': { Icon: Sparkles, color: '#4b32c3', label: 'ESLint', lang: 'javascript' },
  'eslint.config.js': { Icon: Sparkles, color: '#4b32c3', label: 'ESLint', lang: 'javascript' },
  'pnpm-lock.yaml': { Icon: Lock, color: '#f69220', label: 'pnpm Lock', lang: 'yaml' },
  'yarn.lock': { Icon: Lock, color: '#2c8ebb', label: 'Yarn Lock', lang: null },
  'bun.lockb': { Icon: Lock, color: '#fbf0df', label: 'Bun Lock', lang: null },
  'Cargo.toml': { Icon: SiRust, color: C.rust, label: 'Cargo', lang: 'toml' },
  'Cargo.lock': { Icon: Lock, color: C.rust, label: 'Cargo Lock', lang: 'toml' },
  'go.mod': { Icon: SiGo, color: C.go, label: 'Go Module', lang: null },
  'go.sum': { Icon: Lock, color: C.go, label: 'Go Sum', lang: null },
  'requirements.txt': { Icon: SiPython, color: C.python, label: 'pip reqs', lang: null },
  'pyproject.toml': { Icon: SiPython, color: C.python, label: 'PyProject', lang: 'toml' },
  'Pipfile': { Icon: SiPython, color: C.python, label: 'Pipfile', lang: 'toml' },
  'pom.xml': { Icon: SiOpenjdk, color: C.java, label: 'Maven', lang: 'markup' },
  'build.gradle': { Icon: SiGradle, color: C.gradle, label: 'Gradle', lang: 'groovy' },
  'build.gradle.kts': { Icon: SiGradle, color: C.gradle, label: 'Gradle KTS', lang: null },
};

const FALLBACK: FileMeta = {
  Icon: File,
  color: C.fallback,
  label: 'File',
  lang: null,
};

export function getFileMeta(name: string): FileMeta {
  if (SPECIAL_NAMES[name]) return SPECIAL_NAMES[name];
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return EXT[lower] ?? FALLBACK;
  }
  const ext = lower.slice(dot + 1);
  return EXT[ext] ?? FALLBACK;
}

// Re-export a stable shape for the few callers that wanted the "next config"
// triangle. Other glyphs like Zap / Triangle are available if a future entry
// needs them; importing them once here keeps the dependency surface honest.
export const SpecialGlyphs = { Triangle, Zap, KeyRound };
