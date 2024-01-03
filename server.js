const fs = require("node:fs");
const express = require("express");
const expressWs = require("express-ws");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
} = require("vscode-languageserver/node");

const {
  getLanguageService: htmlLanguageServer,
} = require("vscode-html-languageservice");

const {
  AbstractMessageReader,
  AbstractMessageWriter,

  IPCMessageReader,
  IPCMessageWriter,
} = require("vscode-jsonrpc/node");

const { TextDocument } = require("vscode-languageserver-textdocument");

let WebsocketMessageReader, WebsocketMessageWriter;
(async function() {
    let ws = await import("vscode-ws-jsonrpc");
    WebsocketMessageReader = ws.WebSocketMessageReader;
    WebsocketMessageWriter = ws.WebSocketMessageWriter;
})();


function sockWrapper(socket) {
  return {
    onMessage(callback) {
      return socket.addEventListener("message", ({ data }) => {
        callback(data);
      });
    },
    onError(callback) {
      return socket.addEventListener("error", callback);
    },
    onClose(callback) {
      return socket.addEventListener("close", callback);
    },
  };
}

const app = express();
const port = 3030;

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

const documentSettings = new Map();
const documents = new TextDocuments(TextDocument);

const servers = new Map();
const serverModes = {
  svelte: (socket, getConnection) => {
    let ls = require("svelte-language-server/dist/src/server.js");
    return ls.startServer({ connection: getConnection() });
  },
  html: async (socket, getConnection) => {
    let defaultSettings = { maxNumberOfProblems: 1000 };
    let globalSettings = defaultSettings;

    const service = htmlLanguageServer();

    const connection = createConnection(
      new WebsocketMessageReader(sockWrapper(socket)),
      new WebsocketMessageWriter(socket),
      ProposedFeatures.all
    );

    connection.onInitialize((params) => {
      const capabilities = params.capabilities;

      // Does the client support the `workspace/configuration` request?
      // If not, we fall back using global settings.
      hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
      );
      hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
      );
      hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
      );

      const result = {
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Incremental,
          // Tell the client that this server supports code completion.
          hoverProvider: true,
          completionProvider: {
            resolveProvider: true,
          },
          workspace: {
            workspaceFolders: {
              supported: false,
              changeNotifications: false,
            },
          },
          colorProvider: true,
        },
      };
      if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
          workspaceFolders: {
            supported: true,
            changeNotifications: true,
          },
        };
      }
      return result;
    });

    // Cache the settings of all open documents
    connection.onDidChangeConfiguration((change) => {
      if (hasConfigurationCapability) {
        documentSettings.clear();
      } else {
        globalSettings = change.settings || defaultSettings;
      }

      // Revalidate all open text documents
      // documents.all().forEach(validateTextDocument);
    });

    connection.onCompletion((params) => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.doComplete(document, params.position, htmlDocument);
    });

    connection.onCompletionResolve((params) => {
      return params;
    });

    connection.onRenameRequest((params) => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.doRename(
        document,
        params.position,
        params.newName,
        htmlDocument
      );
    });

    connection.onDocumentHighlight((params) => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.findDocumentHighlights(
        document,
        params.position,
        htmlDocument
      );
    });

    connection.onDocumentFormatting((params) => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      return service.format(document, undefined, params.options);
    });

    connection.onRequest("textDocument/hover", (params) => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.doHover(document, params.position, htmlDocument);
    });

    // Only keep settings for open documents
    documents.onDidClose((e) => {
      documentSettings.delete(e.document.uri);
    });

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    documents.onDidChangeContent((change) => {
      // validateTextDocument(change.document);
    });

    documents.listen(connection);
    connection.listen();

    return connection;
  },
  vue: (socket, getConnection) => {
    const { startLanguageServer } = require("@volar/language-server/node");
    const {
      createServerPlugin,
    } = require("@vue/language-server/out/languageServerPlugin");

    const connection = createConnection(
      new WebsocketMessageReader(sockWrapper(socket)),
      new WebsocketMessageWriter(socket),
      ProposedFeatures.all
    );
    let vuePlugin = createServerPlugin(connection);

    return startLanguageServer(connection, vuePlugin);
  },
  typescript: async (socket, getConnection) => {
    const { LspServer, LspClientImpl, LspClientLogger } = await import(
      "./tslangserver.mjs"
    );

    const connection = createConnection(
      new WebsocketMessageReader(sockWrapper(socket)),
      new WebsocketMessageWriter(socket),
      ProposedFeatures.all
    );

    const lspClient = new LspClientImpl(connection);
    const logger = new LspClientLogger(lspClient);
    const server = new LspServer({ logger, lspClient });
    connection.onInitialize(server.initialize.bind(server));
    connection.onInitialized(server.initialized.bind(server));
    connection.onDidChangeConfiguration(
      server.didChangeConfiguration.bind(server)
    );
    connection.onDidOpenTextDocument(server.didOpenTextDocument.bind(server));
    connection.onDidSaveTextDocument(server.didSaveTextDocument.bind(server));
    connection.onDidCloseTextDocument(server.didCloseTextDocument.bind(server));
    connection.onDidChangeTextDocument(
      server.didChangeTextDocument.bind(server)
    );
    connection.onCodeAction(server.codeAction.bind(server));
    connection.onCodeLens(server.codeLens.bind(server));
    connection.onCodeLensResolve(server.codeLensResolve.bind(server));
    connection.onCompletion(server.completion.bind(server));
    connection.onCompletionResolve(server.completionResolve.bind(server));
    connection.onDefinition(server.definition.bind(server));
    connection.onImplementation(server.implementation.bind(server));
    connection.onTypeDefinition(server.typeDefinition.bind(server));
    connection.onDocumentFormatting(server.documentFormatting.bind(server));
    connection.onDocumentRangeFormatting(
      server.documentRangeFormatting.bind(server)
    );
    connection.onDocumentHighlight(server.documentHighlight.bind(server));
    connection.onDocumentSymbol(server.documentSymbol.bind(server));
    connection.onExecuteCommand(server.executeCommand.bind(server));
    connection.onHover(server.hover.bind(server));
    connection.onReferences(server.references.bind(server));
    connection.onRenameRequest(server.rename.bind(server));
    connection.onPrepareRename(server.prepareRename.bind(server));
    connection.onSelectionRanges(server.selectionRanges.bind(server));
    connection.onSignatureHelp(server.signatureHelp.bind(server));
    connection.onWorkspaceSymbol(server.workspaceSymbol.bind(server));
    connection.onFoldingRanges(server.foldingRanges.bind(server));
    connection.languages.onLinkedEditingRange(
      server.linkedEditingRange.bind(server)
    );
    connection.languages.callHierarchy.onPrepare(
      server.prepareCallHierarchy.bind(server)
    );
    connection.languages.callHierarchy.onIncomingCalls(
      server.callHierarchyIncomingCalls.bind(server)
    );
    connection.languages.callHierarchy.onOutgoingCalls(
      server.callHierarchyOutgoingCalls.bind(server)
    );
    connection.languages.inlayHint.on(server.inlayHints.bind(server));
    connection.languages.semanticTokens.on(
      server.semanticTokensFull.bind(server)
    );
    connection.languages.semanticTokens.onRange(
      server.semanticTokensRange.bind(server)
    );
    connection.workspace.onWillRenameFiles(server.willRenameFiles.bind(server));

    connection.listen();
  },
  python: (socket, getConnection) => {
    const pylsp = spawn("pylsp", [
      "--check-parent-process",
      "--ws", "--port", "3031",
    ]);
    let ws, queue = [];

    pylsp.on("error", () => {
      socket.close();
    });

    socket.addEventListener("message", ({ data }) => {
      if (ws) {
        ws.send(data);
      } else {
        queue.push(data);
      }
    });

    let open = () => {
      try {
        ws = new WebSocket("ws://127.0.0.1:3031");
        ws.addEventListener("message", ({ data }) => {
          socket.send(data);
        });

        ws.addEventListener("open", () => {
          queue.map((i) => ws.send(i));
        });
  
        socket.addEventListener("close", () => {
          ws.close();
        });
      } catch {
        setTimeout(open, 1000)
      }
    };

    pylsp.on("spawn", () => setTimeout(open, 2000));
  },
};

// Enable WebSocket support
expressWs(app);

// WebSocket endpoint
app.ws("/:mode", async (socket, req) => {
  let mode = req.params.mode;
  console.log("Connected to client:", mode);

  // let server = servers.get(mode);

  // if (!server) {
    let module = serverModes[mode];
    if (!module) return;

    server = await module(socket, (...args) =>
      createConnection(
        new WebsocketMessageReader(sockWrapper(socket)),
        new WebsocketMessageWriter(socket),
        ...args
      )
    );
    // servers.set(mode, server);
  // }

  // socket.on("message", (msg) => {
  //   console.log(`WebSocket message received: ${msg}`);
  // });

  // socket.on("close", () => {
  //   console.log("WebSocket closed");
  // });
});

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
