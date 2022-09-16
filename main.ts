import { readdir, readFile, readFileSync } from "fs"
import expandHomeDir from "expand-home-dir"
import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian"
import * as exp from "constants"
import * as path from "path"

// Remember to rename these classes and interfaces!

interface UltiSnipsSettings {
	snippetsDir: string
}

type SnippetOptions = ("r" | "w" | "i" | "b" | "A" | "t" | "m")[]

class SnippetDefinition {
	priority: number
	trigger: string
	value: string
	description: string
	options: string
	globals: { [k: string]: string[] }
	location: string
	context: string
	actions: { [k: string]: string }
	matched: boolean
	lastRegex: null | RegExp

	constructor(
		priority: number,
		trigger: string,
		value: string,
		description: string,
		options: string,
		globals: { [k: string]: string[] },
		location: string,
		context: string,
		actions: { [k: string]: string }
	) {
		this.priority = priority
		this.trigger = trigger
		this.value = value
		this.description = description
		this.options = options
		this.globals = globals
		this.location = location
		this.context = context
		this.actions = actions
		// TODO
	}
}

interface Snippet {
	priority: number
	trigger: string
	value: string
	description: string
	options: SnippetOptions
	globals: { [global: string]: string }
	location: string
	context: string
	actions: { [action: string]: string }
}

const DEFAULT_SETTINGS: UltiSnipsSettings = {
	snippetsDir: "~/.config/nvim/UltiSnips/",
}

export default class UltiSnips extends Plugin {
	settings: UltiSnipsSettings
	snippets: { [language: string]: Snippet[] }

	async onload() {
		await this.loadSettings()
		await this.loadSnippets()

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new UltiSnipsSettingTab(this.app, this))
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		)
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	async loadSnippets() {
		let snippetDir = expandHomeDir(this.settings.snippetsDir)
		console.info(`Loading snippets from ${snippetDir}…`)
		await readdir(snippetDir, (err, files) => {
			if (err) throw err
			let snippetFiles = files.filter(f => f.endsWith(".snippets"))
			this.snippets = Object.fromEntries(
				snippetFiles.map(f => [
					f.replace(/^(.+)\..+$/, "$1"),
					[
						...this.parseSnippets(
							path.join(snippetDir, f),
							readFileSync(path.join(snippetDir, f), {
								encoding: "utf-8",
							})
						),
					],
				])
			)
		})
		const loadedSnippetsCount = Object.values(this.snippets)
			.map(s => s.length)
			.reduce((a, b) => a + b, 0)
		const loadedSnippetsFiles = Object.keys(this.snippets).length
		new Notice(
			`UltiSnips: Loaded ${loadedSnippetsCount} snippet${
				loadedSnippetsCount === 1 ? "" : "s"
			} from ${loadedSnippetsFiles} file${
				loadedSnippetsFiles === 1 ? "" : "s"
			}`
		)
	}

	*parseSnippets(filename: string, raw: string): Iterable<Snippet> {
		console.info(`Parsing snippets from ${filename}`)
		let pythonGlobals = null
		let currentLineNumber = 0
		let currentPriority = 0
		let actions = {}
		let context = null

		function headTail(line: string) {
			return line.split(" ", 2)
		}

		function handleSnippetOrGlobal(
			filename: string,
			line: string,
			currentLineNumber: number,
			lines: string[],
			pythonGlobals: { [k: string]: string[] },
			currentPriority: number,
			preExpand: { [k: string]: string },
			context: string
		): ["error", [string, number]] | ["snippet", [SnippetDefinition]] {
			let description = ""
			let options = ""
			const startingLineNumber = currentLineNumber

			let [head, tail] = line.split(" ", 2)
			let words = tail.split(" ")

			if (words.length > 2) {
				// second to last word ends with a quote
				if (
					!words.at(-1)?.includes('"') &&
					words.at(-2)?.endsWith('"')
				) {
					options = words.at(-1) as string
					tail = tail
						.substring(0, tail.length - options.length - 1)
						.trimEnd()
				}
			}

			if (options.includes("e") && !context) {
				let left = tail.substring(0, tail.length - 1).lastIndexOf('"')
				if (![-1, 0].includes(left)) {
					;[context, tail] = [
						tail.substring(left).replace('"', ""),
						tail.substring(0, left),
					]
				}
			}

			tail = tail.trim()
			if (tail.length > 1 && tail.endsWith('"')) {
				let left = tail.substring(0, tail.length - 1).lastIndexOf('"')
				if (![-1, 0].includes(left)) {
					;[description, tail] = [
						tail.substring(left),
						tail.substring(0, left),
					]
				}
			}

			let trigger = tail.trim()
			if (trigger.length > 1 || options.includes("r")) {
				if (trigger.at(0) != trigger.at(-1)) {
					return [
						"error",
						[
							`Invalid multiword trigger: '${trigger}'`,
							currentLineNumber,
						],
					]
				}
				trigger = trigger.substring(1, trigger.length - 1)
			}

			let end = "end" + head
			let content = ""

			let foundEnd = false
			for (const line of lines) {
				if (line.trimEnd() == end) {
					content = content.substring(0, content.length - 1) // chomp last newline
					foundEnd = true
					break
				}
				content += line
				currentLineNumber++
			}

			if (!foundEnd) {
				return [
					"error",
					[`Missing '${end}' for '${trigger}'`, currentLineNumber],
				]
			}

			switch (head) {
				case "global":
					pythonGlobals[trigger].push(content)
					break

				case "snippet":
					return [
						"snippet",
						[
							new SnippetDefinition(
								currentPriority,
								trigger,
								content,
								description,
								options,
								pythonGlobals,
								`${filename}:${startingLineNumber}`,
								context,
								preExpand
							),
						],
					]
			}

			return [
				"error",
				[`Invalid snippet type: '${head}'`, currentLineNumber],
			]
		}

		for (const line of raw.split("\n")) {
			if (!line.trim()) continue

			let [head, tail] = headTail(line)
			if (["snippet", "global"].includes(head)) {
				let snippet = handleSnippetOrGlobal(
					filename,
					line,
					currentLineNumber,
					raw.split("\n"),
					pythonGlobals,
					currentPriority,
					actions,
					context
				)

				actions = {}
				context = null
				if (snippet !== null) {
					return ["snippet", [snippet]]
				}
			}

			currentLineNumber++
		}
	}
}

class UltiSnipsSettingTab extends PluginSettingTab {
	plugin: UltiSnips

	constructor(app: App, plugin: UltiSnips) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		containerEl.createEl("h2", { text: "UltiSnips settings" })

		new Setting(containerEl)
			.setName("Snippets folder")
			.setDesc("Where are your .snippet files?")
			.addText(text =>
				text
					.setPlaceholder("/path/to/my/snippet/files")
					.setValue(this.plugin.settings.snippetsDir)
					.onChange(async value => {
						this.plugin.settings.snippetsDir = value
						await this.plugin.saveSettings()
						await this.plugin.loadSnippets()
					})
			)
	}
}
