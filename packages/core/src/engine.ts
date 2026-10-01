import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import type { KiiraEngine, SourcePosition, VirtualFile } from "./types"

/**
 * A diagnostic in virtual-file coordinates, normalized across the classic and
 * native engines. `check.ts` maps this to a {@link KiiraDiagnostic} (Markdown
 * coordinates) — the mapping logic is shared, only the collection differs.
 */
export interface RawDiagnostic {
	/** The virtual file this diagnostic belongs to. */
	virtualFile: string
	/** Zero-based start position within the virtual file, if the diagnostic has one. */
	start?: SourcePosition
	/** Zero-based end position within the virtual file, if the diagnostic has one. */
	end?: SourcePosition
	code?: number
	message: string
	severity: "error" | "warning" | "info"
}

/** A pluggable TypeScript type-checking backend. */
export interface CheckerEngine {
	name: "classic" | "native"
	/** Type-check the virtual files under `options` and return their diagnostics. */
	collect(virtualFiles: VirtualFile[], options: ts.CompilerOptions): RawDiagnostic[] | Promise<RawDiagnostic[]>
}

// ts.DiagnosticCategory is a numeric enum with the same values in TS5 and TS7
// (Warning=0, Error=1, Suggestion=2, Message=3), so both engines map by number.
export function severityFromCategory(category: number): RawDiagnostic["severity"] {
	switch (category) {
		case ts.DiagnosticCategory.Error:
			return "error"
		case ts.DiagnosticCategory.Warning:
			return "warning"
		default:
			return "info"
	}
}

// --- classic engine (kiira's bundled TypeScript, in-process) ---

function scriptKindFor(lang: VirtualFile["lang"]): ts.ScriptKind {
	switch (lang) {
		case "tsx":
			return ts.ScriptKind.TSX
		case "jsx":
			return ts.ScriptKind.JSX
		case "js":
			return ts.ScriptKind.JS
		default:
			return ts.ScriptKind.TS
	}
}

// Directory holding TypeScript's `lib.*.d.ts` files. When TypeScript is bundled
// into a host (the VS Code extension), `ts.sys.getExecutingFilePath()` no longer
// points next to the real lib files, so the default-lib location is wrong and every
// global (`JSON`, `Date`, DOM types) is reported as undefined. A host that bundles
// TypeScript ships the lib files and calls `setTypescriptLibDir` to point here.
let typescriptLibDir: string | undefined

interface ClassicResolutionCache {
	cache: ts.ModuleResolutionCache
	directories: Map<string, string | undefined>
	files: Map<string, string | undefined>
	virtualFiles: Set<string>
}

const classicResolutionCaches = new Map<string, ClassicResolutionCache>()

function resolutionPath(path: string): string {
	const absolute = resolve(path).replace(/\\/g, "/")
	return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase()
}

function resolutionCacheKey(cwd: string, options: ts.CompilerOptions): string {
	return `${resolutionPath(cwd)}\0${JSON.stringify(options)}`
}

export function getClassicResolutionCache(
	cwd: string,
	options: ts.CompilerOptions
): ts.ModuleResolutionCache | undefined {
	return classicResolutionCaches.get(resolutionCacheKey(cwd, options))?.cache
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

function fileSystemFingerprint(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true })
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined
		}
		throw error
	}
}

function resolutionDirectoryFingerprint(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true })
		return `${stat.dev}:${stat.ino}:${stat.mode}`
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined
		}
		throw error
	}
}

function rememberResolutionDirectory(cache: ClassicResolutionCache, path: string): void {
	const key = resolutionPath(path)
	if (!cache.directories.has(key)) {
		cache.directories.set(key, resolutionDirectoryFingerprint(path))
	}
}

function rememberResolutionFile(cache: ClassicResolutionCache, path: string): void {
	const key = resolutionPath(path)
	if (!cache.files.has(key)) {
		cache.files.set(key, fileSystemFingerprint(path))
	}
}

function hasChangedResolutionInputs(cache: ClassicResolutionCache): boolean {
	for (const [path, fingerprint] of cache.directories) {
		if (resolutionDirectoryFingerprint(path) !== fingerprint) {
			return true
		}
	}
	for (const [path, fingerprint] of cache.files) {
		if (fileSystemFingerprint(path) !== fingerprint) {
			return true
		}
	}
	return false
}

function samePaths(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((path) => right.has(path))
}

/** Override where TypeScript loads its default `lib.*.d.ts` from (for bundled hosts). */
export function setTypescriptLibDir(dir: string | undefined): void {
	typescriptLibDir = dir
}

/** Apply the configured lib-directory override to a compiler/language-service host. */
export function applyLibDirOverride(host: {
	getDefaultLibLocation?: () => string
	getDefaultLibFileName: (options: ts.CompilerOptions) => string
}): void {
	if (!typescriptLibDir) {
		return
	}
	const dir = typescriptLibDir
	host.getDefaultLibLocation = () => dir
	host.getDefaultLibFileName = (options) => join(dir, ts.getDefaultLibFileName(options))
}

/** Build a TS host with virtual files and a cwd/options-scoped module cache. */
function createOverlayHost(cwd: string, options: ts.CompilerOptions, virtualFiles: VirtualFile[]): ts.CompilerHost {
	const host = ts.createCompilerHost(options, true)
	const caseSensitive = host.useCaseSensitiveFileNames()
	const normalize = (file: string): string => {
		const slashed = file.replace(/\\/g, "/")
		return caseSensitive ? slashed : slashed.toLowerCase()
	}

	const overlay = new Map<string, VirtualFile>()
	const overlayDirectories = new Set<string>()
	for (const vf of virtualFiles) {
		const fileName = normalize(vf.fileName)
		overlay.set(fileName, vf)
		let directory = dirname(fileName)
		while (directory.length > 0 && !overlayDirectories.has(directory)) {
			overlayDirectories.add(directory)
			directory = dirname(directory)
		}
	}

	const cacheKey = resolutionCacheKey(cwd, options)
	const virtualFileNames = new Set(overlay.keys())
	let resolutionCache = classicResolutionCaches.get(cacheKey)
	if (!resolutionCache) {
		resolutionCache = {
			cache: ts.createModuleResolutionCache(resolve(cwd), host.getCanonicalFileName, options),
			directories: new Map(),
			files: new Map(),
			virtualFiles: virtualFileNames,
		}
		classicResolutionCaches.set(cacheKey, resolutionCache)
	} else if (
		!samePaths(resolutionCache.virtualFiles, virtualFileNames) ||
		hasChangedResolutionInputs(resolutionCache)
	) {
		resolutionCache.cache.clear()
		resolutionCache.directories.clear()
		resolutionCache.files.clear()
		resolutionCache.virtualFiles = virtualFileNames
	}

	const originalGetSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
		const vf = overlay.get(normalize(fileName))
		if (vf) {
			return ts.createSourceFile(fileName, vf.content, languageVersionOrOptions, true, scriptKindFor(vf.lang))
		}
		return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate)
	}

	const originalFileExists = host.fileExists.bind(host)
	let resolvingModule = false
	host.fileExists = (fileName) => {
		if (resolvingModule && !overlay.has(normalize(fileName))) {
			rememberResolutionDirectory(resolutionCache, dirname(fileName))
			rememberResolutionFile(resolutionCache, fileName)
		}
		return overlay.has(normalize(fileName)) || originalFileExists(fileName)
	}

	const originalReadFile = host.readFile.bind(host)
	host.readFile = (fileName) => {
		const vf = overlay.get(normalize(fileName))
		if (resolvingModule && !vf && fileName.split(/[\\/]/).pop()?.toLowerCase() === "package.json") {
			rememberResolutionFile(resolutionCache, fileName)
		}
		return vf ? vf.content : originalReadFile(fileName)
	}

	const originalDirectoryExists = host.directoryExists?.bind(host) ?? ts.sys.directoryExists?.bind(ts.sys)
	host.directoryExists = (directoryName) => {
		if (resolvingModule) {
			rememberResolutionDirectory(resolutionCache, directoryName)
		}
		return overlayDirectories.has(normalize(directoryName)) || (originalDirectoryExists?.(directoryName) ?? false)
	}

	host.getModuleResolutionCache = () => resolutionCache.cache
	host.resolveModuleNameLiterals = (
		moduleLiterals,
		containingFile,
		redirectedReference,
		resolutionOptions,
		containingSourceFile
	) => {
		resolvingModule = true
		try {
			return moduleLiterals.map((literal) => {
				const mode = ts.getModeForUsageLocation(containingSourceFile, literal, resolutionOptions)
				const result = ts.resolveModuleName(
					literal.text,
					containingFile,
					resolutionOptions,
					host,
					resolutionCache.cache,
					redirectedReference,
					mode
				)
				if (result.resolvedModule) {
					rememberResolutionFile(resolutionCache, result.resolvedModule.resolvedFileName)
				}
				return result
			})
		} finally {
			resolvingModule = false
		}
	}

	applyLibDirOverride(host)
	return host
}

export const classicEngine: CheckerEngine = {
	name: "classic",
	collect(virtualFiles, options) {
		const firstFile = virtualFiles[0]?.fileName
		const cwd = firstFile ? resolve(dirname(dirname(dirname(firstFile)))) : process.cwd()
		const host = createOverlayHost(cwd, options, virtualFiles)
		const program = ts.createProgram({ rootNames: virtualFiles.map((v) => v.fileName), options, host })

		const diagnostics: RawDiagnostic[] = []
		for (const vf of virtualFiles) {
			const sourceFile = program.getSourceFile(vf.fileName)
			if (!sourceFile) {
				continue
			}
			for (const diagnostic of [
				...program.getSyntacticDiagnostics(sourceFile),
				...program.getSemanticDiagnostics(sourceFile),
			]) {
				diagnostics.push(fromTsDiagnostic(diagnostic, vf))
			}
		}
		return diagnostics
	},
}

function fromTsDiagnostic(diagnostic: ts.Diagnostic, vf: VirtualFile): RawDiagnostic {
	const base: RawDiagnostic = {
		virtualFile: vf.fileName,
		code: typeof diagnostic.code === "number" ? diagnostic.code : undefined,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		severity: severityFromCategory(diagnostic.category),
	}
	if (!diagnostic.file || typeof diagnostic.start !== "number") {
		return base
	}
	const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
	const end = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + (diagnostic.length ?? 0))
	base.start = { line: start.line, character: start.character }
	base.end = { line: end.line, character: end.character }
	return base
}

// --- engine resolution ---

/** Read the major version of the `typescript` resolvable from `cwd`, or `undefined`. */
export function projectTypescriptMajor(cwd: string): number | undefined {
	try {
		// createRequire needs a file path to resolve *from*; the file need not exist.
		const require = createRequire(join(cwd, "__kiira_engine_resolver__.js"))
		const pkgPath = require.resolve("typescript/package.json")
		const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version
		const major = version ? Number.parseInt(version.split(".")[0] ?? "", 10) : Number.NaN
		return Number.isNaN(major) ? undefined : major
	} catch {
		return undefined
	}
}

/**
 * Pick the checker engine for a run. `"native"` throws if the project has no
 * TypeScript 7; `"auto"` silently falls back to `"classic"` when it can't load
 * the native engine, so a missing/older TypeScript never breaks a check.
 */
export async function resolveEngine(cwd: string, engine: KiiraEngine): Promise<CheckerEngine> {
	if (engine === "classic") {
		return classicEngine
	}
	if (engine === "native") {
		const { createNativeEngine } = await import("./native-engine")
		return createNativeEngine(cwd)
	}
	// auto
	if ((projectTypescriptMajor(cwd) ?? 0) < 7) {
		return classicEngine
	}
	try {
		const { createNativeEngine } = await import("./native-engine")
		return await createNativeEngine(cwd)
	} catch {
		return classicEngine
	}
}
