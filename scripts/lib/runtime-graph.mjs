import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

export const AGENT_ENTRYPOINTS = ['src/agent/main.ts', 'src/runtime/workers/backtest-child.ts', 'src/runtime/workers/preparation-child.ts'];
const defaultCompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, removeComments: true, esModuleInterop: true };
const emitKeys = new Set(['target', 'module', 'moduleResolution', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource', 'verbatimModuleSyntax', 'esModuleInterop', 'importHelpers', 'downlevelIteration', 'useDefineForClassFields', 'experimentalDecorators', 'emitDecoratorMetadata', 'alwaysStrict', 'preserveConstEnums', 'isolatedModules', 'resolveJsonModule']);
const emitted = new Map();

/** 서버와 agent의 코드 생성 설정을 상속까지 해석한다. */
export function readEmitOptions(root, file, overrides = {}) {
  const read = (name) => overrides[name] ?? fs.readFileSync(path.join(root, name), 'utf8');
  const config = ts.readConfigFile(file, () => read(file));
  if (config.error) throw new Error(`컴파일 설정을 읽을 수 없습니다: ${file}`);
  const parent = config.config.extends;
  const inherited = parent ? readEmitOptions(root, path.posix.normalize(path.posix.join(path.posix.dirname(file), parent)), overrides) : {};
  return { ...inherited, ...Object.fromEntries(Object.entries(config.config.compilerOptions ?? {}).filter(([key]) => emitKeys.has(key))) };
}

/** 타입 전용 의존성은 제거하고 실제 실행되는 import와 명시한 worker를 추적한다. */
export function runtimeGraph(root, entries, { overrides = {}, compiled = false, emitOptions } = {}) {
  const options = emitOptions ? { ...defaultCompilerOptions, ...ts.convertCompilerOptionsFromJson(emitOptions, root).options, module: ts.ModuleKind.ESNext, removeComments: true } : defaultCompilerOptions;
  const optionsKey = JSON.stringify(options);
  const files = new Map();
  const packages = new Set();
  const visit = (file) => {
    file = file.replaceAll(path.sep, '/');
    if (files.has(file)) return;
    const source = overrides[file] ?? fs.readFileSync(path.join(root, file), 'utf8');
    const cacheKey = `${optionsKey}\0${file}\0${source}`;
    let cached = compiled ? undefined : emitted.get(cacheKey);
    if (!cached) {
      const code = compiled ? source : ts.transpileModule(source, { compilerOptions: options, fileName: file }).outputText;
      const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const specifiers = [];
      const scan = (node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifiers.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`동적 import 진입점을 명시하세요: ${file}`);
          specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, scan);
      };
      scan(parsed);
      cached = { code, specifiers };
      if (!compiled) emitted.set(cacheKey, cached);
    }
    files.set(file, cached.code);
    for (const specifier of cached.specifiers) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
        continue;
      }
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!compiled) target = target.replace(/\.js$/, '.ts');
      if (!target.startsWith(compiled ? 'dist/' : 'src/')) throw new Error(`실행 경계 밖 의존성: ${file} → ${target}`);
      visit(target);
    }
  };
  entries.forEach(visit);
  return { files, packages: [...packages].sort() };
}
