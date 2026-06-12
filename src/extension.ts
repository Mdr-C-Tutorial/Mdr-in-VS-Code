import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CodelensProvider } from './CodelensProvider';
import { exec, execFile } from 'child_process';
import axios from 'axios';
import extract = require('extract-zip');

export function activate(context: vscode.ExtensionContext) {

	const diagnosticCollection = vscode.languages.createDiagnosticCollection('c-runner');
	context.subscriptions.push(diagnosticCollection);
	const diagnosticTimers = new Map<string, NodeJS.Timeout>();
	const gccErrorRegex = /^(.+?):(\d+):(\d+):\s+(?:warning|error):\s+(.+)$/gm;

	const C_COMPILER_OPTIONS = [
		"-fdiagnostics-color=always",
		"-g3",
		"-D_DEBUG",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-pedantic",
		"-pipe",
		"-Wshadow",
		"-Wconversion",
		"-Wfloat-equal",
		"-Wpointer-arith",
		"-Wpointer-compare",
		"-Wcast-align",
		"-Wcast-qual",
		"-Wwrite-strings",
		"-Wimplicit-fallthrough",
		"-Wsequence-point",
		"-Wswitch-default",
		"-Wswitch-enum",
		"-Wtautological-compare",
		"-Wdangling-else",
		"-Wmisleading-indentation",
		"-std=c23",
		"-lm", "-lpthread",
		"-finput-charset=UTF-8",
		"-fexec-charset=UTF-8"
	];

	const CPP_COMPILER_OPTIONS = [
		"-fdiagnostics-color=always", "-g3", "-D_DEBUG", "-Wall", "-Wextra",
		"-Werror", "-pedantic", "-pipe", "-Wshadow", "-Wconversion", "-Wfloat-equal",
		"-Wpointer-arith", "-Wpointer-compare", "-Wcast-align", "-Wcast-qual",
		"-Wwrite-strings", "-Wimplicit-fallthrough", "-Wsequence-point",
		"-Wswitch-default", "-Wswitch-enum", "-Wtautological-compare",
		"-Wdangling-else", "-Wmisleading-indentation",
		"-Wnon-virtual-dtor", "-Woverloaded-virtual",
		"-std=c++23",
		"-lm", "-lpthread",
		"-finput-charset=UTF-8",
		"-fexec-charset=UTF-8"
	];

	const COMPILER_DOWNLOAD_URL = 'https://github.com/brechtsanders/winlibs_mingw/releases/download/15.2.0posix-13.0.0-ucrt-r1/winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r1.zip';
	
	const storagePath = context.globalStorageUri.fsPath;
	const compilerInstallDir = path.join(storagePath, 'mingw64');
	const gccExecutablePath = path.join(compilerInstallDir, 'bin', 'gcc.exe');
	const gppExecutablePath = path.join(compilerInstallDir, 'bin', 'g++.exe');

	function getLanguageConfig(document: vscode.TextDocument) {
		if (document.languageId === 'cpp') {
			return {
				compilerPath: gppExecutablePath,
				options: CPP_COMPILER_OPTIONS,
				compilerName: "g++"
			};
		}
		// 默认为 C
		return {
			compilerPath: gccExecutablePath,
			options: C_COMPILER_OPTIONS,
			compilerName: "gcc"
		};
	}

	function isSupportedDocument(document: vscode.TextDocument) {
		return document.languageId === 'c' || document.languageId === 'cpp';
	}

	function getTempDiagnosticPath(document: vscode.TextDocument) {
		const parsedPath = path.parse(document.uri.fsPath);
		const tempName = `${parsedPath.name}.mdr-diagnostic-${process.pid}-${Date.now()}${parsedPath.ext}`;
		return path.join(parsedPath.dir || os.tmpdir(), tempName);
	}

	function compileAndDiagnose(document: vscode.TextDocument) {
		const config = getLanguageConfig(document);
		if (!fs.existsSync(config.compilerPath)) {
			diagnosticCollection.delete(document.uri);
			return;
		}

		const documentVersion = document.version;
		const tempSourcePath = getTempDiagnosticPath(document);
		fs.writeFile(tempSourcePath, document.getText(), { encoding: 'utf8' }, writeError => {
			if (writeError) {
				return;
			}

			const backgroundCompileOptions = config.options.filter(opt => opt !== '-fdiagnostics-color=always');
			const compileArgs = [tempSourcePath, '-fsyntax-only', ...backgroundCompileOptions];

			execFile(config.compilerPath, compileArgs, (_error, _stdout, stderr) => {
				fs.unlink(tempSourcePath, () => { });
				if (document.isClosed || document.version !== documentVersion) {
					return;
				}
				const diagnostics: vscode.Diagnostic[] = [];
				let match;
				gccErrorRegex.lastIndex = 0;
				while ((match = gccErrorRegex.exec(stderr)) !== null) {
					const [, , lineStr, columnStr, message] = match;
					const line = parseInt(lineStr, 10) - 1;
					const column = parseInt(columnStr, 10) - 1;
					const range = new vscode.Range(line, column, line, 1000);
					const severity = /error:/.test(match[0]) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
					const diagnostic = new vscode.Diagnostic(range, message, severity);
					diagnostics.push(diagnostic);
				}
				diagnosticCollection.set(document.uri, diagnostics);
			});
		});
	}

	function scheduleDiagnostics(document: vscode.TextDocument, delay = 300) {
		if (!isSupportedDocument(document) || document.uri.scheme !== 'file') {
			return;
		}

		const timerKey = document.uri.toString();
		const existingTimer = diagnosticTimers.get(timerKey);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			diagnosticTimers.delete(timerKey);
			compileAndDiagnose(document);
		}, delay);
		diagnosticTimers.set(timerKey, timer);
	}

	const onChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
		scheduleDiagnostics(event.document);
	});

	const onSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
		scheduleDiagnostics(document, 0);
	});

	const onCloseListener = vscode.workspace.onDidCloseTextDocument(document => {
		const timerKey = document.uri.toString();
		const existingTimer = diagnosticTimers.get(timerKey);
		if (existingTimer) {
			clearTimeout(existingTimer);
			diagnosticTimers.delete(timerKey);
		}
		diagnosticCollection.delete(document.uri);
	});

	vscode.workspace.textDocuments.forEach(document => scheduleDiagnostics(document, 0));

	context.subscriptions.push(onChangeListener, onSaveListener, onCloseListener);

	const codelensProvider = new CodelensProvider();
	vscode.languages.registerCodeLensProvider(['c', 'cpp'], codelensProvider);

	const disposableRun = vscode.commands.registerCommand('c-runner.run', async (fileUri: vscode.Uri) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.fsPath !== fileUri.fsPath) {
			return;
		}
		const config = getLanguageConfig(editor.document);
		if (!fs.existsSync(config.compilerPath)) {
			const selection = await vscode.window.showErrorMessage(
				'未找到编译器。请选择操作：',
				{ modal: true },
				'立即下载',
				'查看手动放置指南'
			);
			if (selection === '立即下载') {
				vscode.commands.executeCommand('c-runner.downloadCompiler');
			}
			if (selection === '查看手动放置指南') {
				vscode.commands.executeCommand('c-runner.showPath');
			}
			return;
		}
		await editor.document.save();

		const terminal = vscode.window.createTerminal(`Mdr Runner`);
		terminal.show();

		terminal.sendText("[System.Console]::InputEncoding = [System.Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(65001)");

		const filePath = fileUri.fsPath;
		const parsedPath = path.parse(filePath);
		const executablePath = path.join(parsedPath.dir, `${parsedPath.name}.exe`);
		const compileCommand = `"${config.compilerPath}" "${filePath}" -o "${executablePath}" ${config.options.join(' ')}`;
		const compilerBinDir = path.dirname(config.compilerPath);
		const runCommand = `cd /d "${parsedPath.dir}" && "${executablePath}"`;
		const commandForCmd = `${compileCommand} && ${runCommand}`;
		if (editor.document.languageId === "cpp") {
			const pathCommand = `$env:PATH = "${compilerBinDir};$env:PATH"`;
			terminal.sendText(pathCommand);
		}
		const finalCommand = `cmd /c "${commandForCmd}"`;
		terminal.sendText(finalCommand);
	});

	const disposableDownload = vscode.commands.registerCommand('c-runner.downloadCompiler', async () => {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "正在下载 C/C++ 编译器 (MinGW-w64)",
			cancellable: true
		}, async (progress, token) => {
			if (!fs.existsSync(storagePath)) {
				fs.mkdirSync(storagePath, { recursive: true });
			}
			const zipPath = path.join(storagePath, 'compiler.zip');
			token.onCancellationRequested(() => { vscode.window.showInformationMessage("下载已取消。"); });
			try {
				progress.report({ message: "正在连接...", increment: 5 });
				const response = await axios({ method: 'get', url: COMPILER_DOWNLOAD_URL, responseType: 'stream' });
				const totalLength = response.headers['content-length'];
				let downloadedLength = 0;
				const writer = fs.createWriteStream(zipPath);
				response.data.on('data', (chunk: Buffer) => {
					downloadedLength += chunk.length;
					if (totalLength) {
						const percentage = Math.round((downloadedLength / totalLength) * 100);
						progress.report({ message: `已下载 ${percentage}%` });
					}
				});
				response.data.pipe(writer);
				await new Promise<void>((resolve, reject) => {
					writer.on('finish', resolve);
					writer.on('error', reject);
				});
				progress.report({ message: "下载完成，正在解压..." });
				await extract(zipPath, { dir: storagePath });
				progress.report({ message: "正在清理临时文件..." });
				fs.unlinkSync(zipPath);
				progress.report({ message: "安装完成!" });
				vscode.window.showInformationMessage('编译器已成功安装！');
			} catch (error) {
				vscode.window.showErrorMessage(`编译器下载或解压失败: ${error}`);
				if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); }
			}
		});
	});

	const disposableShowPath = vscode.commands.registerCommand('c-runner.showPath', () => {
		vscode.window.showInformationMessage(`请将 mingw64 文件夹放入此目录: ${storagePath}`, { modal: true });
	});

	context.subscriptions.push(disposableRun, disposableDownload, disposableShowPath);
}

export function deactivate() { }
