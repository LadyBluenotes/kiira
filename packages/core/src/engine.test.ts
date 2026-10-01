import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { classicEngine, getClassicResolutionCache, projectTypescriptMajor, resolveEngine } from "./engine"
import type { VirtualFile } from "./types"

const cwd = fileURLToPath(new URL(".", import.meta.url))
const OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	skipLibCheck: true,
	noEmit: true,
}

function virtualFile(root: string, name: string, content: string): VirtualFile {
	return {
		id: name,
		fileName: join(root, ".kiira", "virtual", name),
		lang: "ts",
		content,
		snippet: {} as VirtualFile["snippet"],
		mappings: [],
	}
}

describe("projectTypescriptMajor", () => {
	it("reads the bundled TypeScript major from cwd", () => {
		// kiira-core depends on typescript@^5, so it resolves to a 5.x here.
		expect(projectTypescriptMajor(cwd)).toBe(5)
	})
})

describe("resolveEngine", () => {
	it("returns the classic engine when asked", async () => {
		expect(await resolveEngine(cwd, "classic")).toBe(classicEngine)
	})

	it("auto falls back to classic when the project has no TypeScript 7", async () => {
		expect(await resolveEngine(cwd, "auto")).toBe(classicEngine)
	})

	it("native throws when the project has no TypeScript 7 native API", async () => {
		await expect(resolveEngine(cwd, "native")).rejects.toThrow()
	})
})

describe("classic module resolution cache", () => {
	it("reuses negative lookups across virtual edits and invalidates disk changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiira-resolution-"))
		const virtual = virtualFile(
			root,
			"entry.ts",
			'import type { Value } from "fixture-pkg"\nexport const value: Value = "ok"\n'
		)
		const packageDir = join(root, "node_modules", "fixture-pkg")
		const packageJson = join(packageDir, "package.json")
		const declaration = join(packageDir, "index.d.ts")
		const collectErrors = async (file: VirtualFile) =>
			(await classicEngine.collect([file], OPTIONS)).filter((diagnostic) => diagnostic.severity === "error")

		try {
			expect((await collectErrors(virtual)).some((d) => d.code === 2307)).toBe(true)
			const cache = getClassicResolutionCache(root, OPTIONS)
			expect(cache).toBeDefined()
			if (!cache) {
				throw new Error("Expected classic module resolution cache")
			}
			const clearSpy = vi.spyOn(cache, "clear")
			try {
				const edited = { ...virtual, content: `// changed text\n${virtual.content}` }
				expect((await collectErrors(edited)).some((d) => d.code === 2307)).toBe(true)
				expect(clearSpy).not.toHaveBeenCalled()

				mkdirSync(packageDir, { recursive: true })
				writeFileSync(packageJson, JSON.stringify({ types: "./index.d.ts" }))
				writeFileSync(declaration, 'export type Value = "ok"\n')
				expect((await collectErrors(edited)).some((d) => d.code === 2307)).toBe(false)
				expect(clearSpy).toHaveBeenCalledTimes(1)

				writeFileSync(declaration, "export type Value = number\n")
				expect((await collectErrors(edited)).some((d) => d.code === 2322)).toBe(true)
				expect(clearSpy).toHaveBeenCalledTimes(2)

				rmSync(packageDir, { recursive: true, force: true })
				expect((await collectErrors(edited)).some((d) => d.code === 2307)).toBe(true)
				expect(clearSpy).toHaveBeenCalledTimes(3)
			} finally {
				clearSpy.mockRestore()
			}
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("isolates options and cwd, preserves import and require modes, and invalidates removed overlays", async () => {
		const firstRoot = mkdtempSync(join(tmpdir(), "kiira-resolution-one-"))
		const secondRoot = mkdtempSync(join(tmpdir(), "kiira-resolution-two-"))
		try {
			writeFileSync(join(firstRoot, "first.d.ts"), 'export declare const value: "first"\n')
			writeFileSync(join(firstRoot, "second.d.ts"), 'export declare const value: "second"\n')
			const aliasFile = virtualFile(
				firstRoot,
				"alias.ts",
				'import { value } from "alias"\nconst expected: "first" = value\n'
			)
			const firstOptions = { ...OPTIONS, baseUrl: firstRoot, paths: { alias: ["first.d.ts"] } }
			const secondOptions = { ...OPTIONS, baseUrl: firstRoot, paths: { alias: ["second.d.ts"] } }
			expect((await classicEngine.collect([aliasFile], firstOptions)).some((d) => d.code === 2322)).toBe(false)
			expect((await classicEngine.collect([aliasFile], secondOptions)).some((d) => d.code === 2322)).toBe(true)

			for (const [root, value] of [
				[firstRoot, "first"],
				[secondRoot, "second"],
			] as const) {
				const packageDir = join(root, "node_modules", "cwd-pkg")
				mkdirSync(packageDir, { recursive: true })
				writeFileSync(join(packageDir, "package.json"), JSON.stringify({ types: "./index.d.ts" }))
				writeFileSync(join(packageDir, "index.d.ts"), `export declare const value: "${value}"\n`)
			}
			const cwdOptions = { ...OPTIONS, baseUrl: undefined, paths: undefined }
			const firstCwdFile = virtualFile(
				firstRoot,
				"cwd.ts",
				'import { value } from "cwd-pkg"\nconst expected: "first" = value\n'
			)
			const secondCwdFile = virtualFile(
				secondRoot,
				"cwd.ts",
				'import { value } from "cwd-pkg"\nconst expected: "first" = value\n'
			)
			expect((await classicEngine.collect([firstCwdFile], cwdOptions)).some((d) => d.code === 2322)).toBe(false)
			expect((await classicEngine.collect([secondCwdFile], cwdOptions)).some((d) => d.code === 2322)).toBe(true)

			const modes = join(firstRoot, "node_modules", "mode-pkg")
			mkdirSync(modes, { recursive: true })
			writeFileSync(
				join(modes, "package.json"),
				JSON.stringify({
					exports: {
						".": {
							import: { types: "./import.d.mts", default: "./import.mjs" },
							require: { types: "./require.d.cts", default: "./require.cjs" },
						},
					},
				})
			)
			writeFileSync(join(modes, "import.d.mts"), 'export declare const value: "import"\n')
			writeFileSync(join(modes, "require.d.cts"), 'export declare const value: "require"\n')
			const modeOptions: ts.CompilerOptions = {
				...OPTIONS,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
			}
			const importFile = virtualFile(
				firstRoot,
				"importer.mts",
				'import { value } from "mode-pkg"\nconst expected: "import" = value\n'
			)
			const requireFile = virtualFile(
				firstRoot,
				"requirer.cts",
				'import mode = require("mode-pkg")\nconst expected: "require" = mode.value\n'
			)
			expect(
				(await classicEngine.collect([importFile, requireFile], modeOptions)).filter((d) => d.severity === "error")
			).toHaveLength(0)

			const entry = virtualFile(firstRoot, "overlay.ts", 'import { value } from "./dep"\nexport const copy = value\n')
			const dependency = virtualFile(firstRoot, "dep.ts", "export const value = 1\n")
			expect((await classicEngine.collect([entry, dependency], OPTIONS)).some((d) => d.code === 2307)).toBe(false)
			expect((await classicEngine.collect([entry], OPTIONS)).some((d) => d.code === 2307)).toBe(true)
		} finally {
			rmSync(firstRoot, { recursive: true, force: true })
			rmSync(secondRoot, { recursive: true, force: true })
		}
	})
})
