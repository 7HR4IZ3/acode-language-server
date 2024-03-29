#!/data/data/com.termux/files/usr/bin/node

import express from "express";
import expressWs from "express-ws";
import { spawn } from "node:child_process";
// import Buffer from "node:buffer";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind
} from "vscode-languageserver/node.js";

import { getLanguageService as htmlLanguageServer } from "vscode-html-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";

import {
  WebSocketMessageReader,
  WebSocketMessageWriter
} from "vscode-ws-jsonrpc";

const DEBUG = false;
const VERSION = "1.0.6";

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
    return 3;
  }

  initialize(connection) {
    if (this.connection) {
      this.connection.onclose = null;
      this.connection.close();
    }

    this.connection = connection;
    connection.onopen = event => {
      this.dispatchEvent(new Event("open"));
      this.onopen?.(event);

      if (this.sendQueue.length) {
        let newQueue = [...this.sendQueue];
        this.sendQueue = [];
        newQueue.map(data => this.send(data));
      }
    };

    connection.onmessage = event => {
      // console.log("[Received]:", event.data);
      this.dispatchEvent(
        new MessageEvent("message", {
          data: event.data
        })
      );
      this.onmessage?.(event);
    };

    connection.onclose = event => {
      this.dispatchEvent(
        new Event("close", {
          reason: event.reason,
          code: event.code,
          wasClean: event.wasClean
        })
      );
      this.onclose?.(event);
    };

    connection.onerror = error => {
      this.dispatchEvent(new Event("error"));
      this.onerror?.(error);
    };
  }

  send(data) {
    // console.log("[Sending]:", data);
    if (this.connection) {
      if (this.connection.readyState === 1) {
        this.connection.send(data);
      } else {
        this.sendQueue.push(data);
        console.log("[Server]", "WebSocket not open. Unable to send data.");
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
    }
  };
}

function addHeaders(data, sep) {
  data = data.trim();
  let length = data.length;
  // console.log(data, data.length)
  return "Content-Length: " + String(length) + sep + data;
}

function checkJSON(data) {
  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
}

function proxyServer(websocket, command, args, { callback, seperator } = {}) {
  // Start the language server subprocess
  const languageServer = spawn(command, args || [], {
    stdio: ["pipe", "pipe", process.stderr]
  });
  let messageQueue = [],
    spawned = false;

  // Create separate streams for stdin and stdout
  const stdinStream = languageServer.stdin;
  const stdoutStream = languageServer.stdout;

  let chunks = [];
  let expectedLength = null;

  // Pipe data from the WebSocket to the language server stdin
  websocket.addEventListener("message", ({ data }) => {
    // data = Buffer.from(data);
    if (callback) {
      data = callback(data);
    }
    data = addHeaders(data, seperator || "\r\n\r\n");
    // DEBUG && console.log("Received:", data);
    if (spawned) {
      stdinStream.write(data);
    } else {
      messageQueue.push(data);
    }
  });

  let handleMessage = (dataString, dataLength) => {
    if (!dataString) {
      expectedLength = dataLength;
      return;
    }

    // If currentMessage matches the local data length, send and return
    if (
      dataLength &&
      (
        dataString.length === dataLength ||
        dataString.length === dataLength - 4
      )
    ) {
      DEBUG && console.log("DSending:", dataString, checkJSON(dataString));
      return websocket.send(dataString);
    }

    // If currentMessage matches the expected data length, send and return
    if (
      expectedLength &&
      (
        dataString.length === expectedLength ||
        dataString.length === expectedLength - 4
      )
    ) {
      DEBUG && console.log("ESending:", dataString, checkJSON(dataString));
      return websocket.send(dataString);
    }

    // If no local data length use global expected length
    if (!dataLength && expectedLength) {
      dataLength = expectedLength;
    }

    // Else check if has previous message
    if (chunks.length >= 1) {
      // If previous message, check if current message plus previous messsges
      // length matches the expected length
      const completeMessage = chunks.join("") + dataString;
      if (
        completeMessage.length === dataLength ||
        completeMessage.length === dataLength - 4
      ) {
        // Reset chunks array and expected length
        chunks = [];
        // expectedLength = null;

        DEBUG &&
          console.log("Sending:", completeMessage, checkJSON(completeMessage));
        return websocket.send(completeMessage);
      }
    } else {
      // Add the data to the chunks array
      // and set global length to local length
      chunks.push(dataString);
      expectedLength = dataLength;
    }
  };

  // Pipe data from the language server stdout to the WebSocket
  stdoutStream.on("data", data => {
    let dataString = data.toString();
    DEBUG && console.log("Raw:", dataString);

    // Check if the data contains 'Content-Length'
    if (dataString.includes("Content-Length")) {
      let messages = dataString.split("Content-Length:");
      // console.log(messages);

      for (let message of messages) {
        if (!message?.length) continue;
        DEBUG && console.log("\n\nHandling message:", message, expectedLength);

        // Extract the content length
        const contentLengthMatch = ("Content-Length:" + message).match(
          /Content-Length: (\d+)/
        );
        if (contentLengthMatch) {
          message = message.split("\r\n\r\n")[1];
          handleMessage(message, parseInt(contentLengthMatch[1], 10));
        } else {
          handleMessage(message);
        }
      }
    } else {
      handleMessage(dataString);
    }
  });

  // Handle the closure of WebSocket
  websocket.addEventListener("close", () => {
    // console.log("Closed websocket.")
    languageServer.kill();
  });

  websocket.addEventListener("error", error => {
    console.log("Error:", error);
    // languageServer.kill();
  });

  languageServer.on("spawn", () => {
    spawned = true;
    messageQueue.map(data => stdinStream.write(data));
    messageQueue = [];
  });

  languageServer.on("error", (...args) => {
    console.log("Error in '" + command + "':", ...args);
    websocket.close();
  });

  return languageServer;
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
  cpp: (socket, getConnection) => {
    return proxyServer(socket, "clangd", [], {
      callback: data => {
        return data.replaceAll('"uri":"/', '"uri":"file:///');
      }
    });
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

    connection.onInitialize(params => {
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
            resolveProvider: true
          },
          workspace: {
            workspaceFolders: {
              supported: false,
              changeNotifications: false
            }
          },
          colorProvider: true
        }
      };
      if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
          workspaceFolders: {
            supported: true,
            changeNotifications: true
          }
        };
      }
      return result;
    });

    // Cache the settings of all open documents
    connection.onDidChangeConfiguration(change => {
      if (hasConfigurationCapability) {
        documentSettings.clear();
      } else {
        globalSettings = change.settings || defaultSettings;
      }

      // Revalidate all open text documents
      // documents.all().forEach(validateTextDocument);
    });

    connection.onCompletion(params => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.doComplete(document, params.position, htmlDocument);
    });

    connection.onCompletionResolve(params => {
      return params;
    });

    connection.onRenameRequest(params => {
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

    connection.onDocumentHighlight(params => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.findDocumentHighlights(
        document,
        params.position,
        htmlDocument
      );
    });

    connection.onDocumentFormatting(params => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      return service.format(document, undefined, params.options);
    });

    connection.onRequest("textDocument/hover", params => {
      let document = documents.get(params.textDocument.uri);
      if (!document) return null;
      let htmlDocument = service.parseHTMLDocument(document);
      return service.doHover(document, params.position, htmlDocument);
    });

    // Only keep settings for open documents
    documents.onDidClose(e => {
      documentSettings.delete(e.document.uri);
    });

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    documents.onDidChangeContent(change => {
      // validateTextDocument(change.document);
    });

    documents.listen(connection);
    connection.listen();

    return connection;
  }
  // typescript: async (socket, getConnection) => {
  //   const { LspServer, LspClientImpl, LspClientLogger } = await import(
  //     "./tslangserver.mjs"
  //   );

  //   const connection = createConnection(
  //     new WebSocketMessageReader(sockWrapper(socket)),
  //     new WebSocketMessageWriter(socket),
  //     ProposedFeatures.all
  //   );

  //   const lspClient = new LspClientImpl(connection);
  //   const logger = new LspClientLogger(lspClient);
  //   const server = new LspServer({ logger, lspClient });
  //   connection.onInitialize(server.initialize.bind(server));
  //   connection.onInitialized(server.initialized.bind(server));
  //   connection.onDidChangeConfiguration(
  //     server.didChangeConfiguration.bind(server)
  //   );
  //   connection.onDidOpenTextDocument(server.didOpenTextDocument.bind(server));
  //   connection.onDidSaveTextDocument(server.didSaveTextDocument.bind(server));
  //   connection.onDidCloseTextDocument(server.didCloseTextDocument.bind(server));
  //   connection.onDidChangeTextDocument(
  //     server.didChangeTextDocument.bind(server)
  //   );
  //   connection.onCodeAction(server.codeAction.bind(server));
  //   connection.onCodeLens(server.codeLens.bind(server));
  //   connection.onCodeLensResolve(server.codeLensResolve.bind(server));
  //   connection.onCompletion(server.completion.bind(server));
  //   connection.onCompletionResolve(server.completionResolve.bind(server));
  //   connection.onDefinition(server.definition.bind(server));
  //   connection.onImplementation(server.implementation.bind(server));
  //   connection.onTypeDefinition(server.typeDefinition.bind(server));
  //   connection.onDocumentFormatting(server.documentFormatting.bind(server));
  //   connection.onDocumentRangeFormatting(
  //     server.documentRangeFormatting.bind(server)
  //   );
  //   connection.onDocumentHighlight(server.documentHighlight.bind(server));
  //   connection.onDocumentSymbol(server.documentSymbol.bind(server));
  //   connection.onExecuteCommand(server.executeCommand.bind(server));
  //   connection.onHover(server.hover.bind(server));
  //   connection.onReferences(server.references.bind(server));
  //   connection.onRenameRequest(server.rename.bind(server));
  //   connection.onPrepareRename(server.prepareRename.bind(server));
  //   connection.onSelectionRanges(server.selectionRanges.bind(server));
  //   connection.onSignatureHelp(server.signatureHelp.bind(server));
  //   connection.onWorkspaceSymbol(server.workspaceSymbol.bind(server));
  //   connection.onFoldingRanges(server.foldingRanges.bind(server));
  //   connection.languages.onLinkedEditingRange(
  //     server.linkedEditingRange.bind(server)
  //   );
  //   connection.languages.callHierarchy.onPrepare(
  //     server.prepareCallHierarchy.bind(server)
  //   );
  //   connection.languages.callHierarchy.onIncomingCalls(
  //     server.callHierarchyIncomingCalls.bind(server)
  //   );
  //   connection.languages.callHierarchy.onOutgoingCalls(
  //     server.callHierarchyOutgoingCalls.bind(server)
  //   );
  //   connection.languages.inlayHint.on(server.inlayHints.bind(server));
  //   connection.languages.semanticTokens.on(
  //     server.semanticTokensFull.bind(server)
  //   );
  //   connection.languages.semanticTokens.onRange(
  //     server.semanticTokensRange.bind(server)
  //   );
  //   connection.workspace.onWillRenameFiles(server.willRenameFiles.bind(server));

  //   socket.addEventListener("close", () => {
  //     connection.dispose();
  //   });
  //   connection.listen();
  // },
  // python: (socket, getConnection) => {
  //   return proxyServer(socket, "pylsp", ["--check-parent-process"]);
  // },
  // java: (socket, getConnection) => {
  //   return proxyServer(socket, "~/jdtls/bin/jdtls", [], {
  //     callback: data => {
  //       return data
  //         .replaceAll('"uri":"/', '"uri":"file:///')
  //         .replaceAll('"url":"/', '"url":"file:///');
  //     }
  //   });
  // },
  // rust: (socket, getConnection) => {
  //   return proxyServer(socket, "rust-analyzer", [], {
  //     callback: data => {
  //       return data
  //         .replaceAll('"uri":"/', '"uri":"file:///')
  //         .replaceAll('"url":"/', '"url":"file:///');
  //     },
  //     seperator: "\n\n"
  //   });
  // },
  // vue: (socket, getConnection) => {
  //   return proxyServer(socket, "vls", [], {
  //     callback: data => {
  //       return data
  //         .replaceAll('"uri":"/', '"uri":"file:///')
  //         .replaceAll('"url":"/', '"url":"file:///');
  //     }
  //   });
  // }
};

// Enable WebSocket support
expressWs(app);

app.get("/version", (request, response) => {
  response.send(VERSION);
});

// WebSocket endpoint
app.ws("/server/:mode", async (socket, req) => {
  let mode = req.params.mode;
  let module = serverModes[mode];
  if (!module) return;

  console.log("Connecting to client:", mode);
  let currentServer = servers.get(mode),
    proxySocket;
  if (!currentServer) {
    proxySocket = new WebSocketProxy();
    proxySocket.initialize(socket);

    let server = await module(proxySocket, (...args) =>
      createConnection(
        new WebSocketMessageReader(sockWrapper(proxySocket)),
        new WebSocketMessageWriter(proxySocket),
        ...args
      )
    );

    if (server) {
      servers.set(mode, { proxySocket, server });
    }
  } else {
    proxySocket = currentServer.proxySocket;
    proxySocket.initialize(socket);
  }
});

app.ws("/auto/:command", async (socket, request) => {
  let paramCommand = decodeURIComponent(request.params.command);
  let [command, ...args] = paramCommand.split(" ");

  let currentServer = servers.get(command),
    proxySocket;
  console.log("Connecting to auto client:", command, request.query.args || []);

  // console.log(command, request.query.args);
  if (!currentServer) {
    proxySocket = new WebSocketProxy();
    let server = proxyServer(
      proxySocket,
      command,
      request.query.args ? JSON.parse(request.query.args) : args,
      {
        callback: data => {
          if (request.query.rawuri === "true") {
            return data;
          }
          return data
            .replaceAll('uri":"/', 'uri":"file:///')
            .replaceAll('url":"/', 'url":"file:///');
        }
      }
    );

    if (server) {
      servers.set(command, { proxySocket, server });

      // Handle the closure of language server
      server.on("close", () => {
        console.log("Closing process for '" + command + "'");
        servers.delete(command);
        proxySocket.close();
      });
    }
  } else {
    proxySocket = currentServer.proxySocket;
  }

  proxySocket.initialize(socket);
});

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
