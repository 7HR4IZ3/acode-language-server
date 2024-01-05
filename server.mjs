import express from "express";
import expressWs from "express-ws";
import { spawn } from "node:child_process";
import WebSocket from "ws";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";

import { getLanguageService as htmlLanguageServer } from "vscode-html-languageservice";

// import {
//   AbstractMessageReader,
//   AbstractMessageWriter,
//   IPCMessageReader,
//   IPCMessageWriter,
// } from "vscode-jsonrpc/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";


class WebSocketProxy extends EventTarget {
  onopen;
  onclose;
  onerror;
  onmessage;

  constructor() {
    super();
    this.connection = null;
    this.sendQueue = new Array();
  }

  get readyState() {
    if (this.connection) {
      return this.connection.readyState;
    }
    return WebSocket.CLOSED;
  }

  initialize(connection) {
    if (this.connection) {
      this.connection.onclose = null;
      this.connection.close();
    }

    this.connection = connection;
    connection.onopen = (event) => {
      this.dispatchEvent(new Event("open"));
      this.onopen?.(event);

      if (this.sendQueue.length) {
        let newQueue = [...this.sendQueue];
        this.sendQueue = [];
        newQueue.map((data) => this.send(data));
      }
    };

    connection.onmessage = (event) => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: event.data,
        })
      );
      this.onmessage?.(event);
    };

    connection.onclose = (event) => {
      this.dispatchEvent(
        new Event("close", {
          reason: event.reason,
          code: event.code,
          wasClean: event.wasClean,
        })
      );
      this.onclose?.(event);
    };

    connection.onerror = (error) => {
      this.dispatchEvent(new Event("error"));
      this.onerror?.(error);
    };
  }

  send(data) {
    // console.log("Sending:", data);
    if (this.connection) {
      if (this.connection.readyState === WebSocket.OPEN) {
        this.connection.send(data);
      } else {
        this.sendQueue.push(data);
        console.warn("WebSocket not open. Unable to send data.");
      }
    } else {
      this.sendQueue.push(data);
      this.connect();
    }
  }

  close() {
    if (this.connection) {
      this.connection.close();
    }
  }
}

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

function proxyServer(websocket, command, args) {
  // Start the language server subprocess
  const languageServer = spawn(command, args || [], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Create separate streams for stdin and stdout
  const stdinStream = languageServer.stdin;
  const stdoutStream = languageServer.stdout;

  // Pipe data from the WebSocket to the language server stdin
  websocket.on("message", (data) => {
    stdinStream.write(data);
  });

  // Pipe data from the language server stdout to the WebSocket
  stdoutStream.on("data", (data) => {
    websocket.send(data);
  });

  // Handle the closure of WebSocket
  websocket.on("close", () => {
    languageServer.kill();
  });

  // Handle the closure of language server
  languageServer.on("close", () => {
    websocket.close();
  });

  languageServer.on("error", () => {
    websocket.close();
  });
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
      new WebSocketMessageReader(sockWrapper(socket)),
      new WebSocketMessageWriter(socket),
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
      new WebSocketMessageReader(sockWrapper(socket)),
      new WebSocketMessageWriter(socket),
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
      new WebSocketMessageReader(sockWrapper(socket)),
      new WebSocketMessageWriter(socket),
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

    socket.addEventListener("close", () => {
      connection.dispose();
    });
  },
  python: (socket, getConnection) => {
    const pylsp = spawn("pylsp", [
      "--check-parent-process",
      "--ws",
      "--port",
      "3031",
    ]);
    let ws,
      queue = [];

    pylsp.on("error", () => {
      socket.close();
    });

    socket.addEventListener("close", () => {
      pylsp.kill();
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
        setTimeout(open, 1000);
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
  let module = serverModes[mode];
  if (!module) return;

  console.log("Connected to client:", mode);
  let currentServer = servers.get(mode), proxySocket;
  if (!currentServer) {
    proxySocket = new WebSocketProxy();
    let server = await module(proxySocket, (...args) =>
      createConnection(
        new WebSocketMessageReader(sockWrapper(proxySocket)),
        new WebSocketMessageWriter(proxySocket),
        ...args
      )
    );
    
    servers.set({
      proxySocket, server
    });
  } else {
    proxySocket = currentSocket.proxySocket;
  }
  
  proxySocket.initialize(socket);
});

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
