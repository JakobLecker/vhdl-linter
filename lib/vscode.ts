import * as path from 'path';
import { workspace, ExtensionContext, commands } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient';
import { copy, CopyTypes } from './vhdl-entity-converter';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  // The server is implemented in node
  let serverModule = require.resolve('./language-server');
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  let serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [{ scheme: 'file', language: 'vhdl' }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    }
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'VhdlLinter',
    'VhdlLinter',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();
  context.subscriptions.push(commands.registerCommand('vhdl-linter:copy-as-instance', () => copy(CopyTypes.Instance)));
  context.subscriptions.push(commands.registerCommand('vhdl-linter:copy-as-sysverilog', () => copy(CopyTypes.Sysverilog)));
  context.subscriptions.push(commands.registerCommand('vhdl-linter:copy-as-signals', () => copy(CopyTypes.Signals)));
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}