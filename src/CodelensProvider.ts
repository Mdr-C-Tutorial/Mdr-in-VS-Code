import * as vscode from 'vscode';

/**
 * 这个类负责在代码中找到 main 函数，并在它旁边提供一个可点击的 "运行" 按钮。
 */
export class CodelensProvider implements vscode.CodeLensProvider {

    // 正则表达式，用于匹配 "int main(" 或 "int main ()"
    private regex: RegExp;

    constructor() {
        this.regex = /int\s+main\s*\(/g;
    }

    /**
     * VS Code 会调用这个方法来获取需要在文档中显示的 CodeLens 对象。
     */
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const regex = new RegExp(this.regex);
        const text = document.getText();
        let matches;

        // 遍历文件中所有匹配项
        while ((matches = regex.exec(text)) !== null) {
            const line = document.lineAt(document.positionAt(matches.index).line);
            const position = new vscode.Position(line.lineNumber, 0);
            const range = new vscode.Range(position, position);

            if (range) {
                // 创建一个命令对象，当用户点击 CodeLens 时执行 'c-runner.run' 命令
                const command = {
                    title: "▶ Mdr！",
                    command: "c-runner.run",
                    arguments: [document.uri] // 将当前文件的URI作为参数传给命令
                };
                codeLenses.push(new vscode.CodeLens(range, command));
            }
        }
        return codeLenses;
    }
}