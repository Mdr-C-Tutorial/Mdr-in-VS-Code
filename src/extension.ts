import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodelensProvider } from './CodelensProvider';
import { exec } from 'child_process';
import axios from 'axios';
import extract = require('extract-zip');

export function activate(context: vscode.ExtensionContext) {

	const diagnosticCollection = vscode.languages.createDiagnosticCollection('c-runner');
	context.subscriptions.push(diagnosticCollection);
	const gccErrorRegex = /^(.+?):(\d+):(\d+):\s+(?:warning|error):\s+(.+)$/gm;

	const COMPILER_OPTIONS = [
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
		"-std=c23"
	];

	const COMPILER_DOWNLOAD_URL = 'https://github.com/brechtsanders/winlibs_mingw/releases/download/15.2.0posix-13.0.0-msvcrt-r1/winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64msvcrt-13.0.0-r1.zip';

	const storagePath = context.globalStorageUri.fsPath;
	const compilerInstallDir = path.join(storagePath, 'mingw64');
	const gccExecutablePath = path.join(compilerInstallDir, 'bin', 'gcc.exe');


	function compileAndDiagnoseOnSave(document: vscode.TextDocument) {
		if (document.languageId !== 'c' || !fs.existsSync(gccExecutablePath)) {
			return;
		}

		const backgroundCompileOptions = COMPILER_OPTIONS.filter(opt => opt !== '-fdiagnostics-color=always');
		const compileCommand = `"${gccExecutablePath}" "${document.uri.fsPath}" -fsyntax-only ${backgroundCompileOptions.join(' ')}`;

		exec(compileCommand, (error, stdout, stderr) => {
			diagnosticCollection.set(document.uri, []); // 先清空旧的诊断信息
			if (error || stderr) {
				const diagnostics: vscode.Diagnostic[] = [];
				let match;
				while ((match = gccErrorRegex.exec(stderr)) !== null) {
					const [, , lineStr, columnStr, message] = match;
					const line = parseInt(lineStr, 10) - 1;
					const column = parseInt(columnStr, 10) - 1;
					const range = new vscode.Range(line, column, line, 1000); // 标记到行尾
					const severity = /error:/.test(match[0]) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
					const diagnostic = new vscode.Diagnostic(range, message, severity);
					diagnostics.push(diagnostic);
				}
				diagnosticCollection.set(document.uri, diagnostics);
			}
		});
	}

	const onSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
		compileAndDiagnoseOnSave(document);
	});
	context.subscriptions.push(onSaveListener);

	const codelensProvider = new CodelensProvider();
	vscode.languages.registerCodeLensProvider({ language: 'c' }, codelensProvider);

	const disposableRun = vscode.commands.registerCommand('c-runner.run', async (fileUri: vscode.Uri) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.fsPath !== fileUri.fsPath) {
			return;
		}
		if (!fs.existsSync(gccExecutablePath)) {
			const selection = await vscode.window.showErrorMessage(
				'未找到C编译器。请选择操作：',
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
			return; // 终止本次运行
		}
		await editor.document.save();

		const terminal = vscode.window.createTerminal(`Mdr Runner`);
		terminal.show();

		const filePath = fileUri.fsPath;
		const parsedPath = path.parse(filePath);
		const executablePath = path.join(parsedPath.dir, `${parsedPath.name}.exe`);
		const compileCommand = `"${gccExecutablePath}" "${filePath}" -o "${executablePath}" ${COMPILER_OPTIONS.join(' ')}`;
		const runCommand = `cd /d "${parsedPath.dir}" && "${executablePath}"`;
		const commandForCmd = `${compileCommand} && ${runCommand}`;
		const finalCommand = `cmd /c "${commandForCmd}"`
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