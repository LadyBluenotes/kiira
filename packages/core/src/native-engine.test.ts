import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { type RawDiagnostic, classicEngine } from "./engine"
import {
	type NativeApiConstructor,
	closeNativeEngine,
	collectNativeDiagnostics,
	compilerOptionsToTsconfigJson,
	createNativeEngine,
	createNativeEngineSession,
} from "./native-engine"
import type { VirtualFile } from "./types"

const cwd = fileURLToPath(new URL(".", import.meta.url))

/** Minimal virtual file — the native collector only reads `fileName`, `content`, `lang`. */
function vfile(name: string, content: string): VirtualFile {
	return vfileAt(cwd, name, content)
}

function vfileAt(root: string, name: string, content: string): VirtualFile {
	return {
		id: name,
		fileName: join(root, ".kiira", "virtual", name),
		lang: "ts",
		content,
		snippet: {} as VirtualFile["snippet"],
		mappings: [],
	}
}

function nativeProject(): string {
	const root = mkdtempSync(join(tmpdir(), "kiira-native-"))
	const typescriptEntry = createRequire(import.meta.url).resolve("typescript-7/unstable/sync")
	const typescriptRoot = join(dirname(typescriptEntry), "../../..")
	mkdirSync(join(root, "node_modules"), { recursive: true })
	symlinkSync(typescriptRoot, join(root, "node_modules", "typescript"), "dir")
	return root
}

const OPTIONS: ts.CompilerOptions = {
	// ESNext (=== Latest === 99) specifically exercises enum-alias serialization:
	// a mis-serialized target falls back to the compiler default and would emit
	// false downlevel-iteration errors on the Set-spread snippet below.
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	skipLibCheck: true,
	noEmit: true,
}

const erroredFiles = (diagnostics: RawDiagnostic[]): Set<string> =>
	new Set(diagnostics.filter((d) => d.severity === "error").map((d) => d.virtualFile))

describe("compilerOptionsToTsconfigJson", () => {
	it("serializes numeric enums to the tsconfig string forms", () => {
		const json = compilerOptionsToTsconfigJson({
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			jsx: ts.JsxEmit.ReactJSX,
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		})
		expect(json).toMatchObject({
			target: "es2022",
			module: "esnext",
			moduleResolution: "bundler",
			jsx: "react-jsx",
			lib: ["es2022", "dom", "dom.iterable"],
			noEmit: true,
		})
	})

	it("maps enum aliases and value-collisions to legal tsconfig strings", () => {
		// ScriptTarget.ESNext === Latest === 99; the built-in reverse map keeps
		// "Latest" (illegal in a tsconfig), so this must resolve to "esnext".
		const json = compilerOptionsToTsconfigJson({
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.NodeNext,
			// ModuleResolutionKind.Node10 === NodeJs === 2; must be "node10", not "nodejs".
			moduleResolution: ts.ModuleResolutionKind.Node10,
			moduleDetection: ts.ModuleDetectionKind.Force,
		})
		expect(json).toMatchObject({
			target: "esnext",
			module: "nodenext",
			moduleResolution: "node10",
			moduleDetection: "force",
		})
	})

	it("drops the internal keys the config parser stamps on", () => {
		const json = compilerOptionsToTsconfigJson({
			configFilePath: "/x/tsconfig.json",
			pathsBasePath: "/x",
			strict: true,
		} as ts.CompilerOptions)
		expect(json).not.toHaveProperty("configFilePath")
		expect(json).not.toHaveProperty("pathsBasePath")
		expect(json).toMatchObject({ strict: true })
	})
})

describe("native engine (TypeScript 7)", () => {
	it("reports the same erroring files as the classic engine", async () => {
		const { API } = (await import("typescript-7/unstable/sync")) as unknown as { API: NativeApiConstructor }
		const files = [
			vfile("bad.ts", "export const n: number = 'not a number'\n"),
			vfile("missing.ts", "export const x = totallyUndefinedName\n"),
			// Valid only at target >= ES2015: proves `target: ESNext` is serialized
			// correctly (a mis-serialized target would flag downlevel iteration here).
			vfile("good.ts", "export const arr = [...new Set([1, 2, 3])]\n"),
		]

		const native = collectNativeDiagnostics(API, cwd, files, OPTIONS)
		const classic = (await classicEngine.collect(files, OPTIONS)) as RawDiagnostic[]

		// Parity: the same files carry errors under both engines.
		expect(erroredFiles(native)).toEqual(erroredFiles(classic))
		// The ES2015+ snippet stays clean; the planted type error is found and positioned.
		expect(native.some((d) => d.virtualFile === files[2]?.fileName && d.severity === "error")).toBe(false)
		const typeError = native.find((d) => d.code === 2322)
		expect(typeError).toBeDefined()
		expect(typeError?.start?.line).toBe(0)
	})

	it("reuses a cwd-scoped API and refreshes changed, deleted, and option overlays", async () => {
		const firstCwd = nativeProject()
		const secondCwd = nativeProject()
		try {
			const first = await createNativeEngine(firstCwd)
			const sameCwd = await createNativeEngine(firstCwd)
			const otherCwd = await createNativeEngine(secondCwd)
			expect(sameCwd).toBe(first)
			expect(otherCwd).not.toBe(first)

			const source = vfileAt(firstCwd, "source.ts", "export const value: string = 'ok'\n")
			const initial = await first.collect([source], { ...OPTIONS, strictNullChecks: false })
			expect(initial.filter((diagnostic) => diagnostic.severity === "error")).toHaveLength(0)

			const changed = { ...source, content: "export const value: string = null\n" }
			const strict = await first.collect([changed], { ...OPTIONS, strictNullChecks: true })
			expect(strict.some((diagnostic) => diagnostic.code === 2322)).toBe(true)

			const consumer = vfileAt(firstCwd, "consumer.ts", 'import { value } from "./source"\n')
			const afterDeletion = await first.collect([consumer], OPTIONS)
			expect(afterDeletion.some((diagnostic) => diagnostic.code === 2307)).toBe(true)

			await closeNativeEngine(firstCwd)
			expect(await createNativeEngine(firstCwd)).not.toBe(first)
		} finally {
			await closeNativeEngine()
			rmSync(firstCwd, { recursive: true, force: true })
			rmSync(secondCwd, { recursive: true, force: true })
		}
	})

	it("serializes snapshot updates, reports update failures, and closes snapshots and APIs", async () => {
		type ApiOptions = ConstructorParameters<NativeApiConstructor>[0]
		type UpdateParams = Parameters<InstanceType<NativeApiConstructor>["updateSnapshot"]>[0]
		class FakeApi {
			static latest: FakeApi
			readonly updates: UpdateParams[] = []
			closed = 0
			disposedSnapshots = 0

			constructor(readonly options: ApiOptions) {
				FakeApi.latest = this
			}

			updateSnapshot(params: UpdateParams) {
				this.updates.push(params)
				return {
					getProjects: () => [
						{
							configFileName: "tsconfig.json",
							program: {
								getSyntacticDiagnostics: () => [],
								getSemanticDiagnostics: () => [],
							},
						},
					],
					dispose: () => {
						this.disposedSnapshots += 1
					},
				}
			}

			close(): void {
				this.closed += 1
			}
		}

		const root = "/native-api-test"
		const engine = createNativeEngineSession(FakeApi, root)
		const first = vfileAt(root, "first.ts", "export const first = 1\n")
		const second = vfileAt(root, "second.ts", "export const second = 2\n")
		await Promise.all([engine.collect([first], OPTIONS), engine.collect([second], OPTIONS)])

		expect(FakeApi.latest.updates[0]?.openProjects).toEqual([
			join(root, "__kiira_native.tsconfig.json").replace(/\\/g, "/"),
		])
		expect(FakeApi.latest.updates[1]?.openProjects).toBeUndefined()
		expect(FakeApi.latest.updates[1]?.fileChanges).toMatchObject({
			created: [second.fileName.replace(/\\/g, "/")],
			deleted: [first.fileName.replace(/\\/g, "/")],
		})
		expect(FakeApi.latest.options.fs?.readFile?.(first.fileName)).toBeNull()
		expect(FakeApi.latest.options.fs?.fileExists?.(first.fileName)).toBe(false)
		expect(FakeApi.latest.disposedSnapshots).toBe(2)

		await engine.close()
		await engine.close()
		expect(FakeApi.latest.closed).toBe(1)

		class FailingApi extends FakeApi {
			updateSnapshot(): never {
				throw new Error("snapshot update failed")
			}
		}
		const failing = createNativeEngineSession(FailingApi, root)
		await expect(failing.collect([first], OPTIONS)).rejects.toThrow("snapshot update failed")
		expect(FakeApi.latest.closed).toBe(1)
	})
})
