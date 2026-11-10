/**
 * The subset of LSP 3.17 wire shapes that this client sends and accepts.
 *
 * These are plain structural types: they mirror the JSON payloads rather than
 * importing the protocol package, so the session layer stays free of any
 * server-specific extension.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  location: Location;
  containerName?: string;
}

export interface Hover {
  contents: MarkupContent | MarkedString | Array<MarkupContent | MarkedString>;
  range?: Range;
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkupContent;
}

export interface SignatureInformation {
  label: string;
  documentation?: string | MarkupContent;
  parameters?: ParameterInformation[];
  activeParameter?: number;
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  tags?: number[];
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

export interface ServerCapabilities {
  documentSymbolProvider?: boolean | { label?: string };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  callHierarchyProvider?: boolean | Record<string, unknown>;
  signatureHelpProvider?: boolean | Record<string, unknown>;
  workspaceSymbolProvider?: boolean | Record<string, unknown>;
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  [key: string]: unknown;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}
