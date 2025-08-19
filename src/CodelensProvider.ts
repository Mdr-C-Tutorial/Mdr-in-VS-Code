import * as vscode from 'vscode';

export class CodelensProvider implements vscode.CodeLensProvider {

    private regex: RegExp;

    constructor() {
        this.regex = /int\s+main\s*\(/g;
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const regex = new RegExp(this.regex);
        const text = document.getText();
        let matches;

        while ((matches = regex.exec(text)) !== null) {
            const line = document.lineAt(document.positionAt(matches.index).line);
            const position = new vscode.Position(line.lineNumber, 0);
            const range = new vscode.Range(position, position);

            if (range) {
                const command = {
                    title: "▶ Mdr！",
                    command: "c-runner.run",
                    arguments: [document.uri]
                };
                codeLenses.push(new vscode.CodeLens(range, command));
            }
        }
        return codeLenses;
    }
}