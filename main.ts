import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Vault } from 'obsidian';
import { simpleGit, SimpleGit, CleanOptions, SimpleGitOptions, StatusResult, DiffResult } from 'simple-git';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';

let simpleGitOptions: Partial<SimpleGitOptions>;
let git: SimpleGit;

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
}


export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private formatDiffFiles(diff: DiffResult | undefined): string[] {
		if (!diff) {
			return [];
		}
		return diff.files.map((f) => {
			const stats = 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)";
			return f.file + stats;
		});
	}

	private showSyncSuccessNotice(pushed?: DiffResult, pulled?: DiffResult): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		const maxListed = 5;
		const lines: string[] = ['github sync successful'];
		const section = (arrow: string, label: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			lines.push(arrow + " " + files.length + " " + label);
			for (const f of files.slice(0, maxListed)) {
				lines.push("\t" + f);
			}
			if (files.length > maxListed) {
				lines.push("\t... and " + (files.length - maxListed) + " more");
			}
		};
		section("\u2191", "pushed", this.formatDiffFiles(pushed));
		section("\u2193", "pulled", this.formatDiffFiles(pulled));

		this.showNotice(lines.join("\n"), 'INFO', lines.length > 1 ? 8000 : undefined);
	}

	private buildCommitMessage(status: StatusResult, diff: DiffResult | undefined, hostname: string): string[] {
		const entries: string[] = [];
		const counts: string[] = [];

		const stats = new Map<string, string>();
		for (const f of diff?.files ?? []) {
			stats.set(f.file, 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)");
		}

		const add = (label: string, code: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			counts.push(files.length + " " + label);
			for (const f of files) {
				entries.push(code + " " + f + (stats.get(f) ?? ""));
			}
		};

		const renamed = status.renamed.map((r) => r.from + " -> " + r.to);
		const created = Array.from(new Set([...status.created, ...status.not_added]));
		add("added", "A", created);
		add("modified", "M", status.modified);
		add("deleted", "D", status.deleted);
		add("renamed", "R", renamed);

		const total = diff ? " +" + diff.insertions + " -" + diff.deletions : "";
		const subject = "vault: sync from " + hostname + (counts.length > 0 ? " (" + counts.join(", ") + total + ")" : "");

		const maxListed = 30;
		const body = entries.slice(0, maxListed);
		if (entries.length > maxListed) {
			body.push("... and " + (entries.length - maxListed) + " more");
		}

		return body.length > 0 ? [subject, body.join("\n")] : [subject];
	}

	async SyncNotes()
	{
		const remote = this.settings.remoteURL.trim();

		simpleGitOptions = {
			//@ts-ignore
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation + "git",
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		git = simpleGit(simpleGitOptions);

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return; })

		if (!statusResult) {
			return;
		}

		//@ts-ignore
		let clean = statusResult.isClean();

		let pushedDiff: DiffResult | undefined;

		// git add .
		// git commit -m "vault: sync from <hostname> (<summary>)" -m "<file list>"
		if (!clean) {
			try {
				await git.add("./*");
				pushedDiff = await git.diffSummary(['--cached']).catch(() => undefined);
				await git.commit(this.buildCommitMessage(statusResult, pushedDiff, hostname));
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
		    }
		}

		// configure remote
		try {
			await git.removeRemote('origin').catch((e) => { this.showNotice(e, 'ERROR', 10000); });
			await git.addRemote('origin', remote).catch((e) => { this.showNotice(e, 'ERROR', 10000); });
		}
		catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			this.showNotice(String(e) + "\nGitHub Sync: Invalid remote URL.", 'ERROR', 10000);
			return;
		}

		// remote changes about to be pulled (merge-base..origin/main)
		const pulledDiff = await git.diffSummary(['HEAD...origin/main']).catch(() => undefined);

		// git pull --rebase origin main (linear history, no merge commits)
		// on rebase conflict: abort, then retry as a merge so conflicts can be resolved as before
	    try {
	    	try {
	    		await git.pull('origin', 'main', { '--rebase': null });
	    	} catch (rebaseError) {
	    		await git.rebase(['--abort']).catch(() => {});
	    		await git.pull('origin', 'main', { '--no-rebase': null });
	    	}
	    } catch (e) {
	    	let conflictStatus = await git.status().catch((error) => { this.showNotice(error, 'ERROR', 10000); return; });
	    	if (!conflictStatus) {
	    		return;
	    	}
    		let conflictMsg = "Merge conflicts in:";
	    	//@ts-ignore
			for (let c of conflictStatus.conflicted)
			{
				conflictMsg += "\n\t"+c;
			}
			conflictMsg += "\nResolve them or click sync button again to push with unresolved conflicts."
			this.showNotice(conflictMsg, 'WARNING');
			//@ts-ignore	
			for (let c of conflictStatus.conflicted)
			{
				this.app.workspace.openLinkText("", c, true);
			}
	    	return;
	    }

		// resolve merge conflicts
		// git push origin main
	    if (!clean) {
		    try {
		    	await git.push('origin', 'main', ['-u']);
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
			}
	    }

		this.showSyncSuccessNotice(clean ? undefined : pushedDiff, pulledDiff);
	}

	async CheckStatusOnStart()
	{
		// check status
		try {
			simpleGitOptions = {
				//@ts-ignore
			    baseDir: this.app.vault.adapter.getBasePath(),
			    binary: this.settings.gitLocation + "git",
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			};
			git = simpleGit(simpleGitOptions);

			//check for remote changes
			// git branch --set-upstream-to=origin/main main
			await git.branch({'--set-upstream-to': 'origin/main'});
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				// Automatically sync if needed
				if (this.settings.isSyncOnLoad == true)
				{
					this.SyncNotes();
				}
				else
				{
					this.showNotice("GitHub Sync: " + statusUponOpening.behind + " commits behind remote.\nClick the GitHub ribbon icon to sync.", 'WARNING');
				}
			}
			else
			{
				this.showNotice("GitHub Sync: up to date with remote.", 'INFO');
			}
		} catch (e) {
			// don't care
			// based
		}
	}

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => {
				this.SyncNotes();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			let interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				try {
					setIntervalAsync(async () => {
						await this.SyncNotes();
					}, interval * 60 * 1000);
					//this.registerInterval(setInterval(this.SyncNotes, interval * 6 * 1000));
					this.showNotice("Auto sync enabled", 'INFO');
				} catch (e) {
					
				}
			}
		}

		if (this.settings.checkStatusOnLoad)
		{
			this.CheckStatusOnStart();
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Grab your GitHub repository's HTTPS or SSH url and paste it into the settings here. If you're not authenticated, the first sync with this plugin should prompt you to authenticate. If you've already setup SSH on your device with GitHub, you won't need to authenticate - just paste your repo's SSH url into the settings here.", cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/kevinmkchin/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('git binary location')
			.setDesc('This is optional! Set this only if git is not findable via your system PATH, then provide its location here. See README for more info.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which GitHub Sync notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check to see if you are behind remote when you start Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync with remote when you start Obsidian if there are unsynced changes.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval')
			.setDesc('Set minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
