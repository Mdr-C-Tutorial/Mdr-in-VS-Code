import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodelensProvider } from './CodelensProvider';
import { exec } from 'child_process';

// 引入依赖库
import axios from 'axios';
import extract = require('extract-zip');

/**
 * 当你的扩展被激活时，这个方法会被调用。
 */
export function activate(context: vscode.ExtensionContext) {

	const diagnosticCollection = vscode.languages.createDiagnosticCollection('c-runner');
	context.subscriptions.push(diagnosticCollection);
	const gccErrorRegex = /^(.+?):(\d+):(\d+):\s+(?:warning|error):\s+(.+)$/gm;
	// 1. 定义编译器和编译选项 (硬编码)
	const COMPILER_OPTIONS = [
		// 调试与宏定义
		"-g3",              // 包含最详细的调试信息
		"-D_DEBUG",         // 定义 _DEBUG 宏, 常用于开启 assert() 等调试代码

		// 核心警告与严格模式
		"-Wall",            // 开启大部分常用警告
		"-Wextra",          // 开启 Wall 未覆盖的额外警告
		"-Werror",          // 将所有警告视为错误
		"-pedantic",        // 严格遵循C标准，禁用编译器扩展语法

		// 优化与性能
		"-pipe",            // 在编译的不同阶段间使用管道而非临时文件，加快编译速度

		// 更具体的、非常有用的警告选项
		"-Wshadow",         // 警告变量遮蔽 (您写的 -Wshadow-all 不是标准选项, -Wshadow 已能覆盖大部分情况)
		"-Wconversion",     // 警告可能导致信息丢失的隐式类型转换
		"-Wfloat-equal",    // 警告直接使用 == 或 != 比较浮点数
		"-Wpointer-arith",  // 警告在函数指针上进行算术运算等非法操作
		"-Wpointer-compare",// 警告比较不同类型的指针
		"-Wcast-align",     // 警告可能导致对齐问题的指针类型转换
		"-Wcast-qual",      // 警告移除 const/volatile 限定符的类型转换
		"-Wwrite-strings",  // 将字符串字面量视为 const char* 类型，防止意外修改
		"-Wimplicit-fallthrough", // 警告 switch 语句中没有 break 的 case
		"-Wsequence-point", // 警告违反序列点规则的代码 (如 i = i++;)
		"-Wswitch-default", // 警告 switch 语句没有 default 分支
		"-Wswitch-enum",    // 警告 switch 的变量是枚举类型，但没有处理所有枚举值
		"-Wtautological-compare", // 警告总是为真或为假的比较 (如 x <= x)
		"-Wdangling-else",  // 警告悬垂的 else 问题
		"-Wmisleading-indentation",     // 警告会产生误导的缩进
	]

	const COMPILER_DOWNLOAD_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/220996547/69279c65-efb8-471d-87d0-d3f50ffeb73d?sp=r&sv=2018-11-09&sr=b&spr=https&se=2025-08-18T14%3A38%3A54Z&rscd=attachment%3B+filename%3Dwinlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64msvcrt-13.0.0-r1.zip&rsct=application%2Foctet-stream&skoid=96c2d410-5711-43a1-aedd-ab1947aa7ab0&sktid=398a6654-997b-47e9-b12b-9515b896b4de&skt=2025-08-18T13%3A38%3A10Z&ske=2025-08-18T14%3A38%3A54Z&sks=b&skv=2018-11-09&sig=aW8pJnctOv3vcLXHFLINVSnm4CpGLaG8aWaGpi8MeaU%3D&jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmVsZWFzZS1hc3NldHMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwia2V5Ijoia2V5MSIsImV4cCI6MTc1NTUyNTQ3MiwibmJmIjoxNzU1NTI1MTcyLCJwYXRoIjoicmVsZWFzZWFzc2V0cHJvZHVjdGlvbi5ibG9iLmNvcmUud2luZG93cy5uZXQifQ.yjifAz1Dpakg6LNUhjImnrdwR7U3ZpkT-ou22m7Ww-Q&response-content-disposition=attachment%3B%20filename%3Dwinlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64msvcrt-13.0.0-r1.zip&response-content-type=application%2Foctet-stream';

	// 扩展的私有存储路径，用于存放编译器
	const storagePath = context.globalStorageUri.fsPath;
	const compilerInstallDir = path.join(storagePath, 'mingw64');
	const gccExecutablePath = path.join(compilerInstallDir, 'bin', 'gcc.exe');


	async function compileAndDiagnose(document: vscode.TextDocument): Promise<boolean> {
		return new Promise((resolve) => {
			// 只处理C语言文件
			if (document.languageId !== 'c') {
				return resolve(false);
			}

			// 前置检查 (编译器是否存在)
			if (!fs.existsSync(gccExecutablePath)) {
				// ... (可以添加提示) ...
				return resolve(false);
			}

			diagnosticCollection.set(document.uri, []); // 清空旧诊断

			const filePath = document.uri.fsPath;
			const parsedPath = path.parse(filePath);
			const executableName = `${parsedPath.name}.exe`;
			const executablePath = path.join(parsedPath.dir, executableName);

			const compileCommand = `"${gccExecutablePath}" "${filePath}" -o "${executablePath}" ${COMPILER_OPTIONS.join(' ')}`;

			exec(compileCommand, (error, stdout, stderr) => {
				if (error) {
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
					resolve(false); // 编译失败
				} else {
					diagnosticCollection.set(document.uri, []); // 编译成功，清空诊断
					resolve(true); // 编译成功
				}
			});
		});
	}

	// ======================================================================
	// --- 2. 新增：监听文件保存事件 ---
	// ======================================================================
	const onSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
		// 当任何文件被保存时，自动调用我们的编译诊断函数
		compileAndDiagnose(document);
	});
	context.subscriptions.push(onSaveListener);


	const codelensProvider = new CodelensProvider();
	vscode.languages.registerCodeLensProvider({ language: 'c' }, codelensProvider);

	// ======================================================================
	// --- 3. 修改："运行"命令现在也使用上面的可复用函数 ---
	// ======================================================================
	const disposableRun = vscode.commands.registerCommand('c-runner.run', async (fileUri: vscode.Uri) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.fsPath !== fileUri.fsPath) {
			vscode.window.showErrorMessage("请先激活要运行的C文件编辑器。");
			return;
		}

		const document = editor.document;

		// 第一步：先调用编译函数
		const success = await compileAndDiagnose(document);

		// 第二步：只有在编译成功后，才执行程序
		if (success) {
			vscode.window.showInformationMessage('编译成功！正在运行...');

			const terminal = vscode.window.createTerminal(`C Runner`);
			terminal.show();

			const parsedPath = path.parse(document.uri.fsPath);
			const executablePath = path.join(parsedPath.dir, `${parsedPath.name}.exe`);

			const runCommand = `cd /d "${parsedPath.dir}" && "${executablePath}"`;
			const finalCommand = `cmd /c "${runCommand}"`;
			terminal.sendText(finalCommand);
		} else {
			vscode.window.showErrorMessage('编译失败！请修复代码中的问题后重试。');
		}
	});


	// 4. 注册 "下载编译器" 命令
	// -----------------------------------------------------------------
	const disposableDownload = vscode.commands.registerCommand('c-runner.downloadCompiler', async () => {
		// 使用带进度的通知，提升用户体验
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "正在下载 C/C++ 编译器 (MinGW-w64)",
			cancellable: true
		}, async (progress, token) => {
			if (!fs.existsSync(storagePath)) {
				fs.mkdirSync(storagePath, { recursive: true });
			}
			const zipPath = path.join(storagePath, 'compiler.zip');

			token.onCancellationRequested(() => {
				vscode.window.showInformationMessage("下载已取消。");
			});

			try {
				// 下载
				progress.report({ message: "正在连接...", increment: 5 });
				const response = await axios({
					method: 'get',
					url: COMPILER_DOWNLOAD_URL,
					responseType: 'stream'
				});

				const totalLength = response.headers['content-length'];
				let downloadedLength = 0;

				const writer = fs.createWriteStream(zipPath);
				response.data.on('data', (chunk: Buffer) => {
					downloadedLength += chunk.length;
					if (totalLength) {
						const percentage = Math.round((downloadedLength / totalLength) * 100);
						progress.report({ message: `已下载 ${percentage}%`, increment: percentage - (progress as any).value });
						(progress as any).value = percentage;
					}
				});
				response.data.pipe(writer);

				await new Promise<void>((resolve, reject) => {
					writer.on('finish', resolve);
					writer.on('error', reject);
				});

				// 解压
				progress.report({ message: "下载完成，正在解压...", increment: 90 });
				await extract(zipPath, { dir: storagePath });

				// 清理
				progress.report({ message: "正在清理临时文件...", increment: 98 });
				fs.unlinkSync(zipPath);

				progress.report({ message: "安装完成!", increment: 100 });
				vscode.window.showInformationMessage('编译器已成功安装！现在可以点击 `main` 函数旁的 "▶ 运行" 按钮了。');

			} catch (error) {
				vscode.window.showErrorMessage(`编译器下载或解压失败: ${error}`);
				if (fs.existsSync(zipPath)) {
					fs.unlinkSync(zipPath); // 清理失败的下载文件
				}
			}
		});
	});

	// 将命令添加到订阅中，以便在扩展停用时释放资源
	context.subscriptions.push(disposableRun, disposableDownload);
}

/**
 * 当你的扩展被停用时，这个方法会被调用。
 */
export function deactivate() { }