import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Vault } from 'obsidian';
import { simpleGit, SimpleGit, CleanOptions, SimpleGitOptions } from 'simple-git';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';

let simpleGitOptions: Partial<SimpleGitOptions>;
let git: SimpleGit;


interface GHSyncSettings {
	ghUsername: string;
	ghPersonalAccessToken: string;
	ghRepoUrl: string;
	gitLocation: string;
	syncinterval: number;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	ghUsername: '',
	ghPersonalAccessToken: '',
	ghRepoUrl: '',
	gitLocation: '',
	syncinterval: 0
}


export default class GHSyncPlugin extends Plugin {
	settings: GHSyncSettings;

	async SyncNotes()
	{
		new Notice("Syncing to GitHub remote")

		const USER = this.settings.ghUsername;
		const PAT = this.settings.ghPersonalAccessToken;
		const REPO = this.settings.ghRepoUrl;
		const remote = `https://${USER}:${PAT}@${REPO}`;

		simpleGitOptions = {
			//@ts-ignore
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation,
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		git = simpleGit(simpleGitOptions);

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => { new Notice("Vault is not a Git repo or git binary cannot be found."); return; })
		//@ts-ignore
		let clean = statusResult.isClean();

    	let date = new Date();
    	let msg = hostname + " " + date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate() + ":" + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds();

		// git add .
		// git commit -m hostname-date-time
		if (!clean) {
			try {
				await git
		    		.add("./*")
		    		.commit(msg);
		    } catch (e) {
		    	new Notice(e);
		    	return;
		    }
		} else {
			new Notice("Working branch clean");
		}

		// configure remote
		try {
			await git.removeRemote('origin').catch((e) => { new Notice(e); });
			await git.addRemote('origin', remote).catch((e) => { new Notice(e); });
		}
		catch (e) {
			new Notice(e);
			return;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			new Notice(e + "\nGitHub Sync: Invalid remote URL. Username, PAT, or Repo URL might be incorrect.");
			return;
		}

		new Notice("GitHub Sync: Successfully set remote origin url");


		// git pull origin main
	    try {
	    	//@ts-ignore
	    	await git.pull('origin', 'main', { '--no-rebase': null }, (err, update) => {
	      		if (update) {
					new Notice("GitHub Sync: Pulled " + update.summary.changes + " changes");
	      		}
	   		})
	    } catch (e) {
	    	let conflictStatus = await git.status().catch((e) => { new Notice(e); return; });
	    	let conflictMsg = "Merge conflicts in:";
	    	//@ts-ignore
			for (let c of conflictStatus.conflicted)
			{
				conflictMsg += "\n\t"+c;
			}
			conflictMsg += "\nResolve them or click sync button again to push with unresolved conflicts."
			new Notice(conflictMsg)
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
		    	git.push('origin', 'main');
		    	new Notice("GitHub Sync: Pushed on " + msg);
		    } catch (e) {
		    	new Notice(e);
			}
	    }
	}


	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

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
					new Notice("Auto sync enabled");
				} catch (e) {
					
				}
			}
		}

		// check status
		try {
			const USER = this.settings.ghUsername;
			const PAT = this.settings.ghPersonalAccessToken;
			const REPO = this.settings.ghRepoUrl;
			const remote = `https://${USER}:${PAT}@${REPO}`;

			simpleGitOptions = {
				//@ts-ignore
			    baseDir: this.app.vault.adapter.getBasePath(),
			    binary: this.settings.gitLocation,
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			};
			git = simpleGit(simpleGitOptions);

			//check for remote changes
			let branchresult = await git.branch();
			let currentbranchname = branchresult.current;
			// git branch --set-upstream-to=origin/main main
			await git.branch({'--set-upstream-to': 'origin/'+currentbranchname});
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				new Notice("GitHub Sync: " + statusUponOpening.behind + " commits behind remote branch.\nClick the GitHub ribbon icon to sync.")
			}
		} catch (e) {
			// don't care
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

		new Setting(containerEl)
			.setName('GitHub username')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.ghUsername)
				.onChange(async (value) => {
					this.plugin.settings.ghUsername = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub personal access token')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('ghp_XXXXXXXXXXXXXXXXXXXXXXXX')
				.setValue(this.plugin.settings.ghPersonalAccessToken)
				.onChange(async (value) => {
					this.plugin.settings.ghPersonalAccessToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub repo URL for this vault')
			.setDesc('In this format: "github.com/username/repo"')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.ghRepoUrl)
				.onChange(async (value) => {
					this.plugin.settings.ghRepoUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('git binary location (optional)')
			.setDesc('If git is not findable via your system PATH, then provide its directory here')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval (optional)')
			.setDesc('Set a positive integer minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
