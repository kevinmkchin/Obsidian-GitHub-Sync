import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { simpleGit, SimpleGit, CleanOptions } from 'simple-git';

var simpleGitOptions: Partial<SimpleGitOptions>;
var git: SimpleGit;


interface GHSyncSettings {
	ghPersonalAccessToken: string;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	ghUsername: '',
	ghPersonalAccessToken: '',
	ghRepoUrl: '',
	gitLocation: ''
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
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation,
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		git = simpleGit(simpleGitOptions);

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => { new Notice("Vault is not a Git repo or git binary cannot be found."); return; })
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
	    	await git.pull('origin', 'main', (err, update) => {
	      		if (update) {
					new Notice("GitHub Sync: Pulled " + update.summary.changes + " changes");
	      		}
	   		})
	    } catch (e) {
	    	let conflictStatus = await git.status().catch((e) => { new Notice("Somethings fucked."); return; });
	    	let conflictMsg = "Merge conflicts in:";
			for (let c of conflictStatus.conflicted)
			{
				conflictMsg += "\n\t"+c;
			}
			conflictMsg += "\nResolve them or click sync button again to push with unresolved conflicts."
			new Notice(conflictMsg)
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

		// check status
		try {
			const USER = this.settings.ghUsername;
			const PAT = this.settings.ghPersonalAccessToken;
			const REPO = this.settings.ghRepoUrl;
			const remote = `https://${USER}:${PAT}@${REPO}`;

			simpleGitOptions = {
			    baseDir: this.app.vault.adapter.getBasePath(),
			    binary: this.settings.gitLocation,
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			};
			git = simpleGit(simpleGitOptions);

			//check for remote changes
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				new Notice("GitHub Sync: " + statusUponOpening.behind + " commits behind remote branch.\nClick the GitHub ribbon icon to sync.")
			}
		} catch (e) {
			// don't care
			new Notice(e)
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
			.setName('GitHub Username')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.ghUsername)
				.onChange(async (value) => {
					this.plugin.settings.ghUsername = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub Personal Access Token')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('ghp_XXXXXXXXXXXXXXXXXXXXXXXX')
				.setValue(this.plugin.settings.ghPersonalAccessToken)
				.onChange(async (value) => {
					this.plugin.settings.ghPersonalAccessToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub Repo URL for this Vault')
			.setDesc('In this format: "github.com/username/repo"')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.ghRepoUrl)
				.onChange(async (value) => {
					this.plugin.settings.ghRepoUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('git Binary Location (Optional)')
			.setDesc('If git is not findable via your system PATH, then provide its directory here')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				}));
	}
}
