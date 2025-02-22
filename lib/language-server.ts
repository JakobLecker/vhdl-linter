import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  CodeAction, createConnection, DidChangeConfigurationNotification, ErrorCodes, InitializeParams, LSPErrorCodes, Position, ProposedFeatures, ResponseError, TextDocuments, TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { getCompletions } from './languageFeatures/completion';
import { handleDocumentFormatting } from './languageFeatures/documentFormatting';
import { documentHighlightHandler } from './languageFeatures/documentHighlightHandler';
import { DocumentSymbols } from './languageFeatures/documentSymbol';
import { findDefinitions } from './languageFeatures/findDefinition';
import { findReferencesHandler } from './languageFeatures/findReferencesHandler';
import { foldingHandler } from './languageFeatures/folding';
import { prepareRenameHandler, renameHandler } from './languageFeatures/rename';
import { handleSemanticTokens, semanticTokensLegend } from './languageFeatures/semanticTokens';
import { handleOnWorkspaceSymbol } from './languageFeatures/workspaceSymbols';
import { normalizeUri } from './normalize-uri';
import { OComponent, OFile, OInstantiation, OUseClause } from './parser/objects';
import { ProjectParser } from './project-parser';
import { CancelationError, CancelationObject } from './server-objects';
import { defaultSettings, ISettings } from './settings';
import { VhdlLinter } from './vhdl-linter';

// Create a connection for the server. The connection auto detected protocol
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);


// Create a simple text document manager. The text document manager
// supports full document sync only
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasWorkspaceFolderCapability = false;
// let hasDiagnosticRelatedInformationCapability: boolean = false;
let projectParser: ProjectParser;
let rootUri: string | undefined;




let globalSettings: ISettings = defaultSettings;
let hasConfigurationCapability = false;
// Cache the settings of all open documents
const documentSettings: Map<string, ISettings> = new Map();
connection.onDidChangeConfiguration(change => {

  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ISettings>(
      (change.settings.VhdlLinter || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach((textDocument) => validateTextDocument(textDocument));
});
export async function getDocumentSettings(resource: URL): Promise<ISettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource.toString());
  if (!result) {
    result = await connection.workspace.getConfiguration({
      scopeUri: resource.toString(),
      section: 'VhdlLinter'
    });
  }
  if (!result) {
    return defaultSettings;
  }
  documentSettings.set(resource.toString(), result);
  return result;
}
connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  hasWorkspaceFolderCapability =
    capabilities.workspace?.workspaceFolders ?? false;
  if (params.rootUri) {
    rootUri = params.rootUri;
  }
  hasConfigurationCapability = capabilities.workspace?.configuration ?? false;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      codeActionProvider: true,
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: false
      },
      semanticTokensProvider: {
        legend: semanticTokensLegend,
        range: false,
        full: {
          delta: false
        }
      },

      documentSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      documentFormattingProvider: {
        workDoneProgress: true
      },
      referencesProvider: true,
      foldingRangeProvider: true,
      documentHighlightProvider: true,
      executeCommandProvider: { commands: ['vhdl-linter:lsp-command'] },
      renameProvider: {
        prepareProvider: true
      },
      workspaceSymbolProvider: true,
    }
  };
});
export const initialization = new Promise<void>(resolve => {
  connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
      // Register for all configuration changes.
      connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    const configuration = (await connection.workspace.getConfiguration({
      section: 'VhdlLinter'
    })) as ISettings;

    if (hasWorkspaceFolderCapability) {
      const parseWorkspaces = async () => {
        const workspaceFolders = await connection.workspace.getWorkspaceFolders();
        const folders = (workspaceFolders ?? []).map(workspaceFolder => new URL(workspaceFolder.uri));
        folders.push(...configuration?.paths?.additional?.map(path => pathToFileURL(path))
        .filter(url => existsSync(url)) ?? []);
        projectParser = await ProjectParser.create(folders, configuration?.paths?.ignoreRegex ?? '', getDocumentSettings);
      };
      await parseWorkspaces();
      connection.workspace.onDidChangeWorkspaceFolders(async event => {
        projectParser.addFolders(event.added.map(folder => new URL(folder.uri)));
        connection.console.log('Workspace folder change event received.');
      });
    } else {
      const folders = [];
      if (rootUri) {
        folders.push(new URL(rootUri));
      }
      // console.log('folders', folders);
      projectParser = await ProjectParser.create(folders, configuration.paths.ignoreRegex, getDocumentSettings);
    }
    for (const textDocument of documents.all()) {
      await validateTextDocument(textDocument);
    }
    projectParser.events.on('change', () => {
      // console.log('projectParser.events.change', new Date().getTime(), ... args);
      documents.all().forEach((textDocument) => validateTextDocument(textDocument));
    });
    const timeoutMap = new Map<string, NodeJS.Timeout>();
    const cancelationMap = new Map<string, CancelationObject>();
    documents.onDidChangeContent(change => {
      const oldTimeout = timeoutMap.get(change.document.uri);
      if (oldTimeout !== undefined) {
        clearTimeout(oldTimeout);
      }
      async function handleChange() {
        const cancelationObject = cancelationMap.get(change.document.uri);
        if (cancelationObject) {
          cancelationObject.canceled = true;
        }
        const newCancelationObject = {
          canceled: false
        };
        const vhdlLinter = await validateTextDocument(change.document, newCancelationObject);
        // For some reason the : in the beginning of win pathes comes escaped here.
        const uri = normalizeUri(change.document.uri);
        const cachedFile = process.platform === 'win32'
          ? projectParser.cachedFiles.find(cachedFile => cachedFile.uri.toString().toLowerCase() === uri.toLowerCase())
          : projectParser.cachedFiles.find(cachedFile => cachedFile.uri.toString() === uri);
        cachedFile?.parse(vhdlLinter);
        projectParser.flattenProject();
        cancelationMap.set(change.document.uri, newCancelationObject);
      }
      if (change.document.version === 1) { // Document was initially opened. Do not delay.
        handleChange();
      } else {
        timeoutMap.set(change.document.uri, setTimeout(handleChange, 100));
      }
      // const lintingTime = Date.now() - date;
      // console.log(`${change.document.uri}: ${lintingTime}ms`);

    });
    resolve();
  });
});
documents.onDidClose(change => {
  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
export const linters = new Map<string, VhdlLinter>();
export const lintersValid = new Map<string, boolean>();
async function validateTextDocument(textDocument: TextDocument, cancelationObject: CancelationObject = { canceled: false }): Promise<VhdlLinter> {
  // For some reason the : in the beginning of win pathes comes escaped here.
  const uri = normalizeUri(textDocument.uri);
  const url = new URL(uri);
  const vhdlLinter = new VhdlLinter(url, textDocument.getText(), projectParser, getDocumentSettings, cancelationObject);
  if (vhdlLinter.parsedSuccessfully || typeof linters.get(uri) === 'undefined') {
    linters.set(uri, vhdlLinter);
    lintersValid.set(uri, true);
  } else {
    lintersValid.set(uri, false);
  }
  // console.log(`parsed for: ${Date.now() - start} ms.`);
  // start = Date.now();
  try {
    const diagnostics = await vhdlLinter.checkAll();
    diagnostics.forEach((diag) => diag.source = 'vhdl-linter');
    // console.log(`checked for: ${Date.now() - start} ms.`);
    // start = Date.now();
    // console.profileEnd('a');
    connection.sendDiagnostics({ uri, diagnostics });
    // console.log(`send for: ${Date.now() - start} ms.`);
  } catch (err) {
    // Ignore cancelled
    if (!(err instanceof CancelationError)) {
      throw err;
    }
  }
  return vhdlLinter;

}
async function getLinter(uri: string) {
  await initialization;
  uri = normalizeUri(uri);

  const linter = linters.get(uri);
  // if (lintersValid.get(uri) !== true) {
  //   throw new ResponseError(ErrorCodes.InvalidRequest, 'Document not valid. Renaming only supported for parsable documents.', 'Document not valid. Renaming only supported for parsable documents.');
  // }
  if (typeof linter === 'undefined') {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Parser not ready', 'Parser not ready');
  }
  if (typeof linter.file === 'undefined') {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Parser not ready', 'Parser not ready');
  }
  return linter;
}
connection.onDidChangeWatchedFiles(() => {
  // Monitored files have change in VS Code
  connection.console.log('We received an file change event');
});
connection.onCodeAction(async (params): Promise<CodeAction[]> => {
  const linter = await getLinter(params.textDocument.uri);
  // linter.codeActionEvent.emit()
  const actions = [];
  for (const diagnostic of params.context.diagnostics) {
    if (typeof diagnostic.code === 'number') {
      const callback = linter.diagnosticCodeActionRegistry[diagnostic.code];
      if (typeof callback === 'function') {
        actions.push(...callback(params.textDocument.uri));
      }
    } else if (typeof diagnostic.code === 'string') {
      const codes = diagnostic.code.split(';').map(a => parseInt(a));
      for (const code of codes) {
        const callback = linter.diagnosticCodeActionRegistry[code];
        if (typeof callback === 'function') {
          actions.push(...callback(params.textDocument.uri));
        }

      }
    }
  }
  return actions;
});
connection.onDocumentSymbol(async (params) => {
  const linter = await getLinter(params.textDocument.uri);

  return DocumentSymbols.get(linter);
});
interface IFindDefinitionParams {
  textDocument: {
    uri: string
  };
  position: Position;
}

const findBestDefinition = async (params: IFindDefinitionParams) => {
  const linter = await getLinter(params.textDocument.uri);

  const definitions = await findDefinitions(linter, params.position);
  if (definitions.length === 0) {
    return null;
  }
  return definitions[0];
};

connection.onHover(async (params, token) => {
  await initialization;
  if (token.isCancellationRequested) {
    console.log('hover canceled');
    return new ResponseError(LSPErrorCodes.RequestCancelled, 'canceled');
  }
  const definition = await findBestDefinition(params);
  if (definition === null) {
    return null;
  }
  const lines = definition.text.split('\n').slice(definition.targetRange.start.line, definition.targetRange.end.line + 1);
  if (definition.targetRange.start.line === definition.targetRange.end.line) {
    lines[0] = lines[0].substring(definition.targetRange.start.character, definition.targetRange.end.character);
  } else {
    lines[0] = lines[0].substring(definition.targetRange.start.character);
    lines[lines.length - 1] = lines[lines.length - 1].substring(0, definition.targetRange.end.character);
  }
  return {
    contents: {
      language: 'vhdl',
      value: lines.join('\n')
    }
  };
});
connection.onDefinition(async (params) => {
  const linter = await getLinter(params.textDocument.uri);

  const definitions = await findDefinitions(linter, params.position);
  if (definitions.length === 0) {
    return null;
  }
  return definitions;
});
connection.onCompletion(async (params, cancelationToken) => {
  const linter = await getLinter(params.textDocument.uri);

  if (cancelationToken.isCancellationRequested) {
    return [];
  }
  return getCompletions(linter, params);
});
connection.onReferences( async params => {
  const linter = await getLinter(params.textDocument.uri);

    return findReferencesHandler(linter, params.position);

  });

connection.onPrepareRename(async params => {
  const linter = await getLinter(params.textDocument.uri);

  return prepareRenameHandler(linter, params.position);
});
connection.onRenameRequest(async params => {
  const linter = await getLinter(params.textDocument.uri);

  return renameHandler(linter, params.position, params.newName);
});
connection.onDocumentFormatting(handleDocumentFormatting);
connection.onFoldingRanges(foldingHandler);
connection.onDocumentHighlight(async (params) => {
  const linter = await getLinter(params.textDocument.uri);

  return documentHighlightHandler(linter, params);

});
connection.onWorkspaceSymbol(params => handleOnWorkspaceSymbol(params, projectParser));
// connection.on
// eslint-disable-next-line @typescript-eslint/no-explicit-any
connection.onRequest('vhdl-linter/listing', async (params: any) => {
  const linter = await getLinter(params.textDocument.uri);

  const files: OFile[] = [];
  const unresolved: string[] = [];

  function addUnresolved(name: string) {
    if (unresolved.findIndex(search => search === name) === -1) {
      unresolved.push(name);
    }
  }

  async function parseTree(file: OFile) {
    const index = files.findIndex(fileSearch => fileSearch?.uri === file?.uri);
    if (index === -1) {
      files.push(file);
    } else {
      // push the file to the back to have correct compile order
      files.push(files.splice(index, 1)[0]);
    }

    for (const obj of file.objectList) {
      let found: OFile | undefined = undefined;
      if (obj instanceof OInstantiation) {
        if (obj.type === 'entity') {
          if (obj.definitions?.length > 0 && obj.definitions[0].parent instanceof OFile && obj.definitions[0].parent.entities[0] !== undefined) { // TODO: Fix me better
            found = obj.definitions[0].parent;
          } else {
            addUnresolved(`${obj.library}.${obj.componentName.text}`);
          }
        } else if (obj.type === 'component') {
          if (obj.definitions?.length > 0
            && obj.definitions[0] instanceof OComponent && obj.definitions[0].definitions?.length > 0
            && obj.definitions[0].definitions[0].parent instanceof OFile) {
            found = obj.definitions[0].definitions[0].parent;
          } else {
            addUnresolved(obj.componentName.text);
          }
        }
      } else if (obj instanceof OUseClause) {
        // do not generate file listings for ieee files
        if (obj.library?.referenceToken.getLText() === 'ieee' || obj.library?.referenceToken.getLText() === 'std') {
          continue;
        }
        const matchingPackages = projectParser.packages.filter(pkg => pkg.lexerToken.getLText() === obj.packageName.referenceToken.getLText());
        if (matchingPackages.length > 0) {
          found = matchingPackages[0].parent;
        }
      }

      if (found) {
        const vhdlLinter = new VhdlLinter(found.uri, found.originalText, projectParser, getDocumentSettings);
        await vhdlLinter.checkAll();
        await parseTree(vhdlLinter.file);
      }
    }

  }

  await parseTree(linter.file);
  const filesList = files.reverse().map(file => file.uri.toString().replace((rootUri ?? '').replace('file://', ''), '')).join(`\n`);
  const unresolvedList = unresolved.join('\n');
  return `files:\n${filesList}\n\nUnresolved instantiations:\n${unresolvedList}`;
});
connection.languages.semanticTokens.on(handleSemanticTokens);
documents.listen(connection);

// Listen on the connection
connection.listen();
